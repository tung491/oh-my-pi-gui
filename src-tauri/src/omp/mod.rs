//! Module `omp`: every child process of the agent. The sidecar manager (one
//! `omp --mode rpc-ui` per tab, spawned through the supervisor), the NDJSON
//! bridge, the login-shell and proxy environment, the stats dashboard server
//! and the benchmark runner live here.

mod bench;
mod event_batcher;
pub mod ipc;
mod manager;
mod proxy;
mod rpc_bridge;
mod rpc_client;
mod shell_env;
mod stats;
mod stats_restart_policy;
#[cfg(test)]
mod test_support;
pub mod supervisor;

use std::any::Any;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use futures_util::future::BoxFuture;
use tauri::AppHandle;

use crate::bridge::{Registry, Scope};
use crate::ctx::AppCtx;
use crate::ports::{CtxRef, EventBatcher, FlushCallback, OmpPort, SidecarEvents, SidecarHandle, SidecarOptions, WindowId};

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

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Production `OmpPort`.
pub struct Omp {
    ctx: CtxRef,
    /// The login-shell probe runs once per process; every spawn shares it.
    shell_env: Arc<shell_env::ShellEnvCache>,
    system_proxy: Mutex<proxy::SystemProxyLookup>,
    /// The stats dashboard server, created by the first `stats:fetch`.
    stats: Mutex<Option<Arc<stats::StatsServer>>>,
    stats_client: Arc<stats::StatsClient>,
    /// One benchmark slot per window.
    bench_runs: Mutex<HashMap<WindowId, Arc<bench::BenchRunner>>>,
    #[cfg(test)]
    test_overrides: Mutex<TestOverrides>,
}

/// What tests swap in for the bundled binary and the login-shell probe.
#[cfg(test)]
#[derive(Default)]
struct TestOverrides {
    /// `Some(None)` makes the binary unavailable; `Some(Some(path))` replaces it.
    binary: Option<Option<PathBuf>>,
    spawn_env: Option<manager::SpawnEnvProvider>,
}

impl Omp {
    pub fn new(ctx: CtxRef) -> Self {
        Self {
            ctx,
            shell_env: Arc::default(),
            system_proxy: Mutex::new(proxy::system_proxy_lookup()),
            stats: Mutex::new(None),
            stats_client: Arc::new(stats::StatsClient::default()),
            bench_runs: Mutex::new(HashMap::new()),
            #[cfg(test)]
            test_overrides: Mutex::new(TestOverrides::default()),
        }
    }

    /// The application context; `None` only while the process shuts down.
    fn ctx(&self) -> Option<Arc<AppCtx>> {
        self.ctx.upgrade()
    }

    /// The proxy variables for a child: GUI pref → inherited env → system proxy → none.
    pub(crate) async fn proxy_env(&self, env: &shell_env::Env) -> HashMap<String, String> {
        let pref = self.ctx().and_then(|ctx| ctx.prefs.get_string("proxyUrl"));
        let lookup = lock(&self.system_proxy).clone();
        proxy::resolve(pref, env, &lookup).await
    }

    /// The bundled omp binary every child runs; the message is the `PathsError` text.
    pub(crate) fn omp_binary(&self) -> Result<PathBuf, String> {
        #[cfg(test)]
        {
            let binary = lock(&self.test_overrides).binary.clone();
            if let Some(binary) = binary {
                return binary.ok_or_else(|| "bundled omp is unavailable in this test".to_string());
            }
        }
        crate::paths::resolve_bundled_omp().map_err(|error| error.to_string())
    }

    /// Resolves the spawn environment through the port, without borrowing `self`.
    pub(crate) fn spawn_env_provider(&self) -> manager::SpawnEnvProvider {
        #[cfg(test)]
        {
            let provider = lock(&self.test_overrides).spawn_env.clone();
            if let Some(provider) = provider {
                return provider;
            }
        }
        let weak = self.ctx.clone();
        Arc::new(move || {
            let weak = weak.clone();
            Box::pin(async move {
                match weak.upgrade() {
                    Some(ctx) => ctx.omp.spawn_env().await,
                    None => HashMap::new(),
                }
            })
        })
    }

    /// The stats server, created on first use; `None` when the bundled binary cannot be found.
    pub(crate) fn stats_server(&self) -> Option<Arc<stats::StatsServer>> {
        let mut slot = lock(&self.stats);
        if let Some(server) = slot.as_ref() {
            return Some(server.clone());
        }
        let binary = self.omp_binary().ok()?;
        let server = Arc::new(stats::StatsServer::new(binary, self.spawn_env_provider()));
        let client = self.stats_client.clone();
        server.on_event(Box::new(move |event| match event {
            stats::StatsEvent::Ready(port) => client.set_port(*port),
            stats::StatsEvent::Exit(_) => client.set_port(0),
        }));
        *slot = Some(server.clone());
        Some(server)
    }

