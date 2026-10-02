//! Module `updater`: the yml-feed updater. The bodies below are the stubs the
//! port replaces.

pub mod ipc;

use std::sync::Arc;

use serde_json::Value;
use tauri::AppHandle;

use crate::bridge::{Registry, Scope};
use crate::ctx::AppCtx;
use crate::ports::UpdaterPort;

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
    _private: (),
}

impl Updater {
    pub fn new() -> Self {
        Self { _private: () }
    }
}

impl Default for Updater {
    fn default() -> Self {
        Self::new()
    }
}

impl UpdaterPort for Updater {
    fn check_now(&self) {
        todo!()
    }

    fn status(&self) -> Value {
        todo!()
    }
}

pub fn init(ctx: &Arc<AppCtx>, app: &AppHandle) -> tauri::Result<()> {
    let _ = (ctx, app);
    Ok(())
}
