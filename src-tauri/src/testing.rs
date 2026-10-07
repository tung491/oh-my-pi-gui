//! Test fakes for every port and the host, plus `fake_ctx`, which builds an
//! `AppCtx` from them over temporary stores. Each fake records the calls it
//! receives and returns scripted values, so a module's tests never depend on
//! another module's code. Compiled only for tests.

use std::any::Any;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};

use futures_util::future::BoxFuture;
use serde_json::Value;

use crate::bridge::{Bridge, Envelope, OutboundSink, Registry};
use crate::ctx::AppCtx;
use crate::i18n::MainI18n;
use crate::ports::*;
use crate::prefs::JsonStore;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A page channel that keeps what it was sent.
#[derive(Default)]
pub struct RecordingSink {
    sent: Mutex<Vec<Envelope>>,
    /// When set, every send fails with this message (a dead channel).
    pub fail_with: Mutex<Option<String>>,
}

impl RecordingSink {
    pub fn sent(&self) -> Vec<Envelope> {
        lock(&self.sent).clone()
    }
}

impl OutboundSink for RecordingSink {
    fn send(&self, envelope: Envelope) -> Result<(), String> {
        let failure = lock(&self.fail_with).clone();
        if let Some(message) = failure {
            return Err(message);
        }
        lock(&self.sent).push(envelope);
        Ok(())
    }
}

/// Calls recorded by a fake, as `name(args…)` strings in order.
#[derive(Default)]
pub struct CallLog {
    calls: Mutex<Vec<String>>,
}

impl CallLog {
    pub fn record(&self, entry: impl Into<String>) {
        lock(&self.calls).push(entry.into());
    }

    pub fn calls(&self) -> Vec<String> {
        lock(&self.calls).clone()
    }

    pub fn clear(&self) {
        lock(&self.calls).clear();
    }
}

fn ready<T: Send + 'static>(value: T) -> BoxFuture<'static, T> {
    Box::pin(std::future::ready(value))
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct FakeHost {
    pub log: CallLog,
    /// Scripted answers, consumed in order; `None` entries mean "cancelled".
    pub open_dialog_answers: Mutex<Vec<Option<Vec<PathBuf>>>>,
    pub save_dialog_answers: Mutex<Vec<Option<PathBuf>>>,
    pub message_dialog_answers: Mutex<Vec<usize>>,
    pub clipboard_text: Mutex<String>,
    pub version: Mutex<String>,
    pub locale: Mutex<Option<String>>,
    pub exit_codes: Mutex<Vec<i32>>,
    pub relaunches: Mutex<Vec<PathBuf>>,
}

impl FakeHost {
    pub fn new() -> Self {
        Self { version: Mutex::new("0.0.0-test".into()), ..Default::default() }
    }
}

impl Host for FakeHost {
    fn open_dialog(&self, options: OpenDialogOptions) -> BoxFuture<'_, Option<Vec<PathBuf>>> {
        self.log.record(format!("open_dialog({options:?})"));
        let answer = lock(&self.open_dialog_answers);
        let value = if answer.is_empty() { None } else { answer.first().cloned().flatten() };
        drop(answer);
        if !lock(&self.open_dialog_answers).is_empty() {
            lock(&self.open_dialog_answers).remove(0);
        }
        ready(value)
    }

    fn save_dialog(&self, options: SaveDialogOptions) -> BoxFuture<'_, Option<PathBuf>> {
        self.log.record(format!("save_dialog({options:?})"));
        let mut answers = lock(&self.save_dialog_answers);
        let value = if answers.is_empty() { None } else { answers.remove(0) };
        ready(value)
    }

    fn message_dialog(&self, options: MessageDialogOptions) -> BoxFuture<'_, usize> {
        self.log.record(format!("message_dialog({})", options.title));
        let mut answers = lock(&self.message_dialog_answers);
        let value = if answers.is_empty() { options.buttons.len().saturating_sub(1) } else { answers.remove(0) };
        ready(value)
    }

    fn open_url(&self, url: &str) -> Result<(), HostError> {
        self.log.record(format!("open_url({url})"));
        if url.starts_with("http://") || url.starts_with("https://") {
            Ok(())
        } else {
            Err(HostError::Failed(format!("refused scheme in {url}")))
        }
    }

    fn open_path(&self, path: &std::path::Path) -> Result<(), HostError> {
        self.log.record(format!("open_path({})", path.display()));
        Ok(())
    }

    fn reveal_in_folder(&self, path: &std::path::Path) -> Result<(), HostError> {
        self.log.record(format!("reveal_in_folder({})", path.display()));
        Ok(())
    }

    fn clipboard_read_text(&self) -> BoxFuture<'_, Result<String, HostError>> {
        self.log.record("clipboard_read_text()");
        ready(Ok(lock(&self.clipboard_text).clone()))
    }

    fn clipboard_write_text(&self, text: &str) -> BoxFuture<'_, Result<(), HostError>> {
        self.log.record(format!("clipboard_write_text({text})"));
        *lock(&self.clipboard_text) = text.to_string();
        ready(Ok(()))
    }

    fn notify(&self, title: &str, body: Option<&str>) -> Result<(), HostError> {
        self.log.record(format!("notify({title}, {body:?})"));
        Ok(())
    }

    fn app_version(&self) -> String {
        lock(&self.version).clone()
    }

    fn system_locale(&self) -> Option<String> {
        lock(&self.locale).clone()
    }

    fn exit(&self, code: i32) {
        self.log.record(format!("exit({code})"));
        lock(&self.exit_codes).push(code);
    }

    fn relaunch_after_exit(&self, program: PathBuf) {
        self.log.record(format!("relaunch_after_exit({})", program.display()));
        lock(&self.relaunches).push(program);
    }
}

