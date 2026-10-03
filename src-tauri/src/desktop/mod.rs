//! Module `desktop`: chat windows, the quick-entry bar, shortcuts, tray,
//! menu, deep links and the quit guard. Every OS call goes through the private
//! window backend in `windows.rs`, so each decision runs in tests without a
//! runtime; cross-module calls go through the frozen ports only.

pub mod ipc;

mod app_icons;
mod app_quit;
mod deep_link;
#[cfg(target_os = "linux")]
mod gnome_keybindings;
mod launch_argv;
mod lifecycle;
mod menu;
mod quick_entry;
mod quick_entry_core;
mod quit_guard;
mod shortcut;
mod shortcut_core;
mod tab_layout;
mod tray;
mod tray_labels;
mod wayland_portal;
mod window_bounds;
mod windows;

use std::any::Any;
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use futures_util::future::BoxFuture;
use serde_json::json;
use tauri::AppHandle;

use crate::bridge::{Registry, Scope};
use crate::ctx::AppCtx;
use crate::ports::{CtxRef, DesktopPort, QuitRisk, RunProgressState, SessionKind, WindowClosedListener, WindowId, WindowRecord};
use crate::runtime_log;

use app_quit::{exit_decision, ExitDecision, QuitState};
use deep_link::{plugin_owns_links, registers_url_scheme, BuildKind, PendingLinks, DEEP_LINK_PROTOCOL};
use launch_argv::{launch_arguments, parse_launch_argv, LaunchRequest};
use quick_entry::QuickEntryController;
use shortcut::{QuickEntryShortcut, ShortcutDeps, ShortcutRegistry, TOGGLE_WINDOW_SHORTCUT_ID};
use shortcut_core::{native_accelerator, QuickEntryShortcutPref};
use tray::TrayController;
use wayland_portal::{desktop_entry_candidates, shortcut_mode, xwayland_only, ShortcutMode};
use windows::{Backend, WindowRegistry};

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

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // The module's state is plain bookkeeping; a panic elsewhere must not take the desktop down.
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Run a call into another module on a main-thread path (init, a menu, tray,
/// shortcut or exit callback). A panic there would unwind through the native
/// event loop and abort the process, so it is caught and logged instead, as the
/// bridge does for handlers; the caller treats the call as unanswered.
pub(crate) fn survive<T>(what: &str, call: impl FnOnce() -> T) -> Option<T> {
    match catch_unwind(AssertUnwindSafe(call)) {
        Ok(value) => Some(value),
        Err(payload) => {
            let message = payload
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "panic".to_string());
            runtime_log::note("main-uncaught", format!("{what} panicked: {message}"), json!({ "call": what }));
            None
        }
    }
}

/// Production `DesktopPort`.
pub struct Desktop {
    backend: Arc<dyn Backend>,
    ctx: CtxRef,
    /// Set by `mark_quitting` and `request_quit`: layout persistence stops.
    quitting: AtomicBool,
    windows: WindowRegistry,
    closed_listeners: Mutex<Vec<WindowClosedListener>>,
    quick_entry: QuickEntryController,
    shortcut: Mutex<Option<Arc<QuickEntryShortcut>>>,
    shortcut_registry: Mutex<Option<Arc<dyn ShortcutRegistry>>>,
    tray: TrayController,
    progress: Mutex<BTreeMap<WindowId, RunProgressState>>,
    quit: QuitState,
    links: PendingLinks,
    /// Native Wayland: shortcuts go through the portal and the compositor places the bar.
    wayland_portal: bool,
}

impl Desktop {
    pub fn new(app: AppHandle, ctx: CtxRef) -> Self {
        let backend = Arc::new(windows::TauriBackend::new(app, ctx.clone()));
        Self::with_backend(backend, ctx)
    }

    pub(crate) fn with_backend(backend: Arc<dyn Backend>, ctx: CtxRef) -> Self {
        let wayland_portal = shortcut_mode(backend.platform(), &backend.env()) == ShortcutMode::Portal;
        Self {
            backend,
            ctx,
            quitting: AtomicBool::new(false),
            windows: WindowRegistry::new(),
            closed_listeners: Mutex::new(Vec::new()),
            quick_entry: QuickEntryController::default(),
            shortcut: Mutex::new(None),
            shortcut_registry: Mutex::new(None),
            tray: TrayController::default(),
            progress: Mutex::new(BTreeMap::new()),
            quit: QuitState::default(),
            links: PendingLinks::default(),
            wayland_portal,
        }
    }

