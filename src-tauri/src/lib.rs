#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

//! The Sai ATLAS shell: a Tauri 2 core around the unchanged React renderer and
//! the `omp` sidecar. Foundation modules live at the crate root; each wave
//! module owns one directory and talks to the others only through `ports`.

pub mod bridge;
pub mod ctx;
pub mod i18n;
pub mod paths;
pub mod ports;
pub mod prefs;
pub mod product;
pub mod runtime_log;
pub mod test_hooks;
pub mod webview;

#[cfg(test)]
pub mod testing;

pub mod desktop;
pub mod ollama;
pub mod omp;
pub mod services;
pub mod tabs;
pub mod updater;

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::future::BoxFuture;
use serde_json::json;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use crate::bridge::{Bridge, Registry};
use crate::ctx::AppCtx;
use crate::i18n::MainI18n;
use crate::ports::{Host, HostError, MessageDialogOptions, MessageKind, OpenDialogOptions, SaveDialogOptions, WindowId};
use crate::prefs::JsonStore;
use crate::runtime_log::RuntimeLog;

/// Exit code when the Tauri context or builder fails before the first window.
const STARTUP_FAILURE_EXIT_CODE: u8 = 1;

// ---------------------------------------------------------------------------
// Production Host
// ---------------------------------------------------------------------------

/// A program to start after this process exits (the updater's relaunch).
type PendingRelaunch = Arc<Mutex<Option<PathBuf>>>;

/// OS services through the Tauri plugins. Modules never call a plugin directly.
struct TauriHost {
    app: AppHandle,
    relaunch: PendingRelaunch,
}

impl TauriHost {
    fn window(&self, win_id: Option<WindowId>) -> Option<tauri::WebviewWindow> {
        win_id.and_then(|id| self.app.get_webview_window(&id.label()))
    }

    fn file_dialog(
        &self,
        title: Option<&str>,
        default_path: Option<&Path>,
        filters: &[ports::FileFilter],
        parent: Option<WindowId>,
    ) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
        let mut builder = self.app.dialog().file();
        if let Some(title) = title {
            builder = builder.set_title(title);
        }
        if let Some(path) = default_path {
            if path.is_dir() {
                builder = builder.set_directory(path);
            } else {
                if let Some(dir) = path.parent().filter(|dir| !dir.as_os_str().is_empty()) {
                    builder = builder.set_directory(dir);
                }
                if let Some(name) = path.file_name() {
                    builder = builder.set_file_name(name.to_string_lossy());
                }
            }
        }
        for filter in filters {
            let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
            builder = builder.add_filter(&filter.name, &extensions);
        }
        if let Some(window) = self.window(parent) {
            builder = builder.set_parent(&window);
        }
        builder
    }
}

fn file_paths(paths: Vec<tauri_plugin_dialog::FilePath>) -> Vec<PathBuf> {
    paths.into_iter().filter_map(|path| path.into_path().ok()).collect()
}

fn system_locale() -> Option<String> {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .find(|value| !value.is_empty())
        .map(|value| value.split(['.', '@']).next().unwrap_or("").replace('_', "-"))
        .filter(|value| !value.is_empty() && value != "C" && value != "POSIX")
}

