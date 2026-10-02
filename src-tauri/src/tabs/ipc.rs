//! Handlers for the channels this module owns. Every body starts as a
//! `not_ported` stub; the module's port replaces them and `check-module.sh`
//! fails while any stub remains.

use std::sync::Arc;

use serde_json::Value;

use crate::bridge::{IpcError, Reply};
use crate::ctx::AppCtx;
use crate::ports::Caller;

/// `rpc:command`
pub fn rpc_command(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("rpc:command"))
}

/// `rpc:command-for-tab`
pub fn rpc_command_for_tab(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("rpc:command-for-tab"))
}

/// `extension-ui:respond`
pub fn extension_ui_respond(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("extension-ui:respond"))
}

/// `host-tool:result`
pub fn host_tool_result(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("host-tool:result"))
}

/// `host-tool:update`
pub fn host_tool_update(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("host-tool:update"))
}

/// `host-uri:result`
pub fn host_uri_result(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("host-uri:result"))
}

/// `tab:spawn`
pub fn tab_spawn(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("tab:spawn"))
}

/// `tab:close`
pub fn tab_close(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("tab:close"))
}

/// `tab:set-active`
pub fn tab_set_active(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("tab:set-active"))
}

/// `tab:set-view`
pub fn tab_set_view(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("tab:set-view"))
}

/// `tab:get-all`
pub fn tab_get_all(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("tab:get-all"))
}

/// `tab:get-session-owner`
pub fn tab_get_session_owner(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("tab:get-session-owner"))
}

/// `sidecar:restart`
pub fn sidecar_restart(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("sidecar:restart"))
}

/// `sidecar:status-get`
pub fn sidecar_status_get(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("sidecar:status-get"))
}

/// `sidecar:select-project`
pub fn sidecar_select_project(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("sidecar:select-project"))
}

/// `sidecar:set-project`
pub fn sidecar_set_project(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("sidecar:set-project"))
}

/// `sidecar:default-workspace`
pub fn sidecar_default_workspace(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("sidecar:default-workspace"))
}

/// `prefs:update-launch-profile`
pub fn prefs_update_launch_profile(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("prefs:update-launch-profile"))
}
