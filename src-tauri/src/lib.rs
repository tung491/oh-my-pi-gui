#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

//! The Sai ATLAS shell: a Tauri 2 core around the unchanged React renderer and
//! the `omp` sidecar. Foundation modules live at the crate root; each wave
//! module owns one directory and talks to the others only through `ports`.

#[cfg(target_os = "linux")]
pub mod appimage_handover;
pub mod bridge;
pub mod ctx;
#[cfg(target_os = "linux")]
pub mod electron_relauncher;
#[cfg(target_os = "linux")]
pub mod gstreamer_env;
pub mod i18n;
pub mod paths;
pub mod ports;
pub mod prefs;
pub mod product;
mod relaunch;
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
use crate::ports::{Host, HostError, MessageDialogOptions, MessageKind, OpenDialogOptions, SaveDialogOptions};
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
    /// A file dialog. Native dialogs are never attached to a parent window: the
    /// GTK3 dialog backend ignores a parent, and reading a Wayland window
    /// handle for a hidden window dereferences a null surface.
    fn file_dialog(
        &self,
        title: Option<&str>,
        default_path: Option<&Path>,
        filters: &[ports::FileFilter],
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
            .file_dialog(options.title.as_deref(), options.default_path.as_deref(), &options.filters)
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
        let builder = self.file_dialog(options.title.as_deref(), options.default_path.as_deref(), &options.filters);
        let (tx, rx) = tokio::sync::oneshot::channel();
        builder.save_file(move |picked| {
            let _ = tx.send(picked.and_then(|path| path.into_path().ok()));
        });
        Box::pin(async move { rx.await.ok().flatten() })
    }

    fn message_dialog(&self, options: MessageDialogOptions) -> BoxFuture<'_, usize> {
        let MessageDialogOptions { title, message, detail, kind, buttons, parent: _ } = options;
        let text = match detail {
            Some(detail) if !detail.is_empty() => format!("{message}\n\n{detail}"),
            _ => message,
        };
        let mut builder = self.app.dialog().message(text).title(title).kind(match kind {
            MessageKind::Info => MessageDialogKind::Info,
            MessageKind::Warning => MessageDialogKind::Warning,
            MessageKind::Error => MessageDialogKind::Error,
        });
        // The plugin shows at most three buttons; the first is the affirmative one.
        let labels = buttons;
        builder = builder.buttons(match labels.as_slice() {
            [] => MessageDialogButtons::OkCustom("OK".to_string()),
            [ok] => MessageDialogButtons::OkCustom(ok.clone()),
            [ok, cancel] => MessageDialogButtons::OkCancelCustom(ok.clone(), cancel.clone()),
            [yes, no, cancel, ..] => MessageDialogButtons::YesNoCancelCustom(yes.clone(), no.clone(), cancel.clone()),
        });
        // The plugin reports the last button and a dismissed dialog alike as `Cancel`.
        let last = labels.len().saturating_sub(1);
        let (tx, rx) = tokio::sync::oneshot::channel();
        builder.show_with_result(move |result| {
            let index = match result {
                MessageDialogResult::Ok | MessageDialogResult::Yes => 0,
                MessageDialogResult::No => 1.min(last),
                MessageDialogResult::Cancel => last,
                MessageDialogResult::Custom(label) => labels.iter().position(|l| *l == label).unwrap_or(last),
            };
            let _ = tx.send(index);
        });
        Box::pin(async move { rx.await.unwrap_or(last) })
    }

    fn open_url(&self, url: &str) -> Result<(), HostError> {
        // Checked again here, whoever asks: only http, https and a mailto
        // link reduced to its address, subject, body, cc and bcc reach the OS.
        let Some(target) = services::system::sanitize_external_url(url) else {
            return Err(HostError::Failed(format!("refused to open a URL that is not http, https or mailto: {url}")));
        };
        self.app.opener().open_url(target, None::<&str>).map_err(|error| HostError::Failed(error.to_string()))
    }

    fn open_path(&self, path: &Path) -> Result<(), HostError> {
        self.app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|error| HostError::Failed(error.to_string()))
    }

    fn reveal_in_folder(&self, path: &Path) -> Result<(), HostError> {
        self.app.opener().reveal_item_in_dir(path).map_err(|error| HostError::Failed(error.to_string()))
    }

    fn clipboard_read_text(&self) -> BoxFuture<'_, Result<String, HostError>> {
        // Reading the selection waits on the X11/Wayland selection owner, which
        // can take as long as that app takes to answer; keep it off the runtime
        // workers so a slow owner stalls only this call.
        let app = self.app.clone();
        Box::pin(async move {
            let joined = tokio::task::spawn_blocking(move || app.clipboard().read_text()).await;
            match joined {
                Ok(read) => read.map_err(|error| HostError::Failed(error.to_string())),
                Err(join_error) => Err(HostError::Failed(format!("clipboard read did not complete: {join_error}"))),
            }
        })
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
    // An AppImage's mount: the relaunch must not inherit anything under it, or
    // the old image stays mounted until the new app quits.
    let old_appdir = std::env::var_os("APPDIR").filter(|value| !value.is_empty()).map(PathBuf::from);
    let appdirs: Vec<&Path> = old_appdir.as_deref().into_iter().collect();
    let cwd = relaunch::relaunch_cwd(std::env::current_dir().ok().as_deref(), &appdirs, dirs::home_dir().as_deref());
    // A child would inherit this process's no_new_privs (an app Electron's
    // relaunch helper started directly has it), and pkexec would stay broken
    // in the new app; the user's service manager starts it without the flag.
    #[cfg(target_os = "linux")]
    if relaunch::no_new_privs() {
        match relaunch::launch_detached(&program, &[], std::env::vars_os().collect(), &appdirs, &cwd, "relaunch") {
            Ok(route) => runtime_log::note(
                "unknown",
                format!("relaunching {} ({})", program.display(), route.name()),
                json!({ "program": program.display().to_string(), "route": route.name(), "reason": route.reason(), "noNewPrivs": true }),
            ),
            Err(error) => runtime_log::note("main-uncaught", format!("relaunch of {} failed: {error}", program.display()), json!({})),
        }
        return;
    }
    let spawned = tauri::async_runtime::block_on(async {
        relaunch::relaunch_command(&program, &[], std::env::vars_os().collect(), &appdirs, &cwd).spawn()
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

/// The frozen shutdown order. Runs once; later calls are no-ops. It blocks the
/// main thread, so none of these futures may await a main-thread round trip
/// issued from another thread (see `TabsPort::dispose_all`, `DesktopPort::shutdown`).
fn shutdown(ctx: &Arc<AppCtx>, done: &AtomicBool, reason: &str) {
    if done.swap(true, Ordering::SeqCst) {
        return;
    }
    runtime_log::note(
        "unknown",
        format!("shutdown started ({reason})"),
        json!({ "order": "mark_quitting, tabs.dispose_all, services.shutdown, ollama.shutdown, updater.shutdown, desktop.shutdown" }),
    );
    ctx.desktop.mark_quitting();
    tauri::async_runtime::block_on(async {
        ctx.tabs.dispose_all().await;
        ctx.services.shutdown().await;
        ctx.ollama.shutdown().await;
        ctx.updater.shutdown().await;
        ctx.desktop.shutdown().await;
    });
    runtime_log::note("unknown", "shutdown finished", json!({ "steps": 6 }));
}

/// How long the graceful exit started by a signal may take before the process exits hard.
#[cfg(unix)]
const SIGNAL_EXIT_DEADLINE: std::time::Duration = std::time::Duration::from_secs(15);

/// A plain SIGTERM would end the process without Tauri's exit path; route it
/// (and SIGINT) through `AppHandle::exit` so the sidecars get their grace.
/// Installing the listener replaces the default disposition for good, so a
/// second signal, or a graceful exit that overruns its deadline, exits hard
/// with `128 + signo`: `kill` must always work twice.
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
        let (which, signo) = tokio::select! {
            _ = term.recv() => ("SIGTERM", SignalKind::terminate().as_raw_value()),
            _ = int.recv() => ("SIGINT", SignalKind::interrupt().as_raw_value()),
        };
        runtime_log::note("unknown", format!("{which} received; exiting through Tauri"), json!({ "signal": which }));
        app.exit(0);
        let (reason, code) = tokio::select! {
            _ = term.recv() => ("second SIGTERM", 128 + SignalKind::terminate().as_raw_value()),
            _ = int.recv() => ("second SIGINT", 128 + SignalKind::interrupt().as_raw_value()),
            _ = tokio::time::sleep(SIGNAL_EXIT_DEADLINE) => ("graceful exit overran its deadline", 128 + signo),
        };
        runtime_log::note(
            "unknown",
            format!("{reason}; exiting hard with code {code}"),
            json!({ "signal": which, "deadlineSecs": SIGNAL_EXIT_DEADLINE.as_secs() }),
        );
        std::process::exit(code);
    });
}