// ---------------------------------------------------------------------------
// omp
// ---------------------------------------------------------------------------

/// A sidecar that records what the pool asks of it and answers requests from a script.
pub struct FakeSidecar {
    pub log: CallLog,
    pub options: SidecarOptions,
    pub status: Mutex<SidecarStatus>,
    /// The whole last status, when a test sets one; otherwise built from `status` and `cwd`.
    pub status_payload: Mutex<Option<SidecarStatusPayload>>,
    pub cwd: Mutex<String>,
    pub pids: Mutex<(Option<u32>, Option<u32>)>,
    /// Scripted `request` answers in order; an empty list answers `{ "success": true }`.
    pub responses: Mutex<Vec<Result<Value, SidecarError>>>,
    pub side_channel: Mutex<Vec<Value>>,
    pub events: Mutex<Option<tokio::sync::mpsc::UnboundedSender<SidecarEvent>>>,
}

impl FakeSidecar {
    pub fn new(options: SidecarOptions) -> (Arc<Self>, SidecarEvents) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let cwd = options.cwd.clone();
        let sidecar = Arc::new(Self {
            log: CallLog::default(),
            options,
            status: Mutex::new(SidecarStatus::Asleep),
            status_payload: Mutex::new(None),
            cwd: Mutex::new(cwd),
            pids: Mutex::new((None, None)),
            responses: Mutex::new(Vec::new()),
            side_channel: Mutex::new(Vec::new()),
            events: Mutex::new(Some(tx)),
        });
        (sidecar, rx)
    }

    /// Push an event into the stream as the real manager would.
    pub fn emit(&self, event: SidecarEvent) {
        if let Some(tx) = lock(&self.events).as_ref() {
            let _ = tx.send(event);
        }
    }

    pub fn set_status(&self, status: SidecarStatus) {
        *lock(&self.status) = status;
        let cwd = lock(&self.cwd).clone();
        self.emit(SidecarEvent::Status(SidecarStatusPayload { status, message: None, cwd, restart: None, refusal: None }));
    }
}

impl SidecarHandle for FakeSidecar {
    fn status(&self) -> SidecarStatus {
        *lock(&self.status)
    }

    fn status_payload(&self) -> SidecarStatusPayload {
        lock(&self.status_payload).clone().unwrap_or_else(|| SidecarStatusPayload { status: self.status(), message: None, cwd: self.cwd(), restart: None, refusal: None })
    }

    fn cwd(&self) -> String {
        lock(&self.cwd).clone()
    }

    fn kind(&self) -> SessionKind {
        self.options.kind
    }

    fn omp_pid(&self) -> Option<u32> {
        lock(&self.pids).0
    }

    fn supervisor_pid(&self) -> Option<u32> {
        lock(&self.pids).1
    }

    fn has_rpc_client(&self) -> bool {
        matches!(*lock(&self.status), SidecarStatus::Ready | SidecarStatus::Starting)
    }

