//! Module `tabs`: the sidecar pool, tab routing and the tab/RPC/sidecar
//! handlers (ports of `sidecar-pool.ts`, `tab-spawn.ts`, `snowflake.ts`, the
//! pool factory and ready health check in `index.ts:356-399`, and the tab,
//! RPC and sidecar handlers in `ipc.ts`).

pub mod ipc;
mod pool;
mod snowflake;
mod tab_spawn;
#[cfg(test)]
mod window_spawn_target;

use std::any::Any;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use serde_json::Value;
use tauri::AppHandle;

use crate::bridge::{Registry, Scope};
use crate::ctx::AppCtx;
use crate::ports::{
    AcquireOptions, Caller, CtxRef, IpcSessionOwner, IpcTabInfo, IpcTabViewSplit, PersistedTabLayout, SidecarHandle, TabsPort, WindowId,
    WindowTabFact, WindowTabsChangedListener,
};

use pool::SidecarPool;

/// The pool's hard cap, counted over tabs across every window.
const MAX_TABS: usize = 10;

pub const CHANNELS: &[(&str, Scope)] = &[
    ("rpc:command", Scope::Main),
    ("rpc:command-for-tab", Scope::Main),
    ("extension-ui:respond", Scope::Main),
    ("host-tool:result", Scope::Main),
    ("host-tool:update", Scope::Main),
    ("host-uri:result", Scope::Main),
    ("tab:spawn", Scope::Main),
    ("tab:close", Scope::Main),
    ("tab:set-active", Scope::Main),
    ("tab:set-view", Scope::Main),
    ("tab:get-all", Scope::Main),
    ("tab:get-session-owner", Scope::Main),
    ("sidecar:restart", Scope::Main),
    ("sidecar:status-get", Scope::Main),
    ("sidecar:select-project", Scope::Main),
    ("sidecar:set-project", Scope::Main),
    ("sidecar:default-workspace", Scope::Main),
    ("prefs:update-launch-profile", Scope::Main),
];

pub const EMITS: &[&str] = &[
    "rpc:events",
    "sidecar:status",
    "tab:status",
    "extension-ui:request",
    "host-tool:call",
    "host-uri:request",
    "subagent:frame",
    "commands:update",
    "config:update",
    "prompt:result",
    "command:output",
    "session-info:update",
    "extension:error",
    "live:update",
    "model-catalog:update",
];

pub fn register(reg: &mut Registry) {
    reg.register("rpc:command", Scope::Main, ipc::rpc_command);
    reg.register("rpc:command-for-tab", Scope::Main, ipc::rpc_command_for_tab);
    reg.register("extension-ui:respond", Scope::Main, ipc::extension_ui_respond);
    reg.register("host-tool:result", Scope::Main, ipc::host_tool_result);
    reg.register("host-tool:update", Scope::Main, ipc::host_tool_update);
    reg.register("host-uri:result", Scope::Main, ipc::host_uri_result);
    reg.register("tab:spawn", Scope::Main, ipc::tab_spawn);
    reg.register("tab:close", Scope::Main, ipc::tab_close);
    reg.register("tab:set-active", Scope::Main, ipc::tab_set_active);
    reg.register("tab:set-view", Scope::Main, ipc::tab_set_view);
    reg.register("tab:get-all", Scope::Main, ipc::tab_get_all);
    reg.register("tab:get-session-owner", Scope::Main, ipc::tab_get_session_owner);
    reg.register("sidecar:restart", Scope::Main, ipc::sidecar_restart);
    reg.register("sidecar:status-get", Scope::Main, ipc::sidecar_status_get);
    reg.register("sidecar:select-project", Scope::Main, ipc::sidecar_select_project);
    reg.register("sidecar:set-project", Scope::Main, ipc::sidecar_set_project);
    reg.register("sidecar:default-workspace", Scope::Main, ipc::sidecar_default_workspace);
    reg.register("prefs:update-launch-profile", Scope::Main, ipc::prefs_update_launch_profile);
}

/// Production `TabsPort`.
pub struct Tabs {
    ctx: CtxRef,
    pool: SidecarPool,
}

impl Tabs {
    pub fn new(ctx: CtxRef) -> Self {
        let pool = SidecarPool::new(ctx.clone(), MAX_TABS);
        Self { ctx, pool }
    }

    /// A pool with a different cap, for tests of the cap itself.
    #[cfg(test)]
    fn with_max(ctx: CtxRef, max: usize) -> Self {
        let pool = SidecarPool::new(ctx.clone(), max);
        Self { ctx, pool }
    }

    /// The application context; `None` only while the process shuts down.
    fn ctx(&self) -> Option<Arc<AppCtx>> {
        self.ctx.upgrade()
    }
}

/// `command_for_idle_session` resolves `None` exactly where TS returned `null`
/// (no owner, a run or compaction in flight, not ready, no RPC client). A
/// delivery failure resolves `Some({ "type": "response", "success": false,
/// "error": <message> })`, so a caller that throws `response.error` on
/// `!success` reports the same message the TS rejection carried.
impl TabsPort for Tabs {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn acquire(&self, options: AcquireOptions) -> Option<String> {
        self.pool.acquire(options)
    }

