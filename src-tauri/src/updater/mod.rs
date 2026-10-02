//! Module `updater`: the yml-feed updater. The bodies below are the stubs the
//! port replaces.

pub mod ipc;

use std::any::Any;
use std::sync::Arc;

use futures_util::future::BoxFuture;

use serde_json::Value;
use tauri::AppHandle;

use crate::bridge::{Registry, Scope};
use crate::ctx::AppCtx;
use crate::ports::{CtxRef, UpdaterPort};

pub const CHANNELS: &[(&str, Scope)] = &[
    ("updater:check", Scope::Main),
    ("updater:download", Scope::Main),
    ("updater:apply", Scope::Main),
    ("updater:getStatus", Scope::Main),
    ("updater:version", Scope::Main),
];

pub const EMITS: &[&str] = &[
    "updater:status",
];

pub fn register(reg: &mut Registry) {
    reg.register("updater:check", Scope::Main, ipc::updater_check);
    reg.register("updater:download", Scope::Main, ipc::updater_download);
    reg.register("updater:apply", Scope::Main, ipc::updater_apply);
    reg.register("updater:getStatus", Scope::Main, ipc::updater_get_status);
    reg.register("updater:version", Scope::Main, ipc::updater_version);
}

/// Production `UpdaterPort`.
pub struct Updater {
    ctx: CtxRef,
}

impl Updater {
    pub fn new(ctx: CtxRef) -> Self {
        Self { ctx }
    }

    /// The application context; `None` only while the process shuts down.
    fn ctx(&self) -> Option<Arc<AppCtx>> {
        self.ctx.upgrade()
    }
}

impl UpdaterPort for Updater {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn check_now(&self) {
        todo!()
    }

    fn status(&self) -> Value {
        todo!()
    }

    fn shutdown(&self) -> BoxFuture<'_, ()> {
        // Nothing was downloaded yet; the port installs a pending update here.
        let _ = self.ctx();
        Box::pin(std::future::ready(()))
    }
}

pub fn init(ctx: &Arc<AppCtx>, app: &AppHandle) -> tauri::Result<()> {
    let _ = (ctx, app);
    Ok(())
}