    fn start(&self) {
        self.log.record("start()");
        *lock(&self.status) = SidecarStatus::Starting;
    }

    fn request(&self, command: Value, timeout_ms: Option<u64>) -> BoxFuture<'static, Result<Value, SidecarError>> {
        self.log.record(format!("request({command}, {timeout_ms:?})"));
        let mut responses = lock(&self.responses);
        let answer = if responses.is_empty() { Ok(serde_json::json!({ "success": true })) } else { responses.remove(0) };
        ready(answer)
    }

    fn send_side_channel(&self, frame: Value) {
        self.log.record(format!("send_side_channel({frame})"));
        lock(&self.side_channel).push(frame);
    }

    fn mark_unhealthy(&self, reason: &str) {
        self.log.record(format!("mark_unhealthy({reason})"));
    }

    fn adopt_cwd(&self, cwd: &str) -> bool {
        self.log.record(format!("adopt_cwd({cwd})"));
        let mut current = lock(&self.cwd);
        if *current == cwd {
            return false;
        }
        *current = cwd.to_string();
        true
    }

    fn restart(&self, cwd: Option<&str>, resume_session_path: Option<&str>) {
        self.log.record(format!("restart({cwd:?}, {resume_session_path:?})"));
        if let Some(cwd) = cwd {
            *lock(&self.cwd) = cwd.to_string();
        }
    }

    fn kill(&self) -> BoxFuture<'static, ()> {
        self.log.record("kill()");
        *lock(&self.status) = SidecarStatus::Exited;
        ready(())
    }

    fn dispose(&self) -> BoxFuture<'static, ()> {
        self.log.record("dispose()");
        *lock(&self.status) = SidecarStatus::Exited;
        lock(&self.events).take();
        ready(())
    }
}

/// An event batcher that flushes on every push (no timers in tests).
pub struct ImmediateBatcher {
    flush: FlushCallback,
}

impl EventBatcher for ImmediateBatcher {
    fn push(&self, event: Value) {
        (self.flush)(vec![event]);
    }

    fn flush_now(&self) {}

    fn dispose(&self) {}
}

#[derive(Default)]
pub struct FakeOmp {
    pub log: CallLog,
    pub sidecars: Mutex<Vec<Arc<FakeSidecar>>>,
    pub env: Mutex<HashMap<String, String>>,
    pub editor_command: Mutex<Option<String>>,
}

impl FakeOmp {
    pub fn new() -> Self {
        Self::default()
    }
}

impl OmpPort for FakeOmp {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn new_sidecar(&self, options: SidecarOptions) -> (Arc<dyn SidecarHandle>, SidecarEvents) {
        self.log.record(format!("new_sidecar({}, {:?}, fresh={})", options.cwd, options.kind, options.fresh));
        let (sidecar, events) = FakeSidecar::new(options);
        lock(&self.sidecars).push(sidecar.clone());
        (sidecar, events)
    }

    fn new_event_batcher(&self, flush: FlushCallback) -> Box<dyn EventBatcher> {
        Box::new(ImmediateBatcher { flush })
    }

    fn spawn_env(&self) -> BoxFuture<'_, HashMap<String, String>> {
        self.log.record("spawn_env()");
        ready(lock(&self.env).clone())
    }

    fn resolve_editor_command(&self) -> BoxFuture<'_, Option<String>> {
        self.log.record("resolve_editor_command()");
        ready(lock(&self.editor_command).clone())
    }
}

// ---------------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct FakeTabs {
    pub log: CallLog,
    pub at_cap: Mutex<bool>,
    pub acquire_result: Mutex<Option<String>>,
    pub sidecars: Mutex<HashMap<(WindowId, String), Arc<dyn SidecarHandle>>>,
    pub active: Mutex<HashMap<WindowId, String>>,
    pub owners: Mutex<HashMap<String, IpcSessionOwner>>,
    pub live_owners: Mutex<Vec<String>>,
    pub idle_responses: Mutex<Vec<Option<Value>>>,
    pub tabs: Mutex<HashMap<WindowId, Vec<IpcTabInfo>>>,
    pub inventory: Mutex<Vec<WindowTabFact>>,
    pub any_in_flight: Mutex<bool>,
    pub layouts: Mutex<HashMap<WindowId, PersistedTabLayout>>,
    pub cwds: Mutex<HashMap<WindowId, String>>,
    pub listeners: Mutex<Vec<WindowTabsChangedListener>>,
}