impl Host for TauriHost {
    fn open_dialog(&self, options: OpenDialogOptions) -> BoxFuture<'_, Option<Vec<PathBuf>>> {
        let builder = self
            .file_dialog(options.title.as_deref(), options.default_path.as_deref(), &options.filters, options.parent)
            .set_can_create_directories(options.can_create_directories);
        let (tx, rx) = tokio::sync::oneshot::channel();
        match (options.directory, options.multiple) {
            (true, true) => builder.pick_folders(move |picked| {
                let _ = tx.send(picked.map(file_paths));
            }),
            (true, false) => builder.pick_folder(move |picked| {
                let _ = tx.send(picked.map(|path| file_paths(vec![path])));
            }),
            (false, true) => builder.pick_files(move |picked| {
                let _ = tx.send(picked.map(file_paths));
            }),
            (false, false) => builder.pick_file(move |picked| {
                let _ = tx.send(picked.map(|path| file_paths(vec![path])));
            }),
        }
        Box::pin(async move { rx.await.ok().flatten() })
    }

    fn save_dialog(&self, options: SaveDialogOptions) -> BoxFuture<'_, Option<PathBuf>> {
        let builder = self.file_dialog(options.title.as_deref(), options.default_path.as_deref(), &options.filters, options.parent);
        let (tx, rx) = tokio::sync::oneshot::channel();
        builder.save_file(move |picked| {
            let _ = tx.send(picked.and_then(|path| path.into_path().ok()));
        });
        Box::pin(async move { rx.await.ok().flatten() })
    }

    fn message_dialog(&self, options: MessageDialogOptions) -> BoxFuture<'_, usize> {
        let MessageDialogOptions { title, message, detail, kind, buttons, default_button, cancel_button, parent } = options;
        let text = match detail {
            Some(detail) if !detail.is_empty() => format!("{message}\n\n{detail}"),
            _ => message,
        };
        let mut builder = self.app.dialog().message(text).title(title).kind(match kind {
            MessageKind::Info => MessageDialogKind::Info,
            MessageKind::Warning => MessageDialogKind::Warning,
            MessageKind::Error => MessageDialogKind::Error,
        });
        if let Some(window) = self.window(parent) {
            builder = builder.parent(&window);
        }
        // The plugin shows at most three buttons; the first is the affirmative one.
        let labels = buttons;
        builder = builder.buttons(match labels.as_slice() {
            [] => MessageDialogButtons::OkCustom("OK".to_string()),
            [ok] => MessageDialogButtons::OkCustom(ok.clone()),
            [ok, cancel] => MessageDialogButtons::OkCancelCustom(ok.clone(), cancel.clone()),
            [yes, no, cancel, ..] => MessageDialogButtons::YesNoCancelCustom(yes.clone(), no.clone(), cancel.clone()),
        });
        let fallback = cancel_button.unwrap_or(default_button);
        let (tx, rx) = tokio::sync::oneshot::channel();
        builder.show_with_result(move |result| {
            let index = match result {
                MessageDialogResult::Ok | MessageDialogResult::Yes => 0,
                MessageDialogResult::No => 1,
                MessageDialogResult::Cancel => fallback,
                MessageDialogResult::Custom(label) => labels.iter().position(|l| *l == label).unwrap_or(fallback),
            };
            let _ = tx.send(index);
        });
        Box::pin(async move { rx.await.unwrap_or(fallback) })
    }

    fn open_url(&self, url: &str) -> Result<(), HostError> {
        let lower = url.to_ascii_lowercase();
        if !(lower.starts_with("http://") || lower.starts_with("https://")) {
            return Err(HostError::Failed(format!("refused to open a non-http URL: {url}")));
        }
        self.app.opener().open_url(url, None::<&str>).map_err(|error| HostError::Failed(error.to_string()))
    }

    fn open_path(&self, path: &Path) -> Result<(), HostError> {
        self.app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|error| HostError::Failed(error.to_string()))
    }

    fn reveal_in_folder(&self, path: &Path) -> Result<(), HostError> {
        self.app.opener().reveal_item_in_dir(path).map_err(|error| HostError::Failed(error.to_string()))
    }

    fn clipboard_read_text(&self) -> BoxFuture<'_, Result<String, HostError>> {
        let result = self.app.clipboard().read_text().map_err(|error| HostError::Failed(error.to_string()));
        Box::pin(std::future::ready(result))
    }

    fn clipboard_write_text(&self, text: &str) -> BoxFuture<'_, Result<(), HostError>> {
        let result = self.app.clipboard().write_text(text.to_string()).map_err(|error| HostError::Failed(error.to_string()));
        Box::pin(std::future::ready(result))
    }

    fn notify(&self, title: &str, body: Option<&str>) -> Result<(), HostError> {
        let mut builder = self.app.notification().builder().title(title);
        if let Some(body) = body {
            builder = builder.body(body);
        }
        builder.show().map_err(|error| HostError::Failed(error.to_string()))
    }

    fn app_version(&self) -> String {
        self.app.package_info().version.to_string()
    }

    fn system_locale(&self) -> Option<String> {
        system_locale()
    }

    fn exit(&self, code: i32) {
        self.app.exit(code);
    }

    fn relaunch_after_exit(&self, program: PathBuf) {
        *self.relaunch.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(program);
    }
}

