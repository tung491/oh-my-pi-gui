//! Module `ollama`: probe, hardware, model screen, pull, remedy, warm, and the
//! context-fit scheduler that measures each local model's largest context.

pub mod ipc;

mod base_url;
mod catalog;
mod context_fit;
mod context_fit_scheduler;
mod context_fit_store;
mod hardware;
mod install_progress;
mod local;
mod probe;
mod pull;
mod remedy;
mod warm;
#[cfg(test)]
mod test_fake_ollama;

use std::any::Any;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures_util::future::BoxFuture;
use serde_json::Value;
use tauri::AppHandle;
use tokio::sync::OnceCell;

use crate::bridge::{Registry, Scope};
use crate::ctx::AppCtx;
use crate::paths;
use crate::ports::{CtxRef, OllamaPort, TabStatus, WindowId};
use crate::prefs::JsonStore;

pub const CHANNELS: &[(&str, Scope)] = &[
    ("ollama:status", Scope::Main),
    ("ollama:model-screen", Scope::Main),
    ("ollama:pull", Scope::Main),
    ("ollama:pull-cancel", Scope::Main),
    ("ollama:warm", Scope::Main),
    ("ollama:remedy", Scope::Main),
    ("ollama:open-download", Scope::Main),
    ("ollama:context-list", Scope::Main),
    ("ollama:context-measure", Scope::Main),
    ("ollama:context-set-cap", Scope::Main),
];

pub const EMITS: &[&str] = &[
    "ollama:pull-progress",
    "ollama:install-progress",
    context_fit_scheduler::CHANNEL_CONTEXT_PROGRESS,
    context_fit_scheduler::CHANNEL_CONTEXT_CHANGED,
];

pub fn register(reg: &mut Registry) {
    reg.register("ollama:status", Scope::Main, ipc::ollama_status);
    reg.register("ollama:model-screen", Scope::Main, ipc::ollama_model_screen);
    reg.register("ollama:pull", Scope::Main, ipc::ollama_pull);
    reg.register("ollama:pull-cancel", Scope::Main, ipc::ollama_pull_cancel);
    reg.register("ollama:warm", Scope::Main, ipc::ollama_warm);
    reg.register("ollama:remedy", Scope::Main, ipc::ollama_remedy);
    reg.register("ollama:open-download", Scope::Main, ipc::ollama_open_download);
    reg.register("ollama:context-list", Scope::Main, ipc::ollama_context_list);
    reg.register("ollama:context-measure", Scope::Main, ipc::ollama_context_measure);
    reg.register("ollama:context-set-cap", Scope::Main, ipc::ollama_context_set_cap);
}

/// The renderer's welcome dialog writes this once it closes (`WELCOME_COMPLETED_PREF`).
const WELCOME_COMPLETED_PREF: &str = "welcome.completed";

/// The user's own `OLLAMA_CONTEXT_LENGTH`: a positive whole number, or nothing.
fn parse_env_cap(value: Option<&String>) -> Option<u64> {
    value?.trim().parse::<u64>().ok().filter(|n| *n > 0)
}

/// Whether the models config in `agent_dir` (`models.yml`, else the legacy
/// `models.yaml`) has an `ollama` provider entry, which replaces the built-in
/// provider the context limits apply to. Unreadable or malformed files count as none.
fn has_configured_ollama_provider(agent_dir: &Path) -> bool {
    let preferred = agent_dir.join("models.yml");
    let file = if preferred.exists() { preferred } else { agent_dir.join("models.yaml") };
    let Ok(text) = std::fs::read_to_string(file) else { return false };
    let Ok(doc) = serde_yml::from_str::<serde_yml::Value>(&text) else { return false };
    doc.get("providers").and_then(serde_yml::Value::as_mapping).is_some_and(|providers| providers.contains_key("ollama"))
}

/// The scheduler's production host: the application context.
struct CtxHost {
    ctx: CtxRef,
    base_url_cache: Arc<OnceCell<String>>,
}

impl context_fit_scheduler::SchedulerHost for CtxHost {
    fn prefs(&self) -> Option<JsonStore> {
        self.ctx.upgrade().map(|ctx| ctx.prefs.clone())
    }

    fn overlay_path(&self) -> Option<PathBuf> {
        let prefs = self.ctx.upgrade()?.prefs.path();
        Some(paths::context_limits_overlay_path(prefs.parent()?))
    }