impl FakeTabs {
    pub fn new() -> Self {
        Self::default()
    }
}

impl TabsPort for FakeTabs {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn acquire(&self, options: AcquireOptions) -> Option<String> {
        self.log.record(format!("acquire({options:?})"));
        if *lock(&self.at_cap) {
            return None;
        }
        Some(lock(&self.acquire_result).clone().or(options.tab_id).unwrap_or_else(|| "tab-fake".into()))
    }

    fn size(&self) -> usize {
        lock(&self.sidecars).len()
    }

    fn at_cap(&self) -> bool {
        *lock(&self.at_cap)
    }

    fn sidecar_for_window(&self, win_id: WindowId) -> Option<Arc<dyn SidecarHandle>> {
        let active = lock(&self.active).get(&win_id).cloned()?;
        lock(&self.sidecars).get(&(win_id, active)).cloned()
    }

    fn sidecar_for_tab(&self, win_id: WindowId, tab_id: &str) -> Option<Arc<dyn SidecarHandle>> {
        lock(&self.sidecars).get(&(win_id, tab_id.to_string())).cloned()
    }

    fn active_tab_for_window(&self, win_id: WindowId) -> Option<String> {
        lock(&self.active).get(&win_id).cloned()
    }

    fn command_for_idle_session(&self, session_path: &str, command: Value) -> BoxFuture<'static, Option<Value>> {
        self.log.record(format!("command_for_idle_session({session_path}, {command})"));
        let mut responses = lock(&self.idle_responses);
        let answer = if responses.is_empty() { None } else { responses.remove(0) };
        ready(answer)
    }

    fn set_active_tab(&self, win_id: WindowId, tab_id: &str) -> bool {
        self.log.record(format!("set_active_tab({win_id}, {tab_id})"));
        lock(&self.active).insert(win_id, tab_id.to_string());
        true
    }

    fn set_tab_view(&self, win_id: WindowId, focused_tab_id: &str, visible_tab_ids: &[String], split: Option<IpcTabViewSplit>) -> bool {
        self.log.record(format!("set_tab_view({win_id}, {focused_tab_id}, {visible_tab_ids:?}, {split:?})"));
        lock(&self.active).insert(win_id, focused_tab_id.to_string());
        true
    }

    fn release_tab(&self, tab_id: &str) -> bool {
        self.log.record(format!("release_tab({tab_id})"));
        true
    }

    fn release_window(&self, win_id: WindowId) {
        self.log.record(format!("release_window({win_id})"));
    }

    fn session_owner(&self, session_path: &str) -> Option<IpcSessionOwner> {
        lock(&self.owners).get(session_path).cloned()
    }

    fn session_owner_is_live(&self, session_path: &str) -> bool {
        lock(&self.live_owners).iter().any(|path| path == session_path)
    }

    fn foreign_session_owner(&self, tab_id: Option<&str>, session_path: &str) -> Option<IpcSessionOwner> {
        let owner = lock(&self.owners).get(session_path).cloned()?;
        if Some(owner.tab_id.as_str()) == tab_id {
            None
        } else {
            Some(owner)
        }
    }

    fn note_session_file(&self, tab_id: &str, session_file: Option<&str>) {
        self.log.record(format!("note_session_file({tab_id}, {session_file:?})"));
    }

    fn adopt_session_cwd(&self, tab_id: &str, cwd: &str) -> bool {
        self.log.record(format!("adopt_session_cwd({tab_id}, {cwd})"));
        true
    }

    fn route_side_channel(&self, id: &str, frame: Value, is_final: bool) -> bool {
        self.log.record(format!("route_side_channel({id}, {frame}, {is_final})"));
        true
    }

    fn tabs_for_window(&self, win_id: WindowId) -> Vec<IpcTabInfo> {
        lock(&self.tabs).get(&win_id).cloned().unwrap_or_default()
    }

    fn tab_inventory(&self) -> Vec<WindowTabFact> {
        lock(&self.inventory).clone()
    }

    fn any_in_flight(&self) -> bool {
        *lock(&self.any_in_flight)
    }

    fn tab_layout_for_window(&self, win_id: WindowId) -> Option<PersistedTabLayout> {
        lock(&self.layouts).get(&win_id).cloned()
    }

    fn restore_layout(&self, win_id: WindowId, layout: PersistedTabLayout) -> usize {
        self.log.record(format!("restore_layout({win_id}, {} tabs)", layout.tabs.len()));
        layout.tabs.len()
    }

    fn dispose_all(&self) -> BoxFuture<'_, ()> {
        self.log.record("dispose_all()");
        ready(())
    }

    fn on_window_tabs_changed(&self, listener: WindowTabsChangedListener) {
        lock(&self.listeners).push(listener);
    }

    fn cwd_for(&self, caller: Caller, tab_id: Option<&str>) -> Option<String> {
        self.log.record(format!("cwd_for({}, {tab_id:?})", caller.win_id));
        lock(&self.cwds).get(&caller.win_id).cloned()
    }
}

