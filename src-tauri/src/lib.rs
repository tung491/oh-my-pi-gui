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


/// Start the application. Wiring lands with the first window.
pub fn run() {}
