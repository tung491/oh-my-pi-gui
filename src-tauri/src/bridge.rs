//! The renderer bridge: every `window.omp` call arrives as one `omp_invoke`
//! (or `omp_quick_entry_invoke`) carrying the page generation and a sequence
//! number, and every main→renderer message leaves on the page's one `Channel`.
//!
//! Electron ran handlers on one thread in arrival order and the code relies on
//! it, so calls from one `(window, generation)` are delivered to a per-window
//! dispatcher strictly in `seq` order through a small reorder buffer, and every
//! handler does its synchronous work before returning (`Reply::Ready`) or
//! returns a future only for what it must await (`Reply::Later`).

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::ctx::AppCtx;
use crate::ports::{Caller, WindowId, WindowKind};
use crate::prefs::{renderer_storage_pref_key, RENDERER_STORAGE_KEYS};
use crate::runtime_log;

/// How long the reorder buffer waits for a missing `seq` before skipping it.
pub const GAP_TIMEOUT: Duration = Duration::from_secs(2);
/// Outbound messages queued for a window before its page attaches.
pub const PRE_ATTACH_QUEUE_LIMIT: usize = 1000;
/// Generations remembered as superseded, so a stale page's invokes are rejected rather than buffered.
const SUPERSEDED_GENERATIONS_KEPT: usize = 16;

pub const DEEP_LINK_CHANNEL: &str = "deep-link";
pub const QUICK_ENTRY_STATE_CHANNEL: &str = "quick-entry:state";
pub const RUNTIME_ERROR_REPORT_CHANNEL: &str = "runtime:error-report";

// ---------------------------------------------------------------------------
// Handler contract
// ---------------------------------------------------------------------------

/// Which window kind may call a channel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Scope {
    Main,
    QuickEntry,
}

/// The error a handler rejects with. The renderer port rethrows `message` as an `Error`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct IpcError {
    pub message: String,
}

impl IpcError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into() }
    }

    /// The stub every module starts with; `check-module.sh` fails on any that remain.
    pub fn not_ported(channel: &str) -> Self {
        Self::new(format!("not ported: {channel}"))
    }

    pub fn unknown_channel(channel: &str) -> Self {
        Self::new(format!("unknown channel: {channel}"))
    }

    pub fn wrong_scope(channel: &str) -> Self {
        Self::new(format!("channel {channel} is not available to this window"))
    }

    pub fn bad_payload(channel: &str, detail: impl std::fmt::Display) -> Self {
        Self::new(format!("invalid payload for {channel}: {detail}"))
    }
}

impl From<serde_json::Error> for IpcError {
    fn from(error: serde_json::Error) -> Self {
        Self::new(error.to_string())
    }
}

/// A handler's answer: synchronous work is done, and only the response may still be pending.
pub enum Reply {
    Ready(Result<Value, IpcError>),
    Later(BoxFuture<'static, Result<Value, IpcError>>),
}

impl Reply {
    pub fn ok(value: Value) -> Self {
        Reply::Ready(Ok(value))
    }

    pub fn err(error: IpcError) -> Self {
        Reply::Ready(Err(error))
    }
}

/// Validate, mutate state and enqueue stdin writes before returning; await only for responses.
pub type Handler = fn(&Arc<AppCtx>, Caller, Vec<Value>) -> Reply;

/// The channel table: each channel has one scope and one handler.
#[derive(Default)]
pub struct Registry {
    handlers: HashMap<String, (Scope, Handler)>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a channel. Registering a channel twice is a programming error and panics,
    /// because two owners would make the channel table ambiguous.
    pub fn register(&mut self, channel: &str, scope: Scope, handler: Handler) {
        if self.handlers.insert(channel.to_string(), (scope, handler)).is_some() {
            panic!("channel {channel} registered twice");
        }
    }

    pub fn get(&self, channel: &str) -> Option<(Scope, Handler)> {
        self.handlers.get(channel).copied()
    }

    pub fn scope_of(&self, channel: &str) -> Option<Scope> {
        self.handlers.get(channel).map(|(scope, _)| *scope)
    }

    pub fn channels(&self) -> Vec<String> {
        let mut channels: Vec<String> = self.handlers.keys().cloned().collect();
        channels.sort();
        channels
    }

    pub fn len(&self) -> usize {
        self.handlers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.handlers.is_empty()
    }
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

/// What Rust sends on a page's channel.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub channel: String,
    pub payload: Value,
}

/// The page channel, abstracted so tests need no Tauri runtime.
pub trait OutboundSink: Send + Sync {
    fn send(&self, envelope: Envelope) -> Result<(), String>;
}

impl OutboundSink for tauri::ipc::Channel<Envelope> {
    fn send(&self, envelope: Envelope) -> Result<(), String> {
        tauri::ipc::Channel::send(self, envelope).map_err(|error| error.to_string())
    }
}

// ---------------------------------------------------------------------------
// Test hooks (compiled only with the `e2e-hooks` feature)
// ---------------------------------------------------------------------------

#[cfg(feature = "e2e-hooks")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fault {
    /// Reject the channel with this message.
    Error(String),
    /// Delay the handler by this many milliseconds.
    Delay(u64),
    /// Hold the handler until `test:release` names this barrier.
    Barrier(String),
}

#[cfg(feature = "e2e-hooks")]
#[derive(Default)]
struct Faults {
    by_channel: HashMap<String, Fault>,
    barriers: HashMap<String, Arc<tokio::sync::Notify>>,
}

// ---------------------------------------------------------------------------
// Per-window state
// ---------------------------------------------------------------------------

struct PendingCall {
    channel: String,
    args: Vec<Value>,
    reply: oneshot::Sender<Result<Value, IpcError>>,
}

