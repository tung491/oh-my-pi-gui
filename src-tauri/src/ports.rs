//! The frozen cross-module contracts. Every call one module makes into another
//! goes through one of these traits, so each module can be unit-tested against
//! the fakes in `testing.rs` without a Tauri runtime. Production implementations
//! live in each module; `lib.rs` wires them into `AppCtx`.
//!
//! Serde types mirror their TypeScript namesakes in `src/shared/ipc-types.ts`
//! (camelCase on the wire) and keep the TS name where one exists.

use std::any::Any;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Weak};

use futures_util::future::BoxFuture;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::ctx::AppCtx;

/// How a production port reaches the rest of the application. Every module
/// constructor takes one (`lib.rs` builds the context with `Arc::new_cyclic`),
/// and `upgrade()` fails only during shutdown, after the context is gone.
pub type CtxRef = Weak<AppCtx>;

/// The reserved first argument that turns the GUI binary into a sidecar supervisor.
pub const SUPERVISOR_ARGV: &str = "--omp-supervise";

// ---------------------------------------------------------------------------
// Window identity
// ---------------------------------------------------------------------------

/// A chat window's number. Renderer-visible ids (`IpcSessionOwner.winId`,
/// `ownerWinId`) serialize as this bare number so `typeof … === "number"` holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct WindowId(pub u32);

impl WindowId {
    /// The quick-entry bar is the one window that is not a chat window.
    pub const QUICK_ENTRY: WindowId = WindowId(0);

    /// The webview label: `main-<n>` for chat windows, `quick-entry` for the bar.
    pub fn label(self) -> String {
        if self == WindowId::QUICK_ENTRY {
            WindowKind::QUICK_ENTRY_LABEL.to_string()
        } else {
            format!("{}{}", WindowKind::MAIN_LABEL_PREFIX, self.0)
        }
    }
}

impl std::fmt::Display for WindowId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WindowKind {
    Main,
    QuickEntry,
}

impl WindowKind {
    pub const MAIN_LABEL_PREFIX: &'static str = "main-";
    pub const QUICK_ENTRY_LABEL: &'static str = "quick-entry";
}

/// Who is calling a handler: derived from the webview label, never from a payload.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Caller {
    pub win_id: WindowId,
    pub kind: WindowKind,
}

impl Caller {
    pub fn main(win_id: WindowId) -> Self {
        Self { win_id, kind: WindowKind::Main }
    }

    pub fn quick_entry() -> Self {
        Self { win_id: WindowId::QUICK_ENTRY, kind: WindowKind::QuickEntry }
    }

    /// Parse a webview label (`main-3`, `quick-entry`).
    pub fn from_label(label: &str) -> Option<Self> {
        if label == WindowKind::QUICK_ENTRY_LABEL {
            return Some(Self::quick_entry());
        }
        let number = label.strip_prefix(WindowKind::MAIN_LABEL_PREFIX)?.parse::<u32>().ok()?;
        if number == 0 {
            return None;
        }
        Some(Self::main(WindowId(number)))
    }

    pub fn label(&self) -> String {
        self.win_id.label()
    }
}

// ---------------------------------------------------------------------------
// Shared wire types
// ---------------------------------------------------------------------------

/// Deserialize `T | null | absent` into `Option<Option<T>>` (absent = `None`, null = `Some(None)`).
pub fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

/// Session kind: "agent" (tools enabled) or "chat" (tool-free conversation).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
    #[default]
    Agent,
    Chat,
}

/// `"local" | "global"` for session listing and search.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionScope {
    Local,
    Global,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SidecarStatus {
    Asleep,
    Starting,
    Ready,
    Exited,
    Error,
    Restarting,
}

/// `TabStatus = SidecarStatus | "running"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TabStatus {
    Asleep,
    Starting,
    Ready,
    Exited,
    Error,
    Restarting,
    Running,
}

