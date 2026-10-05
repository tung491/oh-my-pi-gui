//! Port of `src/main/sidecar-pool.ts`: one sidecar per tab, bounded at a hard
//! cap that counts tabs across every window.
//!
//! The cap is atomic: a slot is reserved under the state lock before the
//! sidecar is created, so concurrent acquires cannot overshoot. Each sidecar's
//! event stream is drained by one task; its events update the tab (status, run
//! state, session meta) and are routed to the owning window:
//!
//! - the full channels (`rpc:events`, `sidecar:status`, extension UI, host tool
//!   and URI requests, subagent, live, commands, config, prompt result, command
//!   output, session info, extension error, model catalog) forward only from the
//!   one or two VISIBLE tabs of a window, one of which is focused;
//! - every tab, visible or not, pushes the light `tab:status` channel, so
//!   background tabs report status flips and title/id changes.
//!
//! Session ownership (the double-attach guard): `session_owners` maps a session
//! file to the tab attached to it. It is registered at acquire (spawn with a
//! session path) and from the RPC passthrough (`note_session_file`), and dropped
//! on release or when `session_info_update` reports a session-id change.
//!
//! Response routing: extension UI, host tool and host URI requests are recorded
//! by request id, so a renderer response reaches the sidecar that raised the
//! request even after the user switched tabs.
//!
//! The state is one `std::sync::Mutex`, never held across an `.await`. Renderer
//! sends happen under it, so the messages for one tab leave in the order the
//! state changed; the bridge never calls back into this module. Layout
//! listeners run after the lock is released, because they read layouts back.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use futures_util::future::BoxFuture;
use serde_json::{json, Value};

use crate::bridge::spawn_task;
use crate::ctx::AppCtx;
use crate::paths;
use crate::ports::{
    AcquireOptions, Caller, CtxRef, IpcSessionOwner, IpcTabInfo, IpcTabSplit, IpcTabViewSplit, IpcTabWorktree, PersistedTabDescriptor,
    PersistedTabLayout, PersistedTabSplit, SessionKind, SidecarEvent, SidecarEvents, SidecarHandle, SidecarOptions, SidecarStatus,
    TabStatus, WindowId, WindowTabFact, WindowTabsChangedListener,
};

use super::snowflake::next_snowflake;

/// `TAB_LAYOUT_VERSION` from `tab-layout.ts`.
const TAB_LAYOUT_VERSION: u32 = 1;
/// Split ratios are clamped to this range (`sidecar-pool.ts:507`).
const SPLIT_RATIO_MIN: f64 = 0.2;
const SPLIT_RATIO_MAX: f64 = 0.8;

/// Extension UI methods that wait for a response (`BLOCKING_UI_METHODS` in
/// `src/shared/rpc-types.ts`). Only these get a response route; fire-and-forget
/// updates never reply, so tracking them would leak the owning tab.
const BLOCKING_UI_METHODS: &[&str] = &["select", "confirm", "askDialog", "input", "editor", "open_url"];

pub(crate) const CHANNEL_EVENTS: &str = "rpc:events";
pub(crate) const CHANNEL_SIDECAR_STATUS: &str = "sidecar:status";
pub(crate) const CHANNEL_TAB_STATUS: &str = "tab:status";
pub(crate) const CHANNEL_EXTENSION_UI: &str = "extension-ui:request";
pub(crate) const CHANNEL_HOST_TOOL_CALL: &str = "host-tool:call";
pub(crate) const CHANNEL_HOST_URI_REQUEST: &str = "host-uri:request";
const CHANNEL_SUBAGENT_FRAME: &str = "subagent:frame";
const CHANNEL_COMMANDS_UPDATE: &str = "commands:update";
const CHANNEL_CONFIG_UPDATE: &str = "config:update";
const CHANNEL_PROMPT_RESULT: &str = "prompt:result";
const CHANNEL_COMMAND_OUTPUT: &str = "command:output";
const CHANNEL_SESSION_INFO_UPDATE: &str = "session-info:update";
const CHANNEL_EXTENSION_ERROR: &str = "extension:error";
const CHANNEL_LIVE_UPDATE: &str = "live:update";
const CHANNEL_MODEL_CATALOG_UPDATE: &str = "model-catalog:update";

type LayoutListener = Arc<dyn Fn(WindowId, Option<PersistedTabLayout>) + Send + Sync>;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // Pool state stays consistent between statements; a panic elsewhere must not
    // take every tab's routing down with it.
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Entry {
    /// Identity of this entry (tab ids are renderer-visible and could repeat).
    key: u64,
    sidecar: Arc<dyn SidecarHandle>,
    tab_id: String,
    win_id: WindowId,
    /// Immutable; set at acquire.
    kind: SessionKind,
    /// Untargeted startup tab; disposable once the user opens an explicit tab.
    placeholder: bool,
    /// Git-worktree binding; immutable, set at acquire.
    worktree: Option<IpcTabWorktree>,
    /// Last status the sidecar reported.
    status: SidecarStatus,
    /// An agent run is in flight (`agent_start` seen, no `agent_end` yet).
    running: bool,
    /// Automatic compaction state once observed; `Some(true)` blocks session mutation.
    compacting: Option<bool>,
    session_id: Option<String>,
    /// Absent, `null` (cleared) or a title: from `session_info_update`, or the
    /// persisted title of a restored tab that has not been spawned yet.
    title: Option<Option<String>>,
    /// The session file this tab is attached to (reverse key of `session_owners`).
    session_file: Option<String>,
    /// Full channels forward from this tab (it is visible in its window).
    full_wired: bool,
    /// The pool has started (or resumed) this tab's process.
    started: bool,
    /// User `bash` (`!`) and `eval` (`$`) RPC requests awaiting their response.
    /// Only the quit guard's inventory reads it: tab status and idle-session
    /// routing follow the agent run alone.
    user_execs: usize,
}

impl Entry {
    fn in_flight(&self) -> bool {
        self.running || self.compacting == Some(true)
    }

    /// Whether quitting now would interrupt work: an agent run, a compaction or
    /// a user shell or eval command still awaiting its response.
    fn working(&self) -> bool {
        self.in_flight() || self.user_execs > 0
    }

    /// The `tab:status` push and `tab:get-all` item: a full tab snapshot including cached session meta.
    fn status_payload(&self) -> IpcTabInfo {
        // "running" only makes sense on a live connection: a restarting sidecar
        // reports its connection state even with a dead in-flight run.
        let status = if self.running && self.status == SidecarStatus::Ready { TabStatus::Running } else { TabStatus::from(self.status) };
        IpcTabInfo {
            tab_id: self.tab_id.clone(),
            cwd: self.sidecar.cwd(),
            status,
            active: None,
            visible: None,
            split: None,
            compacting: self.compacting,
            kind: self.kind,
            placeholder: Some(self.placeholder),
            worktree: self.worktree.clone(),
            session_path: Some(self.session_file.clone()),
            session_id: self.session_id.clone(),
            title: self.title.clone(),
        }
    }

    /// Spawn the process unless it is under way or has already run. A tab with
    /// a session to resume goes through `restart`, which on a never-spawned
    /// manager is a plain start carrying `--session`.
    fn ensure_started(&mut self) {
        if self.started || self.sidecar.status() != SidecarStatus::Asleep {
            return;
        }
        self.started = true;
        match self.session_file.as_deref() {
            Some(session_path) => self.sidecar.restart(None, Some(session_path)),
            None => self.sidecar.start(),
        }
        self.status = self.sidecar.status();
    }

    /// Wire the full channels. Being wired is being shown, so this is where a
    /// deferred tab's process is spawned.
    fn wire_full(&mut self) {
        if self.full_wired {
            return;
        }
        self.ensure_started();
        self.full_wired = true;
    }
}

/// What a state change produced: renderer sends (made under the lock), layout
/// notifications and sidecar disposals (both run after it is released).
#[derive(Default)]
struct Outbox {
    sends: Vec<(WindowId, &'static str, Value)>,
    notify: Vec<WindowId>,
    disposals: Vec<BoxFuture<'static, ()>>,
}

impl Outbox {
    fn send(&mut self, win_id: WindowId, channel: &'static str, payload: Value) {
        self.sends.push((win_id, channel, payload));
    }

    fn send_tab_status(&mut self, entry: &Entry) {
        match serde_json::to_value(entry.status_payload()) {
            Ok(payload) => self.send(entry.win_id, CHANNEL_TAB_STATUS, payload),
            Err(error) => crate::runtime_log::note("unknown", format!("tab status for {} did not serialize: {error}", entry.tab_id), json!({})),
        }
    }

    /// `{ tabId, payload }`, the renderer's `IpcActiveTabEnvelope`.
    fn send_active(&mut self, entry: &Entry, channel: &'static str, payload: Value) {
        self.send(entry.win_id, channel, json!({ "tabId": entry.tab_id, "payload": payload }));
    }
}

#[derive(Default)]
struct PoolState {
    /// Acquisition order.
    entries: Vec<Entry>,
    by_tab_id: HashMap<String, u64>,
    /// Window → focused tab. The first acquired tab of a window becomes active.
    active_by_window: HashMap<WindowId, String>,
    /// Window → the one or two tabs whose full streams are rendered (insertion order).
    visible_by_window: HashMap<WindowId, Vec<String>>,
    /// Window → order, axis and ratio of its two-pane view.
    split_by_window: HashMap<WindowId, IpcTabViewSplit>,
    /// Session file → owning tab and window.
    session_owners: HashMap<String, IpcSessionOwner>,
    /// Pending renderer-facing request id → entry key that raised it.
    request_owners: HashMap<String, u64>,
    /// Windows whose saved layout is being rebuilt: partial snapshots are suppressed.
    restoring_windows: HashSet<WindowId>,
    /// Slots claimed by acquires whose sidecar is still being created.
    reserved: usize,
    next_key: u64,
}

impl PoolState {
    fn index_of_key(&self, key: u64) -> Option<usize> {
        self.entries.iter().position(|entry| entry.key == key)
    }

    fn index_of_tab(&self, tab_id: &str) -> Option<usize> {
        let key = *self.by_tab_id.get(tab_id)?;
        self.index_of_key(key)
    }

    fn entry_for_tab(&self, tab_id: &str) -> Option<&Entry> {
        self.index_of_tab(tab_id).map(|index| &self.entries[index])
    }

    fn has_window(&self, win_id: WindowId) -> bool {
        self.entries.iter().any(|entry| entry.win_id == win_id)
    }

    /// The window's active entry, else its first entry (e.g. mid-teardown).
    fn entry_for_window(&self, win_id: WindowId) -> Option<&Entry> {
        let active = self.active_by_window.get(&win_id).and_then(|tab_id| self.entry_for_tab(tab_id));
        if let Some(entry) = active.filter(|entry| entry.win_id == win_id) {
            return Some(entry);
        }
        self.entries.iter().find(|entry| entry.win_id == win_id)
    }

    fn register_session_file(&mut self, index: usize, session_file: &str) {
        if self.entries[index].session_file.as_deref() != Some(session_file) {
            self.unregister_session_file(index);
        }
        let entry = &mut self.entries[index];
        entry.session_file = Some(session_file.to_string());
        self.session_owners.insert(session_file.to_string(), IpcSessionOwner { tab_id: entry.tab_id.clone(), win_id: entry.win_id });
    }

    /// Drop the entry's file → owner mapping when it still points at this entry:
    /// another tab may have registered the same file since.
    fn unregister_session_file(&mut self, index: usize) {
        let entry = &mut self.entries[index];
        let Some(session_file) = entry.session_file.take() else { return };
        if self.session_owners.get(&session_file).is_some_and(|owner| owner.tab_id == entry.tab_id) {
            self.session_owners.remove(&session_file);
        }
    }

    fn sync_full_wiring(&mut self, win_id: WindowId) {
        let visible = self.visible_by_window.get(&win_id).cloned().unwrap_or_default();
        for entry in self.entries.iter_mut().filter(|entry| entry.win_id == win_id) {
            if visible.contains(&entry.tab_id) {
                entry.wire_full();
            } else {
                entry.full_wired = false;
            }
        }
    }