    fn base_url(&self) -> BoxFuture<'static, String> {
        let (ctx, cache) = (self.ctx.clone(), self.base_url_cache.clone());
        Box::pin(async move { resolve_base_url(&ctx, &cache).await })
    }

    fn read_machine(&self) -> BoxFuture<'static, Option<catalog::MachineFacts>> {
        Box::pin(hardware::read_machine_default())
    }

    fn env_cap(&self) -> BoxFuture<'static, Option<u64>> {
        let ctx = self.ctx.clone();
        Box::pin(async move { parse_env_cap(env_overlay(&ctx).await.get("OLLAMA_CONTEXT_LENGTH")) })
    }

    fn any_in_flight(&self) -> bool {
        self.ctx.upgrade().is_some_and(|ctx| ctx.tabs.any_in_flight())
    }

    fn welcome_completed(&self) -> bool {
        let value = self.ctx.upgrade().and_then(|ctx| ctx.prefs.get(WELCOME_COMPLETED_PREF));
        !matches!(value, None | Some(Value::Null) | Some(Value::Bool(false))) && value != Some(Value::String(String::new()))
    }

    fn configured_ollama_provider(&self) -> bool {
        has_configured_ollama_provider(&paths::agent_dir())
    }

    fn measure(&self, request: context_fit_scheduler::MeasureRequest) -> BoxFuture<'static, context_fit::MeasureOutcome> {
        Box::pin(async move {
            let is_busy = request.is_busy.clone();
            let on_progress = request.on_progress.clone();
            context_fit::measure_context_fit(context_fit::MeasureContextFitInput {
                base_url: &request.base_url,
                row: &request.row,
                machine: &request.machine,
                max_context: Some(request.max_context),
                is_busy: &*is_busy,
                on_progress: &*on_progress,
                timing: context_fit::ContextFitTiming::default(),
            })
            .await
        })
    }

    fn idle_sessions(&self) -> Vec<String> {
        let Some(ctx) = self.ctx.upgrade() else { return Vec::new() };
        idle_session_paths(ctx.tabs.as_ref())
    }

    fn session_command(&self, session_path: &str, command: Value) -> BoxFuture<'static, Option<Value>> {
        match self.ctx.upgrade() {
            Some(ctx) => ctx.tabs.command_for_idle_session(session_path, command),
            None => Box::pin(std::future::ready(None)),
        }
    }

    fn broadcast(&self, channel: &str, payload: Value) {
        if let Some(ctx) = self.ctx.upgrade() {
            ctx.bridge.broadcast_main(channel, payload);
        }
    }
}

/// Session files of every ready tab, in any window, with nothing in flight.
fn idle_session_paths(tabs: &dyn crate::ports::TabsPort) -> Vec<String> {
    let inventory = tabs.tab_inventory();
    let busy: BTreeSet<&str> = inventory.iter().filter(|fact| fact.in_flight).map(|fact| fact.tab_id.as_str()).collect();
    let windows: BTreeSet<WindowId> = inventory.iter().map(|fact| fact.window_id).collect();
    let mut sessions = Vec::new();
    for win_id in windows {
        for tab in tabs.tabs_for_window(win_id) {
            if tab.status != TabStatus::Ready || busy.contains(tab.tab_id.as_str()) {
                continue;
            }
            if let Some(Some(path)) = tab.session_path {
                if !sessions.contains(&path) {
                    sessions.push(path);
                }
            }
        }
    }
    sessions
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
    context_fit: Arc<context_fit_scheduler::ContextFitScheduler>,
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

        let host = Arc::new(CtxHost { ctx: ctx.clone(), base_url_cache: base_url_cache.clone() });
        let context_fit = context_fit_scheduler::ContextFitScheduler::new(host, context_fit_scheduler::SchedulerTiming::default());

        Self {
            ctx,
            base_url_cache,
            puller: pull::OllamaPuller::new(base_url_fn, progress_sink),
            remedy_gate: remedy::RemedyGate::new(),
            context_fit,
        }
    }

    pub(crate) fn context_fit(&self) -> &Arc<context_fit_scheduler::ContextFitScheduler> {
        &self.context_fit
    }

    /// The daemon answered: wake the context-fit queue and, the first time,
    /// run the startup measurement pass in the background.
    fn note_ollama_answered(&self) {
        let scheduler = self.context_fit.clone();
        bridge_spawn(async move { scheduler.note_ollama_answered().await });
    }

    /// The application context; `None` only while the process shuts down.
    fn ctx(&self) -> Option<Arc<AppCtx>> {
        self.ctx.upgrade()
    }

    pub(crate) async fn status(&self) -> probe::OllamaStatus {
        let status = probe_with(&self.ctx, &self.base_url_cache).await;
        if status.state == probe::OllamaState::Ok {
            self.note_ollama_answered();
        }
        status
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
        self.context_fit.stop();
        let _ = self.ctx();
        Box::pin(std::future::ready(()))
    }
}

