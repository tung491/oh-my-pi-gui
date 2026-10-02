//! Module `ollama`: probe, hardware, model screen, pull, remedy, warm. The
//! bodies below are the stubs the port replaces.

pub mod ipc;

mod base_url;
mod catalog;
mod hardware;
mod install_progress;
mod probe;
mod pull;
mod remedy;
mod warm;
#[cfg(test)]
mod test_fake_ollama;

use std::any::Any;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use tauri::AppHandle;

use crate::bridge::{Registry, Scope};
use crate::ctx::AppCtx;
use crate::ports::{CtxRef, OllamaPort};

pub const CHANNELS: &[(&str, Scope)] = &[
    ("ollama:status", Scope::Main),
    ("ollama:model-screen", Scope::Main),
    ("ollama:pull", Scope::Main),
    ("ollama:pull-cancel", Scope::Main),
    ("ollama:warm", Scope::Main),
    ("ollama:remedy", Scope::Main),
    ("ollama:open-download", Scope::Main),
];

pub const EMITS: &[&str] = &[
    "ollama:pull-progress",
    "ollama:install-progress",
];

pub fn register(reg: &mut Registry) {
    reg.register("ollama:status", Scope::Main, ipc::ollama_status);
    reg.register("ollama:model-screen", Scope::Main, ipc::ollama_model_screen);
    reg.register("ollama:pull", Scope::Main, ipc::ollama_pull);
    reg.register("ollama:pull-cancel", Scope::Main, ipc::ollama_pull_cancel);
    reg.register("ollama:warm", Scope::Main, ipc::ollama_warm);
    reg.register("ollama:remedy", Scope::Main, ipc::ollama_remedy);
    reg.register("ollama:open-download", Scope::Main, ipc::ollama_open_download);
}

/// Production `OllamaPort`.
pub struct Ollama {
    ctx: CtxRef,
}

impl Ollama {
    pub fn new(ctx: CtxRef) -> Self {
        Self { ctx }
    }

    /// The application context; `None` only while the process shuts down.
    fn ctx(&self) -> Option<Arc<AppCtx>> {
        self.ctx.upgrade()
    }
}

impl OllamaPort for Ollama {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn shutdown(&self) -> BoxFuture<'_, ()> {
        // No pull or remedy runs yet; the port cancels them here.
        let _ = self.ctx();
        Box::pin(std::future::ready(()))
    }
}

pub fn init(ctx: &Arc<AppCtx>, app: &AppHandle) -> tauri::Result<()> {
    let _ = (ctx, app);
    Ok(())
}