    /// Release an entry: routes and ownership first, then dispose. When the
    /// active tab goes away, the oldest surviving (visible first) tab of the
    /// window takes over; releasing the last tab leaves the window tab-less.
    /// `window_closing` skips that hand-over: every tab of the window goes.
    fn release_entry(&mut self, index: usize, window_closing: bool, out: &mut Outbox) {
        self.unregister_session_file(index);
        let entry = self.entries.remove(index);
        if self.by_tab_id.get(&entry.tab_id) == Some(&entry.key) {
            self.by_tab_id.remove(&entry.tab_id);
        }
        // A late renderer response must fall back, never write to a dead sidecar.
        self.request_owners.retain(|_, key| *key != entry.key);
        out.disposals.push(entry.sidecar.dispose());

        let win_id = entry.win_id;
        if let Some(visible) = self.visible_by_window.get_mut(&win_id) {
            visible.retain(|tab_id| *tab_id != entry.tab_id);
        }
        if self.split_by_window.get(&win_id).is_some_and(|split| split.first_tab_id == entry.tab_id || split.second_tab_id == entry.tab_id) {
            self.split_by_window.remove(&win_id);
        }
        if !self.has_window(win_id) {
            self.active_by_window.remove(&win_id);
            self.visible_by_window.remove(&win_id);
            self.split_by_window.remove(&win_id);
            return;
        }
        if self.active_by_window.get(&win_id) != Some(&entry.tab_id) {
            if !window_closing {
                self.sync_full_wiring(win_id);
            }
            return;
        }
        self.active_by_window.remove(&win_id);
        if window_closing {
            return;
        }
        let visible = self.visible_by_window.get(&win_id).cloned().unwrap_or_default();
        let candidates: Vec<&Entry> = self.entries.iter().filter(|candidate| candidate.win_id == win_id).collect();
        let Some(candidate) = candidates.iter().find(|candidate| visible.contains(&candidate.tab_id)).or(candidates.first()) else {
            self.visible_by_window.remove(&win_id);
            return;
        };
        let candidate_tab = candidate.tab_id.clone();
        if visible.is_empty() {
            self.visible_by_window.insert(win_id, vec![candidate_tab.clone()]);
        }
        self.active_by_window.insert(win_id, candidate_tab);
        self.sync_full_wiring(win_id);
    }

    fn tabs_for_window(&self, win_id: WindowId) -> Vec<IpcTabInfo> {
        let active = self.active_by_window.get(&win_id);
        let visible = self.visible_by_window.get(&win_id);
        let split = self.split_by_window.get(&win_id);
        self.entries
            .iter()
            .filter(|entry| entry.win_id == win_id)
            .map(|entry| {
                let mut tab = entry.status_payload();
                if active == Some(&entry.tab_id) {
                    tab.active = Some(true);
                }
                if visible.is_some_and(|visible| visible.contains(&entry.tab_id)) {
                    tab.visible = Some(true);
                }
                if let Some(split) = split {
                    if split.first_tab_id == entry.tab_id {
                        tab.split = Some(IpcTabSplit { axis: split.axis, index: 0, ratio: split.ratio });
                    } else if split.second_tab_id == entry.tab_id {
                        tab.split = Some(IpcTabSplit { axis: split.axis, index: 1, ratio: split.ratio });
                    }
                }
                tab
            })
            .collect()
    }

    /// Serializable layout for the window, without transient run or status data.
    fn tab_layout_for_window(&self, win_id: WindowId) -> Option<PersistedTabLayout> {
        let entries: Vec<&Entry> = self.entries.iter().filter(|entry| entry.win_id == win_id).collect();
        if entries.is_empty() {
            return None;
        }
        let active = self.active_by_window.get(&win_id);
        let active_index = entries.iter().position(|entry| Some(&entry.tab_id) == active).unwrap_or(0);
        let split = self.split_by_window.get(&win_id).and_then(|split| {
            let first_index = entries.iter().position(|entry| entry.tab_id == split.first_tab_id)?;
            let second_index = entries.iter().position(|entry| entry.tab_id == split.second_tab_id)?;
            Some(PersistedTabSplit { axis: split.axis, first_index, second_index, ratio: split.ratio })
        });
        let tabs = entries
            .iter()
            .map(|entry| PersistedTabDescriptor {
                cwd: entry.sidecar.cwd(),
                session_path: entry.session_file.clone(),
                kind: entry.kind,
                worktree: entry.worktree.clone(),
                placeholder: entry.placeholder.then_some(true),
                // A cleared (null) title is written as absent, so a stale title
                // cannot survive until the tab is spawned again.
                title: entry.title.clone().flatten(),
            })
            .collect();
        Some(PersistedTabLayout { version: TAB_LAYOUT_VERSION, tabs, active_index, split })
    }

    /// Apply one sidecar event to entry `index` and queue what it forwards.
    fn apply_event(&mut self, index: usize, event: SidecarEvent, out: &mut Outbox) {
        match event {
            SidecarEvent::Status(payload) => {
                let entry = &mut self.entries[index];
                entry.status = payload.status;
                // A restart or exit kills any in-flight run along with the process.
                if payload.status != SidecarStatus::Ready {
                    entry.running = false;
                    entry.compacting = None;
                }
                out.send_tab_status(entry);
                if entry.full_wired {
                    match serde_json::to_value(&payload) {
                        Ok(mut value) => {
                            value["cwd"] = Value::String(entry.sidecar.cwd());
                            out.send_active(entry, CHANNEL_SIDECAR_STATUS, value);
                        }
                        Err(error) => crate::runtime_log::note("unknown", format!("sidecar status did not serialize: {error}"), json!({})),
                    }
                }
            }
            SidecarEvent::Events(events) => {
                let entry = &mut self.entries[index];
                // Run state comes from the event stream (the connection status never
                // re-fires at run end), so background tabs report running → ready too.
                let was_busy = entry.in_flight();
                let was_placeholder = entry.placeholder;
                for event in &events {
                    match event.get("type").and_then(Value::as_str) {
                        Some("agent_start") => {
                            entry.running = true;
                            entry.placeholder = false;
                        }
                        Some("agent_end") => entry.running = false,
                        Some("auto_compaction_start") => entry.compacting = Some(true),
                        Some("auto_compaction_end") => entry.compacting = Some(false),
                        _ => {}
                    }
                }
                if entry.in_flight() != was_busy || entry.placeholder != was_placeholder {
                    out.send_tab_status(entry);
                }
                if entry.placeholder != was_placeholder {
                    out.notify.push(entry.win_id);
                }
                if entry.full_wired {
                    out.send_active(entry, CHANNEL_EVENTS, Value::Array(events));
                }
            }
            SidecarEvent::SessionInfoUpdate(frame) => {
                let mut session_changed = false;
                {
                    let entry = &mut self.entries[index];
                    if let Some(title) = frame.get("title") {
                        entry.title = Some(title.as_str().map(str::to_string));
                    }
                    if let Some(session_id) = frame.get("sessionId").and_then(Value::as_str) {
                        let previous = entry.session_id.replace(session_id.to_string());
                        // The session under this tab changed (switch, new session,
                        // crash restart): the cached file mapping is stale. The first
                        // attach keeps the acquire-time registration; the renderer's
                        // hydrate (get_state) re-registers the current file.
                        session_changed = previous.is_some_and(|previous| previous != session_id);
                    }
                }
                if session_changed {
                    self.unregister_session_file(index);
                }
                let entry = &self.entries[index];
                // Session meta rides the light channel too, so a background tab's
                // title and id update without waiting for a status flip.
                out.send_tab_status(entry);
                if entry.full_wired {
                    out.send_active(entry, CHANNEL_SESSION_INFO_UPDATE, frame);
                }
            }
            SidecarEvent::ExtensionUi(request) => {
                if !self.entries[index].full_wired {
                    return;
                }
                let blocking = request.get("method").and_then(Value::as_str).is_some_and(|method| BLOCKING_UI_METHODS.contains(&method));
                if let (true, Some(id)) = (blocking, request.get("id").and_then(Value::as_str)) {
                    self.request_owners.insert(id.to_string(), self.entries[index].key);
                }
                let entry = &self.entries[index];
                out.send(entry.win_id, CHANNEL_EXTENSION_UI, json!({ "tabId": entry.tab_id, "request": request }));
            }
            SidecarEvent::HostUriRequest(request) => {
                if !self.entries[index].full_wired {
                    return;
                }
                if let Some(id) = request.get("id").and_then(Value::as_str) {
                    self.request_owners.insert(id.to_string(), self.entries[index].key);
                }
                out.send(self.entries[index].win_id, CHANNEL_HOST_URI_REQUEST, json!({ "request": request }));
            }
            SidecarEvent::SubagentFrame(frame) => self.forward_active(index, CHANNEL_SUBAGENT_FRAME, frame, out),
            SidecarEvent::LiveUpdate(frame) => self.forward_active(index, CHANNEL_LIVE_UPDATE, frame, out),
            SidecarEvent::ModelCatalogUpdate(frame) => self.forward_active(index, CHANNEL_MODEL_CATALOG_UPDATE, frame, out),
            SidecarEvent::CommandsUpdate(commands) => self.forward_active(index, CHANNEL_COMMANDS_UPDATE, Value::Array(commands), out),
            SidecarEvent::ConfigUpdate(frame) => self.forward_active(index, CHANNEL_CONFIG_UPDATE, frame, out),
            SidecarEvent::PromptResult(frame) => self.forward_active(index, CHANNEL_PROMPT_RESULT, frame, out),
            SidecarEvent::CommandOutput(frame) => self.forward_active(index, CHANNEL_COMMAND_OUTPUT, frame, out),
            SidecarEvent::ExtensionError(frame) => self.forward_active(index, CHANNEL_EXTENSION_ERROR, frame, out),
            // Host tool calls need the services port outside the lock (`SidecarPool::host_tool_call`).
            // Raw frames and stderr are not routed to the renderer (the TS pool never wired them).
            SidecarEvent::HostToolCall(_) | SidecarEvent::Frame(_) | SidecarEvent::Stderr(_) => {}
        }
    }

    fn forward_active(&self, index: usize, channel: &'static str, payload: Value, out: &mut Outbox) {
        let entry = &self.entries[index];
        if entry.full_wired {
            out.send_active(entry, channel, payload);
        }
    }
}

struct Inner {
    ctx: CtxRef,
    max: usize,
    state: Mutex<PoolState>,
    listeners: Mutex<Vec<LayoutListener>>,
    /// The ready health check (`index.ts:380-393`), switched on by `tabs::init`.
    health_check: AtomicBool,
}

/// The sidecar pool. Cloning shares the same pool.
#[derive(Clone)]
pub(crate) struct SidecarPool {
    inner: Arc<Inner>,
}

impl SidecarPool {
    pub(crate) fn new(ctx: CtxRef, max: usize) -> Self {
        Self {
            inner: Arc::new(Inner {
                ctx,
                max,
                state: Mutex::new(PoolState::default()),
                listeners: Mutex::new(Vec::new()),
                health_check: AtomicBool::new(false),
            }),
        }
    }

    fn ctx(&self) -> Option<Arc<AppCtx>> {
        self.inner.ctx.upgrade()
    }

    /// Run `change` on the state, send what it queued while still holding the
    /// lock, then dispose released sidecars and notify layout listeners.
    fn with_state<R>(&self, change: impl FnOnce(&mut PoolState, &mut Outbox) -> R) -> R {
        let ctx = self.ctx();
        let mut out = Outbox::default();
        let (result, layouts) = {
            let mut state = lock(&self.inner.state);
            let result = change(&mut state, &mut out);
            if let Some(ctx) = &ctx {
                for (win_id, channel, payload) in out.sends.drain(..) {
                    ctx.bridge.emit_to_window(win_id, channel, payload);
                }
            }
            let layouts: Vec<(WindowId, Option<PersistedTabLayout>)> = out
                .notify
                .iter()
                .filter(|win_id| !state.restoring_windows.contains(win_id))
                .map(|win_id| (*win_id, state.tab_layout_for_window(*win_id)))
                .collect();
            (result, layouts)
        };
        for disposal in out.disposals {
            spawn_task(disposal);
        }
        if !layouts.is_empty() {
            let listeners = lock(&self.inner.listeners).clone();
            for (win_id, layout) in layouts {
                for listener in &listeners {
                    listener(win_id, layout.clone());
                }
            }
        }
        result
    }