struct GenerationQueue {
    /// The next `seq` the dispatcher will admit.
    next_seq: u64,
    pending: BTreeMap<u64, PendingCall>,
    /// Set once the page's `omp_attach` arrived; until then nothing is admitted.
    attached: bool,
    /// A gap timer is running for this `next_seq`.
    gap_timer_for: Option<u64>,
}

impl GenerationQueue {
    fn new(attached: bool) -> Self {
        Self { next_seq: 0, pending: BTreeMap::new(), attached, gap_timer_for: None }
    }
}

struct WindowState {
    kind: WindowKind,
    current_gen: Option<String>,
    superseded: VecDeque<String>,
    queues: HashMap<String, GenerationQueue>,
    sink: Option<Arc<dyn OutboundSink>>,
    /// Running the per-window drain loop right now.
    draining: bool,
    /// Outbound messages for a page that has not attached (deep links and bar state excluded).
    pre_attach: VecDeque<Envelope>,
    /// Deep links no page has received yet, replayed in order on attach.
    undelivered_deep_links: Vec<Value>,
    /// The latest bar state, replayed on every attach of the quick-entry page.
    latest_quick_entry_state: Option<Value>,
}

impl WindowState {
    fn new(kind: WindowKind) -> Self {
        Self {
            kind,
            current_gen: None,
            superseded: VecDeque::new(),
            queues: HashMap::new(),
            sink: None,
            draining: false,
            pre_attach: VecDeque::new(),
            undelivered_deep_links: Vec::new(),
            latest_quick_entry_state: None,
        }
    }
}

#[derive(Default)]
struct BridgeState {
    windows: HashMap<WindowId, WindowState>,
}

/// Dispatch and outbound streams for every window.
pub struct Bridge {
    registry: Registry,
    state: Arc<Mutex<BridgeState>>,
    /// Counts gap skips and overflow drops, for diagnostics and tests.
    skipped_gaps: AtomicU64,
    dropped_outbound: AtomicU64,
    #[cfg(feature = "e2e-hooks")]
    faults: Mutex<Faults>,
}