impl From<SidecarStatus> for TabStatus {
    fn from(status: SidecarStatus) -> Self {
        match status {
            SidecarStatus::Asleep => TabStatus::Asleep,
            SidecarStatus::Starting => TabStatus::Starting,
            SidecarStatus::Ready => TabStatus::Ready,
            SidecarStatus::Exited => TabStatus::Exited,
            SidecarStatus::Error => TabStatus::Error,
            SidecarStatus::Restarting => TabStatus::Restarting,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarRestartProgress {
    pub attempt: u32,
    pub max_attempts: u32,
}

/// A sidecar start the app refused on purpose; the renderer shows its own copy for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SidecarRefusal {
    /// The session file is stamped `chat`, which an assistant session cannot resume.
    #[serde(rename = "kind-mismatch")]
    KindMismatch,
}

/// `SidecarStatusPayload` / `IpcSidecarStatusPayload`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarStatusPayload {
    pub status: SidecarStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart: Option<SidecarRestartProgress>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refusal: Option<SidecarRefusal>,
}

/// `IpcTabWorktree`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcTabWorktree {
    pub name: String,
    pub branch: String,
    pub base_cwd: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TabSplitAxis {
    Columns,
    Rows,
}

/// `IpcTabInfo.split`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcTabSplit {
    pub axis: TabSplitAxis,
    pub index: u8,
    pub ratio: f64,
}

/// `IpcSetTabViewPayload.split`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcTabViewSplit {
    pub axis: TabSplitAxis,
    pub first_tab_id: String,
    pub second_tab_id: String,
    pub ratio: f64,
}

/// `IpcTabInfo` (also the `tab:status` payload).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcTabInfo {
    pub tab_id: String,
    pub cwd: String,
    pub status: TabStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub split: Option<IpcTabSplit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compacting: Option<bool>,
    pub kind: SessionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<IpcTabWorktree>,
    /// Absent, `null` (clears the previous value) or a path.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "double_option")]
    pub session_path: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Absent, `null` (clears the cached title) or a title.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "double_option")]
    pub title: Option<Option<String>>,
}

/// `IpcSessionOwner`: the tab (and its window) attached to a session file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcSessionOwner {
    pub tab_id: String,
    pub win_id: WindowId,
}

/// `WindowTabFact` from `quit-guard.ts`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowTabFact {
    pub window_id: WindowId,
    pub tab_id: String,
    /// A run or an automatic compaction is in flight on this tab.
    pub in_flight: bool,
}

/// `QuitRisk` from `quit-guard.ts`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuitRisk {
    pub working_tabs: usize,
    pub total_tabs: usize,
    pub working_windows: usize,
}

/// `PersistedTabDescriptor` from `tab-layout.ts`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedTabDescriptor {
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_path: Option<String>,
    pub kind: SessionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<IpcTabWorktree>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedTabSplit {
    pub axis: TabSplitAxis,
    pub first_index: usize,
    pub second_index: usize,
    pub ratio: f64,
}

/// `PersistedTabLayout` from `tab-layout.ts` (`version` is `TAB_LAYOUT_VERSION`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedTabLayout {
    pub version: u32,
    pub tabs: Vec<PersistedTabDescriptor>,
    pub active_index: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub split: Option<PersistedTabSplit>,
}

/// `SessionInfo`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub path: String,
    pub id: String,
    pub title: Option<String>,
    pub cwd: String,
    pub created: String,
    pub modified: String,
    pub message_count: u64,
    pub size: u64,
    pub status: SessionStatus,
    /// Present only for chat sessions; absent = agent (legacy files).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<SessionKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_path: Option<String>,
    pub first_message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Complete,
    Interrupted,
    Aborted,
    Error,
    Pending,
    Unknown,
}

/// `RunProgressState`: dock badge and taskbar progress.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunProgressState {
    Working,
    Waiting,
    Idle,
}