fn startup_failure(stage: &str, error: impl std::fmt::Display) -> ExitCode {
    runtime_log::note("main-uncaught", format!("{stage}: {error}"), json!({ "stage": stage }));
    eprintln!("{}: {stage}: {error}", product::PRODUCT_NAME);
    ExitCode::from(STARTUP_FAILURE_EXIT_CODE)
}

/// Start the application and run it to exit.
pub fn run() -> ExitCode {
    // The profile comes first: with no config directory and no override there is
    // nowhere to log to, so this failure can only be reported on stderr.
    let profile = match paths::resolve_user_data_dir() {
        Ok(profile) => profile,
        Err(error) => {
            eprintln!("{}: resolving the profile directory: {error}", product::PRODUCT_NAME);
            return ExitCode::from(STARTUP_FAILURE_EXIT_CODE);
        }
    };
    // The log records the bundle's version (`package.json`, through
    // `tauri.conf.json`), the same one the updater and `app_version` report;
    // the crate version in `Cargo.toml` is not bumped on release.
    let mut context = tauri::generate_context!();
    runtime_log::install(RuntimeLog::new(paths::runtime_log_path(), context.package_info().version.to_string()));
    if let Err(error) = std::fs::create_dir_all(profile) {
        return startup_failure("creating the profile directory", error);
    }

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