impl std::fmt::Debug for Bridge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Bridge").field("channels", &self.registry.len()).finish_non_exhaustive()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // The bridge holds no user data that a poisoned lock could corrupt; a panic
    // in another thread must not take every window's IPC down with it.
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Bridge {
    pub fn new(registry: Registry) -> Self {
        Self {
            registry,
            state: Arc::new(Mutex::new(BridgeState::default())),
            skipped_gaps: AtomicU64::new(0),
            dropped_outbound: AtomicU64::new(0),
            #[cfg(feature = "e2e-hooks")]
            faults: Mutex::new(Faults::default()),
        }
    }

    pub fn registry(&self) -> &Registry {
        &self.registry
    }

    /// Known windows (registered, attached or targeted by an emit).
    pub fn windows(&self) -> Vec<Caller> {
        let state = lock(&self.state);
        let mut callers: Vec<Caller> =
            state.windows.iter().map(|(win_id, window)| Caller { win_id: *win_id, kind: window.kind }).collect();
        callers.sort_by_key(|caller| caller.win_id);
        callers
    }

    /// Whether the window's current page has attached its channel.
    pub fn is_attached(&self, win_id: WindowId) -> bool {
        lock(&self.state).windows.get(&win_id).map(|window| window.sink.is_some()).unwrap_or(false)
    }

    /// Make a window known before its page attaches, so broadcasts queue for it.
    pub fn register_window(&self, caller: Caller) {
        let mut state = lock(&self.state);
        state.windows.entry(caller.win_id).or_insert_with(|| WindowState::new(caller.kind));
    }

    /// Forget a closed window and fail every call still waiting in its buffers.
    pub fn unregister_window(&self, win_id: WindowId) {
        let removed = lock(&self.state).windows.remove(&win_id);
        if let Some(window) = removed {
            for queue in window.queues.into_values() {
                for call in queue.pending.into_values() {
                    let _ = call.reply.send(Err(IpcError::new("the window closed")));
                }
            }
        }
    }

    pub fn skipped_gaps(&self) -> u64 {
        self.skipped_gaps.load(Ordering::Relaxed)
    }

    pub fn dropped_outbound(&self) -> u64 {
        self.dropped_outbound.load(Ordering::Relaxed)
    }

    // -- attach ------------------------------------------------------------

    /// A page attached its channel. A new generation supersedes the previous
    /// one: its channel is dropped and its reorder buffer is flushed in order.
    pub fn attach(&self, ctx: &Arc<AppCtx>, caller: Caller, gen: String, sink: Arc<dyn OutboundSink>) {
        let mut flushed: Vec<PendingCall> = Vec::new();
        let mut replay: Vec<Envelope> = Vec::new();
        {
            let mut state = lock(&self.state);
            let window = state.windows.entry(caller.win_id).or_insert_with(|| WindowState::new(caller.kind));
            if window.current_gen.as_deref() == Some(gen.as_str()) {
                // The same page attached twice (should not happen); keep the newest channel.
                window.sink = Some(sink);
                return;
            }
            if let Some(previous) = window.current_gen.take() {
                if let Some(queue) = window.queues.remove(&previous) {
                    flushed.extend(queue.pending.into_values());
                }
                window.superseded.push_back(previous);
                while window.superseded.len() > SUPERSEDED_GENERATIONS_KEPT {
                    window.superseded.pop_front();
                }
            }
            // Generations that buffered calls but never attached are stale too.
            let stale: Vec<String> = window.queues.keys().filter(|key| **key != gen).cloned().collect();
            for key in stale {
                if let Some(queue) = window.queues.remove(&key) {
                    for call in queue.pending.into_values() {
                        let _ = call.reply.send(Err(IpcError::new("page generation superseded")));
                    }
                }
            }
            window.current_gen = Some(gen.clone());
            window.queues.entry(gen.clone()).or_insert_with(|| GenerationQueue::new(true)).attached = true;
            window.sink = Some(sink);
            replay.extend(window.pre_attach.drain(..));
            if window.kind == WindowKind::Main {
                replay.extend(window.undelivered_deep_links.drain(..).map(|payload| Envelope {
                    channel: DEEP_LINK_CHANNEL.to_string(),
                    payload,
                }));
            }
            if window.kind == WindowKind::QuickEntry {
                if let Some(payload) = window.latest_quick_entry_state.clone() {
                    replay.push(Envelope { channel: QUICK_ENTRY_STATE_CHANNEL.to_string(), payload });
                }
            }
        }
        // The superseded page's buffered calls run in seq order, gaps ignored: the
        // renderer made them, and a lost call must never stall the window's queue.
        for call in flushed {
            self.run_call(ctx, caller, call);
        }
        for envelope in replay {
            self.deliver(caller.win_id, envelope);
        }
        self.drain(ctx, caller, &gen);
    }

    // -- invoke ------------------------------------------------------------

    /// One renderer call. Resolves when the handler's reply is known.
    pub fn invoke(
        &self,
        ctx: &Arc<AppCtx>,
        caller: Caller,
        gen: String,
        seq: u64,
        channel: String,
        args: Vec<Value>,
    ) -> impl std::future::Future<Output = Result<Value, IpcError>> + Send + 'static {
        let (tx, rx) = oneshot::channel();
        let call = PendingCall { channel, args, reply: tx };
        self.enqueue(ctx, caller, gen, seq, call);
        async move { rx.await.unwrap_or_else(|_| Err(IpcError::new("the bridge dropped the call"))) }
    }

    fn enqueue(&self, ctx: &Arc<AppCtx>, caller: Caller, gen: String, seq: u64, call: PendingCall) {
        {
            let mut state = lock(&self.state);
            let window = state.windows.entry(caller.win_id).or_insert_with(|| WindowState::new(caller.kind));
            if window.superseded.iter().any(|old| *old == gen) {
                let _ = call.reply.send(Err(IpcError::new("page generation superseded")));
                return;
            }
            let attached = window.current_gen.as_deref() == Some(gen.as_str());
            let queue = window.queues.entry(gen.clone()).or_insert_with(|| GenerationQueue::new(attached));
            if seq < queue.next_seq {
                let _ = call.reply.send(Err(IpcError::new(format!("sequence {seq} was already dispatched"))));
                return;
            }
            if let Some(previous) = queue.pending.insert(seq, call) {
                let _ = previous.reply.send(Err(IpcError::new(format!("sequence {seq} was sent twice"))));
            }
        }
        self.drain(ctx, caller, &gen);
    }

    /// Admit ready calls in order. One drainer per window at a time, so a
    /// handler's synchronous work always finishes before the next call starts.
    fn drain(&self, ctx: &Arc<AppCtx>, caller: Caller, gen: &str) {
        loop {
            let next = {
                let mut state = lock(&self.state);
                let Some(window) = state.windows.get_mut(&caller.win_id) else { return };
                let Some(queue) = window.queues.get_mut(gen) else {
                    window.draining = false;
                    return;
                };
                if !queue.attached || window.draining {
                    return;
                }
                match queue.pending.remove(&queue.next_seq) {
                    Some(call) => {
                        queue.next_seq += 1;
                        window.draining = true;
                        Some(call)
                    }
                    None => {
                        if let Some(first_pending) = queue.pending.keys().next().copied() {
                            if queue.gap_timer_for != Some(queue.next_seq) {
                                queue.gap_timer_for = Some(queue.next_seq);
                                self.start_gap_timer(ctx, caller, gen.to_string(), queue.next_seq, first_pending);
                            }
                        }
                        window.draining = false;
                        None
                    }
                }
            };
            let Some(call) = next else { return };
            self.run_call(ctx, caller, call);
            // Hand the drainer role back so the next iteration can take it (or a newer arrival can).
            {
                let mut state = lock(&self.state);
                if let Some(window) = state.windows.get_mut(&caller.win_id) {
                    window.draining = false;
                }
            }
        }
    }

    fn start_gap_timer(&self, ctx: &Arc<AppCtx>, caller: Caller, gen: String, missing: u64, first_pending: u64) {
        let state = Arc::clone(&self.state);
        let ctx = Arc::clone(ctx);
        tokio::spawn(async move {
            tokio::time::sleep(GAP_TIMEOUT).await;
            let skipped = {
                let mut guard = lock(&state);
                let Some(window) = guard.windows.get_mut(&caller.win_id) else { return };
                let Some(queue) = window.queues.get_mut(&gen) else { return };
                if queue.gap_timer_for != Some(missing) || queue.next_seq != missing {
                    return;
                }
                queue.gap_timer_for = None;
                match queue.pending.keys().next().copied() {
                    Some(first) if first > queue.next_seq => {
                        let skipped = first - queue.next_seq;
                        queue.next_seq = first;
                        skipped
                    }
                    _ => return,
                }
            };
            ctx.bridge.skipped_gaps.fetch_add(skipped, Ordering::Relaxed);
            runtime_log::note(
                "unknown",
                format!("bridge skipped {skipped} missing call(s) for window {} after {} s", caller.win_id, GAP_TIMEOUT.as_secs()),
                json!({ "winId": caller.win_id.0, "gen": gen, "missingFrom": missing, "resumedAt": first_pending }),
            );
            ctx.bridge.drain(&ctx, caller, &gen);
        });
    }

    fn run_call(&self, ctx: &Arc<AppCtx>, caller: Caller, call: PendingCall) {
        let PendingCall { channel, args, reply } = call;
        let outcome = match self.registry.get(&channel) {
            None => Reply::err(IpcError::unknown_channel(&channel)),
            Some((scope, _)) if !scope_allows(scope, caller.kind) => Reply::err(IpcError::wrong_scope(&channel)),
            Some((_, handler)) => self.call_handler(ctx, caller, &channel, handler, args),
        };
        match outcome {
            Reply::Ready(result) => {
                let _ = reply.send(result);
            }
            Reply::Later(future) => {
                tokio::spawn(async move {
                    let _ = reply.send(future.await);
                });
            }
        }
    }

    #[cfg(not(feature = "e2e-hooks"))]
    fn call_handler(&self, ctx: &Arc<AppCtx>, caller: Caller, _channel: &str, handler: Handler, args: Vec<Value>) -> Reply {
        handler(ctx, caller, args)
    }

    #[cfg(feature = "e2e-hooks")]
    fn call_handler(&self, ctx: &Arc<AppCtx>, caller: Caller, channel: &str, handler: Handler, args: Vec<Value>) -> Reply {
        let fault = lock(&self.faults).by_channel.get(channel).cloned();
        match fault {
            None => handler(ctx, caller, args),
            Some(Fault::Error(message)) => Reply::err(IpcError::new(message)),
            Some(Fault::Delay(ms)) => {
                let ctx = Arc::clone(ctx);
                Reply::Later(Box::pin(async move {
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                    match handler(&ctx, caller, args) {
                        Reply::Ready(result) => result,
                        Reply::Later(future) => future.await,
                    }
                }))
            }
            Some(Fault::Barrier(id)) => {
                let notify = lock(&self.faults).barriers.entry(id).or_insert_with(|| Arc::new(tokio::sync::Notify::new())).clone();
                let ctx = Arc::clone(ctx);
                Reply::Later(Box::pin(async move {
                    notify.notified().await;
                    match handler(&ctx, caller, args) {
                        Reply::Ready(result) => result,
                        Reply::Later(future) => future.await,
                    }
                }))
            }
        }
    }

    // -- outbound ----------------------------------------------------------

    /// Send `payload` on `channel` to one window. Before the page attaches the
    /// message is queued (deep links and the bar state are kept as replay state
    /// instead); the quick-entry window receives only its state channel.
    pub fn emit_to_window(&self, win_id: WindowId, channel: &str, payload: Value) {
        let envelope = Envelope { channel: channel.to_string(), payload };
        let sink = {
            let mut state = lock(&self.state);
            let kind = if win_id == WindowId::QUICK_ENTRY { WindowKind::QuickEntry } else { WindowKind::Main };
            let window = state.windows.entry(win_id).or_insert_with(|| WindowState::new(kind));
            if window.kind == WindowKind::QuickEntry && channel != QUICK_ENTRY_STATE_CHANNEL {
                return;
            }
            if channel == QUICK_ENTRY_STATE_CHANNEL {
                window.latest_quick_entry_state = Some(envelope.payload.clone());
            }
            match window.sink.clone() {
                Some(sink) => sink,
                None => {
                    if channel == DEEP_LINK_CHANNEL {
                        window.undelivered_deep_links.push(envelope.payload);
                    } else if channel != QUICK_ENTRY_STATE_CHANNEL {
                        if window.pre_attach.len() >= PRE_ATTACH_QUEUE_LIMIT {
                            window.pre_attach.pop_front();
                            self.dropped_outbound.fetch_add(1, Ordering::Relaxed);
                        }
                        window.pre_attach.push_back(envelope);
                    }
                    return;
                }
            }
        };
        if let Err(error) = sink.send(envelope.clone()) {
            // The page's channel is gone (reload in flight): keep the message for the next attach.
            let mut state = lock(&self.state);
            if let Some(window) = state.windows.get_mut(&win_id) {
                if Arc::ptr_eq(&sink, window.sink.as_ref().unwrap_or(&sink)) {
                    window.sink = None;
                }
                if channel == DEEP_LINK_CHANNEL {
                    window.undelivered_deep_links.push(envelope.payload);
                } else if channel != QUICK_ENTRY_STATE_CHANNEL {
                    window.pre_attach.push_back(envelope);
                }
            }
            runtime_log::note(
                "unknown",
                format!("bridge channel send failed for window {win_id}: {error}"),
                json!({ "winId": win_id.0, "channel": channel }),
            );
        }
    }

    fn deliver(&self, win_id: WindowId, envelope: Envelope) {
        let sink = lock(&self.state).windows.get(&win_id).and_then(|window| window.sink.clone());
        if let Some(sink) = sink {
            if let Err(error) = sink.send(envelope) {
                runtime_log::note(
                    "unknown",
                    format!("bridge replay failed for window {win_id}: {error}"),
                    json!({ "winId": win_id.0 }),
                );
            }
        }
    }

    /// Send to every chat window (known, attached or not).
    pub fn broadcast_main(&self, channel: &str, payload: Value) {
        let targets: Vec<WindowId> = {
            let state = lock(&self.state);
            state.windows.iter().filter(|(_, window)| window.kind == WindowKind::Main).map(|(id, _)| *id).collect()
        };
        for win_id in targets {
            self.emit_to_window(win_id, channel, payload.clone());
        }
    }

    // -- e2e hooks ----------------------------------------------------------

    #[cfg(feature = "e2e-hooks")]
    pub fn set_fault(&self, channel: &str, fault: Fault) {
        lock(&self.faults).by_channel.insert(channel.to_string(), fault);
    }

    #[cfg(feature = "e2e-hooks")]
    pub fn clear_fault(&self, channel: &str) {
        lock(&self.faults).by_channel.remove(channel);
    }

    #[cfg(feature = "e2e-hooks")]
    pub fn clear_faults(&self) {
        lock(&self.faults).by_channel.clear();
    }

    /// Release every call held at `id`; true when a barrier of that name existed.
    #[cfg(feature = "e2e-hooks")]
    pub fn release_barrier(&self, id: &str) -> bool {
        match lock(&self.faults).barriers.remove(id) {
            Some(notify) => {
                notify.notify_waiters();
                true
            }
            None => false,
        }
    }
}

