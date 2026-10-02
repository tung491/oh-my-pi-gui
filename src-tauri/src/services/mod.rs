//! Module `services`: sessions, files, dialogs, system actions, logs, prefs
//! and the GUI host tools. The bodies below are the stubs the port replaces.

pub mod ipc;

mod dialog_memory;
mod dialogs;
mod editor;
mod fs;
mod models_config;
mod open_path_target;
mod provider_cleanup;
mod session_cache;
mod session_index;
mod system;

use std::path::PathBuf;
use std::any::Any;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use serde_json::Value;
use tauri::AppHandle;

use crate::bridge::{Registry, Scope};
use crate::ctx::AppCtx;
use crate::ports::{CtxRef, Caller, ServiceError, ServicesPort, SessionInfo, SessionKind, SessionScope};
use session_index::SessionIndex;

pub const CHANNELS: &[(&str, Scope)] = &[
    ("runtime:error-report", Scope::Main),
    ("runtime:log-path", Scope::Main),
    ("log:snapshot", Scope::Main),
    ("sessions:list", Scope::Main),
    ("sessions:delete", Scope::Main),
    ("sessions:rename", Scope::Main),
    ("sessions:search", Scope::Main),
    ("session:open-new-window", Scope::Main),
    ("session:consume-pending", Scope::Main),
    ("system:open-external", Scope::Main),
    ("system:open-path", Scope::Main),
    ("system:save-dialog", Scope::Main),
    ("system:open-dialog", Scope::Main),
    ("system:clipboard-read", Scope::Main),
    ("system:notify", Scope::Main),
    ("prefs:get", Scope::Main),
    ("prefs:set", Scope::Main),
    ("models:providers-list", Scope::Main),
    ("provider-cleanup:config", Scope::Main),
    ("fs:list", Scope::Main),
    ("fs:read", Scope::Main),
    ("fs:read-plan", Scope::Main),
    ("fs:read-image", Scope::Main),
    ("editor:open-external", Scope::Main),
];

pub const EMITS: &[&str] = &[
    "sessions:changed",
    "log:line",
];

pub fn register(reg: &mut Registry) {
    reg.register("runtime:error-report", Scope::Main, ipc::runtime_error_report);
    reg.register("runtime:log-path", Scope::Main, ipc::runtime_log_path);
    reg.register("log:snapshot", Scope::Main, ipc::log_snapshot);
    reg.register("sessions:list", Scope::Main, ipc::sessions_list);
    reg.register("sessions:delete", Scope::Main, ipc::sessions_delete);
    reg.register("sessions:rename", Scope::Main, ipc::sessions_rename);
    reg.register("sessions:search", Scope::Main, ipc::sessions_search);
    reg.register("session:open-new-window", Scope::Main, ipc::session_open_new_window);
    reg.register("session:consume-pending", Scope::Main, ipc::session_consume_pending);
    reg.register("system:open-external", Scope::Main, ipc::system_open_external);
    reg.register("system:open-path", Scope::Main, ipc::system_open_path);
    reg.register("system:save-dialog", Scope::Main, ipc::system_save_dialog);
    reg.register("system:open-dialog", Scope::Main, ipc::system_open_dialog);
    reg.register("system:clipboard-read", Scope::Main, ipc::system_clipboard_read);
    reg.register("system:notify", Scope::Main, ipc::system_notify);
    reg.register("prefs:get", Scope::Main, ipc::prefs_get);
    reg.register("prefs:set", Scope::Main, ipc::prefs_set);
    reg.register("models:providers-list", Scope::Main, ipc::models_providers_list);
    reg.register("provider-cleanup:config", Scope::Main, ipc::provider_cleanup_config);
    reg.register("fs:list", Scope::Main, ipc::fs_list);
    reg.register("fs:read", Scope::Main, ipc::fs_read);
    reg.register("fs:read-plan", Scope::Main, ipc::fs_read_plan);
    reg.register("fs:read-image", Scope::Main, ipc::fs_read_image);
    reg.register("editor:open-external", Scope::Main, ipc::editor_open_external);
}

