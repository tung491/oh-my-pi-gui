//! Module `omp`: every child process of the agent. The sidecar manager (one
//! `omp --mode rpc-ui` per tab, spawned through the supervisor), the NDJSON
//! bridge and the login-shell and proxy environment live here.

mod assistant_pack;
mod event_batcher;
mod manager;
mod proxy;
mod rpc_bridge;
mod rpc_client;
mod shell_env;
#[cfg(test)]
mod test_support;
pub mod supervisor;

use std::any::Any;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_util::future::BoxFuture;
use tauri::AppHandle;

use crate::bridge::{Registry, Scope};
use crate::ctx::AppCtx;
use crate::ports::{CtxRef, EventBatcher, FlushCallback, OmpPort, SidecarEvents, SidecarHandle, SidecarOptions};

/// The module owns no channel: its sidecars talk through the tabs module.
pub const CHANNELS: &[(&str, Scope)] = &[];

pub const EMITS: &[&str] = &[];

pub fn register(reg: &mut Registry) {
    let _ = reg;
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
}

impl Omp {
    pub fn new(ctx: CtxRef) -> Self {
        Self {
            ctx,
            shell_env: Arc::default(),
            system_proxy: Mutex::new(proxy::system_proxy_lookup()),
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

    /// Resolves the spawn environment through the port, without borrowing `self`.
    pub(crate) fn spawn_env_provider(&self) -> manager::SpawnEnvProvider {
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

    #[cfg(test)]
    pub(crate) fn set_system_proxy_for_test(&self, lookup: proxy::SystemProxyLookup) {
        *lock(&self.system_proxy) = lookup;
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
}

/// Start the module's background work. Called once from `lib.rs` after `AppCtx` exists.
pub fn init(ctx: &Arc<AppCtx>, app: &AppHandle) -> tauri::Result<()> {
    let _ = (ctx, app);
    Ok(())
}
