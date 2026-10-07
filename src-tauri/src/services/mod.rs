//! Module `services`: sessions, files, dialogs, system actions, logs, prefs
//! and the GUI host tools. The bodies below are the stubs the port replaces.

pub mod ipc;

mod dialog_memory;
mod dialogs;
mod editor;
mod fs;
mod host_tools;
mod legacy_storage;
mod log_watcher;
mod models_config;
mod open_path_target;
mod provider_cleanup;
mod session_cache;
mod session_index;
mod system;

use std::path::PathBuf;
use std::any::Any;
use std::sync::{Arc, Weak};

use futures_util::future::BoxFuture;
use serde_json::Value;
use tauri::AppHandle;

use crate::bridge::{Registry, Scope};
use crate::ctx::AppCtx;
use crate::ports::{CtxRef, Caller, ServiceError, ServicesPort, SessionInfo, SessionKind, SessionScope};
use log_watcher::LogWatcher;
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
    ("fs:read-pdf", Scope::Main),
    ("editor:open-external", Scope::Main),
];

pub const EMITS: &[&str] = &[
    "sessions:changed",
    "log:line",
    // Emitted by the WebKitGTK drag observer in `webview.rs`.
    "system:native-drop-paths",
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
    reg.register("fs:read-pdf", Scope::Main, ipc::fs_read_pdf);
    reg.register("editor:open-external", Scope::Main, ipc::editor_open_external);
}

/// Production `ServicesPort`.
pub struct Services {
    ctx: CtxRef,
    index: Arc<SessionIndex>,
    pub(crate) log_watcher: Arc<LogWatcher>,
    pub(crate) dialog_memory: dialogs::DialogMemory,
    pub(crate) notify_dedupe: system::NotifyDedupe,
}

impl Services {
    pub fn new(ctx: CtxRef) -> Self {
        let agent_dir = crate::paths::agent_dir();
        let sessions_dir = agent_dir.join("sessions");
        let logs_dir = agent_dir.join("..").join("logs");
        // Almost every caller passes its own cwd (`ctx.tabs.cwd_for`); this is
        // only the fallback for a "local" scope query with no caller cwd at all.
        let default_cwd = String::new();
        Self {
            ctx,
            index: Arc::new(SessionIndex::new(sessions_dir, default_cwd)),
            log_watcher: Arc::new(LogWatcher::new(logs_dir)),
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
        let _ = caller;
        let ctx = self.ctx()?;
        host_tools::execute(&ctx, name, &args)
    }

    fn import_legacy_renderer_storage(&self) -> BoxFuture<'_, ()> {
        // Runs before any window exists; `services::init` awaits it synchronously.
        if let Some(ctx) = self.ctx() {
            legacy_storage::import(&ctx.prefs, crate::paths::user_data_dir());
        }
        Box::pin(std::future::ready(()))
    }

    fn shutdown(&self) -> BoxFuture<'_, ()> {
        let _ = self.ctx();
        self.index.stop();
        self.log_watcher.stop();
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

        let weak_ctx = Arc::downgrade(ctx);
        wire_log_watcher(weak_ctx, services.log_watcher.clone());
        services.log_watcher.start();
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

/// Wires the log watcher's flush callback to broadcast `log:line` on `weak_ctx`'s
/// bridge. Extracted from `init` so a test can exercise the wiring itself
/// (callback re-entering `snapshot()`, the broadcast payload shape) against a
/// fake ctx, without running `init`'s other side effects.
fn wire_log_watcher(weak_ctx: Weak<AppCtx>, log_watcher: Arc<LogWatcher>) {
    let captured = log_watcher.clone();
    log_watcher.on_lines(Box::new(move |lines| {
        if let Some(ctx) = weak_ctx.upgrade() {
            let snapshot = captured.snapshot();
            ctx.bridge.broadcast_main("log:line", serde_json::json!({ "lines": lines, "nextSequence": snapshot.next_sequence }));
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::Registry;
    use crate::ports::{Caller, WindowId};
    use crate::testing::{self, Fakes, RecordingSink};
    use std::time::{Duration, Instant};

    fn registry() -> Registry {
        let mut reg = Registry::new();
        register(&mut reg);
        reg
    }

    /// Reproduces `log_watcher.rs`'s `callback_may_reenter_snapshot_and_stop_returns`
    /// at the wiring level: the production callback (built by `wire_log_watcher`)
    /// calls `snapshot()` while still inside the flush callback, then shutdown
    /// must still complete, and the resulting broadcast must carry the batch and
    /// the sequence number the renderer expects.
    ///
    /// As in `log_watcher.rs`, waiting here uses a plain OS poll interval
    /// (a channel receive with a short timeout, run off the async scheduler
    /// via `spawn_blocking`) instead of `tokio::time`: once this bug's
    /// self-deadlock stalls the runtime's reactor, every `tokio::time` wakeup
    /// stalls with it, so a `tokio::time`-based wait would hang alongside the
    /// bug instead of failing it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn wire_log_watcher_broadcasts_log_line_and_shuts_down_within_timeout() {
        let fakes = Fakes::default();
        let logs_dir = fakes.dir.path().join("logs");
        std::fs::create_dir_all(&logs_dir).unwrap();
        let log_file = logs_dir.join("omp.test.log");
        std::fs::write(&log_file, "").unwrap();

        let log_watcher = Arc::new(LogWatcher::new(logs_dir));
        let ctx = testing::fake_ctx_with(&fakes, registry());
        let weak_ctx = Arc::downgrade(&ctx);
        wire_log_watcher(weak_ctx, log_watcher.clone());

        let sink = Arc::new(RecordingSink::default());
        ctx.bridge.attach(&ctx, Caller::main(WindowId(1)), "g1".to_string(), sink.clone());

        log_watcher.start();
        std::fs::write(&log_file, "hello\n").unwrap();

        let sink_for_wait = sink.clone();
        let broadcast = tokio::task::spawn_blocking(move || {
            // A channel that nothing ever sends on: `recv_timeout` blocks for
            // the poll interval via the OS without an explicit sleep call.
            let (_never_tx, ticker) = std::sync::mpsc::channel::<()>();
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if let Some(envelope) = sink_for_wait.sent().into_iter().find(|envelope| envelope.channel == "log:line") {
                    return Some(envelope);
                }
                if Instant::now() > deadline {
                    return None;
                }
                let _ = ticker.recv_timeout(Duration::from_millis(20));
            }
        })
        .await
        .unwrap()
        .expect("timed out waiting for the log:line broadcast");
        assert_eq!(broadcast.payload["lines"], serde_json::json!(["hello"]));
        assert_eq!(broadcast.payload["nextSequence"], serde_json::json!(1));

        let stop_result = tokio::task::spawn_blocking(move || {
            let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
            std::thread::spawn(move || {
                log_watcher.stop();
                let _ = stop_tx.send(());
            });
            stop_rx.recv_timeout(Duration::from_secs(2))
        })
        .await
        .unwrap();
        assert!(stop_result.is_ok(), "stop() must return instead of deadlocking on the state lock");
    }
}
