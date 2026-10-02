//! Module `tabs`: the sidecar pool, tab routing and the tab/RPC/sidecar
//! handlers. The bodies below are the stubs the port replaces.

pub mod ipc;
mod snowflake;
mod window_spawn_target;

use std::any::Any;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use serde_json::Value;
use tauri::AppHandle;

use crate::bridge::{Registry, Scope};
use crate::ctx::AppCtx;
use crate::ports::{CtxRef, 
    AcquireOptions, Caller, IpcSessionOwner, IpcTabInfo, IpcTabViewSplit, PersistedTabLayout, SidecarHandle, TabsPort,
    WindowId, WindowTabFact, WindowTabsChangedListener,
};

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
}

impl Tabs {
    pub fn new(ctx: CtxRef) -> Self {
        Self { ctx }
    }

    /// The application context; `None` only while the process shuts down.
    fn ctx(&self) -> Option<Arc<AppCtx>> {
        self.ctx.upgrade()
    }
}

impl TabsPort for Tabs {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn acquire(&self, options: AcquireOptions) -> Option<String> {
        let _ = options;
        todo!()
    }

    fn size(&self) -> usize {
        todo!()
    }

    fn at_cap(&self) -> bool {
        todo!()
    }

    fn sidecar_for_window(&self, win_id: WindowId) -> Option<Arc<dyn SidecarHandle>> {
        let _ = win_id;
        todo!()
    }

    fn sidecar_for_tab(&self, win_id: WindowId, tab_id: &str) -> Option<Arc<dyn SidecarHandle>> {
        let _ = (win_id, tab_id);
        todo!()
    }

    fn active_tab_for_window(&self, win_id: WindowId) -> Option<String> {
        let _ = win_id;
        todo!()
    }

    fn command_for_idle_session(&self, session_path: &str, command: Value) -> BoxFuture<'static, Option<Value>> {
        let _ = (session_path, command);
        todo!()
    }

    fn set_active_tab(&self, win_id: WindowId, tab_id: &str) -> bool {
        let _ = (win_id, tab_id);
        todo!()
    }

    fn set_tab_view(&self, win_id: WindowId, focused_tab_id: &str, visible_tab_ids: &[String], split: Option<IpcTabViewSplit>) -> bool {
        let _ = (win_id, focused_tab_id, visible_tab_ids, split);
        todo!()
    }

    fn release_tab(&self, tab_id: &str) -> bool {
        let _ = tab_id;
        todo!()
    }

    fn release_window(&self, win_id: WindowId) {
        let _ = win_id;
        todo!()
    }

    fn session_owner(&self, session_path: &str) -> Option<IpcSessionOwner> {
        let _ = session_path;
        todo!()
    }

    fn session_owner_is_live(&self, session_path: &str) -> bool {
        let _ = session_path;
        todo!()
    }

    fn foreign_session_owner(&self, tab_id: Option<&str>, session_path: &str) -> Option<IpcSessionOwner> {
        let _ = (tab_id, session_path);
        todo!()
    }

    fn note_session_file(&self, tab_id: &str, session_file: Option<&str>) {
        let _ = (tab_id, session_file);
        todo!()
    }

    fn adopt_session_cwd(&self, tab_id: &str, cwd: &str) -> bool {
        let _ = (tab_id, cwd);
        todo!()
    }

    fn route_side_channel(&self, id: &str, frame: Value, is_final: bool) -> bool {
        let _ = (id, frame, is_final);
        todo!()
    }

    fn tabs_for_window(&self, win_id: WindowId) -> Vec<IpcTabInfo> {
        let _ = win_id;
        todo!()
    }

    fn tab_inventory(&self) -> Vec<WindowTabFact> {
        todo!()
    }

    fn tab_layout_for_window(&self, win_id: WindowId) -> Option<PersistedTabLayout> {
        let _ = win_id;
        todo!()
    }

    fn restore_layout(&self, win_id: WindowId, layout: PersistedTabLayout) -> usize {
        let _ = (win_id, layout);
        todo!()
    }

    fn dispose_all(&self) -> BoxFuture<'_, ()> {
        // No sidecars exist yet; the port stops every supervisor here.
        let _ = self.ctx();
        Box::pin(std::future::ready(()))
    }

    fn on_window_tabs_changed(&self, listener: WindowTabsChangedListener) {
        let _ = listener;
        todo!()
    }

    fn cwd_for(&self, caller: Caller, tab_id: Option<&str>) -> Option<String> {
        let _ = (caller, tab_id);
        todo!()
    }
}

/// Start the module's background work (ready health checks, window-closed release).
pub fn init(ctx: &Arc<AppCtx>, app: &AppHandle) -> tauri::Result<()> {
    let _ = (ctx, app);
    Ok(())
}