    fn read<R>(&self, read: impl FnOnce(&PoolState) -> R) -> R {
        read(&lock(&self.inner.state))
    }

    pub(crate) fn enable_health_check(&self) {
        self.inner.health_check.store(true, Ordering::SeqCst);
    }

    pub(crate) fn on_window_tabs_changed(&self, listener: WindowTabsChangedListener) {
        lock(&self.inner.listeners).push(Arc::from(listener));
    }

    pub(crate) fn size(&self) -> usize {
        self.read(|state| state.entries.len() + state.reserved)
    }

    /// The single source of truth for the cap.
    pub(crate) fn at_cap(&self) -> bool {
        self.size() >= self.inner.max
    }

    /// Bind a new tab (and its sidecar) to `options.win_id`; the tab id, or
    /// `None` at the cap. The first tab of a window becomes its active tab;
    /// later tabs start in the background. `defer_start` creates the tab without
    /// spawning its process and without claiming the active slot: a sidecar
    /// holds ~200 MB, so a restored layout pays only for the tabs it shows.
    pub(crate) fn acquire(&self, options: AcquireOptions) -> Option<String> {
        {
            let mut state = lock(&self.inner.state);
            if state.entries.len() + state.reserved >= self.inner.max {
                return None;
            }
            state.reserved += 1;
        }
        // The reservation is given back exactly once: on success the slot becomes
        // the live entry; on failure the pool never held it.
        let reservation = Reservation { pool: self };
        let ctx = self.ctx()?;
        let binary_path = paths::resolve_bundled_omp().unwrap_or_default();
        let (sidecar, events) = ctx.omp.new_sidecar(SidecarOptions {
            binary_path,
            cwd: options.cwd.clone(),
            extra_flags: Vec::new(),
            packaged: !tauri::is_dev(),
            fresh: options.fresh,
            kind: options.kind,
            resume_session_path: options.session_path.clone(),
        });
        drop(ctx);
        let tab_id = options.tab_id.clone().unwrap_or_else(next_snowflake);
        let key = self.with_state(|state, out| {
            reservation.release(state);
            let key = state.next_key;
            state.next_key += 1;
            let status = sidecar.status();
            state.entries.push(Entry {
                key,
                sidecar: sidecar.clone(),
                tab_id: tab_id.clone(),
                win_id: options.win_id,
                kind: options.kind,
                placeholder: options.placeholder,
                worktree: options.worktree.clone(),
                status,
                running: false,
                compacting: None,
                session_id: None,
                title: options.title.clone().filter(|title| !title.is_empty()).map(Some),
                session_file: None,
                full_wired: false,
                started: false,
                user_execs: 0,
            });
            state.by_tab_id.insert(tab_id.clone(), key);
            let index = state.entries.len() - 1;
            // A spawn with a session path attaches immediately, and a deferred tab
            // owns its file the moment it exists: register before any duplicate
            // attach can slip past the guard.
            if let Some(session_path) = options.session_path.as_deref().filter(|path| !path.is_empty()) {
                state.register_session_file(index, session_path);
            }
            if !options.defer_start && !state.active_by_window.contains_key(&options.win_id) {
                state.active_by_window.insert(options.win_id, tab_id.clone());
                state.visible_by_window.insert(options.win_id, vec![tab_id.clone()]);
                state.sync_full_wiring(options.win_id);
            }
            if !options.defer_start {
                if let Some(index) = state.index_of_key(key) {
                    state.entries[index].ensure_started();
                }
            }
            out.notify.push(options.win_id);
            key
        });
        self.drain_events(key, events);
        Some(tab_id)
    }

    /// Feed one sidecar's events into the pool until the stream ends or its tab is released.
    fn drain_events(&self, key: u64, mut events: SidecarEvents) {
        let pool: Weak<Inner> = Arc::downgrade(&self.inner);
        spawn_task(async move {
            while let Some(event) = events.recv().await {
                let Some(inner) = pool.upgrade() else { break };
                if !(SidecarPool { inner }).handle_event(key, event) {
                    break;
                }
            }
        });
    }

    /// False when the entry is gone (released), which ends its drain task.
    fn handle_event(&self, key: u64, event: SidecarEvent) -> bool {
        if let SidecarEvent::HostToolCall(request) = event {
            return self.host_tool_call(key, request);
        }
        let ready = matches!(&event, SidecarEvent::Status(payload) if payload.status == SidecarStatus::Ready);
        let sidecar = self.with_state(|state, out| {
            let index = state.index_of_key(key)?;
            let sidecar = state.entries[index].sidecar.clone();
            state.apply_event(index, event, out);
            Some(sidecar)
        });
        let Some(sidecar) = sidecar else { return false };
        if ready && self.inner.health_check.load(Ordering::SeqCst) {
            health_check(sidecar);
        }
        true
    }

    /// A GUI host tool is answered here; any other tool goes to the owning
    /// window's renderer, with its request id recorded for the response route.
    fn host_tool_call(&self, key: u64, request: Value) -> bool {
        let target = self.read(|state| {
            let entry = &state.entries[state.index_of_key(key)?];
            Some(entry.full_wired.then(|| (entry.win_id, entry.sidecar.clone())))
        });
        let Some(target) = target else { return false };
        let Some((win_id, sidecar)) = target else { return true };
        let Some(ctx) = self.ctx() else { return true };
        let name = request.get("toolName").and_then(Value::as_str).unwrap_or_default();
        let arguments = request.get("arguments").cloned().unwrap_or_else(|| json!({}));
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        match ctx.services.execute_host_tool(Caller::main(win_id), name, arguments) {
            Some(result) => spawn_task(async move {
                let result = match result.await {
                    Ok(value) => value,
                    // Only the clipboard read can fail (`ipc.ts:388-395`).
                    Err(error) => Value::String(format!("Clipboard read failed: {error}")),
                };
                sidecar.send_side_channel(json!({ "type": "host_tool_result", "id": id, "result": result }));
            }),
            None => {
                drop(ctx);
                self.with_state(|state, out| {
                    if state.index_of_key(key).is_none() {
                        return;
                    }
                    if let Some(id) = id.as_str() {
                        state.request_owners.insert(id.to_string(), key);
                    }
                    out.send(win_id, CHANNEL_HOST_TOOL_CALL, json!({ "request": request }));
                });
            }
        }
        true
    }

    pub(crate) fn sidecar_for_window(&self, win_id: WindowId) -> Option<Arc<dyn SidecarHandle>> {
        self.read(|state| state.entry_for_window(win_id).map(|entry| entry.sidecar.clone()))
    }

    pub(crate) fn sidecar_for_tab(&self, win_id: WindowId, tab_id: &str) -> Option<Arc<dyn SidecarHandle>> {
        self.read(|state| state.entry_for_tab(tab_id).filter(|entry| entry.win_id == win_id).map(|entry| entry.sidecar.clone()))
    }

    pub(crate) fn active_tab_for_window(&self, win_id: WindowId) -> Option<String> {
        self.read(|state| state.active_by_window.get(&win_id).cloned())
    }

    /// Send `command` to the idle, ready tab attached to `session_path`. The
    /// command is queued on that sidecar's stdin before this returns. A delivery
    /// failure resolves as a failed response carrying the error, so the caller
    /// reports it the way the TS rejection did.
    pub(crate) fn command_for_idle_session(&self, session_path: &str, command: Value) -> BoxFuture<'static, Option<Value>> {
        let sidecar = self.read(|state| {
            let owner = state.session_owners.get(session_path)?;
            let entry = state.entry_for_tab(&owner.tab_id)?;
            if entry.in_flight() || entry.sidecar.status() != SidecarStatus::Ready {
                return None;
            }
            Some(entry.sidecar.clone())
        });
        let Some(sidecar) = sidecar.filter(|sidecar| sidecar.has_rpc_client()) else {
            return Box::pin(std::future::ready(None));
        };
        let command_type = command.get("type").cloned().unwrap_or(Value::Null);
        let response = sidecar.request(command, None);
        Box::pin(async move {
            match response.await {
                Ok(response) => Some(response),
                Err(error) => Some(json!({ "type": "response", "command": command_type, "success": false, "error": error.to_string() })),
            }
        })
    }

    pub(crate) fn set_active_tab(&self, win_id: WindowId, tab_id: &str) -> bool {
        self.set_tab_view(win_id, tab_id, &[tab_id.to_string()], None)
    }

    /// Focus one tab and wire the full streams of one or two visible tabs, atomically.
    pub(crate) fn set_tab_view(&self, win_id: WindowId, focused_tab_id: &str, visible_tab_ids: &[String], split: Option<IpcTabViewSplit>) -> bool {
        let mut ids: Vec<String> = Vec::new();
        for tab_id in visible_tab_ids {
            if !ids.contains(tab_id) {
                ids.push(tab_id.clone());
            }
        }
        if ids.is_empty() || ids.len() > 2 || !ids.iter().any(|id| id == focused_tab_id) {
            return false;
        }
        if let Some(split) = &split {
            if ids.len() != 2
                || !ids.contains(&split.first_tab_id)
                || !ids.contains(&split.second_tab_id)
                || split.first_tab_id == split.second_tab_id
                || !split.ratio.is_finite()
            {
                return false;
            }
        }
        self.with_state(|state, out| {
            if !ids.iter().all(|tab_id| state.entry_for_tab(tab_id).is_some_and(|entry| entry.win_id == win_id)) {
                return false;
            }
            state.active_by_window.insert(win_id, focused_tab_id.to_string());
            state.visible_by_window.insert(win_id, ids);
            match split {
                Some(split) => {
                    let ratio = split.ratio.clamp(SPLIT_RATIO_MIN, SPLIT_RATIO_MAX);
                    state.split_by_window.insert(win_id, IpcTabViewSplit { ratio, ..split });
                }
                None => {
                    state.split_by_window.remove(&win_id);
                }
            }
            state.sync_full_wiring(win_id);
            out.notify.push(win_id);
            true
        })
    }

    /// Release one tab's sidecar; false when the tab is unknown.
    pub(crate) fn release_tab(&self, tab_id: &str) -> bool {
        self.with_state(|state, out| {
            let Some(index) = state.index_of_tab(tab_id) else { return false };
            let win_id = state.entries[index].win_id;
            state.release_entry(index, false, out);
            out.notify.push(win_id);
            true
        })
    }

    /// Release every tab of a closed window.
    pub(crate) fn release_window(&self, win_id: WindowId) {
        self.with_state(|state, out| {
            while let Some(index) = state.entries.iter().position(|entry| entry.win_id == win_id) {
                state.release_entry(index, true, out);
            }
        });
    }

    pub(crate) fn session_owner(&self, session_path: &str) -> Option<IpcSessionOwner> {
        self.read(|state| state.session_owners.get(session_path).cloned())
    }

    /// Whether the owner of `session_path` has a process holding the session in
    /// memory. `asleep`, `exited` and `error` have none, so the file on disk is
    /// the whole session; `starting` counts, because that spawn is about to read it.
    pub(crate) fn session_owner_is_live(&self, session_path: &str) -> bool {
        self.read(|state| {
            let Some(entry) = state.session_owners.get(session_path).and_then(|owner| state.entry_for_tab(&owner.tab_id)) else {
                return false;
            };
            !matches!(entry.sidecar.status(), SidecarStatus::Asleep | SidecarStatus::Exited | SidecarStatus::Error)
        })
    }

    /// The owner blocking `tab_id`'s attach to `session_path`: the current owner
    /// when it is another tab. An untracked issuer is blocked by any owner.
    pub(crate) fn foreign_session_owner(&self, tab_id: Option<&str>, session_path: &str) -> Option<IpcSessionOwner> {
        self.read(|state| state.session_owners.get(session_path).filter(|owner| Some(owner.tab_id.as_str()) != tab_id).cloned())
    }

    /// Record the session file a tab is attached to (from `switch_session` and
    /// `get_state` responses); `None` unregisters (a fresh unsaved session).
    pub(crate) fn note_session_file(&self, tab_id: &str, session_file: Option<&str>) {
        self.with_state(|state, out| {
            let Some(index) = state.index_of_tab(tab_id) else { return };
            let previous = state.entries[index].session_file.clone();
            match session_file.filter(|file| !file.is_empty()) {
                Some(file) => state.register_session_file(index, file),
                None => state.unregister_session_file(index),
            }
            let entry = &state.entries[index];
            if entry.session_file != previous {
                out.send_tab_status(entry);
                out.notify.push(entry.win_id);
            }
        });
    }

