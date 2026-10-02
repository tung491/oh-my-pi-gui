// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::ExitCode;

use sai_atlas_lib::{omp, ports, product, webview};

fn main() -> ExitCode {
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();

    // The sidecar supervisor is this same binary, re-executed with a reserved
    // first argument. It must take over before anything initializes Tauri, so
    // the single-instance and deep-link plugins never see that process.
    if args.get(1).map(|arg| arg == ports::SUPERVISOR_ARGV).unwrap_or(false) {
        return omp::supervisor::run(args);
    }

    // The 0.9.x Electron AppImage updater runs the new AppImage with this
    // variable set and blocks until it exits; a shell that kept running would
    // hang the install.
    if std::env::var("APPIMAGE_EXIT_AFTER_INSTALL").map(|value| value == "true").unwrap_or(false) {
        return ExitCode::SUCCESS;
    }

    #[cfg(target_os = "linux")]
    {
        // tao sets the Wayland app_id from g_get_prgname(), which defaults to the
        // binary name; GTK only sets prgname when it is unset, so this wins.
        glib::set_prgname(Some(product::APP_ID));
        glib::set_application_name(product::PRODUCT_NAME);
        // Every WebKitWebContext must be sandboxed before its first web process.
        webview::install_sandbox_hook();
    }

    sai_atlas_lib::run()
}