    /// The application context; `None` only while the process shuts down.
    fn ctx(&self) -> Option<Arc<AppCtx>> {
        self.ctx.upgrade()
    }

    /// The production struct behind the port, for this module's callbacks and handlers.
    pub(crate) fn of(ctx: &AppCtx) -> Option<&Desktop> {
        ctx.desktop.as_any().downcast_ref::<Desktop>()
    }

    pub(crate) fn is_quitting_latched(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    fn forget_progress(&self, win_id: WindowId) {
        let aggregate = {
            let mut progress = lock(&self.progress);
            if progress.remove(&win_id).is_none() {
                return;
            }
            Self::aggregate_progress(progress.values().copied())
        };
        self.apply_run_progress(aggregate);
    }

    /// `progress:set` from `win_id`: aggregate per window, any working > waiting > idle.
    pub(crate) fn push_progress(&self, win_id: WindowId, state: RunProgressState) {
        let aggregate = {
            let mut progress = lock(&self.progress);
            progress.insert(win_id, state);
            Self::aggregate_progress(progress.values().copied())
        };
        self.apply_run_progress(aggregate);
    }

    pub(crate) fn shortcut_release_window(&self, win_id: WindowId) {
        if let Some(shortcut) = lock(&self.shortcut).clone() {
            shortcut.release_window(win_id);
        }
    }

    pub(crate) fn shortcut_handle(&self) -> Option<Arc<QuickEntryShortcut>> {
        lock(&self.shortcut).clone()
    }

    fn start_guarded_quit_from(&self, ctx: &AppCtx) {
        if let Some(ctx) = self.ctx() {
            self.start_guarded_quit(&ctx);
        } else {
            self.request_quit_in(ctx);
        }
    }

    /// The window toggle (`CommandOrControl+Shift+O`): hide the focused window,
    /// else show the most recent, else open one.
    fn toggle_window_shortcut(&self, ctx: &AppCtx) {
        if let Some(focused) = self.windows.focused() {
            if self.backend.is_visible(focused) {
                self.backend.hide(focused);
            } else {
                self.backend.focus(focused);
            }
            return;
        }
        match self.windows.main_window() {
            Some(id) => self.backend.focus(id),
            None => {
                self.spawn_window_in(ctx, None, None, None);
            }
        }
    }

    /// Register both global shortcuts in one tick (a portal session binds once).
    fn install_shortcuts(&self, ctx: &Arc<AppCtx>, registry: Arc<dyn ShortcutRegistry>) {
        let platform = self.backend.platform();
        let env = self.backend.env();
        let mode = shortcut_mode(platform, &env);
        let portal = mode == ShortcutMode::Portal;
        runtime_log::note("global-shortcut", "global shortcut mode", json!({ "portal": portal }));
        *lock(&self.shortcut_registry) = Some(registry.clone());

        let weak = Arc::downgrade(ctx);
        let toggle: shortcut::Activation = Arc::new(move || {
            runtime_log::note("global-shortcut", "window toggle shortcut activated", json!({ "portal": portal }));
            survive("window toggle shortcut", || {
                if let Some(ctx) = weak.upgrade() {
                    if let Some(desktop) = Desktop::of(&ctx) {
                        desktop.toggle_window_shortcut(&ctx);
                    }
                }
            });
        });
        if let Some(accelerator) = native_accelerator("window.toggle") {
            match registry.register(TOGGLE_WINDOW_SHORTCUT_ID, accelerator, toggle) {
                Ok(true) => {}
                Ok(false) => runtime_log::note("global-shortcut", format!("globalShortcut.register refused {accelerator}"), json!({ "accelerator": accelerator })),
                Err(error) => runtime_log::note("global-shortcut", format!("globalShortcut.register threw for {accelerator}: {error}"), json!({ "accelerator": accelerator })),
            }
        }

        let desktop_entry_missing = portal && {
            let home = self.backend.home_dir().map(|home| home.to_string_lossy().to_string()).unwrap_or_default();
            !desktop_entry_candidates(&format!("{}.desktop", crate::product::APP_ID), &env, &home).iter().any(|candidate| std::path::Path::new(candidate).is_file())
        };
        let read_ctx = Arc::downgrade(ctx);
        let save_ctx = Arc::downgrade(ctx);
        let activate_ctx = Arc::downgrade(ctx);
        let shortcut = QuickEntryShortcut::new(ShortcutDeps {
            registry,
            log: Box::new(|message, details| runtime_log::note("global-shortcut", message, details)),
            read_pref: Box::new(move || read_ctx.upgrade().and_then(|ctx| ctx.prefs.get("quickEntryShortcut"))),
            save_pref: Box::new(move |pref: &QuickEntryShortcutPref| {
                let ctx = save_ctx.upgrade().ok_or_else(|| "shutting down".to_string())?;
                let value = serde_json::to_value(pref).map_err(|error| error.to_string())?;
                ctx.prefs.set("quickEntryShortcut", value).map_err(|error| error.to_string())
            }),
            mode,
            desktop_entry_missing,
            xwayland_only: xwayland_only(platform, &env),
            on_activate: Arc::new(move || {
                runtime_log::note("global-shortcut", "quick entry shortcut activated", json!({ "portal": portal }));
                survive("quick entry shortcut", || {
                    if let Some(ctx) = activate_ctx.upgrade() {
                        if let Some(desktop) = Desktop::of(&ctx) {
                            desktop.quick_entry.toggle(&ctx, desktop);
                        }
                    }
                });
            }),
            platform,
        });
        shortcut.register_at_startup();
        *lock(&self.shortcut) = Some(shortcut);
    }

    /// Open the startup windows: an explicit workspace, or the saved session in full.
    pub(crate) fn restore_startup_windows(&self, ctx: &AppCtx, explicit_cwd: Option<String>) {
        // Read before the first window restores: every tab change rewrites the store.
        let saved = Self::read_saved_tab_layouts(ctx);
        let explicit = explicit_cwd.is_some();
        self.spawn_window_in(ctx, explicit_cwd, None, None);
        if !explicit {
            for layout in saved.into_iter().skip(1) {
                self.spawn_window_with_layout(ctx, layout);
            }
        }
    }

    /// Everything `init` does once the backend and the shortcut registry exist.
    pub(crate) fn start(&self, ctx: &Arc<AppCtx>, registry: Arc<dyn ShortcutRegistry>) {
        let weak = Arc::downgrade(ctx);
        survive("tabs.on_window_tabs_changed", || {
            ctx.tabs.on_window_tabs_changed(Box::new(move |_, _| {
                if let Some(ctx) = weak.upgrade() {
                    if let Some(desktop) = Desktop::of(&ctx) {
                        desktop.persist_tab_layouts(&ctx);
                    }
                }
            }))
        });

        self.register_url_scheme();

        let argv = launch_arguments(&self.backend.argv(), false);
        let request = parse_launch_argv(&argv, DEEP_LINK_PROTOCOL, |path| self.backend.directory_exists(path));
        let explicit_cwd = match &request {
            LaunchRequest::Path(path) => Some(path.clone()),
            _ => None,
        };

        self.install_shortcuts(ctx, registry.clone());
        self.restore_startup_windows(ctx, explicit_cwd);
        let ids = self.windows.ids();
        self.quick_entry.mark_startup_windows(ctx, self, &ids);

        self.tray.install(ctx, self);
        self.install_app_menu(ctx);

        // Cold-start links: argv everywhere, plus the OS handoff on macOS. Off
        // macOS the plugin's startup URLs are a copy of the same argv.
        if let LaunchRequest::Url(url) = &request {
            self.links_offer_cold_start(url.clone());
        }
        if plugin_owns_links(self.backend.platform()) {
            for url in self.backend.startup_urls() {
                self.links_offer_cold_start(url);
            }
        }
        self.replay_pending_links(ctx);
        if request == LaunchRequest::QuickEntry {
            self.quick_entry.show_when_settled(ctx, self);
        }
        registry.start();
    }

    /// Make this binary the system `omp://` handler. Only a release build does:
    /// a debug or e2e build would point every link on the desktop at a binary
    /// that runs without the profile it was started with.
    fn register_url_scheme(&self) {
        if registers_url_scheme(BuildKind::current(), self.backend.platform()) {
            self.register_url_scheme_now();
        }
    }

    #[cfg(not(debug_assertions))]
    fn register_url_scheme_now(&self) {
        if let Err(error) = self.backend.register_deep_link_scheme() {
            runtime_log::note("unknown", format!("could not register the omp:// scheme: {error}"), json!({}));
        }
    }

    /// The registration is not even compiled into a debug build.
    #[cfg(debug_assertions)]
    fn register_url_scheme_now(&self) {}

    fn links_offer_cold_start(&self, url: String) {
        // Before setup the buffer holds it; `replay_pending_links` runs right after.
        if let Some(ctx) = self.ctx() {
            self.open_url(&ctx, url);
        }
    }
}

impl DesktopPort for Desktop {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn spawn_window(&self, cwd: Option<String>, pending_session_path: Option<String>, kind: Option<SessionKind>) -> Option<WindowId> {
        let ctx = self.ctx()?;
        self.spawn_window_in(&ctx, cwd, pending_session_path, kind)
    }

