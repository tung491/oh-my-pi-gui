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
use std::collections::HashMap;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use serde_json::Value;
use tauri::AppHandle;
use tokio::sync::OnceCell;

use crate::bridge::{Registry, Scope};
use crate::ctx::AppCtx;
use crate::ports::{CtxRef, OllamaPort, WindowId};

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

pub(crate) const OLLAMA_DOWNLOAD_URL: &str = "https://ollama.com/download";

/// The login-shell environment overlay, process env laid on top (not in
/// `OVERLAY_DENYLIST`, so `OLLAMA_HOST` and `PATH` both come through).
async fn env_overlay(ctx: &CtxRef) -> HashMap<String, String> {
    let mut env = match ctx.upgrade() {
        Some(ctx) => ctx.omp.spawn_env().await,
        None => HashMap::new(),
    };
    for (key, value) in std::env::vars() {
        env.insert(key, value);
    }
    env
}

/// The endpoint for this app run, cached like `resolveOllamaBaseUrl`.
async fn resolve_base_url(ctx: &CtxRef, cache: &OnceCell<String>) -> String {
    cache.get_or_init(|| async { base_url::ollama_base_url(&env_overlay(ctx).await) }).await.clone()
}

/// `NodeJS.Platform`-shaped name, matching the strings `OllamaStatus.platform` carried in Electron.
fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

fn install_checks(ctx: CtxRef) -> probe::InstallChecks {
    probe::default_install_checks(move || {
        let ctx = ctx.clone();
        Box::pin(async move { env_overlay(&ctx).await.get("PATH").cloned().unwrap_or_default() })
    })
}

async fn probe_with(ctx: &CtxRef, cache: &Arc<OnceCell<String>>) -> probe::OllamaStatus {
    let base_url = resolve_base_url(ctx, cache).await;
    let checks = install_checks(ctx.clone());
    let local_app_data = std::env::var("LOCALAPPDATA").ok();
    probe::probe_ollama(&base_url, node_platform(), &checks, probe::PROBE_TIMEOUT_MS, local_app_data.as_deref()).await
}

/// Production `OllamaPort`.
pub struct Ollama {
    ctx: CtxRef,
    base_url_cache: Arc<OnceCell<String>>,
    puller: pull::OllamaPuller,
    remedy_gate: remedy::RemedyGate,
}

impl Ollama {
    pub fn new(ctx: CtxRef) -> Self {
        let base_url_cache = Arc::new(OnceCell::new());

        let base_url_ctx = ctx.clone();
        let base_url_cache_for_puller = base_url_cache.clone();
        let base_url_fn: pull::BaseUrlFn = Arc::new(move || {
            let ctx = base_url_ctx.clone();
            let cache = base_url_cache_for_puller.clone();
            Box::pin(async move { resolve_base_url(&ctx, &cache).await })
        });

        let sink_ctx = ctx.clone();
        let progress_sink: pull::ProgressSink = Arc::new(move |win_id, frame| {
            if let Some(ctx) = sink_ctx.upgrade() {
                if let Ok(value) = serde_json::to_value(&frame) {
                    ctx.bridge.emit_to_window(win_id, "ollama:pull-progress", value);
                }
            }
        });

        Self {
            ctx,
            base_url_cache,
            puller: pull::OllamaPuller::new(base_url_fn, progress_sink),
            remedy_gate: remedy::RemedyGate::new(),
        }
    }

    /// The application context; `None` only while the process shuts down.
    fn ctx(&self) -> Option<Arc<AppCtx>> {
        self.ctx.upgrade()
    }

    pub(crate) async fn status(&self) -> probe::OllamaStatus {
        probe_with(&self.ctx, &self.base_url_cache).await
    }

    pub(crate) async fn model_screen(&self) -> catalog::ModelScreen {
        let (machine, status) = tokio::join!(hardware::read_machine_default(), self.status());
        let installed_tags = (status.state == probe::OllamaState::Ok).then_some(status.installed_tags.as_slice());
        catalog::choose_models(machine.as_ref(), &catalog::OLLAMA_CATALOG, installed_tags)
    }

    pub(crate) async fn pull(&self, tag: &str, win_id: WindowId) -> pull::PullProgress {
        self.puller.pull(tag, Some(win_id)).await
    }

    pub(crate) fn pull_cancel(&self) {
        self.puller.cancel();
    }

    pub(crate) async fn warm(&self, tag: String) {
        let base_url = resolve_base_url(&self.ctx, &self.base_url_cache).await;
        warm::warm_model_default(&base_url, &tag).await;
    }

    fn probe_fn(&self) -> remedy::ProbeFn {
        let ctx = self.ctx.clone();
        let cache = self.base_url_cache.clone();
        Arc::new(move || {
            let ctx = ctx.clone();
            let cache = cache.clone();
            Box::pin(async move { probe_with(&ctx, &cache).await })
        })
    }

    pub(crate) async fn run_remedy(&self, id: probe::OllamaRemedyId) -> Result<remedy::OllamaRemedyResult, String> {
        let probe_fn = self.probe_fn();
        let probe_fn_for_attempt = probe_fn.clone();
        let broadcast_ctx = self.ctx.clone();
        self.remedy_gate
            .run(id, &probe_fn, move || {
                Box::pin(async move {
                    let throttle = install_progress::InstallProgressThrottle::new(move |frame| {
                        if let Some(ctx) = broadcast_ctx.upgrade() {
                            if let Ok(value) = serde_json::to_value(&frame) {
                                ctx.bridge.broadcast_main("ollama:install-progress", value);
                            }
                        }
                    });
                    let on_progress: &(dyn Fn(install_progress::OllamaInstallProgress) + Send + Sync) = &move |frame| throttle.push(frame);
                    remedy::run_remedy_real(id, node_platform(), &probe_fn_for_attempt, remedy::SettleOptions::default(), Some(on_progress)).await
                })
            })
            .await
    }
}

impl OllamaPort for Ollama {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn shutdown(&self) -> BoxFuture<'_, ()> {
        // The remedy's own `pkexec` child has no cancel (2026-10-02 decision:
        // a root child of `pkexec` cannot be stopped safely); only the pull
        // this port owns is stopped here.
        self.puller.cancel();
        let _ = self.ctx();
        Box::pin(std::future::ready(()))
    }
}

pub fn init(ctx: &Arc<AppCtx>, app: &AppHandle) -> tauri::Result<()> {
    let _ = (ctx, app);
    Ok(())
}

/// `args[0].get(field)` as a string, or `None`.
pub(crate) fn string_field<'a>(args: &'a [Value], field: &str) -> Option<&'a str> {
    args.first()?.get(field)?.as_str()
}