    /// Re-root a tab to its live session's cwd (`switch_session` re-roots the
    /// agent with no event; `get_state` reports the new cwd). True when it changed.
    pub(crate) fn adopt_session_cwd(&self, tab_id: &str, cwd: &str) -> bool {
        if cwd.is_empty() {
            return false;
        }
        self.with_state(|state, out| {
            let Some(index) = state.index_of_tab(tab_id) else { return false };
            let entry = &state.entries[index];
            if !entry.sidecar.adopt_cwd(cwd) {
                return false;
            }
            out.send_tab_status(entry);
            out.notify.push(entry.win_id);
            true
        })
    }

    /// Route a renderer response to the sidecar that raised request `id`.
    /// `is_final` consumes the route (a host tool update keeps it for the result).
    pub(crate) fn route_side_channel(&self, id: &str, frame: Value, is_final: bool) -> bool {
        let sidecar = {
            let mut state = lock(&self.inner.state);
            let Some(key) = state.request_owners.get(id).copied() else { return false };
            let Some(index) = state.index_of_key(key) else {
                state.request_owners.remove(id);
                return false;
            };
            if is_final {
                state.request_owners.remove(id);
            }
            state.entries[index].sidecar.clone()
        };
        sidecar.send_side_channel(frame);
        true
    }

    /// The window's tabs in acquisition order (`tab:get-all` boot reconciliation).
    pub(crate) fn tabs_for_window(&self, win_id: WindowId) -> Vec<IpcTabInfo> {
        self.read(|state| state.tabs_for_window(win_id))
    }

    /// What every live tab is doing: the quit guard's inventory. A tab counts
    /// as working during an agent run or compaction, and also while a user
    /// `bash` or `eval` command it issued is running. Those commands emit no
    /// agent events, so the agent run state alone would let a quit kill them
    /// unasked; `sidecar-pool.ts` reports only the agent run state.
    pub(crate) fn tab_inventory(&self) -> Vec<WindowTabFact> {
        self.read(|state| {
            state
                .entries
                .iter()
                .map(|entry| WindowTabFact { window_id: entry.win_id, tab_id: entry.tab_id.clone(), in_flight: entry.working() })
                .collect()
        })
    }

    /// Count a user `bash` or `eval` request of `tab_id` as running work until
    /// the returned guard drops; `None` when the tab is unknown. Take it before
    /// the request is sent and hold it until its response settles.
    pub(crate) fn begin_user_exec(&self, tab_id: &str) -> Option<UserExecGuard> {
        let mut state = lock(&self.inner.state);
        let index = state.index_of_tab(tab_id)?;
        let entry = &mut state.entries[index];
        entry.user_execs += 1;
        Some(UserExecGuard { pool: Arc::downgrade(&self.inner), key: entry.key })
    }

    pub(crate) fn tab_layout_for_window(&self, win_id: WindowId) -> Option<PersistedTabLayout> {
        self.read(|state| state.tab_layout_for_window(win_id))
    }

    /// Recreate saved tabs with fresh ids, then restore the active tab and split.
    /// Every tab is acquired deferred: only the panes the view shows get a process.
    pub(crate) fn restore_layout(&self, win_id: WindowId, layout: PersistedTabLayout) -> usize {
        lock(&self.inner.state).restoring_windows.insert(win_id);
        let mut restored = 0;
        let mut restored_tab_ids: Vec<Option<String>> = vec![None; layout.tabs.len()];
        let mut first_restored: Option<String> = None;
        let mut active_restored: Option<String> = None;
        for (index, tab) in layout.tabs.iter().enumerate() {
            let options = AcquireOptions {
                cwd: tab.cwd.clone(),
                win_id,
                tab_id: Some(next_snowflake()),
                session_path: tab.session_path.clone(),
                kind: tab.kind,
                worktree: tab.worktree.clone(),
                fresh: tab.session_path.is_none(),
                placeholder: tab.placeholder == Some(true),
                defer_start: true,
                title: tab.title.clone(),
            };
            let Some(tab_id) = self.acquire(options) else { continue };
            restored += 1;
            if first_restored.is_none() {
                first_restored = Some(tab_id.clone());
            }
            if index == layout.active_index {
                active_restored = Some(tab_id.clone());
            }
            restored_tab_ids[index] = Some(tab_id);
        }
        if let Some(active) = active_restored.or(first_restored) {
            let pane = |index: usize| restored_tab_ids.get(index).cloned().flatten();
            let panes = layout.split.as_ref().and_then(|split| Some((split, pane(split.first_index)?, pane(split.second_index)?)));
            // Routing the view is what spawns the shown tabs, so a split whose
            // panes were dropped still falls back to one visible tab.
            match panes {
                Some((split, first, second)) => {
                    let view = IpcTabViewSplit { axis: split.axis, first_tab_id: first.clone(), second_tab_id: second.clone(), ratio: split.ratio };
                    self.set_tab_view(win_id, &active, &[first, second], Some(view));
                }
                None => {
                    self.set_active_tab(win_id, &active);
                }
            }
        }
        self.with_state(|state, out| {
            state.restoring_windows.remove(&win_id);
            out.notify.push(win_id);
        });
        restored
    }

    /// Stop every sidecar in parallel and clear the pool; the future resolves
    /// once every supervisor has exited. Each stop is initiated before this returns.
    pub(crate) fn dispose_all(&self) -> BoxFuture<'static, ()> {
        let disposals: Vec<BoxFuture<'static, ()>> = {
            let mut state = lock(&self.inner.state);
            let entries = std::mem::take(&mut state.entries);
            *state = PoolState { next_key: state.next_key, ..PoolState::default() };
            entries.into_iter().map(|entry| entry.sidecar.dispose()).collect()
        };
        Box::pin(async move {
            futures_util::future::join_all(disposals).await;
        })
    }

    #[cfg(test)]
    fn wiring(&self, tab_id: &str) -> usize {
        // TS counted "events" listeners: the light wiring is always on, full wiring adds one.
        self.read(|state| state.entry_for_tab(tab_id).map_or(0, |entry| 1 + usize::from(entry.full_wired)))
    }
}

/// One in-flight user `bash` or `eval` request. Dropping it (response, delivery
/// error, timeout or a cancelled reply) gives the count back exactly once. A
/// released tab or a disposed pool has nothing left to decrement, and the entry
/// key is never reused, so a later tab with the same id is not affected.
pub(crate) struct UserExecGuard {
    pool: Weak<Inner>,
    key: u64,
}

impl Drop for UserExecGuard {
    fn drop(&mut self) {
        let Some(inner) = self.pool.upgrade() else { return };
        let mut state = lock(&inner.state);
        if let Some(index) = state.index_of_key(self.key) {
            let entry = &mut state.entries[index];
            entry.user_execs = entry.user_execs.saturating_sub(1);
        }
    }
}

/// Gives a cap reservation back exactly once, including when acquire bails out early.
struct Reservation<'a> {
    pool: &'a SidecarPool,
}

impl Reservation<'_> {
    fn release(self, state: &mut PoolState) {
        state.reserved = state.reserved.saturating_sub(1);
        std::mem::forget(self);
    }
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        let mut state = lock(&self.pool.inner.state);
        state.reserved = state.reserved.saturating_sub(1);
    }
}