    fn records(&self) -> Vec<WindowRecord> {
        self.windows.records()
    }

    fn record(&self, win_id: WindowId) -> Option<WindowRecord> {
        self.windows.record(win_id)
    }

    fn main_window(&self) -> Option<WindowId> {
        self.windows.main_window()
    }

    fn target_window(&self) -> Option<WindowId> {
        self.windows.target_window()
    }

    fn focus(&self, win_id: WindowId) -> bool {
        if !self.windows.is_record(win_id) || !self.backend.exists(win_id) {
            return false;
        }
        self.backend.focus(win_id);
        true
    }

    fn set_cwd(&self, win_id: WindowId, cwd: &str) {
        self.windows.set_cwd(win_id, cwd);
    }

    fn consume_pending_session(&self, win_id: WindowId) -> Option<String> {
        self.windows.consume_pending_session(win_id)
    }

    fn set_run_progress(&self, state: RunProgressState) {
        self.apply_run_progress(state);
    }

    fn on_window_closed(&self, listener: WindowClosedListener) {
        lock(&self.closed_listeners).push(listener);
    }

    fn rebuild_menu(&self) {
        if let Some(ctx) = self.ctx() {
            self.install_app_menu(&ctx);
        }
    }

    fn is_main_owned_pref_key(&self, key: &str) -> bool {
        shortcut_core::is_main_owned_pref_key(key)
    }