// ---------------------------------------------------------------------------
// desktop
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct FakeDesktop {
    pub log: CallLog,
    pub records: Mutex<Vec<WindowRecord>>,
    pub focused: Mutex<Option<WindowId>>,
    pub spawn_result: Mutex<Option<WindowId>>,
    pub quitting: Mutex<bool>,
    pub quit_risk: Mutex<QuitRisk>,
    pub approve_install: Mutex<bool>,
    pub main_owned_keys: Mutex<Vec<String>>,
    pub closed_listeners: Mutex<Vec<WindowClosedListener>>,
    /// What `on_exit_requested` answers (true keeps the app running).
    pub prevent_exit: Mutex<bool>,
}

impl FakeDesktop {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_record(&self, record: WindowRecord) {
        lock(&self.records).push(record);
    }

    /// Simulate a window closing: notify listeners, then drop the record.
    pub fn close(&self, win_id: WindowId) {
        let record = lock(&self.records).iter().find(|record| record.id == win_id).cloned();
        if let Some(record) = record {
            for listener in lock(&self.closed_listeners).iter() {
                listener(&record);
            }
            lock(&self.records).retain(|record| record.id != win_id);
        }
    }
}

impl DesktopPort for FakeDesktop {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn spawn_window(&self, cwd: Option<String>, pending_session_path: Option<String>, kind: Option<SessionKind>) -> Option<WindowId> {
        self.log.record(format!("spawn_window({cwd:?}, {pending_session_path:?}, {kind:?})"));
        let id = lock(&self.spawn_result).take().or_else(|| {
            let next = lock(&self.records).iter().map(|record| record.id.0).max().unwrap_or(0) + 1;
            Some(WindowId(next))
        })?;
        lock(&self.records).push(WindowRecord { id, cwd: cwd.unwrap_or_default(), pending_session_path });
        Some(id)
    }

    fn records(&self) -> Vec<WindowRecord> {
        lock(&self.records).clone()
    }

    fn record(&self, win_id: WindowId) -> Option<WindowRecord> {
        lock(&self.records).iter().find(|record| record.id == win_id).cloned()
    }

    fn main_window(&self) -> Option<WindowId> {
        lock(&self.focused).or_else(|| lock(&self.records).first().map(|record| record.id))
    }

    fn target_window(&self) -> Option<WindowId> {
        self.main_window()
    }

    fn focus(&self, win_id: WindowId) -> bool {
        self.log.record(format!("focus({win_id})"));
        let exists = lock(&self.records).iter().any(|record| record.id == win_id);
        if exists {
            *lock(&self.focused) = Some(win_id);
        }
        exists
    }

    fn set_cwd(&self, win_id: WindowId, cwd: &str) {
        self.log.record(format!("set_cwd({win_id}, {cwd})"));
        if let Some(record) = lock(&self.records).iter_mut().find(|record| record.id == win_id) {
            record.cwd = cwd.to_string();
        }
    }

    fn consume_pending_session(&self, win_id: WindowId) -> Option<String> {
        self.log.record(format!("consume_pending_session({win_id})"));
        lock(&self.records).iter_mut().find(|record| record.id == win_id).and_then(|record| record.pending_session_path.take())
    }

    fn set_run_progress(&self, state: RunProgressState) {
        self.log.record(format!("set_run_progress({state:?})"));
    }

    fn on_window_closed(&self, listener: WindowClosedListener) {
        lock(&self.closed_listeners).push(listener);
    }

