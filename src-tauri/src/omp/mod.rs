//! Module `omp`: every child process of the agent. The sidecar manager, the
//! NDJSON bridge, the stats server and the benchmark runner are ported here;
//! the bodies below are the stubs the port replaces.

mod event_batcher;
pub mod ipc;
mod rpc_bridge;
mod rpc_client;
pub mod supervisor;

use std::collections::HashMap;
use std::any::Any;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use tauri::AppHandle;

use crate::bridge::{Registry, Scope};
use crate::ctx::AppCtx;
use crate::ports::{CtxRef, EventBatcher, FlushCallback, OmpPort, SidecarEvents, SidecarHandle, SidecarOptions};

pub const CHANNELS: &[(&str, Scope)] = &[
    ("stats:fetch", Scope::Main),
    ("bench:run", Scope::Main),
    ("bench:abort", Scope::Main),
];

pub const EMITS: &[&str] = &[
    "stats:data",
];

pub fn register(reg: &mut Registry) {
    reg.register("stats:fetch", Scope::Main, ipc::stats_fetch);
    reg.register("bench:run", Scope::Main, ipc::bench_run);
    reg.register("bench:abort", Scope::Main, ipc::bench_abort);
}

/// Production `OmpPort`.
pub struct Omp {
    ctx: CtxRef,
}

impl Omp {
    pub fn new(ctx: CtxRef) -> Self {
        Self { ctx }
    }

    /// The application context; `None` only while the process shuts down.
    fn ctx(&self) -> Option<Arc<AppCtx>> {
        self.ctx.upgrade()
    }
}

impl OmpPort for Omp {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn new_sidecar(&self, options: SidecarOptions) -> (Arc<dyn SidecarHandle>, SidecarEvents) {
        let _ = options;
        todo!()
    }

    fn new_event_batcher(&self, flush: FlushCallback) -> Box<dyn EventBatcher> {
        Box::new(event_batcher::Batcher::new(flush))
    }

    fn spawn_env(&self) -> BoxFuture<'_, HashMap<String, String>> {
        todo!()
    }

    fn resolve_editor_command(&self) -> BoxFuture<'_, Option<String>> {
        todo!()
    }

    fn shutdown(&self) -> BoxFuture<'_, ()> {
        // Nothing runs yet; the port stops the stats server and any bench here.
        let _ = self.ctx();
        Box::pin(std::future::ready(()))
    }
}

/// Start the module's background work. Called once from `lib.rs` after `AppCtx` exists.
pub fn init(ctx: &Arc<AppCtx>, app: &AppHandle) -> tauri::Result<()> {
    let _ = (ctx, app);
    Ok(())
}
