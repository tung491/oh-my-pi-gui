//! Handlers for the channels this module owns. Each one answers from the
//! `Updater` behind `ctx.updater`; the long-running ones (`check`, `download`,
//! `apply`) do their synchronous state change first and finish in a `Later`
//! future, as `updater.ts` awaited them.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use serde_json::Value;

use crate::bridge::{IpcError, Reply};
use crate::ctx::AppCtx;
use crate::ports::{Caller, UpdaterPort};

use super::Updater;

fn not_installed() -> IpcError {
    IpcError::new("the updater is not installed in this context")
}

/// Run `work` against the module's state once the future is polled. The future
/// holds the port, not the context, so it can never keep the context alive.
fn later<F>(ctx: &Arc<AppCtx>, work: F) -> Reply
where
    F: for<'a> FnOnce(&'a Updater) -> BoxFuture<'a, Result<Value, IpcError>> + Send + 'static,
{
    let port: Arc<dyn UpdaterPort> = ctx.updater.clone();
    Reply::Later(Box::pin(async move {
        let Some(updater) = port.as_any().downcast_ref::<Updater>() else { return Err(not_installed()) };
        work(updater).await
    }))
}

/// `updater:check`: a manual check; answers the status it ended in.
pub fn updater_check(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (caller, args);
    later(ctx, |updater| Box::pin(async move { serde_json::to_value(updater.check(super::CheckKind::Manual).await).map_err(IpcError::from) }))
}

/// `updater:download`: only while an update is available; answers the status it ended in.
pub fn updater_download(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (caller, args);
    later(ctx, |updater| Box::pin(async move { serde_json::to_value(updater.download().await).map_err(IpcError::from) }))
}

/// `updater:apply`: install a downloaded update.
pub fn updater_apply(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (caller, args);
    later(ctx, |updater| {
        Box::pin(async move {
            updater.apply().await;
            Ok(Value::Null)
        })
    })
}

/// `updater:getStatus`: the current status, replayed to a window that asks.
pub fn updater_get_status(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (caller, args);
    Reply::ok(ctx.updater.status())
}

/// `updater:version`: the running build's version.
pub fn updater_version(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (caller, args);
    Reply::ok(Value::String(ctx.host.app_version()))
}