/// Start the pending relaunch, if any. Runs in the `RunEvent::Exit` arm, after
/// the plugins' own exit hooks released the single-instance D-Bus name.
fn start_pending_relaunch(relaunch: &PendingRelaunch) {
    let Some(program) = relaunch.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take() else { return };
    let spawned = tauri::async_runtime::block_on(async {
        tokio::process::Command::new(&program).env_remove("APPIMAGE_EXIT_AFTER_INSTALL").spawn()
    });
    match spawned {
        Ok(_child) => runtime_log::note("unknown", format!("relaunching {}", program.display()), json!({ "program": program.display().to_string() })),
        Err(error) => runtime_log::note("main-uncaught", format!("relaunch of {} failed: {error}", program.display()), json!({})),
    }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

fn registry() -> Registry {
    let mut registry = Registry::new();
    omp::register(&mut registry);
    tabs::register(&mut registry);
    desktop::register(&mut registry);
    services::register(&mut registry);
    ollama::register(&mut registry);
    updater::register(&mut registry);
    test_hooks::register(&mut registry);
    registry
}

fn build_ctx(app: &AppHandle, relaunch: PendingRelaunch) -> Arc<AppCtx> {
    let host: Arc<dyn Host> = Arc::new(TauriHost { app: app.clone(), relaunch });
    let prefs = JsonStore::open(paths::user_data_dir().join("prefs.json"));
    let window_state = JsonStore::open(paths::user_data_dir().join("window-state.json"));
    let i18n = MainI18n::new(prefs.clone(), host.system_locale());
    // Every production port holds a `Weak` back-reference to the context it lives in.
    Arc::new_cyclic(|ctx| AppCtx {
        host,
        bridge: Bridge::new(registry()),
        prefs,
        window_state,
        i18n,
        omp: Arc::new(omp::Omp::new(ctx.clone())),
        tabs: Arc::new(tabs::Tabs::new(ctx.clone())),
        desktop: Arc::new(desktop::Desktop::new(app.clone(), ctx.clone())),
        services: Arc::new(services::Services::new(ctx.clone())),
        ollama: Arc::new(ollama::Ollama::new(ctx.clone())),
        updater: Arc::new(updater::Updater::new(ctx.clone())),
    })
}

/// The frozen shutdown order. Runs once; later calls are no-ops.
fn shutdown(ctx: &Arc<AppCtx>, done: &AtomicBool, reason: &str) {
    if done.swap(true, Ordering::SeqCst) {
        return;
    }
    runtime_log::note(
        "unknown",
        format!("shutdown started ({reason})"),
        json!({ "order": "mark_quitting, tabs.dispose_all, omp.shutdown, services.shutdown, ollama.shutdown, updater.shutdown, desktop.shutdown" }),
    );
    ctx.desktop.mark_quitting();
    tauri::async_runtime::block_on(async {
        ctx.tabs.dispose_all().await;
        ctx.omp.shutdown().await;
        ctx.services.shutdown().await;
        ctx.ollama.shutdown().await;
        ctx.updater.shutdown().await;
        ctx.desktop.shutdown().await;
    });
    runtime_log::note("unknown", "shutdown finished", json!({ "steps": 7 }));
}

/// A plain SIGTERM would end the process without Tauri's exit path; route it
/// (and SIGINT) through `AppHandle::exit` so the sidecars get their grace.
#[cfg(unix)]
fn listen_for_signals(app: AppHandle) {
    use tokio::signal::unix::{signal, SignalKind};
    tauri::async_runtime::spawn(async move {
        let mut term = match signal(SignalKind::terminate()) {
            Ok(stream) => stream,
            Err(error) => {
                runtime_log::note("unknown", format!("SIGTERM listener failed: {error}"), json!({}));
                return;
            }
        };
        let mut int = match signal(SignalKind::interrupt()) {
            Ok(stream) => stream,
            Err(error) => {
                runtime_log::note("unknown", format!("SIGINT listener failed: {error}"), json!({}));
                return;
            }
        };
        let which = tokio::select! {
            _ = term.recv() => "SIGTERM",
            _ = int.recv() => "SIGINT",
        };
        runtime_log::note("unknown", format!("{which} received; exiting through Tauri"), json!({ "signal": which }));
        app.exit(0);
    });
}

#[cfg(not(unix))]
fn listen_for_signals(_app: AppHandle) {}

fn startup_failure(stage: &str, error: impl std::fmt::Display) -> ExitCode {
    runtime_log::note("main-uncaught", format!("{stage}: {error}"), json!({ "stage": stage }));
    eprintln!("{}: {stage}: {error}", product::PRODUCT_NAME);
    ExitCode::from(STARTUP_FAILURE_EXIT_CODE)
}

/// Start the application and run it to exit.
pub fn run() -> ExitCode {
    runtime_log::install(RuntimeLog::new(paths::runtime_log_path(), env!("CARGO_PKG_VERSION")));
    if let Err(error) = std::fs::create_dir_all(paths::user_data_dir()) {
        return startup_failure("creating the profile directory", error);
    }

    let mut context = tauri::generate_context!();
    // Throwaway profiles get their own identity, so the single-instance D-Bus
    // name (and the GtkApplication name) never hand off to the user's real app.
    if !paths::is_default_profile() {
        context.config_mut().identifier = paths::single_instance_id();
    }

    let done = Arc::new(AtomicBool::new(false));
    let relaunch: PendingRelaunch = Arc::new(Mutex::new(None));
    let relaunch_for_setup = relaunch.clone();
    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_single_instance::Builder::new()
                .dbus_id(paths::single_instance_id())
                .callback(|app, argv, cwd| {
                    if let Some(ctx) = app.try_state::<Arc<AppCtx>>() {
                        ctx.desktop.on_second_instance(argv, Some(cwd));
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![bridge::omp_invoke, bridge::omp_quick_entry_invoke, bridge::omp_attach])
        .setup(move |app| {
            let handle = app.handle().clone();
            let ctx = build_ctx(&handle, relaunch_for_setup);
            app.manage(ctx.clone());
            omp::init(&ctx, &handle)?;
            services::init(&ctx, &handle)?;
            tabs::init(&ctx, &handle)?;
            desktop::init(&ctx, &handle)?;
            ollama::init(&ctx, &handle)?;
            updater::init(&ctx, &handle)?;
            listen_for_signals(handle);
            Ok(())
        })
        .build(context);

    let app = match app {
        Ok(app) => app,
        Err(error) => return startup_failure("building the Tauri application", error),
    };

    app.run(move |handle, event| match event {
        RunEvent::ExitRequested { code, api, .. } => {
            let Some(ctx) = handle.try_state::<Arc<AppCtx>>() else { return };
            if ctx.desktop.on_exit_requested(code) {
                api.prevent_exit();
                return;
            }
            shutdown(ctx.inner(), &done, &format!("exit requested, code {code:?}"));
        }
        RunEvent::Exit => {
            if let Some(ctx) = handle.try_state::<Arc<AppCtx>>() {
                shutdown(ctx.inner(), &done, "exit");
            }
            start_pending_relaunch(&relaunch);
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { has_visible_windows, .. } => {
            if let Some(ctx) = handle.try_state::<Arc<AppCtx>>() {
                ctx.desktop.on_reopen(has_visible_windows);
            }
        }
        _ => {}
    });
    ExitCode::SUCCESS
}