/// Production `ServicesPort`.
pub struct Services {
    ctx: CtxRef,
    index: Arc<SessionIndex>,
    pub(crate) dialog_memory: dialogs::DialogMemory,
    pub(crate) notify_dedupe: system::NotifyDedupe,
}

impl Services {
    pub fn new(ctx: CtxRef) -> Self {
        let sessions_dir = crate::paths::agent_dir().join("sessions");
        // Almost every caller passes its own cwd (`ctx.tabs.cwd_for`); this is
        // only the fallback for a "local" scope query with no caller cwd at all.
        let default_cwd = String::new();
        Self {
            ctx,
            index: Arc::new(SessionIndex::new(sessions_dir, default_cwd)),
            dialog_memory: dialogs::DialogMemory::new(),
            notify_dedupe: system::NotifyDedupe::new(),
        }
    }

    /// The application context; `None` only while the process shuts down.
    fn ctx(&self) -> Option<Arc<AppCtx>> {
        self.ctx.upgrade()
    }
}

impl ServicesPort for Services {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn sessions_list(&self, scope: SessionScope, cwd: Option<String>) -> BoxFuture<'_, Result<Vec<SessionInfo>, ServiceError>> {
        let result = self.index.list(scope, cwd.as_deref());
        Box::pin(std::future::ready(result))
    }

    fn session_kind_for(&self, session_path: &str) -> BoxFuture<'_, SessionKind> {
        let result = self.index.kind_for(session_path);
        Box::pin(std::future::ready(result))
    }

    fn session_delete(&self, session_path: &str) -> BoxFuture<'_, Result<(), ServiceError>> {
        let result = self.index.delete_session(session_path);
        Box::pin(std::future::ready(result))
    }

    fn session_search(&self, query: &str, candidate_paths: Vec<String>) -> BoxFuture<'_, Vec<String>> {
        let result = self.index.search_content(query, &candidate_paths);
        Box::pin(std::future::ready(result))
    }

    fn sessions_dir(&self) -> PathBuf {
        self.index.sessions_dir().to_path_buf()
    }

    fn on_sessions_changed(&self, listener: Box<dyn Fn() + Send + Sync>) {
        self.index.on_change(listener);
    }

    fn execute_host_tool(&self, caller: Caller, name: &str, args: Value) -> Option<BoxFuture<'static, Result<Value, String>>> {
        let _ = (caller, name, args);
        todo!()
    }

    fn import_legacy_renderer_storage(&self) -> BoxFuture<'_, ()> {
        // The port imports Chromium localStorage here, before any window exists.
        Box::pin(std::future::ready(()))
    }

    fn shutdown(&self) -> BoxFuture<'_, ()> {
        // No log watcher runs yet; the port stops it here too once Task 6.5 lands.
        let _ = self.ctx();
        self.index.stop();
        Box::pin(std::future::ready(()))
    }
}

/// Run the legacy storage import and start the watchers. Runs before `desktop::init`.
pub fn init(ctx: &Arc<AppCtx>, app: &AppHandle) -> tauri::Result<()> {
    let _ = app;
    tauri::async_runtime::block_on(ctx.services.import_legacy_renderer_storage());
    if let Some(services) = ctx.services.as_any().downcast_ref::<Services>() {
        let weak_ctx = Arc::downgrade(ctx);
        services.index.on_change(Box::new(move || {
            if let Some(ctx) = weak_ctx.upgrade() {
                ctx.bridge.broadcast_main("sessions:changed", Value::Null);
            }
        }));
        services.index.start();
    }
    let weak_ctx = Arc::downgrade(ctx);
    ctx.desktop.on_window_closed(Box::new(move |record| {
        if let Some(ctx) = weak_ctx.upgrade() {
            if let Some(services) = ctx.services.as_any().downcast_ref::<Services>() {
                services.dialog_memory.forget(record.id);
            }
        }
    }));
    Ok(())
}