/// A window the desktop module manages (`WindowRecord` minus the BrowserWindow).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowRecord {
    pub id: WindowId,
    pub cwd: String,
    /// Session to switch to once the renderer is up; the renderer pulls it on boot.
    pub pending_session_path: Option<String>,
}

// ---------------------------------------------------------------------------
// Sidecar (omp child process) contract
// ---------------------------------------------------------------------------

/// Everything the manager needs to spawn `omp --mode rpc-ui` for one tab.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SidecarOptions {
    pub binary_path: PathBuf,
    pub cwd: String,
    /// Extra user flags for every spawn. The manager appends the workspace's
    /// launch profile (`launchProfiles.<cwd>` from prefs, re-read on every
    /// spawn and restart) and applies the denylist itself.
    pub extra_flags: Vec<String>,
    /// `app.isPackaged`: only a dev tree can act on a build instruction in the missing-binary message.
    pub packaged: bool,
    /// Fresh GUI tabs must not inherit the CLI's persistent autoResume setting.
    pub fresh: bool,
    pub kind: SessionKind,
    /// Session file to resume on the first start, if any.
    pub resume_session_path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SidecarError {
    #[error("the sidecar is not running")]
    NotRunning,
    /// The TS message: `RPC timeout (<ms>ms): <command type>`.
    #[error("RPC timeout ({timeout_ms}ms): {command_type}")]
    Timeout { timeout_ms: u64, command_type: String },
    #[error("the sidecar connection closed before the response arrived")]
    Closed,
    #[error("{0}")]
    Other(String),
}

/// One variant per event the sidecar manager emits. Frame payloads are the
/// JSON frames as received, so routing modules forward them unchanged.
#[derive(Clone, Debug, PartialEq)]
pub enum SidecarEvent {
    /// `status`: lifecycle change.
    Status(SidecarStatusPayload),
    /// `events`: one batch of agent session events (already batched by the manager, 32 ms / 1,000 cap).
    Events(Vec<Value>),
    /// `stderr`: one chunk of the child's stderr.
    Stderr(String),
    /// `frame`: every outbound frame that is not an agent session event.
    Frame(Value),
    /// `extensionUi`
    ExtensionUi(Value),
    /// `hostToolCall`
    HostToolCall(Value),
    /// `hostUriRequest`
    HostUriRequest(Value),
    /// `subagentFrame`
    SubagentFrame(Value),
    /// `commandsUpdate`: the `commands` array of the frame.
    CommandsUpdate(Vec<Value>),
    /// `modelCatalogUpdate`
    ModelCatalogUpdate(Value),
    /// `configUpdate`
    ConfigUpdate(Value),
    /// `promptResult`
    PromptResult(Value),
    /// `commandOutput`
    CommandOutput(Value),
    /// `sessionInfoUpdate`
    SessionInfoUpdate(Value),
    /// `extensionError`
    ExtensionError(Value),
    /// `liveUpdate`
    LiveUpdate(Value),
}

/// The receiving end of a sidecar's event stream.
pub type SidecarEvents = tokio::sync::mpsc::UnboundedReceiver<SidecarEvent>;

