//! Handlers for the channels this module owns. Every body starts as a
//! `not_ported` stub; the module's port replaces them and `check-module.sh`
//! fails while any stub remains.

use std::sync::Arc;

use serde_json::Value;

use crate::bridge::{IpcError, Reply};
use crate::ctx::AppCtx;
use crate::ports::Caller;

/// `ollama:status`
pub fn ollama_status(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("ollama:status"))
}

/// `ollama:model-screen`
pub fn ollama_model_screen(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("ollama:model-screen"))
}

/// `ollama:pull`
pub fn ollama_pull(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("ollama:pull"))
}

/// `ollama:pull-cancel`
pub fn ollama_pull_cancel(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("ollama:pull-cancel"))
}

/// `ollama:warm`
pub fn ollama_warm(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("ollama:warm"))
}

/// `ollama:remedy`
pub fn ollama_remedy(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("ollama:remedy"))
}

/// `ollama:open-download`
pub fn ollama_open_download(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("ollama:open-download"))
}
