//! Handlers for the channels this module owns. Every body starts as a
//! `not_ported` stub; the module's port replaces them and `check-module.sh`
//! fails while any stub remains.

use std::sync::Arc;

use serde_json::Value;

use crate::bridge::{IpcError, Reply};
use crate::ctx::AppCtx;
use crate::ports::Caller;

/// `app:quit`
pub fn app_quit(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("app:quit"))
}

/// `quick-entry:submit`
pub fn quick_entry_submit(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("quick-entry:submit"))
}

/// `quick-entry:consume-restored`
pub fn quick_entry_consume_restored(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("quick-entry:consume-restored"))
}

/// `quick-entry:dismiss`
pub fn quick_entry_dismiss(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("quick-entry:dismiss"))
}

/// `quick-entry:claim`
pub fn quick_entry_claim(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("quick-entry:claim"))
}

/// `quick-entry:ack`
pub fn quick_entry_ack(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("quick-entry:ack"))
}

/// `quick-entry:return`
pub fn quick_entry_return(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("quick-entry:return"))
}

/// `quick-entry:shortcut-get`
pub fn quick_entry_shortcut_get(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("quick-entry:shortcut-get"))
}

/// `quick-entry:shortcut-set`
pub fn quick_entry_shortcut_set(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("quick-entry:shortcut-set"))
}

/// `quick-entry:shortcut-suspend`
pub fn quick_entry_shortcut_suspend(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("quick-entry:shortcut-suspend"))
}

/// `quick-entry:shortcut-notice`
pub fn quick_entry_shortcut_notice(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("quick-entry:shortcut-notice"))
}

/// `tray:state-push`
pub fn tray_state_push(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("tray:state-push"))
}

/// `progress:set`
pub fn progress_set(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("progress:set"))
}