/// Ask a sidecar that just reported ready for its state; a failure or timeout
/// marks it unhealthy so the manager restarts it (`index.ts:380-393`).
fn health_check(sidecar: Arc<dyn SidecarHandle>) {
    if !sidecar.has_rpc_client() {
        return;
    }
    let response = sidecar.request(json!({ "type": "get_state" }), None);
    spawn_task(async move {
        match response.await {
            Ok(response) => {
                if response.get("success").and_then(Value::as_bool) != Some(true) {
                    let error = response.get("error").and_then(Value::as_str).unwrap_or("unknown");
                    sidecar.mark_unhealthy(&format!("Health check failed: {error}"));
                }
            }
            Err(error) => sidecar.mark_unhealthy(&format!("Health check timed out: {error}")),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::Registry;
    use crate::ports::{SidecarError, TabsPort, WindowRecord};
    use crate::tabs::Tabs;
    use crate::testing::{fake_ctx_cyclic, FakeSidecar, Fakes, RecordingSink};

    struct Harness {
        fakes: Fakes,
        ctx: Arc<AppCtx>,
        sinks: Mutex<HashMap<WindowId, Arc<RecordingSink>>>,
    }

    fn harness() -> Harness {
        harness_with_max(10)
    }

    fn harness_with_max(max: usize) -> Harness {
        let fakes = Fakes::default();
        let ctx = fake_ctx_cyclic(&fakes, Registry::new(), |ctx, ports| ports.tabs = Some(Arc::new(Tabs::with_max(ctx.clone(), max))));
        Harness { fakes, ctx, sinks: Mutex::new(HashMap::new()) }
    }

    impl Harness {
        fn tabs(&self) -> &dyn TabsPort {
            &*self.ctx.tabs
        }

        fn pool(&self) -> &SidecarPool {
            &self.ctx.tabs.as_any().downcast_ref::<Tabs>().unwrap().pool
        }

        /// A chat window with a desktop record and an attached page that records what it receives.
        fn window(&self, n: u32) -> WindowId {
            let win_id = WindowId(n);
            self.fakes.desktop.add_record(WindowRecord { id: win_id, cwd: format!("/win-{n}"), pending_session_path: None });
            self.clear(win_id);
            win_id
        }

        /// Forget what the window received so far (the same page re-attaches with a fresh sink).
        fn clear(&self, win_id: WindowId) {
            let sink = Arc::new(RecordingSink::default());
            self.ctx.bridge.attach(&self.ctx, Caller::main(win_id), format!("gen-{win_id}"), sink.clone());
            lock(&self.sinks).insert(win_id, sink);
        }

        fn sent(&self, win_id: WindowId, channel: &str) -> Vec<Value> {
            let sink = lock(&self.sinks).get(&win_id).cloned().unwrap();
            sink.sent().into_iter().filter(|envelope| envelope.channel == channel).map(|envelope| envelope.payload).collect()
        }

        fn acquire(&self, cwd: &str, win_id: WindowId, tab_id: &str) -> Option<String> {
            self.tabs().acquire(AcquireOptions { tab_id: Some(tab_id.into()), ..AcquireOptions::new(cwd, win_id) })
        }

        fn acquire_with_session(&self, cwd: &str, win_id: WindowId, tab_id: &str, session_path: &str) -> Option<String> {
            self.tabs().acquire(AcquireOptions { tab_id: Some(tab_id.into()), session_path: Some(session_path.into()), ..AcquireOptions::new(cwd, win_id) })
        }

        fn sidecars(&self) -> Vec<Arc<FakeSidecar>> {
            self.fakes.omp.sidecars.lock().unwrap().clone()
        }

        fn sidecar(&self, index: usize) -> Arc<FakeSidecar> {
            self.sidecars()[index].clone()
        }

        fn tabs_json(&self, win_id: WindowId) -> Value {
            serde_json::to_value(self.tabs().tabs_for_window(win_id)).unwrap()
        }

        fn statuses(&self, win_id: WindowId) -> Vec<Value> {
            self.sent(win_id, CHANNEL_TAB_STATUS).into_iter().map(|payload| payload["status"].clone()).collect()
        }
    }

    /// Let every drain task process what was emitted (current-thread runtime).
    async fn settle() {
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
    }

    fn agent_events(sidecar: &FakeSidecar, types: &[&str]) {
        sidecar.emit(SidecarEvent::Events(types.iter().map(|kind| json!({ "type": kind })).collect()));
    }

    fn session_info(sidecar: &FakeSidecar, mut frame: Value) {
        frame["type"] = json!("session_info_update");
        sidecar.emit(SidecarEvent::SessionInfoUpdate(frame));
    }

    fn confirm_request(id: &str) -> Value {
        json!({ "type": "extension_ui_request", "id": id, "method": "confirm", "title": "Proceed?", "message": "ok?" })
    }

    fn host_tool_call(sidecar: &FakeSidecar, id: &str) {
        sidecar.emit(SidecarEvent::HostToolCall(
            json!({ "type": "host_tool_call", "id": id, "toolCallId": format!("call-{id}"), "toolName": "gui_tool", "arguments": {} }),
        ));
    }

    fn log_has(sidecar: &FakeSidecar, entry: &str) -> bool {
        sidecar.log.calls().iter().any(|call| call == entry)
    }

    fn started(sidecar: &FakeSidecar) -> bool {
        log_has(sidecar, "start()")
    }

    fn disposed(sidecar: &FakeSidecar) -> bool {
        log_has(sidecar, "dispose()")
    }

    fn restarts(sidecar: &FakeSidecar) -> Vec<String> {
        sidecar.log.calls().into_iter().filter(|call| call.starts_with("restart(")).collect()
    }

    /// The real manager reports `starting` as soon as the pool starts it; the fake does not, so emulate it.
    fn report_starting(sidecar: &FakeSidecar) {
        assert!(started(sidecar) || !restarts(sidecar).is_empty(), "the pool never started this sidecar");
        sidecar.set_status(SidecarStatus::Starting);
    }

    fn same(handle: &Arc<dyn SidecarHandle>, fake: &Arc<FakeSidecar>) -> bool {
        std::ptr::eq(Arc::as_ptr(handle) as *const (), Arc::as_ptr(fake) as *const ())
    }

    fn layout(value: Value) -> PersistedTabLayout {
        serde_json::from_value(value).unwrap()
    }

    fn tab_status(tab_id: &str, cwd: &str, status: &str) -> Value {
        json!({ "kind": "agent", "tabId": tab_id, "cwd": cwd, "status": status, "placeholder": false, "sessionPath": null })
    }

    // -- session kind ---------------------------------------------------------

    #[tokio::test]
    async fn threads_the_spawn_kind_through_the_factory_into_tab_status_payloads() {
        let h = harness();
        let win = h.window(1);
        h.acquire("/a", win, "tab-agent");
        h.tabs().acquire(AcquireOptions { tab_id: Some("tab-chat".into()), kind: SessionKind::Chat, ..AcquireOptions::new("/b", win) });
        // acquire defaults the kind to agent: the factory always sees a defined value.
        let kinds: Vec<SessionKind> = h.sidecars().iter().map(|sidecar| sidecar.options.kind).collect();
        assert_eq!(kinds, [SessionKind::Agent, SessionKind::Chat]);

        settle().await;
        h.clear(win);
        h.sidecar(1).set_status(SidecarStatus::Ready);
        settle().await;
        assert_eq!(
            h.sent(win, CHANNEL_TAB_STATUS),
            [json!({ "kind": "chat", "tabId": "tab-chat", "cwd": "/b", "status": "ready", "placeholder": false, "sessionPath": null })]
        );

        // tab:get-all exposes the immutable kind for every tab.
        let kinds: Vec<SessionKind> = h.tabs().tabs_for_window(win).iter().map(|tab| tab.kind).collect();
        assert_eq!(kinds, [SessionKind::Agent, SessionKind::Chat]);
    }

    // -- tabs -----------------------------------------------------------------

    #[tokio::test]
    async fn binds_two_tabs_to_one_window_the_first_is_active() {
        let h = harness();
        let win = h.window(1);
        assert_eq!(h.acquire("/a", win, "tab-a").as_deref(), Some("tab-a"));
        assert_eq!(h.acquire("/b", win, "tab-b").as_deref(), Some("tab-b"));

        assert_eq!(h.tabs().size(), 2);
        assert_eq!(h.sidecars().iter().map(|sidecar| started(sidecar)).collect::<Vec<_>>(), [true, true]);
        assert!(same(&h.tabs().sidecar_for_window(win).unwrap(), &h.sidecar(0)));
        assert!(same(&h.tabs().sidecar_for_tab(win, "tab-b").unwrap(), &h.sidecar(1)));
        assert!(h.tabs().sidecar_for_tab(win, "nope").is_none());
        assert_eq!(h.tabs().active_tab_for_window(win).as_deref(), Some("tab-a"));
        assert_eq!(
            h.tabs_json(win),
            json!([
                { "kind": "agent", "tabId": "tab-a", "cwd": "/a", "status": "starting", "active": true, "visible": true, "placeholder": false, "sessionPath": null },
                { "kind": "agent", "tabId": "tab-b", "cwd": "/b", "status": "starting", "placeholder": false, "sessionPath": null },
            ])
        );
    }

    #[tokio::test]
    async fn mints_a_snowflake_tabid_when_none_is_given() {
        let h = harness();
        let win = h.window(1);
        let minted = h.tabs().acquire(AcquireOptions::new("/a", win)).unwrap();
        let tabs = h.tabs().tabs_for_window(win);
        assert_eq!(tabs[0].tab_id, minted);
        assert_eq!(minted.len(), 16);
        assert!(minted.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)), "{minted}");
    }

    #[tokio::test]
    async fn resumes_a_session_on_first_start_when_sessionpath_is_given() {
        let h = harness();
        let win = h.window(1);
        assert!(h.acquire_with_session("/a", win, "tab-a", "/sessions/s.jsonl").is_some());
        let sidecar = h.sidecar(0);
        assert!(!started(&sidecar));
        assert_eq!(restarts(&sidecar), [r#"restart(None, Some("/sessions/s.jsonl"))"#]);
        assert_eq!(sidecar.options.resume_session_path.as_deref(), Some("/sessions/s.jsonl"));
        assert_eq!(h.tabs().tabs_for_window(win)[0].session_path, Some(Some("/sessions/s.jsonl".into())));
    }

    #[tokio::test]
    async fn forwards_full_channels_only_from_the_active_tab_tab_status_from_every_tab() {
        let h = harness();
        let win = h.window(1);
        h.acquire("/a", win, "tab-a");
        h.acquire("/b", win, "tab-b");
        let (a, b) = (h.sidecar(0), h.sidecar(1));
        settle().await;
        h.clear(win);

        agent_events(&a, &["agent_start"]);
        settle().await;
        agent_events(&b, &["agent_start"]);
        settle().await;
        // Only the active tab's batch reaches the full channel…
        assert_eq!(h.sent(win, CHANNEL_EVENTS), [json!({ "tabId": "tab-a", "payload": [{ "type": "agent_start" }] })]);
        // …but both tabs pushed tab:status for their running transition.
        assert_eq!(h.sent(win, CHANNEL_TAB_STATUS), [tab_status("tab-a", "/a", "starting"), tab_status("tab-b", "/b", "starting")]);

        // Connection status is forwarded on the full channel for the active tab only.
        a.set_status(SidecarStatus::Ready);
        b.set_status(SidecarStatus::Ready);
        settle().await;
        assert_eq!(h.sent(win, CHANNEL_SIDECAR_STATUS).len(), 1);
        assert_eq!(h.sent(win, CHANNEL_TAB_STATUS).len(), 4);

        // The background sidecar emits nothing on the remaining full channels.
        b.emit(SidecarEvent::SubagentFrame(json!({ "type": "subagent_lifecycle" })));
        b.emit(SidecarEvent::PromptResult(json!({ "type": "prompt_result" })));
        settle().await;
        assert!(h.sent(win, CHANNEL_SUBAGENT_FRAME).is_empty());
        assert!(h.sent(win, CHANNEL_PROMPT_RESULT).is_empty());
        a.emit(SidecarEvent::PromptResult(json!({ "type": "prompt_result" })));
        settle().await;
        assert_eq!(h.sent(win, CHANNEL_PROMPT_RESULT), [json!({ "tabId": "tab-a", "payload": { "type": "prompt_result" } })]);
    }

    #[tokio::test]
    async fn synthesizes_running_ready_per_tab_from_the_agent_event_stream() {
        let h = harness();
        let win = h.window(1);
        h.acquire("/a", win, "tab-a");
        h.acquire("/b", win, "tab-b");
        let (a, b) = (h.sidecar(0), h.sidecar(1));
        a.set_status(SidecarStatus::Ready);
        b.set_status(SidecarStatus::Ready);
        settle().await;
        h.clear(win);

        // A background tab starts a run: tab:status reports running without any full-channel leak.
        agent_events(&b, &["agent_start"]);
        settle().await;
        assert!(h.sent(win, CHANNEL_EVENTS).is_empty());
        assert_eq!(h.sent(win, CHANNEL_TAB_STATUS), [tab_status("tab-b", "/b", "running")]);
        assert_eq!(
            h.tabs_json(win),
            json!([
                { "kind": "agent", "tabId": "tab-a", "cwd": "/a", "status": "ready", "active": true, "visible": true, "placeholder": false, "sessionPath": null },
                { "kind": "agent", "tabId": "tab-b", "cwd": "/b", "status": "running", "placeholder": false, "sessionPath": null },
            ])
        );

        // The run settles → ready (the renderer's unread-done signal for background tabs).
        h.clear(win);
        agent_events(&b, &["agent_end"]);
        settle().await;
        assert_eq!(h.sent(win, CHANNEL_TAB_STATUS), [tab_status("tab-b", "/b", "ready")]);

        // A restart mid-run clears the flag: no stale "running" after recovery.
        h.clear(win);
        agent_events(&b, &["agent_start"]);
        b.set_status(SidecarStatus::Restarting);
        b.set_status(SidecarStatus::Ready);
        settle().await;
        assert_eq!(h.statuses(win), [json!("running"), json!("restarting"), json!("ready")]);
        assert_eq!(h.tabs().tabs_for_window(win)[1].status, TabStatus::Ready);
    }

    #[tokio::test]
    async fn re_wires_forwarding_on_switch_without_duplicating_listeners() {
        let h = harness();
        let win = h.window(1);
        h.acquire("/a", win, "tab-a");
        h.acquire("/b", win, "tab-b");
        let (a, b) = (h.sidecar(0), h.sidecar(1));
        // Light wiring (run tracking) is always on; full wiring adds one more.
        assert_eq!((h.pool().wiring("tab-a"), h.pool().wiring("tab-b")), (2, 1));

        assert!(h.tabs().set_active_tab(win, "tab-b"));
        assert_eq!((h.pool().wiring("tab-a"), h.pool().wiring("tab-b")), (1, 2));

        settle().await;
        h.clear(win);
        agent_events(&a, &["agent_start"]);
        agent_events(&b, &["agent_start"]);
        settle().await;
        assert_eq!(h.sent(win, CHANNEL_EVENTS).len(), 1);
        assert_eq!(h.sent(win, CHANNEL_TAB_STATUS).len(), 2);

        // Switching back re-arms A exactly once (one batch per emit, not two).
        assert!(h.tabs().set_active_tab(win, "tab-a"));
        assert_eq!((h.pool().wiring("tab-a"), h.pool().wiring("tab-b")), (2, 1));
        h.clear(win);
        agent_events(&a, &["agent_end"]);
        settle().await;
        assert_eq!(h.sent(win, CHANNEL_EVENTS).len(), 1);

        // Re-setting the already-active tab is a no-op.
        assert!(h.tabs().set_active_tab(win, "tab-a"));
        assert_eq!(h.pool().wiring("tab-a"), 2);
        // Foreign and unknown tabs are refused.
        assert!(!h.tabs().set_active_tab(WindowId(2), "tab-a"));
        assert!(!h.tabs().set_active_tab(win, "nope"));
    }

    #[tokio::test]
    async fn forwards_exactly_two_visible_sessions_and_persists_their_split_geometry() {
        let h = harness();
        let win = h.window(1);
        h.acquire("/a", win, "tab-a");
        h.acquire("/b", win, "tab-b");
        h.acquire("/c", win, "tab-c");
        let (a, b, c) = (h.sidecar(0), h.sidecar(1), h.sidecar(2));

        let split = IpcTabViewSplit { axis: crate::ports::TabSplitAxis::Columns, first_tab_id: "tab-a".into(), second_tab_id: "tab-b".into(), ratio: 0.65 };
        assert!(h.tabs().set_tab_view(win, "tab-b", &["tab-a".into(), "tab-b".into()], Some(split)));
        assert_eq!([h.pool().wiring("tab-a"), h.pool().wiring("tab-b"), h.pool().wiring("tab-c")], [2, 2, 1]);
        settle().await;
        h.clear(win);
        for sidecar in [&a, &b, &c] {
            agent_events(sidecar, &["agent_start"]);
            settle().await;
        }
        assert_eq!(
            h.sent(win, CHANNEL_EVENTS),
            [json!({ "tabId": "tab-a", "payload": [{ "type": "agent_start" }] }), json!({ "tabId": "tab-b", "payload": [{ "type": "agent_start" }] })]
        );
        let splits: Vec<Value> = h.tabs_json(win).as_array().unwrap().iter().filter(|tab| tab["visible"] == json!(true)).map(|tab| tab["split"].clone()).collect();
        assert_eq!(splits, [json!({ "axis": "columns", "index": 0, "ratio": 0.65 }), json!({ "axis": "columns", "index": 1, "ratio": 0.65 })]);
        assert_eq!(
            serde_json::to_value(h.tabs().tab_layout_for_window(win).unwrap().split).unwrap(),
            json!({ "axis": "columns", "firstIndex": 0, "secondIndex": 1, "ratio": 0.65 })
        );
        assert!(!h.tabs().set_tab_view(win, "tab-b", &["tab-a".into(), "tab-b".into(), "tab-c".into()], None));

        assert!(h.tabs().release_tab("tab-b"));
        assert_eq!(h.tabs().active_tab_for_window(win).as_deref(), Some("tab-a"));
        assert!(h.tabs().tab_layout_for_window(win).unwrap().split.is_none());
        assert_eq!((h.pool().wiring("tab-a"), h.pool().wiring("tab-c")), (2, 1));
    }

    #[tokio::test]
    async fn caches_session_meta_per_tab_and_includes_it_in_tab_status_and_get_tabs() {
        let h = harness();
        let win = h.window(1);
        h.acquire("/a", win, "tab-a");
        h.acquire("/b", win, "tab-b");
        let b = h.sidecar(1);
        settle().await;
        h.clear(win);

        session_info(&b, json!({ "title": "Fix flaky test", "sessionId": "sess-1" }));
        settle().await;
        let expected = json!({
            "kind": "agent", "tabId": "tab-b", "cwd": "/b", "status": "starting", "placeholder": false,
            "sessionPath": null, "sessionId": "sess-1", "title": "Fix flaky test",
        });
        // A background session-info pushes a light snapshot and caches it for later…
        assert_eq!(h.sent(win, CHANNEL_TAB_STATUS), std::slice::from_ref(&expected));
        // …with no full-channel forward from a background tab.
        assert!(h.sent(win, CHANNEL_SESSION_INFO_UPDATE).is_empty());
        assert_eq!(h.tabs_json(win)[1], expected);

        // Later status pushes keep carrying the cached meta.
        h.clear(win);
        b.set_status(SidecarStatus::Ready);
        settle().await;
        let mut ready = expected;
        ready["status"] = json!("ready");
        assert_eq!(h.sent(win, CHANNEL_TAB_STATUS), [ready]);
    }

    #[tokio::test]
    async fn spawns_only_the_tabs_a_restored_layout_shows_then_wakes_a_sleeping_tab_on_demand() {
        let h = harness();
        let win = h.window(1);
        h.tabs().restore_layout(
            win,
            layout(json!({
                "version": 1, "activeIndex": 2,
                "tabs": [{ "cwd": "/a", "kind": "agent", "sessionPath": "/sessions/a.jsonl" }, { "cwd": "/b", "kind": "agent" }, { "cwd": "/c", "kind": "agent" }],
            })),
        );

        // A sidecar holds ~200 MB, so a restored background tab is an entry, not a process, until it is rendered.
        assert_eq!(h.sidecars().iter().map(|sidecar| started(sidecar)).collect::<Vec<_>>(), [false, false, true]);
        assert!(restarts(&h.sidecar(0)).is_empty());
        let tabs = h.tabs().tabs_for_window(win);
        assert_eq!(tabs.iter().map(|tab| tab.status).collect::<Vec<_>>(), [TabStatus::Asleep, TabStatus::Asleep, TabStatus::Starting]);

        // Showing it spawns it, resuming the session its layout saved.
        settle().await;
        h.clear(win);
        assert!(h.tabs().set_active_tab(win, &tabs[0].tab_id));
        assert_eq!(restarts(&h.sidecar(0)), [r#"restart(None, Some("/sessions/a.jsonl"))"#]);
        report_starting(&h.sidecar(0));
        settle().await;
        assert_eq!(h.statuses(win), [json!("starting")]);

        // Hiding and re-showing it does not spawn a second process.
        h.tabs().set_active_tab(win, &tabs[1].tab_id);
        h.tabs().set_active_tab(win, &tabs[0].tab_id);
        assert_eq!(restarts(&h.sidecar(0)).len(), 1);
    }

    #[tokio::test]
    async fn labels_a_sleeping_tab_with_the_title_its_session_last_had() {
        let h = harness();
        let win = h.window(1);
        h.tabs().restore_layout(
            win,
            layout(json!({
                "version": 1, "activeIndex": 1,
                "tabs": [
                    { "cwd": "/a", "kind": "agent", "sessionPath": "/sessions/a.jsonl", "title": "Fix races" },
                    { "cwd": "/b", "kind": "agent", "title": "Audit report" },
                ],
            })),
        );

        // With the process deferred, the saved title is all the chip can show besides the folder name.
        let titles: Vec<Option<Option<String>>> = h.tabs().tabs_for_window(win).into_iter().map(|tab| tab.title).collect();
        assert_eq!(titles, [Some(Some("Fix races".into())), Some(Some("Audit report".into()))]);
        assert_eq!(
            serde_json::to_value(&h.tabs().tab_layout_for_window(win).unwrap().tabs[0]).unwrap(),
            json!({ "cwd": "/a", "kind": "agent", "sessionPath": "/sessions/a.jsonl", "title": "Fix races" })
        );
    }

    #[tokio::test]
    async fn restores_tab_order_sessions_kinds_and_the_persisted_active_tab() {
        let h = harness();
        let win = h.window(1);
        let saved = json!({
            "version": 1, "activeIndex": 1,
            "tabs": [{ "cwd": "/agent", "kind": "agent", "sessionPath": "/sessions/a.jsonl" }, { "cwd": "/chat", "kind": "chat" }],
            "split": { "axis": "rows", "firstIndex": 0, "secondIndex": 1, "ratio": 0.6 },
        });
        let restored = h.tabs().restore_layout(win, layout(saved.clone()));

        assert_eq!(restored, 2);
        let calls: Vec<(String, SessionKind, bool)> = h.sidecars().iter().map(|s| (s.options.cwd.clone(), s.options.kind, s.options.fresh)).collect();
        assert_eq!(calls, [("/agent".to_string(), SessionKind::Agent, false), ("/chat".to_string(), SessionKind::Chat, true)]);
        assert_eq!(restarts(&h.sidecar(0)), [r#"restart(None, Some("/sessions/a.jsonl"))"#]);
        assert!(started(&h.sidecar(1)));
        let tabs = h.tabs_json(win);
        let active: Vec<bool> = tabs.as_array().unwrap().iter().map(|tab| tab["active"] == json!(true)).collect();
        assert_eq!(active, [false, true]);
        let splits: Vec<Value> = tabs.as_array().unwrap().iter().map(|tab| tab["split"].clone()).collect();
        assert_eq!(splits, [json!({ "axis": "rows", "index": 0, "ratio": 0.6 }), json!({ "axis": "rows", "index": 1, "ratio": 0.6 })]);
        assert_eq!(serde_json::to_value(h.tabs().tab_layout_for_window(win)).unwrap(), saved);
    }

    #[tokio::test]
    async fn publishes_durable_layout_changes_after_tab_session_cwd_and_active_mutations() {
        let h = harness();
        let win = h.window(1);
        let snapshots: Arc<Mutex<Vec<Option<PersistedTabLayout>>>> = Arc::default();
        let sink = snapshots.clone();
        h.tabs().on_window_tabs_changed(Box::new(move |_, layout| lock(&sink).push(layout)));
        let last = || serde_json::to_value(lock(&snapshots).last().cloned().flatten()).unwrap();

        h.acquire_with_session("/a", win, "tab-a", "/sessions/a.jsonl");
        h.tabs().acquire(AcquireOptions { tab_id: Some("tab-b".into()), kind: SessionKind::Chat, ..AcquireOptions::new("/b", win) });
        h.tabs().set_active_tab(win, "tab-b");
        h.tabs().note_session_file("tab-b", Some("/sessions/b.jsonl"));
        h.tabs().adopt_session_cwd("tab-b", "/moved");

        assert_eq!(
            last(),
            json!({
                "version": 1, "activeIndex": 1,
                "tabs": [{ "cwd": "/a", "kind": "agent", "sessionPath": "/sessions/a.jsonl" }, { "cwd": "/moved", "kind": "chat", "sessionPath": "/sessions/b.jsonl" }],
            })
        );

        h.tabs().release_tab("tab-b");
        assert_eq!(last(), json!({ "version": 1, "activeIndex": 0, "tabs": [{ "cwd": "/a", "kind": "agent", "sessionPath": "/sessions/a.jsonl" }] }));
    }

    #[tokio::test]
    async fn marks_only_the_untargeted_startup_tab_as_disposable_and_clears_it_on_first_run() {
        let h = harness();
        let win = h.window(1);
        let snapshots: Arc<Mutex<Vec<Option<PersistedTabLayout>>>> = Arc::default();
        let sink = snapshots.clone();
        h.tabs().on_window_tabs_changed(Box::new(move |_, layout| lock(&sink).push(layout)));

        h.tabs().acquire(AcquireOptions {
            tab_id: Some("tab-idle".into()),
            kind: SessionKind::Chat,
            fresh: true,
            placeholder: true,
            ..AcquireOptions::new("/neutral", win)
        });
        let tab = &h.tabs().tabs_for_window(win)[0];
        assert_eq!((tab.tab_id.as_str(), tab.placeholder), ("tab-idle", Some(true)));
        assert_eq!(h.tabs().tab_layout_for_window(win).unwrap().tabs[0].placeholder, Some(true));

        agent_events(&h.sidecar(0), &["agent_start"]);
        settle().await;

        let tab = &h.tabs().tabs_for_window(win)[0];
        assert_eq!((tab.tab_id.as_str(), tab.placeholder), ("tab-idle", Some(false)));
        assert!(serde_json::to_value(&h.tabs().tab_layout_for_window(win).unwrap().tabs[0]).unwrap().get("placeholder").is_none());
        let last = lock(&snapshots).last().cloned().flatten().unwrap();
        assert!(last.tabs[0].placeholder.is_none());
    }

    #[tokio::test]
    async fn releases_a_tab_disposed_pool_shrinks_active_falls_back_to_a_sibling() {
        let h = harness();
        let win = h.window(1);
        h.acquire("/a", win, "tab-a");
        h.acquire("/b", win, "tab-b");
        let (a, b) = (h.sidecar(0), h.sidecar(1));

        // Closing the ACTIVE tab releases it and activates the remaining one.
        assert!(h.tabs().release_tab("tab-a"));
        assert!(disposed(&a));
        assert_eq!(h.tabs().size(), 1);
        assert!(same(&h.tabs().sidecar_for_window(win).unwrap(), &b));
        assert_eq!(h.tabs().active_tab_for_window(win).as_deref(), Some("tab-b"));
        assert_eq!(h.pool().wiring("tab-b"), 2);

        // An unknown tab is a no-op; closing the last tab leaves the window tab-less.
        assert!(!h.tabs().release_tab("tab-a"));
        assert!(h.tabs().release_tab("tab-b"));
        assert!(disposed(&b));
        assert_eq!(h.tabs().size(), 0);
        assert!(h.tabs().sidecar_for_window(win).is_none());
        assert!(h.tabs().active_tab_for_window(win).is_none());
        assert!(h.tabs().tabs_for_window(win).is_empty());
    }

    #[tokio::test]
    async fn counts_tabs_across_windows_against_the_cap() {
        let h = harness_with_max(2);
        let (first, second) = (h.window(1), h.window(2));
        assert!(h.acquire("/a", first, "tab-a").is_some());
        assert!(h.acquire("/b", first, "tab-b").is_some());
        assert!(h.tabs().at_cap());
        // A second window gets no slot either: the cap is pool-wide over tabs.
        assert!(h.acquire("/c", second, "tab-c").is_none());
        assert_eq!(h.tabs().size(), 2);
        assert_eq!(h.sidecars().len(), 2);

        h.tabs().release_tab("tab-b");
        assert!(!h.tabs().at_cap());
        assert!(h.acquire("/c", second, "tab-c").is_some());
    }

    #[tokio::test]
    async fn releases_every_tab_of_a_closed_window() {
        let h = harness();
        crate::tabs::install(&h.ctx);
        let (first, second) = (h.window(1), h.window(2));
        h.acquire("/a", first, "tab-a");
        h.acquire("/b", first, "tab-b");
        h.acquire("/c", second, "tab-c");

        h.fakes.desktop.close(first);
        assert_eq!(h.sidecars().iter().map(|sidecar| disposed(sidecar)).collect::<Vec<_>>(), [true, true, false]);
        assert_eq!(h.tabs().size(), 1);
        assert_eq!(h.tabs().active_tab_for_window(second).as_deref(), Some("tab-c"));
        assert!(same(&h.tabs().sidecar_for_window(second).unwrap(), &h.sidecar(2)));

        // Late events from the surviving window still forward normally.
        h.sidecar(2).set_status(SidecarStatus::Ready);
        settle().await;
        assert_eq!(h.sent(second, CHANNEL_SIDECAR_STATUS).len(), 1);
    }

    // -- session ownership ---------------------------------------------------

    #[tokio::test]
    async fn routes_session_mutations_only_to_an_idle_attached_tab() {
        let h = harness();
        let win = h.window(1);
        h.acquire_with_session("/a", win, "tab-a", "/sessions/s.jsonl");
        let sidecar = h.sidecar(0);
        sidecar.set_status(SidecarStatus::Ready);
        settle().await;

        let command = json!({ "type": "set_session_name", "name": "Renamed", "sessionPath": "/sessions/s.jsonl" });
        let response = h.tabs().command_for_idle_session("/sessions/s.jsonl", command.clone()).await;
        assert_eq!(response.and_then(|response| response["success"].as_bool()), Some(true));
        let requests: Vec<String> = sidecar.log.calls().into_iter().filter(|call| call.starts_with("request(")).collect();
        assert_eq!(requests, [format!("request({command}, None)")]);

        agent_events(&sidecar, &["agent_start"]);
        settle().await;
        assert!(h.tabs().command_for_idle_session("/sessions/s.jsonl", json!({ "type": "drop_session" })).await.is_none());
    }

    #[tokio::test]
    async fn blocks_session_mutations_while_automatic_compaction_is_in_flight() {
        let h = harness();
        let win = h.window(1);
        h.acquire_with_session("/a", win, "tab-a", "/sessions/s.jsonl");
        let sidecar = h.sidecar(0);
        sidecar.set_status(SidecarStatus::Ready);
        agent_events(&sidecar, &["auto_compaction_start"]);
        settle().await;

        assert_eq!(h.tabs().tabs_for_window(win)[0].compacting, Some(true));
        assert!(h.tabs().command_for_idle_session("/sessions/s.jsonl", json!({ "type": "drop_session" })).await.is_none());

        agent_events(&sidecar, &["auto_compaction_end"]);
        settle().await;
        assert_eq!(h.tabs().tabs_for_window(win)[0].compacting, Some(false));
        let response = h.tabs().command_for_idle_session("/sessions/s.jsonl", json!({ "type": "drop_session" })).await;
        assert_eq!(response.and_then(|response| response["success"].as_bool()), Some(true));
    }

    #[tokio::test]
    async fn reports_a_session_as_live_only_while_some_process_holds_it() {
        let h = harness();
        let win = h.window(1);
        h.tabs().restore_layout(
            win,
            layout(json!({
                "version": 1, "activeIndex": 1,
                "tabs": [{ "cwd": "/a", "kind": "agent", "sessionPath": "/sessions/s.jsonl" }, { "cwd": "/b", "kind": "agent" }],
            })),
        );
        let owner = h.tabs().session_owner("/sessions/s.jsonl").expect("the restored tab owns the session");
        let sidecar = h.sidecar(0);

        // Unowned paths are never live, and neither is an asleep owner: services
        // deletes or renames those on disk instead of asking a process that is not there.
        assert!(!h.tabs().session_owner_is_live("/sessions/other.jsonl"));
        assert!(!h.tabs().session_owner_is_live("/sessions/s.jsonl"));

        // Showing the tab spawns it, and a spawn in flight counts as live: it is about to read the file.
        assert!(h.tabs().set_active_tab(win, &owner.tab_id));
        report_starting(&sidecar);
        settle().await;
        assert_eq!(sidecar.status(), SidecarStatus::Starting);
        assert!(h.tabs().session_owner_is_live("/sessions/s.jsonl"));

        sidecar.set_status(SidecarStatus::Ready);
        assert!(h.tabs().session_owner_is_live("/sessions/s.jsonl"));
        sidecar.set_status(SidecarStatus::Restarting);
        assert!(h.tabs().session_owner_is_live("/sessions/s.jsonl"));

        // A dead process holds nothing.
        sidecar.set_status(SidecarStatus::Exited);
        assert!(!h.tabs().session_owner_is_live("/sessions/s.jsonl"));
        sidecar.set_status(SidecarStatus::Error);
        assert!(!h.tabs().session_owner_is_live("/sessions/s.jsonl"));
    }

    #[tokio::test]
    async fn registers_the_owner_at_acquire_with_sessionpath_and_unregisters_on_release() {
        let h = harness();
        let win = h.window(1);
        h.acquire_with_session("/a", win, "tab-a", "/sessions/s.jsonl");

        // A duplicate attach consults this: tab:spawn maps it to a refusal instead of acquiring.
        assert_eq!(h.tabs().session_owner("/sessions/s.jsonl"), Some(IpcSessionOwner { tab_id: "tab-a".into(), win_id: win }));
        assert_eq!(serde_json::to_value(h.tabs().session_owner("/sessions/s.jsonl")).unwrap(), json!({ "tabId": "tab-a", "winId": 1 }));
        assert!(h.tabs().session_owner("/sessions/other.jsonl").is_none());

        assert!(h.tabs().release_tab("tab-a"));
        assert!(h.tabs().session_owner("/sessions/s.jsonl").is_none());
    }

    #[tokio::test]
    async fn learns_the_file_from_notesessionfile_get_state_switch_session_reports() {
        let h = harness();
        let win = h.window(1);
        h.acquire("/a", win, "tab-a");
        assert!(h.tabs().session_owner("/sessions/s.jsonl").is_none());

        h.tabs().note_session_file("tab-a", Some("/sessions/s.jsonl"));
        let owner = Some(IpcSessionOwner { tab_id: "tab-a".into(), win_id: win });
        assert_eq!(h.tabs().session_owner("/sessions/s.jsonl"), owner);
        let pushed = h.sent(win, CHANNEL_TAB_STATUS).last().cloned().unwrap();
        assert_eq!((pushed["tabId"].clone(), pushed["sessionPath"].clone()), (json!("tab-a"), json!("/sessions/s.jsonl")));

        // A switch moves the entry: the old file is freed, the new one owned.
        h.tabs().note_session_file("tab-a", Some("/sessions/s2.jsonl"));
        assert!(h.tabs().session_owner("/sessions/s.jsonl").is_none());
        assert_eq!(h.tabs().session_owner("/sessions/s2.jsonl"), owner);

        // get_state with sessionFile null (a fresh unsaved session) unregisters.
        h.tabs().note_session_file("tab-a", None);
        assert!(h.tabs().session_owner("/sessions/s2.jsonl").is_none());
        let pushed = h.sent(win, CHANNEL_TAB_STATUS).last().cloned().unwrap();
        assert_eq!((pushed["tabId"].clone(), pushed["sessionPath"].clone()), (json!("tab-a"), Value::Null));

        // Unknown tabs are a no-op.
        h.tabs().note_session_file("nope", Some("/sessions/x.jsonl"));
        assert!(h.tabs().session_owner("/sessions/x.jsonl").is_none());
    }

    #[tokio::test]
    async fn keeps_the_acquire_time_registration_through_first_attach_but_drops_it_on_a_sessionid_change() {
        let h = harness();
        let win = h.window(1);
        h.acquire_with_session("/a", win, "tab-a", "/sessions/s.jsonl");
        let a = h.sidecar(0);
        let owner = Some(IpcSessionOwner { tab_id: "tab-a".into(), win_id: win });

        // First attach: the resumed session reports its id and the registration stays.
        session_info(&a, json!({ "sessionId": "sess-1", "title": "Resumed" }));
        settle().await;
        assert_eq!(h.tabs().session_owner("/sessions/s.jsonl"), owner);

        // Title-only updates do not touch ownership either.
        session_info(&a, json!({ "title": "Renamed" }));
        settle().await;
        assert!(h.tabs().session_owner("/sessions/s.jsonl").is_some());

        // The session under the tab changed: the cached file mapping is stale…
        session_info(&a, json!({ "sessionId": "sess-2" }));
        settle().await;
        assert!(h.tabs().session_owner("/sessions/s.jsonl").is_none());
        // …and the renderer's hydrate re-registers the file now attached.
        h.tabs().note_session_file("tab-a", Some("/sessions/s.jsonl"));
        assert_eq!(h.tabs().session_owner("/sessions/s.jsonl"), owner);
    }

    #[tokio::test]
    async fn only_the_current_owner_clears_a_mapping() {
        let h = harness();
        let win = h.window(1);
        h.acquire_with_session("/a", win, "tab-a", "/sessions/s.jsonl");
        h.acquire("/b", win, "tab-b");

        // Last writer wins if two tabs ever report the same file…
        h.tabs().note_session_file("tab-b", Some("/sessions/s.jsonl"));
        let owner = Some(IpcSessionOwner { tab_id: "tab-b".into(), win_id: win });
        assert_eq!(h.tabs().session_owner("/sessions/s.jsonl"), owner);

        // …so releasing the FORMER owner must not drop the new registration.
        assert!(h.tabs().release_tab("tab-a"));
        assert_eq!(h.tabs().session_owner("/sessions/s.jsonl"), owner);
    }

    #[tokio::test]
    async fn foreignsessionowner_blocks_only_foreign_attaches() {
        let h = harness();
        let win = h.window(1);
        h.acquire_with_session("/a", win, "tab-a", "/sessions/s.jsonl");
        h.acquire("/b", win, "tab-b");
        let owner = Some(IpcSessionOwner { tab_id: "tab-a".into(), win_id: win });

        // Another tab's switch_session is blocked, with the owner the refusal carries for routing.
        assert_eq!(h.tabs().foreign_session_owner(Some("tab-b"), "/sessions/s.jsonl"), owner);
        // The owner itself re-attaches freely.
        assert!(h.tabs().foreign_session_owner(Some("tab-a"), "/sessions/s.jsonl").is_none());
        // Unowned files are free.
        assert!(h.tabs().foreign_session_owner(Some("tab-b"), "/sessions/other.jsonl").is_none());
        // An untracked issuer is blocked by any owner: the safe direction.
        assert_eq!(h.tabs().foreign_session_owner(None, "/sessions/s.jsonl"), owner);
        // After release the mapping is gone and the path is free.
        assert!(h.tabs().release_tab("tab-a"));
        assert!(h.tabs().foreign_session_owner(Some("tab-b"), "/sessions/s.jsonl").is_none());
    }

    #[tokio::test]
    async fn unregisters_owners_when_a_window_closes() {
        let h = harness();
        crate::tabs::install(&h.ctx);
        let win = h.window(1);
        h.acquire_with_session("/a", win, "tab-a", "/sessions/s.jsonl");
        assert!(h.tabs().session_owner("/sessions/s.jsonl").is_some());
        h.fakes.desktop.close(win);
        assert!(h.tabs().session_owner("/sessions/s.jsonl").is_none());
    }

    // -- session cwd tracking --------------------------------------------------

    #[tokio::test]
    async fn adoptsessioncwd_re_roots_the_tab_and_pushes_the_live_cwd_over_tab_status() {
        let h = harness();
        let win = h.window(1);
        h.acquire("/spawn-a", win, "tab-a");
        settle().await;
        h.clear(win);

        // switch_session re-roots the agent silently; the get_state report moves the tab off its spawn cwd…
        assert!(h.tabs().adopt_session_cwd("tab-a", "/live-b"));
        assert_eq!(h.sidecar(0).cwd(), "/live-b");

        // …and the pushed tab:status carries the NEW cwd.
        let pushes = h.sent(win, CHANNEL_TAB_STATUS);
        assert_eq!(pushes.len(), 1);
        assert_eq!(pushes[0]["cwd"], json!("/live-b"));

        // Same cwd, unknown tab and empty cwd are no-ops (no push, no mutation).
        assert!(!h.tabs().adopt_session_cwd("tab-a", "/live-b"));
        assert!(!h.tabs().adopt_session_cwd("nope", "/elsewhere"));
        assert!(!h.tabs().adopt_session_cwd("tab-a", ""));
        assert_eq!(h.sidecar(0).cwd(), "/live-b");
        assert_eq!(h.sent(win, CHANNEL_TAB_STATUS).len(), 1);
    }

    // -- request-origin routing ------------------------------------------------

    #[tokio::test]
    async fn does_not_retain_fire_and_forget_extension_ui_updates() {
        let h = harness();
        let win = h.window(1);
        h.acquire("/a", win, "tab-a");

        h.sidecar(0).emit(SidecarEvent::ExtensionUi(
            json!({ "type": "extension_ui_request", "id": "update-1", "method": "set_editor_text", "text": "restore me", "prepend": true }),
        ));
        settle().await;
        assert_eq!(h.sent(win, CHANNEL_EXTENSION_UI).len(), 1);
        assert!(!h.tabs().route_side_channel("update-1", json!({ "type": "extension_ui_response", "id": "update-1" }), true));
    }

    #[tokio::test]
    async fn routes_an_extension_ui_response_to_the_raising_sidecar_even_after_a_tab_switch() {
        let h = harness();
        let win = h.window(1);
        h.acquire("/a", win, "tab-a");
        h.acquire("/b", win, "tab-b");
        let (a, b) = (h.sidecar(0), h.sidecar(1));

        // Tab A raises the request while active; the dialog is forwarded…
        a.emit(SidecarEvent::ExtensionUi(confirm_request("req-1")));
        settle().await;
        assert_eq!(h.sent(win, CHANNEL_EXTENSION_UI), [json!({ "tabId": "tab-a", "request": confirm_request("req-1") })]);

        // …the user switches to tab B, THEN the response arrives. It must reach A's sidecar.
        assert!(h.tabs().set_active_tab(win, "tab-b"));
        let response = json!({ "type": "extension_ui_response", "id": "req-1", "confirmed": true });
        assert!(h.tabs().route_side_channel("req-1", response.clone(), true));
        assert_eq!(*a.side_channel.lock().unwrap(), *std::slice::from_ref(&response));
        assert!(b.side_channel.lock().unwrap().is_empty());

        // Final responses consume the route: a repeated id falls back to the caller.
        assert!(!h.tabs().route_side_channel("req-1", response, true));
    }

    #[tokio::test]
    async fn routes_host_uri_results_to_the_origin_sidecar() {
        let h = harness();
        let win = h.window(1);
        h.acquire("/a", win, "tab-a");
        h.acquire("/b", win, "tab-b");
        let (a, b) = (h.sidecar(0), h.sidecar(1));

        let request = json!({ "type": "host_uri_request", "id": "uri-1", "operation": "read", "url": "https://example.com" });
        a.emit(SidecarEvent::HostUriRequest(request.clone()));
        settle().await;
        assert_eq!(h.sent(win, CHANNEL_HOST_URI_REQUEST), [json!({ "request": request })]);
        h.tabs().set_active_tab(win, "tab-b");

        let result = json!({ "type": "host_uri_result", "id": "uri-1", "content": "data" });
        assert!(h.tabs().route_side_channel("uri-1", result.clone(), true));
        assert_eq!(*a.side_channel.lock().unwrap(), [result]);
        assert!(b.side_channel.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn keeps_the_route_across_non_final_host_tool_updates_and_consumes_it_on_the_result() {
        let h = harness();
        let win = h.window(1);
        h.acquire("/a", win, "tab-a");
        h.acquire("/b", win, "tab-b");
        let (a, b) = (h.sidecar(0), h.sidecar(1));

        // Not a GUI tool (services answers None): the pool forwards it to the renderer.
        host_tool_call(&a, "tool-1");
        settle().await;
        let forwarded = h.sent(win, CHANNEL_HOST_TOOL_CALL);
        assert_eq!(forwarded.len(), 1);
        assert_eq!(forwarded[0]["request"]["id"], json!("tool-1"));
        assert!(h.fakes.services.log.calls().iter().any(|call| call.starts_with("execute_host_tool(1, gui_tool")));
        h.tabs().set_active_tab(win, "tab-b");

        let update = json!({ "type": "host_tool_update", "id": "tool-1", "update": "working…" });
        assert!(h.tabs().route_side_channel("tool-1", update.clone(), false));
        // Still registered: the result follows the update stream.
        let result = json!({ "type": "host_tool_result", "id": "tool-1", "result": "done" });
        assert!(h.tabs().route_side_channel("tool-1", result.clone(), true));
        assert_eq!(*a.side_channel.lock().unwrap(), [update, result.clone()]);
        assert!(b.side_channel.lock().unwrap().is_empty());
        assert!(!h.tabs().route_side_channel("tool-1", result, true));
    }

    #[tokio::test]
    async fn does_not_track_host_tools_answered_inline() {
        let h = harness();
        let win = h.window(1);
        h.acquire("/a", win, "tab-a");
        let a = h.sidecar(0);
        // A GUI-registered tool: answered on the spot, nothing reaches the renderer.
        h.fakes.services.host_tools.lock().unwrap().insert("gui_tool".into(), Ok(json!("inline")));

        host_tool_call(&a, "tool-inline");
        settle().await;
        assert_eq!(*a.side_channel.lock().unwrap(), [json!({ "type": "host_tool_result", "id": "tool-inline", "result": "inline" })]);
        assert!(h.sent(win, CHANNEL_HOST_TOOL_CALL).is_empty());
        assert!(!h.tabs().route_side_channel("tool-inline", json!({ "type": "host_tool_result", "id": "tool-inline" }), true));
    }

    #[tokio::test]
    async fn drops_pending_routes_when_the_owning_tab_is_released() {
        let h = harness();
        let win = h.window(1);
        h.acquire("/a", win, "tab-a");
        h.acquire("/b", win, "tab-b");
        let (a, b) = (h.sidecar(0), h.sidecar(1));

        a.emit(SidecarEvent::ExtensionUi(confirm_request("req-doomed")));
        settle().await;
        assert!(h.tabs().release_tab("tab-a"));
        // A late response falls back instead of writing to a disposed sidecar.
        assert!(!h.tabs().route_side_channel("req-doomed", json!({ "type": "extension_ui_response", "id": "req-doomed" }), true));
        assert!(a.side_channel.lock().unwrap().is_empty());
        assert!(b.side_channel.lock().unwrap().is_empty());
    }

    // -- quit inventory ----------------------------------------------------------

    #[tokio::test]
    async fn reports_every_live_tab_s_in_flight_run_across_windows_and_drops_released_tabs() {
        let h = harness();
        let (first, second) = (h.window(1), h.window(2));
        h.acquire("/a", first, "tab-a");
        h.acquire("/b", second, "tab-b");
        h.acquire("/c", second, "tab-c");
        let (a, b, c) = (h.sidecar(0), h.sidecar(1), h.sidecar(2));

        // Nothing running yet: the quit guard must not ask.
        assert_eq!(
            serde_json::to_value(h.tabs().tab_inventory()).unwrap(),
            json!([
                { "windowId": 1, "tabId": "tab-a", "inFlight": false },
                { "windowId": 2, "tabId": "tab-b", "inFlight": false },
                { "windowId": 2, "tabId": "tab-c", "inFlight": false },
            ])
        );

        // A background window's run counts the same as the active one's, and an automatic compaction is work too.
        agent_events(&a, &["agent_start"]);
        agent_events(&c, &["auto_compaction_start"]);
        settle().await;
        let in_flight: Vec<WindowTabFact> = h.tabs().tab_inventory().into_iter().filter(|fact| fact.in_flight).collect();
        assert_eq!(
            in_flight,
            [
                WindowTabFact { window_id: first, tab_id: "tab-a".into(), in_flight: true },
                WindowTabFact { window_id: second, tab_id: "tab-c".into(), in_flight: true },
            ]
        );

        // A closed tab leaves the inventory.
        agent_events(&b, &["agent_end"]);
        settle().await;
        assert!(h.tabs().release_tab("tab-b"));
        let ids: Vec<String> = h.tabs().tab_inventory().into_iter().map(|fact| fact.tab_id).collect();
        assert_eq!(ids, ["tab-a", "tab-c"]);
    }

    // -- factory, health check, shutdown -------------------------------------------

    #[tokio::test]
    async fn acquire_hands_the_manager_its_spawn_options() {
        let h = harness();
        let win = h.window(1);
        h.tabs().acquire(AcquireOptions { fresh: true, kind: SessionKind::Chat, ..AcquireOptions::new("/work", win) });
        let options = &h.sidecar(0).options;
        assert_eq!((options.cwd.as_str(), options.kind, options.fresh), ("/work", SessionKind::Chat, true));
        assert!(options.extra_flags.is_empty());
        assert_eq!(options.resume_session_path, None);
        // Never a system omp: the bundled binary, or an empty path the manager reports as missing.
        let expected = paths::resolve_bundled_omp().unwrap_or_default();
        assert_eq!(options.binary_path, expected);
    }

    #[tokio::test]
    async fn the_ready_health_check_marks_a_sidecar_unhealthy_when_get_state_fails() {
        let h = harness();
        crate::tabs::install(&h.ctx);
        let win = h.window(1);
        h.acquire("/a", win, "tab-a");
        let sidecar = h.sidecar(0);
        sidecar.responses.lock().unwrap().push(Ok(json!({ "type": "response", "success": false, "error": "no session" })));

        sidecar.set_status(SidecarStatus::Ready);
        settle().await;
        assert!(log_has(&sidecar, &format!("request({}, None)", json!({ "type": "get_state" }))));
        assert!(log_has(&sidecar, "mark_unhealthy(Health check failed: no session)"));
    }

    #[tokio::test]
    async fn the_ready_health_check_reports_a_timeout() {
        let h = harness();
        crate::tabs::install(&h.ctx);
        let win = h.window(1);
        h.acquire("/a", win, "tab-a");
        let sidecar = h.sidecar(0);
        sidecar.responses.lock().unwrap().push(Err(SidecarError::Timeout { timeout_ms: 8000, command_type: "get_state".into() }));

        sidecar.set_status(SidecarStatus::Ready);
        settle().await;
        assert!(log_has(&sidecar, "mark_unhealthy(Health check timed out: RPC timeout (8000ms): get_state)"));

        // A healthy answer marks nothing; without `init` there is no check at all.
        let quiet = harness();
        let win = quiet.window(1);
        quiet.acquire("/a", win, "tab-a");
        quiet.sidecar(0).set_status(SidecarStatus::Ready);
        settle().await;
        assert!(!quiet.sidecar(0).log.calls().iter().any(|call| call.starts_with("request(")));
    }

    #[tokio::test]
    async fn dispose_all_stops_every_sidecar_and_empties_the_pool() {
        let h = harness();
        let (first, second) = (h.window(1), h.window(2));
        h.acquire_with_session("/a", first, "tab-a", "/sessions/a.jsonl");
        h.acquire("/b", second, "tab-b");

        h.tabs().dispose_all().await;
        assert!(h.sidecars().iter().all(|sidecar| disposed(sidecar)));
        assert_eq!(h.tabs().size(), 0);
        assert!(h.tabs().tabs_for_window(first).is_empty());
        assert!(h.tabs().session_owner("/sessions/a.jsonl").is_none());
        // The pool still works afterwards.
        assert!(h.acquire("/c", first, "tab-c").is_some());
    }
}