    fn rebuild_menu(&self) {
        self.log.record("rebuild_menu()");
    }

    fn is_main_owned_pref_key(&self, key: &str) -> bool {
        lock(&self.main_owned_keys).iter().any(|owned| owned == key)
    }

    fn on_second_instance(&self, argv: Vec<String>, cwd: Option<String>) {
        self.log.record(format!("on_second_instance({argv:?}, {cwd:?})"));
    }

    fn request_quit(&self) {
        self.log.record("request_quit()");
        *lock(&self.quitting) = true;
    }

    fn on_exit_requested(&self, code: Option<i32>) -> bool {
        self.log.record(format!("on_exit_requested({code:?})"));
        *lock(&self.prevent_exit)
    }

    fn on_reopen(&self, has_visible_windows: bool) {
        self.log.record(format!("on_reopen({has_visible_windows})"));
    }

    fn mark_quitting(&self) {
        self.log.record("mark_quitting()");
        *lock(&self.quitting) = true;
    }

    fn is_quitting(&self) -> bool {
        *lock(&self.quitting)
    }

    fn quit_risk(&self) -> QuitRisk {
        *lock(&self.quit_risk)
    }

    fn approve_quit_before_install(&self) -> BoxFuture<'_, bool> {
        self.log.record("approve_quit_before_install()");
        ready(*lock(&self.approve_install))
    }

    fn withdraw_quit_approval(&self) {
        self.log.record("withdraw_quit_approval()");
    }

    fn shutdown(&self) -> BoxFuture<'_, ()> {
        self.log.record("shutdown()");
        ready(())
    }
}

// ---------------------------------------------------------------------------
// services
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct FakeServices {
    pub log: CallLog,
    pub sessions: Mutex<Vec<SessionInfo>>,
    pub kinds: Mutex<HashMap<String, SessionKind>>,
    pub search_results: Mutex<Vec<String>>,
    pub sessions_dir: Mutex<PathBuf>,
    /// Host tools this fake "knows"; others return `None`.
    pub host_tools: Mutex<HashMap<String, Result<Value, String>>>,
    pub changed_listeners: Mutex<Vec<Box<dyn Fn() + Send + Sync>>>,
}

impl FakeServices {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ServicesPort for FakeServices {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn sessions_list(&self, scope: SessionScope, cwd: Option<String>) -> BoxFuture<'_, Result<Vec<SessionInfo>, ServiceError>> {
        self.log.record(format!("sessions_list({scope:?}, {cwd:?})"));
        ready(Ok(lock(&self.sessions).clone()))
    }

    fn session_kind_for(&self, session_path: &str) -> BoxFuture<'_, SessionKind> {
        self.log.record(format!("session_kind_for({session_path})"));
        ready(lock(&self.kinds).get(session_path).copied().unwrap_or_default())
    }

    fn session_delete(&self, session_path: &str) -> BoxFuture<'_, Result<(), ServiceError>> {
        self.log.record(format!("session_delete({session_path})"));
        ready(Ok(()))
    }

    fn session_search(&self, query: &str, candidate_paths: Vec<String>) -> BoxFuture<'_, Vec<String>> {
        self.log.record(format!("session_search({query}, {} candidates)", candidate_paths.len()));
        ready(lock(&self.search_results).clone())
    }

    fn sessions_dir(&self) -> PathBuf {
        lock(&self.sessions_dir).clone()
    }

    fn on_sessions_changed(&self, listener: Box<dyn Fn() + Send + Sync>) {
        lock(&self.changed_listeners).push(listener);
    }

    fn execute_host_tool(&self, caller: Caller, name: &str, args: Value) -> Option<BoxFuture<'static, Result<Value, String>>> {
        self.log.record(format!("execute_host_tool({}, {name}, {args})", caller.win_id));
        let answer = lock(&self.host_tools).get(name).cloned()?;
        Some(ready(answer))
    }

    fn import_legacy_renderer_storage(&self) -> BoxFuture<'_, ()> {
        self.log.record("import_legacy_renderer_storage()");
        ready(())
    }

    fn shutdown(&self) -> BoxFuture<'_, ()> {
        self.log.record("shutdown()");
        ready(())
    }
}

// ---------------------------------------------------------------------------
// ollama, updater
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct FakeOllama {
    pub log: CallLog,
}