    fn size(&self) -> usize {
        self.pool.size()
    }

    fn at_cap(&self) -> bool {
        self.pool.at_cap()
    }

    fn sidecar_for_window(&self, win_id: WindowId) -> Option<Arc<dyn SidecarHandle>> {
        self.pool.sidecar_for_window(win_id)
    }

    fn sidecar_for_tab(&self, win_id: WindowId, tab_id: &str) -> Option<Arc<dyn SidecarHandle>> {
        self.pool.sidecar_for_tab(win_id, tab_id)
    }

    fn active_tab_for_window(&self, win_id: WindowId) -> Option<String> {
        self.pool.active_tab_for_window(win_id)
    }

    fn command_for_idle_session(&self, session_path: &str, command: Value) -> BoxFuture<'static, Option<Value>> {
        self.pool.command_for_idle_session(session_path, command)
    }

    fn set_active_tab(&self, win_id: WindowId, tab_id: &str) -> bool {
        self.pool.set_active_tab(win_id, tab_id)
    }

    fn set_tab_view(&self, win_id: WindowId, focused_tab_id: &str, visible_tab_ids: &[String], split: Option<IpcTabViewSplit>) -> bool {
        self.pool.set_tab_view(win_id, focused_tab_id, visible_tab_ids, split)
    }

    fn release_tab(&self, tab_id: &str) -> bool {
        self.pool.release_tab(tab_id)
    }

    fn release_window(&self, win_id: WindowId) {
        self.pool.release_window(win_id);
    }

    fn session_owner(&self, session_path: &str) -> Option<IpcSessionOwner> {
        self.pool.session_owner(session_path)
    }

    fn session_owner_is_live(&self, session_path: &str) -> bool {
        self.pool.session_owner_is_live(session_path)
    }

    fn foreign_session_owner(&self, tab_id: Option<&str>, session_path: &str) -> Option<IpcSessionOwner> {
        self.pool.foreign_session_owner(tab_id, session_path)
    }

    fn note_session_file(&self, tab_id: &str, session_file: Option<&str>) {
        self.pool.note_session_file(tab_id, session_file);
    }

    fn adopt_session_cwd(&self, tab_id: &str, cwd: &str) -> bool {
        self.pool.adopt_session_cwd(tab_id, cwd)
    }

    fn route_side_channel(&self, id: &str, frame: Value, is_final: bool) -> bool {
        self.pool.route_side_channel(id, frame, is_final)
    }

    fn tabs_for_window(&self, win_id: WindowId) -> Vec<IpcTabInfo> {
        self.pool.tabs_for_window(win_id)
    }

    fn tab_inventory(&self) -> Vec<WindowTabFact> {
        self.pool.tab_inventory()
    }

    fn any_in_flight(&self) -> bool {
        self.pool.any_in_flight()
    }

    fn tab_layout_for_window(&self, win_id: WindowId) -> Option<PersistedTabLayout> {
        self.pool.tab_layout_for_window(win_id)
    }

    fn restore_layout(&self, win_id: WindowId, layout: PersistedTabLayout) -> usize {
        self.pool.restore_layout(win_id, layout)
    }

    fn dispose_all(&self) -> BoxFuture<'_, ()> {
        self.pool.dispose_all()
    }

    fn on_window_tabs_changed(&self, listener: WindowTabsChangedListener) {
        self.pool.on_window_tabs_changed(listener);
    }

    /// The tab's cwd when `tab_id` is given (and non-empty); otherwise the
    /// window's sidecar cwd, else the cwd its window record was created with.
    fn cwd_for(&self, caller: Caller, tab_id: Option<&str>) -> Option<String> {
        if let Some(tab_id) = tab_id.filter(|tab_id| !tab_id.is_empty()) {
            return self.pool.sidecar_for_tab(caller.win_id, tab_id).map(|sidecar| sidecar.cwd());
        }
        if let Some(sidecar) = self.pool.sidecar_for_window(caller.win_id) {
            return Some(sidecar.cwd());
        }
        self.ctx()?.desktop.record(caller.win_id).map(|record| record.cwd)
    }
}

/// Start the module's background work: the ready health check of every pooled
/// sidecar, and releasing a closed window's tabs.
pub fn init(ctx: &Arc<AppCtx>, app: &AppHandle) -> tauri::Result<()> {
    let _ = app;
    install(ctx);
    Ok(())
}

/// The runtime-free part of `init`, so tests can wire it over fakes.
fn install(ctx: &Arc<AppCtx>) {
    if let Some(tabs) = ctx.tabs.as_any().downcast_ref::<Tabs>() {
        tabs.pool.enable_health_check();
    }
    // The listener holds a `Weak`: an `Arc<AppCtx>` inside a port of that same
    // context would keep it alive forever.
    let weak = Arc::downgrade(ctx);
    ctx.desktop.on_window_closed(Box::new(move |record| {
        if let Some(ctx) = weak.upgrade() {
            ctx.tabs.release_window(record.id);
        }
    }));
}