/// The manager surface the pool drives (`SidecarManager` in TS). Object-safe so
/// the pool can be tested with fakes.
pub trait SidecarHandle: Send + Sync {
    fn status(&self) -> SidecarStatus;
    /// The last status reported, whole (message, restart progress, refusal), so a
    /// window that subscribes after a push still shows it.
    fn status_payload(&self) -> SidecarStatusPayload;
    fn cwd(&self) -> String;
    fn kind(&self) -> SessionKind;
    /// The agent's pid, once the supervisor has reported it.
    fn omp_pid(&self) -> Option<u32>;
    /// The supervisor's pid (the direct child); `None` where no supervisor is used.
    fn supervisor_pid(&self) -> Option<u32>;
    /// Whether an RPC client is attached (the TS `rpcClient !== null`).
    fn has_rpc_client(&self) -> bool;
    fn start(&self);
    /// Send an RPC command and await its correlated response (`RpcResponse` as JSON).
    /// The frame is queued on stdin before this returns, so a handler can call it
    /// synchronously and hand the future to `Reply::Later`; stdin order equals arrival order.
    fn request(&self, command: Value, timeout_ms: Option<u64>) -> BoxFuture<'static, Result<Value, SidecarError>>;
    /// Write a side-channel frame (extension UI response, host tool result) to stdin.
    fn send_side_channel(&self, frame: Value);
    fn mark_unhealthy(&self, reason: &str);
    /// Remember a new cwd without restarting; true when it changed.
    fn adopt_cwd(&self, cwd: &str) -> bool;
    fn restart(&self, cwd: Option<&str>, resume_session_path: Option<&str>);
    /// Stop the child through its supervisor; the stop is initiated before this
    /// returns and the future resolves when the supervisor has exited.
    fn kill(&self) -> BoxFuture<'static, ()>;
    /// `kill` plus no further restarts or events.
    fn dispose(&self) -> BoxFuture<'static, ()>;
}

/// Flush callback for an [`EventBatcher`].
pub type FlushCallback = Box<dyn Fn(Vec<Value>) + Send + Sync>;

/// 32 ms batches, 1,000-entry buffer, drops `tool_execution_update` under backpressure.
pub const BATCH_INTERVAL_MS: u64 = 32;
pub const MAX_BUFFER_SIZE: usize = 1000;

/// `EventBatcher` from `event-batcher.ts`; constructed through [`OmpPort::new_event_batcher`].
/// The sidecar manager batches its own `SidecarEvent::Events` with one of these,
/// so the pool forwards those batches as they are; this is for other streams.
pub trait EventBatcher: Send + Sync {
    fn push(&self, event: Value);
    /// Flush immediately (e.g. on sidecar disconnect).
    fn flush_now(&self);
    fn dispose(&self);
}

/// Module `omp`: child processes of the agent.
pub trait OmpPort: Send + Sync {
    /// The concrete module struct, so the module's own handlers reach its state
    /// (`ctx.omp.as_any().downcast_ref::<…>()`).
    fn as_any(&self) -> &dyn Any;
    /// Create (not start) a sidecar manager and the stream of its events.
    fn new_sidecar(&self, options: SidecarOptions) -> (Arc<dyn SidecarHandle>, SidecarEvents);
    fn new_event_batcher(&self, flush: FlushCallback) -> Box<dyn EventBatcher>;
    /// The environment overlay for every child: login-shell PATH plus proxy variables.
    fn spawn_env(&self) -> BoxFuture<'_, HashMap<String, String>>;
    /// `$VISUAL` / `$EDITOR` from the login shell, if any.
    fn resolve_editor_command(&self) -> BoxFuture<'_, Option<String>>;
}

// ---------------------------------------------------------------------------
// Tabs (sidecar pool) contract
// ---------------------------------------------------------------------------

/// Arguments of `SidecarPool.acquire`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcquireOptions {
    pub cwd: String,
    pub win_id: WindowId,
    /// Minted when `None`.
    pub tab_id: Option<String>,
    pub session_path: Option<String>,
    pub kind: SessionKind,
    pub worktree: Option<IpcTabWorktree>,
    pub fresh: bool,
    pub placeholder: bool,
    pub defer_start: bool,
    pub title: Option<String>,
}

impl AcquireOptions {
    pub fn new(cwd: impl Into<String>, win_id: WindowId) -> Self {
        Self {
            cwd: cwd.into(),
            win_id,
            tab_id: None,
            session_path: None,
            kind: SessionKind::Agent,
            worktree: None,
            fresh: false,
            placeholder: false,
            defer_start: false,
            title: None,
        }
    }
}

/// Listener for `onWindowTabsChanged`: the window and its current layout (`None` when it has no tabs).
pub type WindowTabsChangedListener = Box<dyn Fn(WindowId, Option<PersistedTabLayout>) + Send + Sync>;

