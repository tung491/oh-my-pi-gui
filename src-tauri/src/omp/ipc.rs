//! Handlers for the channels this module owns. Every body starts as a
//! `not_ported` stub; the module's port replaces them and `check-module.sh`
//! fails while any stub remains.

use std::sync::Arc;

use serde_json::Value;

use crate::bridge::{IpcError, Reply};
use crate::ctx::AppCtx;
use crate::ports::Caller;

/// `stats:fetch`
pub fn stats_fetch(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("stats:fetch"))
}

/// `bench:run`
pub fn bench_run(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("bench:run"))
}

/// `bench:abort`
pub fn bench_abort(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("bench:abort"))
}