/// Start the context-fit worker, write the overlay once the login-shell
/// environment (and with it the user's `OLLAMA_CONTEXT_LENGTH`) resolves, and
/// try the startup measurement pass.
pub fn init(ctx: &Arc<AppCtx>, app: &AppHandle) -> tauri::Result<()> {
    let _ = app;
    if let Some(ollama) = ctx.ollama.as_any().downcast_ref::<Ollama>() {
        let scheduler = ollama.context_fit.clone();
        scheduler.start();
        // The env cap read here waits for the login shell, so the overlay is
        // written with the user's `OLLAMA_CONTEXT_LENGTH` already known.
        bridge_spawn(async move {
            scheduler.refresh_overlay().await;
            scheduler.startup_pass().await;
        });
    }
    Ok(())
}

fn bridge_spawn(future: impl std::future::Future<Output = ()> + Send + 'static) {
    crate::bridge::spawn_task(future);
}

/// `args[0].get(field)` as a string, or `None`.
pub(crate) fn string_field<'a>(args: &'a [Value], field: &str) -> Option<&'a str> {
    args.first()?.get(field)?.as_str()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::{IpcTabInfo, SessionKind, WindowTabFact};
    use crate::testing::FakeTabs;

    fn tab(tab_id: &str, status: TabStatus, session_path: Option<&str>) -> IpcTabInfo {
        IpcTabInfo {
            tab_id: tab_id.into(),
            cwd: "/w".into(),
            status,
            active: None,
            visible: None,
            split: None,
            compacting: None,
            kind: SessionKind::Agent,
            placeholder: None,
            worktree: None,
            session_path: Some(session_path.map(str::to_string)),
            session_id: None,
            title: None,
        }
    }

    #[test]
    fn lists_the_session_files_of_ready_idle_tabs_in_every_window() {
        let tabs = FakeTabs::new();
        *tabs.inventory.lock().unwrap() = vec![
            WindowTabFact { window_id: WindowId(1), tab_id: "a".into(), in_flight: false },
            WindowTabFact { window_id: WindowId(1), tab_id: "b".into(), in_flight: true },
            WindowTabFact { window_id: WindowId(2), tab_id: "c".into(), in_flight: false },
            WindowTabFact { window_id: WindowId(2), tab_id: "d".into(), in_flight: false },
            WindowTabFact { window_id: WindowId(2), tab_id: "e".into(), in_flight: false },
        ];
        tabs.tabs.lock().unwrap().insert(WindowId(1), vec![tab("a", TabStatus::Ready, Some("/s/a.jsonl")), tab("b", TabStatus::Running, Some("/s/b.jsonl"))]);
        tabs.tabs.lock().unwrap().insert(
            WindowId(2),
            vec![tab("c", TabStatus::Ready, Some("/s/c.jsonl")), tab("d", TabStatus::Asleep, Some("/s/d.jsonl")), tab("e", TabStatus::Ready, None)],
        );
        assert_eq!(idle_session_paths(&tabs), vec!["/s/a.jsonl".to_string(), "/s/c.jsonl".to_string()]);
    }

    #[test]
    fn reads_only_a_positive_whole_env_cap() {
        assert_eq!(parse_env_cap(Some(&"32768".to_string())), Some(32_768));
        assert_eq!(parse_env_cap(Some(&" 8192 ".to_string())), Some(8_192));
        for bad in ["0", "-1", "32k", "", "1.5"] {
            assert_eq!(parse_env_cap(Some(&bad.to_string())), None, "{bad}");
        }
        assert_eq!(parse_env_cap(None), None);
    }

    #[test]
    fn finds_a_configured_ollama_provider_in_either_models_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!has_configured_ollama_provider(dir.path()));
        std::fs::write(dir.path().join("models.yaml"), "providers:\n  ollama:\n    baseUrl: http://127.0.0.1:11434\n").unwrap();
        assert!(has_configured_ollama_provider(dir.path()));
        // The preferred file wins once it exists.
        std::fs::write(dir.path().join("models.yml"), "providers:\n  openrouter: {}\n").unwrap();
        assert!(!has_configured_ollama_provider(dir.path()));
        std::fs::write(dir.path().join("models.yml"), "{not yaml").unwrap();
        assert!(!has_configured_ollama_provider(dir.path()));
    }
}