/// Module `tabs`: the sidecar pool and tab routing.
pub trait TabsPort: Send + Sync {
    /// The concrete module struct, so the module's own handlers reach its state
    /// (`ctx.tabs.as_any().downcast_ref::<…>()`).
    fn as_any(&self) -> &dyn Any;
    /// Reserve a slot and spawn (or defer) a sidecar for a tab; the minted tab id, or `None` at the cap.
    fn acquire(&self, options: AcquireOptions) -> Option<String>;
    fn size(&self) -> usize;
    fn at_cap(&self) -> bool;
    fn sidecar_for_window(&self, win_id: WindowId) -> Option<Arc<dyn SidecarHandle>>;
    fn sidecar_for_tab(&self, win_id: WindowId, tab_id: &str) -> Option<Arc<dyn SidecarHandle>>;
    fn active_tab_for_window(&self, win_id: WindowId) -> Option<String>;
    /// Send a command to the live, idle owner of a session file; `None` when it has none.
    /// The command is queued on that sidecar's stdin before this returns.
    fn command_for_idle_session(&self, session_path: &str, command: Value) -> BoxFuture<'static, Option<Value>>;
    fn set_active_tab(&self, win_id: WindowId, tab_id: &str) -> bool;
    fn set_tab_view(&self, win_id: WindowId, focused_tab_id: &str, visible_tab_ids: &[String], split: Option<IpcTabViewSplit>) -> bool;
    fn release_tab(&self, tab_id: &str) -> bool;
    /// Release every tab of a closed window.
    fn release_window(&self, win_id: WindowId);
    fn session_owner(&self, session_path: &str) -> Option<IpcSessionOwner>;
    fn session_owner_is_live(&self, session_path: &str) -> bool;
    /// The owner of `session_path` when it is a different tab than `tab_id`.
    fn foreign_session_owner(&self, tab_id: Option<&str>, session_path: &str) -> Option<IpcSessionOwner>;
    fn note_session_file(&self, tab_id: &str, session_file: Option<&str>);
    fn adopt_session_cwd(&self, tab_id: &str, cwd: &str) -> bool;
    /// Route a renderer response to the sidecar that raised the request id; true when routed.
    fn route_side_channel(&self, id: &str, frame: Value, is_final: bool) -> bool;
    fn tabs_for_window(&self, win_id: WindowId) -> Vec<IpcTabInfo>;
    fn tab_inventory(&self) -> Vec<WindowTabFact>;
    /// Whether any tab in any window has an agent run or a compaction in flight.
    fn any_in_flight(&self) -> bool;
    fn tab_layout_for_window(&self, win_id: WindowId) -> Option<PersistedTabLayout>;
    /// Recreate a window's tabs from a saved layout; the number of tabs restored.
    fn restore_layout(&self, win_id: WindowId, layout: PersistedTabLayout) -> usize;
    /// Stop every sidecar through its supervisor, in parallel, and wait for them.
    /// Runs inside `block_on` on the main thread during shutdown: the future must
    /// never await a main-thread round trip made from another thread (a spawned
    /// task reading window geometry, say), or quitting deadlocks.
    fn dispose_all(&self) -> BoxFuture<'_, ()>;
    fn on_window_tabs_changed(&self, listener: WindowTabsChangedListener);
    /// `cwdFor` from `ipc.ts`: the tab's cwd, else the window's sidecar cwd, else the window record's cwd.
    fn cwd_for(&self, caller: Caller, tab_id: Option<&str>) -> Option<String>;
}

// ---------------------------------------------------------------------------
// Desktop (windows, tray, menu, quit) contract
// ---------------------------------------------------------------------------

pub type WindowClosedListener = Box<dyn Fn(&WindowRecord) + Send + Sync>;