    pub(crate) fn stats_client(&self) -> Arc<stats::StatsClient> {
        self.stats_client.clone()
    }

    /// The window's benchmark slot, created on first use.
    pub(crate) fn bench_runner(&self, win_id: WindowId) -> Arc<bench::BenchRunner> {
        lock(&self.bench_runs).entry(win_id).or_default().clone()
    }

    /// Forget a window's slot once its run ended (a later run gets a fresh one).
    pub(crate) fn release_bench_runner(&self, win_id: WindowId, runner: &Arc<bench::BenchRunner>) {
        if runner.running() {
            return;
        }
        let mut runs = lock(&self.bench_runs);
        if runs.get(&win_id).map(|current| Arc::ptr_eq(current, runner)).unwrap_or(false) {
            runs.remove(&win_id);
        }
    }

    /// Abort the window's run, if any; true when one was running.
    pub(crate) fn abort_bench(&self, win_id: WindowId) -> bool {
        let runner = lock(&self.bench_runs).get(&win_id).cloned();
        runner.map(|runner| runner.abort()).unwrap_or(false)
    }

    /// A closed window takes its benchmark with it.
    fn forget_window(&self, win_id: WindowId) {
        let runner = lock(&self.bench_runs).remove(&win_id);
        if let Some(runner) = runner {
            runner.abort();
        }
    }

    /// Listeners on other ports, plus the startup probe of the dashboard client
    /// (`index.ts` probes once at launch; at port 0 it only records "unavailable").
    /// `init` runs this once the context exists.
    pub(crate) fn register_listeners(ctx: &Arc<AppCtx>) {
        if let Some(omp) = ctx.omp.as_any().downcast_ref::<Omp>() {
            let client = omp.stats_client();
            crate::bridge::spawn_task(async move {
                let _ = client.probe().await;
            });
        }
        let weak = Arc::downgrade(ctx);
        ctx.desktop.on_window_closed(Box::new(move |record| {
            if let Some(ctx) = weak.upgrade() {
                if let Some(omp) = ctx.omp.as_any().downcast_ref::<Omp>() {
                    omp.forget_window(record.id);
                }
            }
        }));
    }

    #[cfg(test)]
    pub(crate) fn set_system_proxy_for_test(&self, lookup: proxy::SystemProxyLookup) {
        *lock(&self.system_proxy) = lookup;
    }

    #[cfg(test)]
    pub(crate) fn set_binary_for_test(&self, binary: Option<PathBuf>) {
        lock(&self.test_overrides).binary = Some(binary);
    }

    #[cfg(test)]
    pub(crate) fn set_spawn_env_for_test(&self, provider: manager::SpawnEnvProvider) {
        lock(&self.test_overrides).spawn_env = Some(provider);
    }
}

impl OmpPort for Omp {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn new_sidecar(&self, options: SidecarOptions) -> (Arc<dyn SidecarHandle>, SidecarEvents) {
        let (handle, events) = manager::SidecarManager::new(self.ctx.clone(), options, self.spawn_env_provider());
        (handle, events)
    }

    fn new_event_batcher(&self, flush: FlushCallback) -> Box<dyn EventBatcher> {
        Box::new(event_batcher::Batcher::new(flush))
    }

    fn spawn_env(&self) -> BoxFuture<'_, HashMap<String, String>> {
        Box::pin(async move {
            let env = shell_env::process_env();
            let probed = self.shell_env.resolve(&env).await;
            // Login-shell PATH first so the GUI proxy pref (and inherited proxy
            // env) keeps precedence over rc-file proxy exports.
            let mut overlay = shell_env::shell_spawn_env(&env, probed);
            overlay.extend(self.proxy_env(&env).await);
            overlay
        })
    }

    fn resolve_editor_command(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async move {
            let env = shell_env::process_env();
            let probed = self.shell_env.resolve(&env).await;
            shell_env::resolve_editor_command(&env, probed)
        })
    }

    fn shutdown(&self) -> BoxFuture<'_, ()> {
        // The slot is emptied, so a read after shutdown would rebuild the server;
        // the frozen shutdown order runs no handler after this point, so that path
        // is unreachable (the TS kept the killed instance and answered "exhausted").
        let server = lock(&self.stats).take();
        if let Some(server) = server {
            server.kill();
        }
        let runs: Vec<Arc<bench::BenchRunner>> = lock(&self.bench_runs).drain().map(|(_, runner)| runner).collect();
        for runner in runs {
            runner.abort();
        }
        Box::pin(std::future::ready(()))
    }
}

/// Start the module's background work. Called once from `lib.rs` after `AppCtx` exists.
pub fn init(ctx: &Arc<AppCtx>, app: &AppHandle) -> tauri::Result<()> {
    let _ = app;
    Omp::register_listeners(ctx);
    Ok(())
}