    fn on_second_instance(&self, argv: Vec<String>, cwd: Option<String>) {
        let _ = cwd;
        if let Some(ctx) = self.ctx() {
            self.on_second_instance_in(&ctx, argv);
        }
    }

    fn request_quit(&self) {
        match self.ctx() {
            Some(ctx) => self.request_quit_in(&ctx),
            None => {
                self.quit.approve();
                self.quitting.store(true, Ordering::SeqCst);
            }
        }
    }

    fn on_exit_requested(&self, code: Option<i32>) -> bool {
        let approved = self.quit.approved() || self.is_quitting_latched();
        match exit_decision(code, approved, self.backend.platform()) {
            ExitDecision::Allow => false,
            ExitDecision::Veto => true,
            ExitDecision::VetoAndAsk => {
                if let Some(ctx) = self.ctx() {
                    self.start_guarded_quit(&ctx);
                }
                true
            }
        }
    }

    fn on_reopen(&self, has_visible_windows: bool) {
        if let Some(ctx) = self.ctx() {
            self.on_reopen_in(&ctx, has_visible_windows);
        }
    }

    fn mark_quitting(&self) {
        self.quitting.store(true, Ordering::SeqCst);
    }

    fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    fn quit_risk(&self) -> QuitRisk {
        match self.ctx() {
            Some(ctx) => self.quit_risk_in(&ctx),
            None => QuitRisk::default(),
        }
    }

    fn approve_quit_before_install(&self) -> BoxFuture<'_, bool> {
        Box::pin(async move {
            match self.ctx() {
                Some(ctx) => self.approve_quit_before_install_in(&ctx).await,
                None => true,
            }
        })
    }

    fn withdraw_quit_approval(&self) {
        self.quit.withdraw();
    }

    fn shutdown(&self) -> BoxFuture<'_, ()> {
        self.shutdown_in();
        Box::pin(std::future::ready(()))
    }
}

/// Wire the module: listeners on the other ports, shortcuts, the startup
/// windows, tray, menu and deep links. Runs on the main thread after the
/// context is managed.
pub fn init(ctx: &Arc<AppCtx>, app: &AppHandle) -> tauri::Result<()> {
    let Some(desktop) = Desktop::of(ctx) else { return Ok(()) };
    let registry: Arc<dyn ShortcutRegistry> = shortcut_registry_for(app, desktop.wayland_portal, &desktop.backend.env());
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        let weak = Arc::downgrade(ctx);
        app.deep_link().on_open_url(move |event| {
            survive("deep link event", || {
                let Some(ctx) = weak.upgrade() else { return };
                let Some(desktop) = Desktop::of(&ctx) else { return };
                desktop.on_plugin_urls(&ctx, event.urls());
            });
        });
    }
    {
        let weak = Arc::downgrade(ctx);
        app.on_menu_event(move |_app, event| {
            survive("menu event", || {
                let Some(ctx) = weak.upgrade() else { return };
                let Some(desktop) = Desktop::of(&ctx) else { return };
                desktop.on_menu_id(&ctx, event.id().as_ref());
            });
        });
    }
    desktop.start(ctx, registry);
    Ok(())
}