impl OllamaPort for FakeOllama {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn shutdown(&self) -> BoxFuture<'_, ()> {
        self.log.record("shutdown()");
        ready(())
    }
}

#[derive(Default)]
pub struct FakeUpdater {
    pub log: CallLog,
    pub status: Mutex<Value>,
}

impl UpdaterPort for FakeUpdater {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn check_now(&self) {
        self.log.record("check_now()");
    }

    fn status(&self) -> Value {
        lock(&self.status).clone()
    }

    fn shutdown(&self) -> BoxFuture<'_, ()> {
        self.log.record("shutdown()");
        ready(())
    }
}

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

/// The fakes behind a test context, so tests can script and inspect them.
pub struct Fakes {
    pub host: Arc<FakeHost>,
    pub omp: Arc<FakeOmp>,
    pub tabs: Arc<FakeTabs>,
    pub desktop: Arc<FakeDesktop>,
    pub services: Arc<FakeServices>,
    pub ollama: Arc<FakeOllama>,
    pub updater: Arc<FakeUpdater>,
    /// Keeps the stores' directory alive for the test.
    pub dir: tempfile::TempDir,
}

impl Default for Fakes {
    fn default() -> Self {
        Self {
            host: Arc::new(FakeHost::new()),
            omp: Arc::new(FakeOmp::new()),
            tabs: Arc::new(FakeTabs::new()),
            desktop: Arc::new(FakeDesktop::new()),
            services: Arc::new(FakeServices::new()),
            ollama: Arc::new(FakeOllama::default()),
            updater: Arc::new(FakeUpdater::default()),
            dir: tempfile::tempdir().expect("temp dir for test stores"),
        }
    }
}

/// Ports a module test installs instead of the fakes (usually its own production struct).
#[derive(Default)]
pub struct Ports {
    pub omp: Option<Arc<dyn OmpPort>>,
    pub tabs: Option<Arc<dyn TabsPort>>,
    pub desktop: Option<Arc<dyn DesktopPort>>,
    pub services: Option<Arc<dyn ServicesPort>>,
    pub ollama: Option<Arc<dyn OllamaPort>>,
    pub updater: Option<Arc<dyn UpdaterPort>>,
}

/// Build an `AppCtx` from `fakes` and the channel `registry`, letting `build`
/// replace ports with real ones that receive the context's `Weak` handle:
/// `fake_ctx_cyclic(&fakes, reg, |ctx, ports| ports.omp = Some(Arc::new(Omp::new(ctx.clone()))))`.
pub fn fake_ctx_cyclic(fakes: &Fakes, registry: Registry, build: impl FnOnce(&Weak<AppCtx>, &mut Ports)) -> Arc<AppCtx> {
    let prefs = JsonStore::open(fakes.dir.path().join("prefs.json"));
    let window_state = JsonStore::open(fakes.dir.path().join("window-state.json"));
    Arc::new_cyclic(|ctx| {
        let mut ports = Ports::default();
        build(ctx, &mut ports);
        AppCtx {
            host: fakes.host.clone(),
            bridge: Bridge::new(registry),
            prefs: prefs.clone(),
            window_state,
            i18n: MainI18n::new(prefs, fakes.host.system_locale()),
            omp: ports.omp.unwrap_or_else(|| fakes.omp.clone()),
            tabs: ports.tabs.unwrap_or_else(|| fakes.tabs.clone()),
            desktop: ports.desktop.unwrap_or_else(|| fakes.desktop.clone()),
            services: ports.services.unwrap_or_else(|| fakes.services.clone()),
            ollama: ports.ollama.unwrap_or_else(|| fakes.ollama.clone()),
            updater: ports.updater.unwrap_or_else(|| fakes.updater.clone()),
        }
    })
}

/// Build an `AppCtx` from `fakes` and the channel `registry`.
pub fn fake_ctx_with(fakes: &Fakes, registry: Registry) -> Arc<AppCtx> {
    fake_ctx_cyclic(fakes, registry, |_, _| {})
}

/// An `AppCtx` over fresh fakes; the fakes stay reachable through `Fakes` when
/// a test needs them (`let fakes = Fakes::default(); fake_ctx_with(&fakes, …)`).
pub fn fake_ctx(registry: Registry) -> Arc<AppCtx> {
    let fakes = Box::leak(Box::new(Fakes::default()));
    fake_ctx_with(fakes, registry)
}