/// Module `desktop`: windows and OS-facing surfaces.
pub trait DesktopPort: Send + Sync {
    /// The concrete module struct, so the module's own handlers reach its state
    /// (`ctx.desktop.as_any().downcast_ref::<…>()`).
    fn as_any(&self) -> &dyn Any;
    /// Open a chat window with its own sidecar; `None` when the pool is at its cap.
    fn spawn_window(&self, cwd: Option<String>, pending_session_path: Option<String>, kind: Option<SessionKind>) -> Option<WindowId>;
    fn records(&self) -> Vec<WindowRecord>;
    fn record(&self, win_id: WindowId) -> Option<WindowRecord>;
    /// The most recently focused chat window.
    fn main_window(&self) -> Option<WindowId>;
    /// The focused chat window, else the main window.
    fn target_window(&self) -> Option<WindowId>;
    fn focus(&self, win_id: WindowId) -> bool;
    fn set_cwd(&self, win_id: WindowId, cwd: &str);
    fn consume_pending_session(&self, win_id: WindowId) -> Option<String>;
    fn set_run_progress(&self, state: RunProgressState);
    /// Called before the record is dropped, so subscribers can still read it.
    fn on_window_closed(&self, listener: WindowClosedListener);
    /// Rebuild the application menu (after a language change).
    fn rebuild_menu(&self);
    /// Pref keys the main process owns; `prefs:set` refuses them.
    fn is_main_owned_pref_key(&self, key: &str) -> bool;
    /// A second instance started with `argv` in `cwd`: focus, open a link or a path.
    fn on_second_instance(&self, argv: Vec<String>, cwd: Option<String>);
    fn request_quit(&self);
    /// `RunEvent::ExitRequested`: `code` is `None` for a user-initiated exit (last
    /// window closed, OS quit) and `Some` for the app's own `AppHandle::exit`
    /// (`request_quit`, the updater, SIGTERM). Return `true` to keep the app
    /// running (`api.prevent_exit()`; e.g. macOS keeps running without windows,
    /// or the quit guard asks first); `false` lets the frozen shutdown order run.
    /// Always return `false` for `Some(_)`: those exits were already decided.
    fn on_exit_requested(&self, code: Option<i32>) -> bool;
    /// Set the quitting latch without starting a quit (the exit path already began).
    fn mark_quitting(&self);
    fn is_quitting(&self) -> bool;
    fn quit_risk(&self) -> QuitRisk;
    /// Ask before an update installs while sessions work; false keeps working.
    fn approve_quit_before_install(&self) -> BoxFuture<'_, bool>;
    fn withdraw_quit_approval(&self);
    /// Last step of the frozen shutdown order: destroy windows and the tray.
    /// Runs inside `block_on` on the main thread: persist bounds synchronously
    /// here, and never await a main-thread getter issued from another thread.
    fn shutdown(&self) -> BoxFuture<'_, ()>;
}

// ---------------------------------------------------------------------------
// Services (sessions, files, system) contract
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ServiceError {
    #[error("{0}")]
    Io(String),
    #[error("{0}")]
    Refused(String),
}

/// Module `services`: sessions, files, dialogs, system actions, host tools.
pub trait ServicesPort: Send + Sync {
    /// The concrete module struct, so the module's own handlers reach its state
    /// (`ctx.services.as_any().downcast_ref::<…>()`).
    fn as_any(&self) -> &dyn Any;
    fn sessions_list(&self, scope: SessionScope, cwd: Option<String>) -> BoxFuture<'_, Result<Vec<SessionInfo>, ServiceError>>;
    /// The kind stamped in a session file's header (agent for legacy files).
    fn session_kind_for(&self, session_path: &str) -> BoxFuture<'_, SessionKind>;
    fn session_delete(&self, session_path: &str) -> BoxFuture<'_, Result<(), ServiceError>>;
    fn session_search(&self, query: &str, candidate_paths: Vec<String>) -> BoxFuture<'_, Vec<String>>;
    fn sessions_dir(&self) -> PathBuf;
    fn on_sessions_changed(&self, listener: Box<dyn Fn() + Send + Sync>);
    /// A GUI host tool (`gui_open_url`, `gui_notify`, `gui_clipboard_read`), or `None` for anything else.
    fn execute_host_tool(&self, caller: Caller, name: &str, args: Value) -> Option<BoxFuture<'static, Result<Value, String>>>;
    /// One-time Chromium localStorage import; runs before any window exists.
    fn import_legacy_renderer_storage(&self) -> BoxFuture<'_, ()>;
    /// Stop the session and log watchers.
    fn shutdown(&self) -> BoxFuture<'_, ()>;
}