fn scope_allows(scope: Scope, kind: WindowKind) -> bool {
    matches!((scope, kind), (Scope::Main, WindowKind::Main) | (Scope::QuickEntry, WindowKind::QuickEntry))
}

// ---------------------------------------------------------------------------
// Bootstrap script
// ---------------------------------------------------------------------------

/// Node's platform name for `OmpApi.platform`.
pub fn node_platform() -> &'static str {
    runtime_log::node_platform()
}

/// Escape what JSON allows but JavaScript source (or an HTML embedding) does
/// not: the two line terminators, and `<` so `</script>` can never appear.
/// Every replacement is a valid JSON string escape, so the data round-trips.
pub fn escape_for_script(json: &str) -> String {
    json.replace('\u{2028}', "\\u2028").replace('\u{2029}', "\\u2029").replace('<', "\\u003c")
}

/// The initialization script for a webview: sets `window.__OMP_BOOTSTRAP__`
/// and seeds the mirrored renderer storage keys into localStorage when absent,
/// before any page script (including `pre-paint.js`) runs. Built by serializing
/// one JSON value; the script never interpolates strings.
pub fn bootstrap_script(ctx: &AppCtx, caller: Caller) -> String {
    let mut storage = serde_json::Map::new();
    for key in RENDERER_STORAGE_KEYS {
        if let Some(Value::String(text)) = ctx.prefs.get(&renderer_storage_pref_key(key)) {
            storage.insert(key.to_string(), Value::String(text));
        }
    }
    let data = json!({
        "bootstrap": {
            "platform": node_platform(),
            "version": ctx.host.app_version(),
            "windowKind": caller.kind,
            "winId": caller.win_id,
        },
        "storage": storage,
    });
    let encoded = escape_for_script(&serde_json::to_string(&data).unwrap_or_else(|_| "{}".to_string()));
    format!(
        "(function () {{\n  var data = {encoded};\n  window.__OMP_BOOTSTRAP__ = data.bootstrap;\n  try {{\n    for (var key in data.storage) {{\n      if (Object.prototype.hasOwnProperty.call(data.storage, key) && window.localStorage.getItem(key) === null) {{\n        window.localStorage.setItem(key, data.storage[key]);\n      }}\n    }}\n  }} catch (error) {{\n    /* storage unavailable: the renderer falls back to its defaults */\n  }}\n}})();\n"
    )
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InvokeArgs {
    channel: String,
    args: Vec<Value>,
    seq: u64,
    gen: String,
}

fn caller_for(window: &tauri::WebviewWindow, expected: WindowKind) -> Result<Caller, IpcError> {
    let label = window.label();
    let caller = Caller::from_label(label).ok_or_else(|| IpcError::new(format!("unknown window label: {label}")))?;
    if caller.kind != expected {
        return Err(IpcError::new(format!("window {label} may not use this bridge command")));
    }
    Ok(caller)
}

#[tauri::command]
pub async fn omp_invoke(
    window: tauri::WebviewWindow,
    ctx: tauri::State<'_, Arc<AppCtx>>,
    channel: String,
    args: Vec<Value>,
    seq: u64,
    gen: String,
) -> Result<Value, IpcError> {
    let caller = caller_for(&window, WindowKind::Main)?;
    let invoke = InvokeArgs { channel, args, seq, gen };
    ctx.bridge.invoke(ctx.inner(), caller, invoke.gen, invoke.seq, invoke.channel, invoke.args).await
}

#[tauri::command]
pub async fn omp_quick_entry_invoke(
    window: tauri::WebviewWindow,
    ctx: tauri::State<'_, Arc<AppCtx>>,
    channel: String,
    args: Vec<Value>,
    seq: u64,
    gen: String,
) -> Result<Value, IpcError> {
    let caller = caller_for(&window, WindowKind::QuickEntry)?;
    let invoke = InvokeArgs { channel, args, seq, gen };
    ctx.bridge.invoke(ctx.inner(), caller, invoke.gen, invoke.seq, invoke.channel, invoke.args).await
}

#[tauri::command]
pub fn omp_attach(
    window: tauri::WebviewWindow,
    ctx: tauri::State<'_, Arc<AppCtx>>,
    gen: String,
    on_message: tauri::ipc::Channel<Envelope>,
) -> Result<(), IpcError> {
    let label = window.label();
    let caller = Caller::from_label(label).ok_or_else(|| IpcError::new(format!("unknown window label: {label}")))?;
    ctx.bridge.attach(ctx.inner(), caller, gen, Arc::new(on_message));
    Ok(())
}

/// Run one call through the ordered dispatcher without Tauri: the page attaches
/// a recording sink first, so the call is admitted at once.
#[cfg(test)]
pub async fn dispatch_for_test(ctx: &Arc<AppCtx>, caller: Caller, channel: &str, args: Vec<Value>) -> Result<Value, IpcError> {
    use crate::testing::RecordingSink;
    let gen = format!("test-{}", caller.win_id);
    if !ctx.bridge.is_attached(caller.win_id) {
        ctx.bridge.attach(ctx, caller, gen.clone(), Arc::new(RecordingSink::default()));
    }
    let seq = {
        let mut state = lock(&ctx.bridge.state);
        let window = state.windows.get_mut(&caller.win_id).expect("attached above");
        let current = window.current_gen.clone().expect("attached above");
        let queue = window.queues.get(&current).expect("attached above");
        queue.next_seq + queue.pending.len() as u64
    };
    let current = lock(&ctx.bridge.state).windows[&caller.win_id].current_gen.clone().expect("attached above");
    ctx.bridge.invoke(ctx, caller, current, seq, channel.to_string(), args).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{fake_ctx, RecordingSink};

    /// Appends the first argument to the context's own `order` list, so parallel tests never share state.
    fn record_order(ctx: &Arc<AppCtx>, _: Caller, args: Vec<Value>) -> Reply {
        let name = args.first().and_then(Value::as_str).unwrap_or("").to_string();
        let mut length = 0;
        ctx.prefs
            .update("order", |current| {
                let mut list = current.and_then(|v| v.as_array().cloned()).unwrap_or_default();
                list.push(Value::String(name));
                length = list.len();
                Some(Value::Array(list))
            })
            .expect("order list");
        Reply::ok(json!(length))
    }

    fn order(ctx: &AppCtx) -> Vec<String> {
        ctx.prefs
            .get("order")
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect()
    }

    fn echo(_: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
        Reply::ok(json!({ "winId": caller.win_id, "args": args }))
    }

    fn never_resolves(_: &Arc<AppCtx>, _: Caller, _: Vec<Value>) -> Reply {
        Reply::Later(Box::pin(std::future::pending()))
    }

    fn registry() -> Registry {
        let mut registry = Registry::new();
        registry.register("test:order", Scope::Main, record_order);
        registry.register("test:echo", Scope::Main, echo);
        registry.register("test:never", Scope::Main, never_resolves);
        registry.register("quick-entry:dismiss", Scope::QuickEntry, echo);
        registry
    }

    fn ctx() -> Arc<AppCtx> {
        fake_ctx(registry())
    }

    fn main_caller() -> Caller {
        Caller::main(WindowId(1))
    }

    async fn attach(ctx: &Arc<AppCtx>, caller: Caller, gen: &str) -> Arc<RecordingSink> {
        let sink = Arc::new(RecordingSink::default());
        ctx.bridge.attach(ctx, caller, gen.to_string(), sink.clone());
        sink
    }

    #[tokio::test]
    async fn dispatches_in_seq_order_when_calls_arrive_out_of_order() {
        let ctx = ctx();
        attach(&ctx, main_caller(), "g1").await;
        let c2 = ctx.bridge.invoke(&ctx, main_caller(), "g1".into(), 2, "test:order".into(), vec![json!("c")]);
        let c0 = ctx.bridge.invoke(&ctx, main_caller(), "g1".into(), 0, "test:order".into(), vec![json!("a")]);
        let c1 = ctx.bridge.invoke(&ctx, main_caller(), "g1".into(), 1, "test:order".into(), vec![json!("b")]);
        let (r0, r1, r2) = tokio::join!(c0, c1, c2);
        assert_eq!((r0.unwrap(), r1.unwrap(), r2.unwrap()), (json!(1), json!(2), json!(3)));
        assert_eq!(order(&ctx), vec!["a", "b", "c"]);
    }

    #[tokio::test]
    async fn an_invoke_that_arrives_before_its_attach_waits_for_that_generation() {
        let ctx = ctx();
        let mut pending = Box::pin(ctx.bridge.invoke(&ctx, main_caller(), "g1".into(), 0, "test:echo".into(), vec![json!(1)]));
        tokio::time::timeout(Duration::from_millis(50), &mut pending).await.expect_err("must wait for the attach");
        assert!(order(&ctx).is_empty());
        attach(&ctx, main_caller(), "g1").await;
        let result = pending.await.unwrap();
        assert_eq!(result["args"], json!([1]));
        assert_eq!(result["winId"], json!(1));
    }

    #[tokio::test]
    async fn an_older_generation_is_rejected_after_reattach() {
        let ctx = ctx();
        attach(&ctx, main_caller(), "g1").await;
        ctx.bridge.invoke(&ctx, main_caller(), "g1".into(), 0, "test:echo".into(), vec![]).await.unwrap();
        attach(&ctx, main_caller(), "g2").await;
        let stale = ctx.bridge.invoke(&ctx, main_caller(), "g1".into(), 1, "test:echo".into(), vec![]).await;
        assert_eq!(stale, Err(IpcError::new("page generation superseded")));
        let fresh = ctx.bridge.invoke(&ctx, main_caller(), "g2".into(), 0, "test:echo".into(), vec![]).await;
        assert!(fresh.is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn a_missing_seq_is_skipped_after_the_gap_timeout() {
        let ctx = ctx();
        attach(&ctx, main_caller(), "g1").await;
        ctx.bridge.invoke(&ctx, main_caller(), "g1".into(), 0, "test:order".into(), vec![json!("a")]).await.unwrap();
        let mut late = Box::pin(ctx.bridge.invoke(&ctx, main_caller(), "g1".into(), 2, "test:order".into(), vec![json!("c")]));
        tokio::time::timeout(Duration::from_millis(10), &mut late).await.expect_err("seq 1 is missing");
        tokio::time::advance(GAP_TIMEOUT + Duration::from_millis(1)).await;
        assert_eq!(late.await.unwrap(), json!(2));
        assert_eq!(order(&ctx), vec!["a", "c"]);
        assert_eq!(ctx.bridge.skipped_gaps(), 1);
        // Seq 1 arriving afterwards is refused rather than run out of order.
        let stale = ctx.bridge.invoke(&ctx, main_caller(), "g1".into(), 1, "test:order".into(), vec![json!("b")]).await;
        assert!(stale.is_err());
    }

    #[tokio::test]
    async fn later_futures_do_not_block_the_next_admission() {
        let ctx = ctx();
        attach(&ctx, main_caller(), "g1").await;
        let mut never = Box::pin(ctx.bridge.invoke(&ctx, main_caller(), "g1".into(), 0, "test:never".into(), vec![]));
        let second = ctx.bridge.invoke(&ctx, main_caller(), "g1".into(), 1, "test:order".into(), vec![json!("b")]);
        assert_eq!(tokio::time::timeout(Duration::from_secs(1), second).await.unwrap().unwrap(), json!(1));
        assert_eq!(order(&ctx), vec!["b"]);
        tokio::time::timeout(Duration::from_millis(20), &mut never).await.expect_err("still pending");
    }

    #[tokio::test]
    async fn rejects_a_main_channel_from_the_quick_entry_window() {
        let ctx = ctx();
        attach(&ctx, Caller::quick_entry(), "q1").await;
        let refused = ctx.bridge.invoke(&ctx, Caller::quick_entry(), "q1".into(), 0, "test:echo".into(), vec![]).await;
        assert_eq!(refused, Err(IpcError::wrong_scope("test:echo")));
        let allowed = ctx.bridge.invoke(&ctx, Caller::quick_entry(), "q1".into(), 1, "quick-entry:dismiss".into(), vec![]).await;
        assert!(allowed.is_ok());
        let unknown = ctx.bridge.invoke(&ctx, Caller::quick_entry(), "q1".into(), 2, "nope".into(), vec![]).await;
        assert_eq!(unknown, Err(IpcError::unknown_channel("nope")));
    }

    #[tokio::test]
    async fn reattach_drops_the_old_channel() {
        let ctx = ctx();
        let old = attach(&ctx, main_caller(), "g1").await;
        let new = attach(&ctx, main_caller(), "g2").await;
        ctx.bridge.emit_to_window(WindowId(1), "sessions:changed", Value::Null);
        assert!(old.sent().is_empty());
        assert_eq!(new.sent().len(), 1);
        assert_eq!(new.sent()[0].channel, "sessions:changed");
    }

    #[tokio::test]
    async fn queues_before_attach_and_flushes_on_attach() {
        let ctx = ctx();
        ctx.bridge.register_window(main_caller());
        for i in 0..(PRE_ATTACH_QUEUE_LIMIT + 5) {
            ctx.bridge.emit_to_window(WindowId(1), "log:line", json!(i));
        }
        ctx.bridge.emit_to_window(WindowId(1), DEEP_LINK_CHANNEL, json!({ "action": "new-session" }));
        let sink = attach(&ctx, main_caller(), "g1").await;
        let sent = sink.sent();
        assert_eq!(sent.len(), PRE_ATTACH_QUEUE_LIMIT + 1);
        assert_eq!(sent[0].payload, json!(5), "the oldest entries were dropped");
        assert_eq!(sent[PRE_ATTACH_QUEUE_LIMIT - 1].payload, json!(PRE_ATTACH_QUEUE_LIMIT + 4));
        assert_eq!(sent[PRE_ATTACH_QUEUE_LIMIT].channel, DEEP_LINK_CHANNEL, "the deep link survives the overflow");
        assert_eq!(ctx.bridge.dropped_outbound(), 5);
        ctx.bridge.emit_to_window(WindowId(1), "log:line", json!("live"));
        assert_eq!(sink.sent().len(), PRE_ATTACH_QUEUE_LIMIT + 2);
    }

    #[tokio::test]
    async fn replays_undelivered_deep_links_in_order() {
        let ctx = ctx();
        ctx.bridge.emit_to_window(WindowId(1), DEEP_LINK_CHANNEL, json!({ "action": "switch-session", "sessionId": "a" }));
        ctx.bridge.emit_to_window(WindowId(1), DEEP_LINK_CHANNEL, json!({ "action": "new-session" }));
        let first = attach(&ctx, main_caller(), "g1").await;
        let links: Vec<Value> = first.sent().into_iter().filter(|e| e.channel == DEEP_LINK_CHANNEL).map(|e| e.payload).collect();
        assert_eq!(links, vec![json!({ "action": "switch-session", "sessionId": "a" }), json!({ "action": "new-session" })]);
        // Delivered links are not replayed to the next page.
        let second = attach(&ctx, main_caller(), "g2").await;
        assert!(second.sent().is_empty());
    }

    #[tokio::test]
    async fn quick_entry_receives_only_its_state_channel() {
        let ctx = ctx();
        ctx.bridge.emit_to_window(WindowId::QUICK_ENTRY, QUICK_ENTRY_STATE_CHANNEL, json!({ "showId": 1 }));
        ctx.bridge.emit_to_window(WindowId::QUICK_ENTRY, QUICK_ENTRY_STATE_CHANNEL, json!({ "showId": 2 }));
        ctx.bridge.emit_to_window(WindowId::QUICK_ENTRY, "sessions:changed", Value::Null);
        ctx.bridge.emit_to_window(WindowId::QUICK_ENTRY, DEEP_LINK_CHANNEL, json!({ "action": "new-session" }));
        let sink = attach(&ctx, Caller::quick_entry(), "q1").await;
        assert_eq!(sink.sent(), vec![Envelope { channel: QUICK_ENTRY_STATE_CHANNEL.into(), payload: json!({ "showId": 2 }) }]);
        ctx.bridge.emit_to_window(WindowId::QUICK_ENTRY, "menu:action", json!({ "action": "settings" }));
        ctx.bridge.broadcast_main("sessions:changed", Value::Null);
        assert_eq!(sink.sent().len(), 1);
        // A reattach (the bar page reloaded) gets the latest state again.
        let again = attach(&ctx, Caller::quick_entry(), "q2").await;
        assert_eq!(again.sent().len(), 1);
    }

    #[tokio::test]
    async fn bootstrap_escapes_hostile_values() {
        let ctx = ctx();
        let hostile = "quote\" backslash\\ </script> sep\u{2028}\u{2029} end";
        ctx.prefs.set(&renderer_storage_pref_key("omp.lang"), json!(hostile)).unwrap();
        ctx.prefs.set(&renderer_storage_pref_key("omp.themeScheme"), json!(7)).unwrap();
        let script = bootstrap_script(&ctx, Caller::main(WindowId(4)));
        assert!(!script.contains('\u{2028}') && !script.contains('\u{2029}'));
        assert!(script.contains("\\u2028\\u2029"));
        assert!(script.contains("\\u003c/script>") && !script.contains("</script>"));
        assert!(script.contains("\\\"") && script.contains("\\\\"));
        assert!(!script.contains("\"omp.themeScheme\""), "non-string storage values are dropped");
        let start = script.find("var data = ").unwrap() + "var data = ".len();
        let end = script[start..].find(";\n").unwrap() + start;
        let data: Value = serde_json::from_str(&script[start..end]).unwrap();
        assert_eq!(data["bootstrap"], json!({ "platform": node_platform(), "version": "0.0.0-test", "windowKind": "main", "winId": 4 }));
        assert_eq!(data["storage"]["omp.lang"], json!(hostile));
        let bar = bootstrap_script(&ctx, Caller::quick_entry());
        assert!(bar.contains("\"windowKind\":\"quick-entry\""));
    }

    #[test]
    fn fault_hooks_are_absent_without_the_feature() {
        let mut registry = Registry::new();
        crate::test_hooks::register(&mut registry);
        if cfg!(feature = "e2e-hooks") {
            assert!(registry.get("test:emit").is_some());
        } else {
            assert!(registry.is_empty());
            assert!(registry.get("test:emit").is_none());
        }
    }

    #[tokio::test]
    async fn dispatch_for_test_runs_the_registered_handler() {
        let ctx = ctx();
        let result = dispatch_for_test(&ctx, main_caller(), "test:echo", vec![json!("x")]).await.unwrap();
        assert_eq!(result["args"], json!(["x"]));
        let second = dispatch_for_test(&ctx, main_caller(), "test:order", vec![json!("y")]).await.unwrap();
        assert_eq!(second, json!(1));
    }

    #[tokio::test]
    async fn unregistering_a_window_fails_its_buffered_calls() {
        let ctx = ctx();
        let pending = ctx.bridge.invoke(&ctx, main_caller(), "g1".into(), 0, "test:echo".into(), vec![]);
        ctx.bridge.unregister_window(WindowId(1));
        assert_eq!(pending.await, Err(IpcError::new("the window closed")));
    }

    #[cfg(feature = "e2e-hooks")]
    #[tokio::test]
    async fn barrier_faults_hold_a_call_until_released() {
        let ctx = ctx();
        attach(&ctx, main_caller(), "g1").await;
        ctx.bridge.set_fault("test:echo", Fault::Barrier("b1".into()));
        let mut held = Box::pin(ctx.bridge.invoke(&ctx, main_caller(), "g1".into(), 0, "test:echo".into(), vec![]));
        tokio::time::timeout(Duration::from_millis(20), &mut held).await.expect_err("held");
        assert!(ctx.bridge.release_barrier("b1"));
        assert!(held.await.is_ok());
        ctx.bridge.set_fault("test:echo", Fault::Error("scripted".into()));
        let failed = ctx.bridge.invoke(&ctx, main_caller(), "g1".into(), 1, "test:echo".into(), vec![]).await;
        assert_eq!(failed, Err(IpcError::new("scripted")));
        ctx.bridge.clear_faults();
        assert!(ctx.bridge.invoke(&ctx, main_caller(), "g1".into(), 2, "test:echo".into(), vec![]).await.is_ok());
    }

    #[tokio::test]
    async fn runtime_log_path_answers_through_the_dispatcher() {
        let mut registry = Registry::new();
        crate::services::register(&mut registry);
        let ctx = fake_ctx(registry);
        let path = dispatch_for_test(&ctx, main_caller(), "runtime:log-path", vec![]).await.unwrap();
        assert_eq!(path, json!(crate::runtime_log::path().to_string_lossy()));
        let report = json!({ "source": "window-error", "message": "boom" });
        let ack = dispatch_for_test(&ctx, main_caller(), "runtime:error-report", vec![report]).await.unwrap();
        assert_eq!(ack, Value::Null);
        let unknown = dispatch_for_test(&ctx, main_caller(), "fs:read", vec![json!({ "path": "x" })]).await;
        assert_eq!(unknown, Err(IpcError::not_ported("fs:read")));
    }

    #[test]
    fn registry_refuses_a_second_owner() {
        let mut registry = Registry::new();
        registry.register("a", Scope::Main, echo);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| registry.register("a", Scope::Main, echo)));
        assert!(result.is_err());
    }
}
