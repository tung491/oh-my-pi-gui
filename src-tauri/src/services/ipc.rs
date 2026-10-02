//! Handlers for the channels this module owns. Every body starts as a
//! `not_ported` stub; the module's port replaces them and `check-module.sh`
//! fails while any stub remains.

use std::sync::Arc;

use serde_json::Value;

use crate::bridge::{IpcError, Reply};
use crate::ctx::AppCtx;
use crate::ports::Caller;

/// `runtime:error-report`
pub fn runtime_error_report(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    // Normalized and bounded by the runtime log; the cwd comes from the caller's window.
    let report = args.into_iter().next().unwrap_or(Value::Null);
    let cwd = ctx.desktop.record(caller.win_id).map(|record| record.cwd);
    crate::runtime_log::write(&report, Some(caller.win_id.0), cwd.as_deref());
    Reply::ok(Value::Null)
}

/// `runtime:log-path`
pub fn runtime_log_path(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::ok(Value::String(crate::runtime_log::path().to_string_lossy().to_string()))
}

/// `log:snapshot`
pub fn log_snapshot(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("log:snapshot"))
}

/// `sessions:list`
pub fn sessions_list(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("sessions:list"))
}

/// `sessions:delete`
pub fn sessions_delete(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("sessions:delete"))
}

/// `sessions:rename`
pub fn sessions_rename(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("sessions:rename"))
}

/// `sessions:search`
pub fn sessions_search(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("sessions:search"))
}

/// `session:open-new-window`
pub fn session_open_new_window(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("session:open-new-window"))
}

/// `session:consume-pending`
pub fn session_consume_pending(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("session:consume-pending"))
}

/// `system:open-external`
pub fn system_open_external(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("system:open-external"))
}

/// `system:open-path`
pub fn system_open_path(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("system:open-path"))
}

/// `system:save-dialog`
pub fn system_save_dialog(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("system:save-dialog"))
}

/// `system:open-dialog`
pub fn system_open_dialog(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("system:open-dialog"))
}

/// `system:clipboard-read`
pub fn system_clipboard_read(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("system:clipboard-read"))
}

/// `system:notify`
pub fn system_notify(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("system:notify"))
}

/// `prefs:get`
pub fn prefs_get(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("prefs:get"))
}

/// `prefs:set`
pub fn prefs_set(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("prefs:set"))
}

/// `models:providers-list`
pub fn models_providers_list(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("models:providers-list"))
}

/// `provider-cleanup:config`
pub fn provider_cleanup_config(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("provider-cleanup:config"))
}

/// `fs:list`
pub fn fs_list(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("fs:list"))
}

/// `fs:read`
pub fn fs_read(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("fs:read"))
}

/// `fs:read-plan`
pub fn fs_read_plan(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("fs:read-plan"))
}

/// `fs:read-image`
pub fn fs_read_image(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("fs:read-image"))
}

/// `editor:open-external`
pub fn editor_open_external(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("editor:open-external"))
}