// ---------------------------------------------------------------------------
// Ollama and updater contracts
// ---------------------------------------------------------------------------

/// Module `ollama`: nothing else calls it besides shutdown.
pub trait OllamaPort: Send + Sync {
    /// The concrete module struct, so the module's own handlers reach its state
    /// (`ctx.ollama.as_any().downcast_ref::<…>()`).
    fn as_any(&self) -> &dyn Any;
    fn shutdown(&self) -> BoxFuture<'_, ()>;
}

/// Module `updater`.
pub trait UpdaterPort: Send + Sync {
    /// The concrete module struct, so the module's own handlers reach its state
    /// (`ctx.updater.as_any().downcast_ref::<…>()`).
    fn as_any(&self) -> &dyn Any;
    /// The menu's "Check for Updates…".
    fn check_now(&self);
    /// The current `UpdateStatus` (replayed to the renderer on `updater:getStatus`).
    fn status(&self) -> Value;
    /// Part of the frozen shutdown order, after every sidecar stopped: install a
    /// downloaded update when `installsOnQuit` holds, otherwise do nothing.
    fn shutdown(&self) -> BoxFuture<'_, ()>;
}

// ---------------------------------------------------------------------------
// Host: OS services behind one fakeable surface
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OpenDialogOptions {
    pub title: Option<String>,
    pub default_path: Option<PathBuf>,
    pub filters: Vec<FileFilter>,
    pub directory: bool,
    pub multiple: bool,
    pub can_create_directories: bool,
    /// The window to attach the dialog to.
    pub parent: Option<WindowId>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SaveDialogOptions {
    pub title: Option<String>,
    pub default_path: Option<PathBuf>,
    pub filters: Vec<FileFilter>,
    pub parent: Option<WindowId>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MessageKind {
    #[default]
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MessageDialogOptions {
    pub title: String,
    pub message: String,
    pub detail: Option<String>,
    pub kind: MessageKind,
    /// One to three button labels in display order; the answer is an index into
    /// this list. Closing the dialog without a choice counts as the **last**
    /// button on every platform, so callers put the safe choice last.
    pub buttons: Vec<String>,
    pub parent: Option<WindowId>,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum HostError {
    #[error("{0}")]
    Failed(String),
    #[error("{0} is not available on this platform")]
    Unsupported(&'static str),
}

/// OS services every module may need: dialogs, the opener, the clipboard,
/// notifications, the app version and process exit. Production: Tauri plugins.
pub trait Host: Send + Sync {
    /// Selected paths, or `None` when cancelled.
    fn open_dialog(&self, options: OpenDialogOptions) -> BoxFuture<'_, Option<Vec<PathBuf>>>;
    /// The chosen path, or `None` when cancelled.
    fn save_dialog(&self, options: SaveDialogOptions) -> BoxFuture<'_, Option<PathBuf>>;
    /// The index of the button the user chose; a dismissed dialog answers the last button.
    fn message_dialog(&self, options: MessageDialogOptions) -> BoxFuture<'_, usize>;
    /// Open an `http`/`https` URL in the browser. Callers check the scheme; the host refuses any other.
    fn open_url(&self, url: &str) -> Result<(), HostError>;
    /// Open a file or folder with its default application.
    fn open_path(&self, path: &std::path::Path) -> Result<(), HostError>;
    /// Show a file selected in the file manager.
    fn reveal_in_folder(&self, path: &std::path::Path) -> Result<(), HostError>;
    fn clipboard_read_text(&self) -> BoxFuture<'_, Result<String, HostError>>;
    fn clipboard_write_text(&self, text: &str) -> BoxFuture<'_, Result<(), HostError>>;
    fn notify(&self, title: &str, body: Option<&str>) -> Result<(), HostError>;
    fn app_version(&self) -> String;
    /// The OS locale (`en-US`, `vi_VN`), if known.
    fn system_locale(&self) -> Option<String>;
    /// Exit through Tauri's exit path, so the frozen shutdown order runs.
    fn exit(&self, code: i32);
    /// Start `program` with no arguments once this process has exited (after the
    /// single-instance name is released), for the updater's relaunch. A launch
    /// link or workspace is deliberately not replayed.
    fn relaunch_after_exit(&self, program: PathBuf);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn window_ids_serialize_as_bare_numbers_and_labels_round_trip() {
        assert_eq!(serde_json::to_value(IpcSessionOwner { tab_id: "t".into(), win_id: WindowId(3) }).unwrap(), json!({ "tabId": "t", "winId": 3 }));
        assert_eq!(WindowId(7).label(), "main-7");
        assert_eq!(WindowId::QUICK_ENTRY.label(), "quick-entry");
        assert_eq!(Caller::from_label("main-7"), Some(Caller::main(WindowId(7))));
        assert_eq!(Caller::from_label("quick-entry"), Some(Caller::quick_entry()));
        assert_eq!(Caller::from_label("main-0"), None);
        assert_eq!(Caller::from_label("other"), None);
    }

    #[test]
    fn tab_info_keeps_null_and_absent_apart() {
        let cleared: IpcTabInfo = serde_json::from_value(json!({
            "tabId": "a", "cwd": "/w", "status": "ready", "kind": "agent", "sessionPath": null
        }))
        .unwrap();
        assert_eq!(cleared.session_path, Some(None));
        assert_eq!(cleared.title, None);
        let json = serde_json::to_value(&cleared).unwrap();
        assert_eq!(json["sessionPath"], Value::Null);
        assert!(json.get("title").is_none());
        assert_eq!(json["status"], "ready");
    }

    #[test]
    fn every_inventoried_cross_module_call_is_a_trait_method() {
        #[derive(serde::Deserialize)]
        struct Entry {
            caller: String,
            callee: String,
            method: String,
        }
        let entries: Vec<Entry> = serde_json::from_str(include_str!("../contracts/cross-module-calls.json")).unwrap();
        assert!(entries.len() >= 40);
        let source = include_str!("ports.rs");
        let modules = ["foundation", "omp", "tabs", "desktop", "services", "ollama", "updater"];
        for entry in entries {
            assert!(modules.contains(&entry.caller.as_str()), "unknown caller {}", entry.caller);
            assert!(modules.contains(&entry.callee.as_str()), "unknown callee {}", entry.callee);
            let needle = format!("fn {}(", entry.method);
            assert!(source.contains(&needle), "{} ({} -> {}) has no trait method", entry.method, entry.caller, entry.callee);
        }
    }

    #[test]
    fn wire_enums_use_the_typescript_spellings() {
        assert_eq!(serde_json::to_value(TabStatus::Running).unwrap(), "running");
        assert_eq!(serde_json::to_value(TabStatus::from(SidecarStatus::Restarting)).unwrap(), "restarting");
        assert_eq!(serde_json::to_value(WindowKind::QuickEntry).unwrap(), "quick-entry");
        assert_eq!(serde_json::to_value(RunProgressState::Working).unwrap(), "working");
        assert_eq!(serde_json::to_value(SessionScope::Global).unwrap(), "global");
        assert_eq!(serde_json::to_value(TabSplitAxis::Columns).unwrap(), "columns");
    }
}