#[cfg(target_os = "linux")]
fn shortcut_registry_for(app: &AppHandle, portal: bool, env: &wayland_portal::Env) -> Arc<dyn ShortcutRegistry> {
    if !portal {
        return Arc::new(shortcut::PluginShortcutRegistry::new(app.clone()));
    }
    // GNOME's portal reports a chord mutter refused as bound; read GNOME's own bindings to see it.
    let gnome_bindings = if gnome_keybindings::is_gnome_session(env) {
        let bindings = survive("read GNOME keybindings", gnome_keybindings::read_gnome_keybindings).unwrap_or_default();
        runtime_log::note("global-shortcut", format!("read {} GNOME keybinding settings", bindings.len()), json!({ "count": bindings.len() }));
        bindings
    } else {
        Vec::new()
    };
    Arc::new(shortcut::PortalShortcutRegistry::new(gnome_bindings))
}

#[cfg(not(target_os = "linux"))]
fn shortcut_registry_for(app: &AppHandle, _portal: bool, _env: &wayland_portal::Env) -> Arc<dyn ShortcutRegistry> {
    Arc::new(shortcut::PluginShortcutRegistry::new(app.clone()))
}

#[cfg(test)]
pub(crate) mod testing {
    //! A context with the real `Desktop` over the fake backend and the testing fakes.

    use std::sync::Arc;

    pub(crate) use super::windows::fake::FakeBackend;
    pub(crate) use super::windows::Backend;
    use super::{Desktop, Platform};
    pub(crate) use crate::ports::DesktopPort;
    use crate::bridge::Registry;
    use crate::ctx::AppCtx;
    use crate::ports::{Caller, WindowId};
    use crate::testing::{fake_ctx_cyclic, Fakes, RecordingSink};

    /// A view into the `Desktop` the context holds; the trait object cannot be
    /// turned back into an `Arc<Desktop>`, so tests reach it through `Deref`.
    pub(crate) struct DesktopView(Arc<AppCtx>);

    impl std::ops::Deref for DesktopView {
        type Target = Desktop;
        fn deref(&self) -> &Desktop {
            self.0.desktop.as_any().downcast_ref::<Desktop>().expect("the harness installs the real Desktop")
        }
    }

    pub(crate) struct Harness {
        pub ctx: Arc<AppCtx>,
        pub desktop: DesktopView,
        pub fakes: Box<Fakes>,
        pub backend: Arc<FakeBackend>,
    }

    pub(crate) fn harness(platform: Platform) -> Harness {
        let fakes = Box::new(Fakes::default());
        let backend = Arc::new(FakeBackend::new(platform));
        let installed = backend.clone();
        let mut registry = Registry::new();
        super::register(&mut registry);
        let ctx = fake_ctx_cyclic(&fakes, registry, move |ctx, ports| {
            ports.desktop = Some(Arc::new(Desktop::with_backend(installed, ctx.clone())));
        });
        *backend.ctx.lock().unwrap() = Some(Arc::downgrade(&ctx));
        let desktop = DesktopView(ctx.clone());
        desktop.install_shortcuts(&ctx, Arc::new(AcceptAllRegistry));
        Harness { desktop, ctx, fakes, backend }
    }

    /// A shortcut registry that grabs everything and never fires.
    pub(crate) struct AcceptAllRegistry;

    impl super::shortcut::ShortcutRegistry for AcceptAllRegistry {
        fn register(&self, _id: &str, _accelerator: &str, _callback: super::shortcut::Activation) -> Result<bool, String> {
            Ok(true)
        }
        fn unregister(&self, _accelerator: &str) -> Result<(), String> {
            Ok(())
        }
        fn set_suspended(&self, _suspended: bool) {}
        fn start(&self) {}
    }

    /// Attach a recording channel as the page of `win_id` would.
    pub(crate) fn attach_recording_sink(ctx: &Arc<AppCtx>, win_id: WindowId) -> Arc<RecordingSink> {
        let sink = Arc::new(RecordingSink::default());
        let caller = if win_id == WindowId::QUICK_ENTRY { Caller::quick_entry() } else { Caller::main(win_id) };
        ctx.bridge.attach(ctx, caller, format!("gen-{win_id}"), sink.clone());
        sink
    }
}
