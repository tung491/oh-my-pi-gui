//! Module `desktop`: chat windows, the quick-entry bar, shortcuts, tray,
//! menu, deep links and the quit guard. The bodies below are the stubs the
//! port replaces; `init` opens one window so the shell can be exercised.

pub mod ipc;

mod app_icons;
mod launch_argv;
mod quick_entry_core;
mod quit_guard;
mod shortcut_core;
mod tab_layout;
mod tray_labels;
mod wayland_portal;
mod window_bounds;

use std::any::Any;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::future::BoxFuture;
use tauri::AppHandle;

use crate::bridge::{Registry, Scope};
use crate::ctx::AppCtx;
use crate::ports::{CtxRef, DesktopPort, QuitRisk, RunProgressState, SessionKind, WindowClosedListener, WindowId, WindowKind, WindowRecord};
use crate::product;
use crate::webview::{self, WindowSpec};

pub const CHANNELS: &[(&str, Scope)] = &[
    ("app:quit", Scope::Main),
    ("quick-entry:submit", Scope::QuickEntry),
    ("quick-entry:consume-restored", Scope::QuickEntry),
    ("quick-entry:dismiss", Scope::QuickEntry),
    ("quick-entry:claim", Scope::Main),
    ("quick-entry:ack", Scope::Main),
    ("quick-entry:return", Scope::Main),
    ("quick-entry:shortcut-get", Scope::Main),
    ("quick-entry:shortcut-set", Scope::Main),
    ("quick-entry:shortcut-suspend", Scope::Main),
    ("quick-entry:shortcut-notice", Scope::Main),
    ("tray:state-push", Scope::Main),
    ("progress:set", Scope::Main),
];

pub const EMITS: &[&str] = &[
    "menu:action",
    "deep-link",
    "quick-entry:state",
];

/// The OS family, in Node's spelling, for the decisions that differ per platform.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Platform {
    Darwin,
    Win32,
    Linux,
}

impl Platform {
    pub(crate) fn current() -> Self {
        if cfg!(target_os = "macos") {
            Platform::Darwin
        } else if cfg!(windows) {
            Platform::Win32
        } else {
            Platform::Linux
        }
    }
}

pub fn register(reg: &mut Registry) {
    reg.register("app:quit", Scope::Main, ipc::app_quit);
    reg.register("quick-entry:submit", Scope::QuickEntry, ipc::quick_entry_submit);
    reg.register("quick-entry:consume-restored", Scope::QuickEntry, ipc::quick_entry_consume_restored);
    reg.register("quick-entry:dismiss", Scope::QuickEntry, ipc::quick_entry_dismiss);
    reg.register("quick-entry:claim", Scope::Main, ipc::quick_entry_claim);
    reg.register("quick-entry:ack", Scope::Main, ipc::quick_entry_ack);
    reg.register("quick-entry:return", Scope::Main, ipc::quick_entry_return);
    reg.register("quick-entry:shortcut-get", Scope::Main, ipc::quick_entry_shortcut_get);
    reg.register("quick-entry:shortcut-set", Scope::Main, ipc::quick_entry_shortcut_set);
    reg.register("quick-entry:shortcut-suspend", Scope::Main, ipc::quick_entry_shortcut_suspend);
    reg.register("quick-entry:shortcut-notice", Scope::Main, ipc::quick_entry_shortcut_notice);
    reg.register("tray:state-push", Scope::Main, ipc::tray_state_push);
    reg.register("progress:set", Scope::Main, ipc::progress_set);
}

/// Production `DesktopPort`.
pub struct Desktop {
    app: AppHandle,
    ctx: CtxRef,
    quitting: AtomicBool,
}

impl Desktop {
    pub fn new(app: AppHandle, ctx: CtxRef) -> Self {
        Self { app, ctx, quitting: AtomicBool::new(false) }
    }

    /// The application context; `None` only while the process shuts down.
    fn ctx(&self) -> Option<Arc<AppCtx>> {
        self.ctx.upgrade()
    }
}

impl DesktopPort for Desktop {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn spawn_window(&self, cwd: Option<String>, pending_session_path: Option<String>, kind: Option<SessionKind>) -> Option<WindowId> {
        let _ = (cwd, pending_session_path, kind);
        todo!()
    }

    // The read-only queries answer "no window known" until the window manager
    // exists: the bridge's error reporting and test hooks call them at startup.
    fn records(&self) -> Vec<WindowRecord> {
        Vec::new()
    }

    fn record(&self, win_id: WindowId) -> Option<WindowRecord> {
        let _ = win_id;
        None
    }

    fn main_window(&self) -> Option<WindowId> {
        None
    }

    fn target_window(&self) -> Option<WindowId> {
        None
    }

    fn focus(&self, win_id: WindowId) -> bool {
        let _ = win_id;
        todo!()
    }

    fn set_cwd(&self, win_id: WindowId, cwd: &str) {
        let _ = (win_id, cwd);
        todo!()
    }

    fn consume_pending_session(&self, win_id: WindowId) -> Option<String> {
        let _ = win_id;
        todo!()
    }

    fn set_run_progress(&self, state: RunProgressState) {
        let _ = state;
        todo!()
    }

    fn on_window_closed(&self, listener: WindowClosedListener) {
        let _ = listener;
        todo!()
    }

    fn rebuild_menu(&self) {
        todo!()
    }

    fn is_main_owned_pref_key(&self, key: &str) -> bool {
        let _ = key;
        todo!()
    }

    fn on_second_instance(&self, argv: Vec<String>, cwd: Option<String>) {
        let _ = (argv, cwd);
        todo!()
    }

    fn request_quit(&self) {
        self.quitting.store(true, Ordering::SeqCst);
        self.app.exit(0);
    }

    fn on_exit_requested(&self, code: Option<i32>) -> bool {
        // Until the lifecycle port lands, every exit request runs the shutdown order.
        let _ = (code, self.ctx());
        false
    }

    fn on_reopen(&self, has_visible_windows: bool) {
        let _ = has_visible_windows;
    }

    fn mark_quitting(&self) {
        self.quitting.store(true, Ordering::SeqCst);
    }

    fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    fn quit_risk(&self) -> QuitRisk {
        todo!()
    }

    fn approve_quit_before_install(&self) -> BoxFuture<'_, bool> {
        todo!()
    }

    fn withdraw_quit_approval(&self) {
        todo!()
    }

    fn shutdown(&self) -> BoxFuture<'_, ()> {
        // Windows close with the app; the port destroys the bar and the tray here.
        Box::pin(std::future::ready(()))
    }
}

/// Open the first chat window. The window manager replaces this.
pub fn init(ctx: &Arc<AppCtx>, app: &AppHandle) -> tauri::Result<()> {
    let _ = ctx;
    // replaced by the window manager
    webview::build_window(
        app,
        WindowSpec {
            kind: WindowKind::Main,
            win_id: WindowId(1),
            url: "index.html",
            title: product::PRODUCT_NAME.into(),
            inner_size: (1400.0, 900.0),
            ..Default::default()
        },
    )?;
    Ok(())
}
