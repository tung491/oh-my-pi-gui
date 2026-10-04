// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::ExitCode;

#[cfg(target_os = "linux")]
use sai_atlas_lib::{appimage_handover, electron_relauncher};
use sai_atlas_lib::{omp, ports, product, webview};

fn main() -> ExitCode {
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();

    // After a .deb update the 0.9.x Electron app starts this binary as its
    // relaunch helper and blocks until the helper answers on fd 3. It is
    // handled first, before glib, Tauri or the 0.9.x AppImage flag below, so
    // Electron is never left waiting.
    #[cfg(target_os = "linux")]
    if electron_relauncher::is_relauncher_invocation(&args) {
        return electron_relauncher::run(args);
    }

    // The sidecar supervisor is this same binary, re-executed with a reserved
    // first argument. It must take over before anything initializes Tauri, so
    // the single-instance and deep-link plugins never see that process.
    if args.get(1).map(|arg| arg == ports::SUPERVISOR_ARGV).unwrap_or(false) {
        return omp::supervisor::run(args);
    }

    // The 0.9.x Electron AppImage updater runs the new AppImage with this
    // variable set and blocks until it exits; a shell that kept running would
    // hang the install. Electron cannot start the new image afterwards, so
    // this run schedules that start. It exits 0 whatever happens: any other
    // status would report a failed install after the file was replaced.
    if std::env::var("APPIMAGE_EXIT_AFTER_INSTALL").map(|value| value == "true").unwrap_or(false) {
        #[cfg(target_os = "linux")]
        appimage_handover::schedule_relaunch();
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
