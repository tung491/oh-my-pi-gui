//! The one way windows are created. `build_window` applies a caller-supplied
//! `WindowSpec` first and the security settings last, so no spec field can
//! weaken them: the shared data directory, the navigation lock, the new-window
//! lock, HTML5 drops, the bootstrap init script and, on Linux, the WebKitGTK
//! sandbox assertion, media permissions, spell checking and crash recovery.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use serde_json::json;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri::Url;

use crate::bridge;
use crate::ctx::AppCtx;
use crate::paths;
use crate::ports::{Caller, Host, SaveDialogOptions, WindowId, WindowKind};
use crate::product;
use crate::runtime_log;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Reload a crashed web process at most once per this many milliseconds (`renderer-recovery.ts`).
pub const RENDERER_RECOVERY_COOLDOWN_MS: u64 = 30_000;
/// Exit code when the WebKitGTK sandbox is off: the UI must not show unsandboxed.
pub const SANDBOX_MISSING_EXIT_CODE: i32 = 70;

/// Everything a caller may vary about a window. The label is derived, never passed.
#[derive(Clone, Debug, PartialEq)]
pub struct WindowSpec {
    pub kind: WindowKind,
    pub win_id: WindowId,
    /// `"index.html"` or `"quick-entry.html"`.
    pub url: &'static str,
    pub title: String,
    pub inner_size: (f64, f64),
    pub min_inner_size: Option<(f64, f64)>,
    pub max_inner_size: Option<(f64, f64)>,
    pub position: Option<(f64, f64)>,
    pub visible: bool,
    pub decorations: bool,
    /// Left at Tauri's default unless `false`: on GTK, `resizable(false)` grows a
    /// 680×168 request to 680×200, so a fixed size is pinned with equal min and max sizes instead.
    pub resizable: bool,
    pub minimizable: bool,
    pub maximizable: bool,
    pub skip_taskbar: bool,
    pub always_on_top: bool,
    pub focused: bool,
    pub background_color: Option<tauri::window::Color>,
}

impl Default for WindowSpec {
    fn default() -> Self {
        Self {
            kind: WindowKind::Main,
            win_id: WindowId(1),
            url: "index.html",
            title: product::PRODUCT_NAME.to_string(),
            inner_size: (1400.0, 900.0),
            min_inner_size: None,
            max_inner_size: None,
            position: None,
            visible: true,
            decorations: true,
            resizable: true,
            minimizable: true,
            maximizable: true,
            skip_taskbar: false,
            always_on_top: false,
            focused: true,
            background_color: None,
        }
    }
}

impl WindowSpec {
    pub fn caller(&self) -> Caller {
        Caller { win_id: self.win_id, kind: self.kind }
    }

    /// `main-<n>` or `quick-entry`.
    pub fn label(&self) -> String {
        match self.kind {
            WindowKind::Main => self.win_id.label(),
            WindowKind::QuickEntry => WindowKind::QUICK_ENTRY_LABEL.to_string(),
        }
    }
}

/// One builder call `build_window` will make, in order. Pure data so tests can
/// check the plan without a runtime.
#[derive(Clone, Debug, PartialEq)]
pub enum BuilderCall {
    Title(String),
    InnerSize(f64, f64),
    MinInnerSize(f64, f64),
    MaxInnerSize(f64, f64),
    Position(f64, f64),
    Visible(bool),
    Decorations(bool),
    Resizable(bool),
    Minimizable(bool),
    Maximizable(bool),
    SkipTaskbar(bool),
    AlwaysOnTop(bool),
    Focused(bool),
    BackgroundColor(tauri::window::Color),
    // Security settings; always after every spec call.
    DataDirectory(PathBuf),
    DisableDragDropHandler,
    NavigationLock,
    NewWindowLock,
    /// Detach the bridge when a page starts loading, so emits during a reload are kept for the next page.
    ReloadDetach,
    /// Route same-origin blob downloads through the save dialog; refuse every other download.
    DownloadHandler,
    InitializationScript,
}

/// The builder calls a spec produces, in order.
pub fn spec_calls(spec: &WindowSpec) -> Vec<BuilderCall> {
    let mut calls = vec![
        BuilderCall::Title(spec.title.clone()),
        BuilderCall::InnerSize(spec.inner_size.0, spec.inner_size.1),
    ];
    if let Some((w, h)) = spec.min_inner_size {
        calls.push(BuilderCall::MinInnerSize(w, h));
    }
    if let Some((w, h)) = spec.max_inner_size {
        calls.push(BuilderCall::MaxInnerSize(w, h));
    }
    if let Some((x, y)) = spec.position {
        calls.push(BuilderCall::Position(x, y));
    }
    calls.push(BuilderCall::Visible(spec.visible));
    calls.push(BuilderCall::Decorations(spec.decorations));
    if !spec.resizable {
        calls.push(BuilderCall::Resizable(false));
    }
    calls.push(BuilderCall::Minimizable(spec.minimizable));
    calls.push(BuilderCall::Maximizable(spec.maximizable));
    calls.push(BuilderCall::SkipTaskbar(spec.skip_taskbar));
    calls.push(BuilderCall::AlwaysOnTop(spec.always_on_top));
    calls.push(BuilderCall::Focused(spec.focused));
    if let Some(color) = spec.background_color {
        calls.push(BuilderCall::BackgroundColor(color));
    }
    calls
}

/// The security calls, applied after the spec.
pub fn security_calls(data_dir: PathBuf) -> Vec<BuilderCall> {
    vec![
        BuilderCall::DataDirectory(data_dir),
        BuilderCall::DisableDragDropHandler,
        BuilderCall::NavigationLock,
        BuilderCall::NewWindowLock,
        BuilderCall::ReloadDetach,
        BuilderCall::DownloadHandler,
        BuilderCall::InitializationScript,
    ]
}

/// The complete plan: spec first, security last.
pub fn apply_spec(spec: &WindowSpec, data_dir: PathBuf) -> Vec<BuilderCall> {
    let mut calls = spec_calls(spec);
    calls.extend(security_calls(data_dir));
    calls
}

fn strip_fragment(url: &Url) -> Url {
    let mut copy = url.clone();
    copy.set_fragment(None);
    copy
}

/// Whether `url` is on the app's own origin: `tauri://localhost`, the
/// `http(s)://tauri.localhost` origin Windows serves the app from (elsewhere
/// that host resolves to 127.0.0.1 and is not the app), or the dev server in a
/// debug build.
fn is_app_origin(url: &Url, dev_url: Option<&Url>, debug: bool) -> bool {
    let app = match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => cfg!(windows) && url.host_str() == Some("tauri.localhost"),
        _ => false,
    };
    app || matches!((debug, dev_url), (true, Some(dev)) if url.origin() == dev.origin())
}

/// Whether the app may navigate to `candidate`: only the page's own URL on the
/// app origin, or a `blob:` URL the page created itself (an `<a download>`
/// click reaches WebKitGTK as a navigation to that URL before it becomes a
/// download). Everything else is denied, matching Electron's `will-navigate`
/// → `preventDefault()`.
pub fn navigation_allowed(candidate: &Url, page: &str, dev_url: Option<&Url>, debug: bool) -> bool {
    let candidate = strip_fragment(candidate);
    if candidate.scheme() == "blob" {
        return download_allowed(&candidate, dev_url, debug);
    }
    // Tauri loads the main page as `tauri://localhost`, whose path is empty, not `/`.
    let path_ok = candidate.path() == format!("/{page}") || (page == "index.html" && matches!(candidate.path(), "" | "/"));
    path_ok && is_app_origin(&candidate, dev_url, debug)
}

/// Whether a download of `url` may proceed: only a `blob:` URL whose inner
/// origin (`blob:<origin>/<uuid>`) is the app's, which is what
/// `URL.createObjectURL` in the page produces. Nothing else is ever downloaded.
pub fn download_allowed(url: &Url, dev_url: Option<&Url>, debug: bool) -> bool {
    if url.scheme() != "blob" {
        return false;
    }
    Url::parse(url.path()).map(|inner| is_app_origin(&inner, dev_url, debug)).unwrap_or(false)
}

/// What to do with a `window.open`/new-window request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NewWindowAction {
    /// An `http`/`https` URL opens in the browser.
    OpenExternally,
    /// Every other scheme is dropped.
    Deny,
}

pub fn new_window_action(url: &Url) -> NewWindowAction {
    match url.scheme() {
        "http" | "https" => NewWindowAction::OpenExternally,
        _ => NewWindowAction::Deny,
    }
}

/// The WebKit spell-checking language from a POSIX locale value (`vi_VN.UTF-8` → `vi_VN`).
pub fn spell_checking_language(locale: Option<&str>) -> String {
    let value = locale.map(str::trim).unwrap_or("");
    let base = value.split(['.', '@']).next().unwrap_or("");
    if base.is_empty() || base == "C" || base == "POSIX" {
        "en_US".to_string()
    } else {
        base.replace('-', "_")
    }
}

/// Whether a crashed web process may be reloaded now (`shouldReloadRenderer`).
pub fn should_reload(last_recovery_ms: Option<u64>, now_ms: u64) -> bool {
    match last_recovery_ms {
        None => true,
        Some(last) => now_ms.saturating_sub(last) >= RENDERER_RECOVERY_COOLDOWN_MS,
    }
}

fn apply_calls<'a>(
    mut builder: WebviewWindowBuilder<'a, tauri::Wry, AppHandle>,
    calls: &[BuilderCall],
    spec: &WindowSpec,
    ctx: &Arc<AppCtx>,
    dev_url: Option<Url>,
    init_script: &str,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    for call in calls {
        builder = match call {
            BuilderCall::Title(title) => builder.title(title),
            BuilderCall::InnerSize(w, h) => builder.inner_size(*w, *h),
            BuilderCall::MinInnerSize(w, h) => builder.min_inner_size(*w, *h),
            BuilderCall::MaxInnerSize(w, h) => builder.max_inner_size(*w, *h),
            BuilderCall::Position(x, y) => builder.position(*x, *y),
            BuilderCall::Visible(visible) => builder.visible(*visible),
            BuilderCall::Decorations(decorations) => builder.decorations(*decorations),
            BuilderCall::Resizable(resizable) => builder.resizable(*resizable),
            BuilderCall::Minimizable(minimizable) => builder.minimizable(*minimizable),
            BuilderCall::Maximizable(maximizable) => builder.maximizable(*maximizable),
            BuilderCall::SkipTaskbar(skip) => builder.skip_taskbar(*skip),
            BuilderCall::AlwaysOnTop(on_top) => builder.always_on_top(*on_top),
            BuilderCall::Focused(focused) => builder.focused(*focused),
            BuilderCall::BackgroundColor(color) => builder.background_color(*color),
            BuilderCall::DataDirectory(dir) => builder.data_directory(dir.clone()),
            BuilderCall::DisableDragDropHandler => builder.disable_drag_drop_handler(),
            BuilderCall::NavigationLock => {
                let page = spec.url;
                let dev_url = dev_url.clone();
                let label = spec.label();
                builder.on_navigation(move |url| {
                    let allowed = navigation_allowed(url, page, dev_url.as_ref(), cfg!(debug_assertions));
                    if !allowed {
                        runtime_log::note(
                            "renderer-load",
                            format!("blocked navigation of {label} to {url}"),
                            json!({ "label": label, "url": url.as_str() }),
                        );
                    }
                    allowed
                })
            }
            BuilderCall::NewWindowLock => {
                let host = ctx.host.clone();
                builder.on_new_window(move |url, _features| {
                    if new_window_action(&url) == NewWindowAction::OpenExternally {
                        if let Err(error) = host.open_url(url.as_str()) {
                            runtime_log::note("unknown", format!("could not open {url} externally: {error}"), json!({}));
                        }
                    }
                    NewWindowResponse::Deny
                })
            }
            BuilderCall::ReloadDetach => {
                let ctx = ctx.clone();
                let win_id = spec.win_id;
                builder.on_page_load(move |_window, payload| {
                    if matches!(payload.event(), PageLoadEvent::Started) {
                        ctx.bridge.detach(win_id);
                    }
                })
            }
            BuilderCall::DownloadHandler => {
                let downloads = Downloads::new(ctx.host.clone(), spec.win_id, dev_url.clone());
                builder.on_download(move |_webview, event| downloads.handle(event))
            }
            BuilderCall::InitializationScript => builder.initialization_script(init_script),
        };
    }
    builder
}

/// Create a window from `spec`. The only window constructor in the crate.
pub fn build_window(app: &AppHandle, spec: WindowSpec) -> tauri::Result<WebviewWindow> {
    let ctx = app.state::<Arc<AppCtx>>().inner().clone();
    let caller = spec.caller();
    let init_script = bridge::bootstrap_script(&ctx, caller);
    let data_dir = paths::webview_data_dir();
    if let Err(error) = std::fs::create_dir_all(&data_dir) {
        runtime_log::note("unknown", format!("could not create the webview data dir: {error}"), json!({ "path": data_dir.display().to_string() }));
    }
    let dev_url = app.config().build.dev_url.clone();
    let calls = apply_spec(&spec, data_dir);
    let builder = WebviewWindowBuilder::new(app, spec.label(), WebviewUrl::App(spec.url.into()));
    let builder = apply_calls(builder, &calls, &spec, &ctx, dev_url, &init_script);
    ctx.bridge.register_window(caller);
    let window = builder.build()?;
    #[cfg(target_os = "linux")]
    configure_webkit(&window, &spec, &ctx);
    Ok(window)
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

/// Downloads the page starts itself (`<a download>` on a `URL.createObjectURL`
/// result, as the log export does). WebKit writes the file to a hidden staging
/// name in the Downloads folder; once it has finished, the user picks the
/// destination through `Host::save_dialog` and the file moves there, which is
/// what Electron's default `will-download` handling did. The dialog cannot run
/// inside the request callback: that runs on the main thread, which the dialog
/// itself needs.
///
/// Every window gets its own handler, but on WebKitGTK all of them hang off the
/// one shared web context, so each download's `Finished` event reaches every
/// window's handler (and `Requested` reaches the first one built). The
/// bookkeeping is therefore process-wide: the first `Requested` for a URL
/// stages it, later ones reuse that staging path, and the first `Finished`
/// claims it, so the save dialog opens exactly once per download.
struct Downloads {
    host: Arc<dyn Host>,
    win_id: WindowId,
    dev_url: Option<Url>,
    staging_dir: PathBuf,
    /// Decide completion from the staged file rather than wry's reported result
    /// (see `download_completed`).
    filesystem_decides: bool,
    registry: Arc<DownloadRegistry>,
}

/// The downloads in flight across every window, by URL. A `blob:` URL is
/// unique per `URL.createObjectURL`, and wry reports the same request URI for
/// a download's request and its completion.
#[derive(Default)]
struct DownloadRegistry {
    counter: AtomicU64,
    in_flight: Mutex<HashMap<Url, StagedDownload>>,
}

#[derive(Clone, Debug, PartialEq)]
struct StagedDownload {
    /// The filename the page suggested, offered in the save dialog.
    suggested: String,
    /// Where WebKit writes the file until the user picks a destination.
    staged: PathBuf,
    /// The window whose handler staged the download, used as the dialog parent.
    win_id: WindowId,
}

/// The one registry every window's download handler shares.
static DOWNLOAD_REGISTRY: LazyLock<Arc<DownloadRegistry>> = LazyLock::new(Arc::default);

/// Whether a finished download left a complete file to save. WebKitGTK removes
/// the file of a failed or cancelled download itself, while wry's failure flag
/// is set once per window and never cleared, so after one blocked download it
/// reports every later one as failed. There the staged file's presence is the
/// truth; elsewhere the reported result is, as long as the file is there.
fn download_completed(reported_success: bool, staged_exists: bool, filesystem_decides: bool) -> bool {
    staged_exists && (filesystem_decides || reported_success)
}

impl Downloads {
    fn new(host: Arc<dyn Host>, win_id: WindowId, dev_url: Option<Url>) -> Self {
        Self::with_registry(
            host,
            win_id,
            dev_url,
            downloads_dir(),
            cfg!(target_os = "linux"),
            DOWNLOAD_REGISTRY.clone(),
        )
    }

    fn with_registry(
        host: Arc<dyn Host>,
        win_id: WindowId,
        dev_url: Option<Url>,
        staging_dir: PathBuf,
        filesystem_decides: bool,
        registry: Arc<DownloadRegistry>,
    ) -> Self {
        Self { host, win_id, dev_url, staging_dir, filesystem_decides, registry }
    }

    fn handle(&self, event: DownloadEvent<'_>) -> bool {
        match event {
            DownloadEvent::Requested { url, destination } => self.requested(url, destination),
            DownloadEvent::Finished { url, path, success } => {
                if let Some(save) = self.finished(url, path, success) {
                    bridge::spawn_task(save);
                }
                true
            }
            _ => true,
        }
    }

    fn requested(&self, url: Url, destination: &mut PathBuf) -> bool {
        if !download_allowed(&url, self.dev_url.as_ref(), cfg!(debug_assertions)) {
            runtime_log::note(
                "renderer-load",
                format!("blocked download of {url} for window {}", self.win_id),
                json!({ "winId": self.win_id.0, "url": url.as_str() }),
            );
            return false;
        }
        if let Some(record) = lock(&self.registry.in_flight).get(&url) {
            // Another window's handler staged this download already; keep its path
            // so the file lands where that record expects it.
            *destination = record.staged.clone();
            return true;
        }
        if let Err(error) = std::fs::create_dir_all(&self.staging_dir) {
            runtime_log::note(
                "unknown",
                format!("could not create the download directory: {error}"),
                json!({ "path": self.staging_dir.display().to_string() }),
            );
            return false;
        }
        // wry pre-fills the destination with the suggested filename under the Downloads folder.
        let suggested = destination
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "download".to_string());
        let mut in_flight = lock(&self.registry.in_flight);
        let record = in_flight.entry(url).or_insert_with(|| StagedDownload {
            staged: self.staging_dir.join(format!(
                ".{suggested}.{}-{}.part",
                std::process::id(),
                self.registry.counter.fetch_add(1, Ordering::Relaxed)
            )),
            suggested,
            win_id: self.win_id,
        });
        *destination = record.staged.clone();
        true
    }

    /// Claim a finished download. Only the first handler to see it gets the
    /// record; the others return `None` without touching anything. A completed
    /// download yields the save task (dialog, then move or discard); a failed
    /// one has its staged file removed here.
    fn finished(&self, url: Url, path: Option<PathBuf>, success: bool) -> Option<impl Future<Output = ()> + Send + 'static> {
        let record = lock(&self.registry.in_flight).remove(&url)?;
        let StagedDownload { suggested, staged, win_id } = record;
        if let Some(reported) = path.as_ref().filter(|reported| **reported != staged) {
            runtime_log::note(
                "unknown",
                format!("download of {url} finished at {} instead of {}", reported.display(), staged.display()),
                json!({ "winId": win_id.0 }),
            );
        }
        if !download_completed(success, staged.exists(), self.filesystem_decides) {
            remove_staged(&staged);
            runtime_log::note("unknown", format!("download of {url} failed"), json!({ "winId": win_id.0 }));
            return None;
        }
        if !success {
            runtime_log::note(
                "unknown",
                format!("download of {url} was reported as failed but its file is complete; saving it"),
                json!({ "winId": win_id.0 }),
            );
        }
        let host = self.host.clone();
        let default_path = self.staging_dir.join(&suggested);
        Some(async move {
            let options = SaveDialogOptions { title: None, default_path: Some(default_path), filters: Vec::new(), parent: Some(win_id) };
            match host.save_dialog(options).await {
                Some(target) => {
                    if let Err(error) = move_file(&staged, &target) {
                        runtime_log::note(
                            "unknown",
                            format!("could not save the download to {}: {error}", target.display()),
                            json!({ "winId": win_id.0 }),
                        );
                        remove_staged(&staged);
                    }
                }
                None => remove_staged(&staged),
            }
        })
    }
}

/// Remove a staged download, logging anything but its already being gone.
fn remove_staged(staged: &Path) {
    if let Err(error) = std::fs::remove_file(staged) {
        if error.kind() != std::io::ErrorKind::NotFound {
            runtime_log::note(
                "unknown",
                format!("could not remove the staged download {}: {error}", staged.display()),
                json!({}),
            );
        }
    }
}

/// The user's Downloads folder, the home directory, or the profile as a last resort.
fn downloads_dir() -> PathBuf {
    dirs::download_dir().or_else(dirs::home_dir).unwrap_or_else(|| paths::user_data_dir().join("downloads"))
}

/// Rename, or copy and remove when the destination is on another filesystem.
fn move_file(from: &Path, to: &Path) -> std::io::Result<()> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, to)?;
    std::fs::remove_file(from)
}

// ---------------------------------------------------------------------------
// Linux: WebKitGTK hooks
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
mod linux {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Once;

    use gobject_sys::{g_type_class_ref, GObject, GObjectClass};
    use webkit2gtk_sys::{webkit_web_context_get_type, webkit_web_context_set_sandbox_enabled, WebKitWebContext};

    type Constructed = unsafe extern "C" fn(*mut GObject);

    static INSTALL: Once = Once::new();
    static ORIGINAL: AtomicUsize = AtomicUsize::new(0);
    static HOOKED_CONTEXTS: AtomicUsize = AtomicUsize::new(0);

    unsafe extern "C" fn constructed_with_sandbox(object: *mut GObject) {
        let original = ORIGINAL.load(Ordering::SeqCst);
        if original != 0 {
            // SAFETY: `original` is the `constructed` vfunc pointer read from the
            // class struct in `install_sandbox_hook`, stored as usize; it has the
            // `Constructed` signature by GObject ABI.
            let original: Constructed = unsafe { std::mem::transmute::<usize, Constructed>(original) };
            unsafe { original(object) };
        }
        // SAFETY: `object` is a WebKitWebContext instance being constructed; the
        // sandbox flag may be set until the first web process launches, which
        // happens lazily after `constructed` returns.
        unsafe { webkit_web_context_set_sandbox_enabled(object as *mut WebKitWebContext, 1) };
        HOOKED_CONTEXTS.fetch_add(1, Ordering::SeqCst);
    }

    /// Override the GObject `constructed` vfunc of `WebKitWebContext` once, so
    /// every context is sandboxed before its first web process. wry builds the
    /// context and the webview back to back inside `WebViewBuilder::build`, so
    /// Tauri's `with_webview` runs too late; this is the only hook that works.
    pub fn install_sandbox_hook() {
        INSTALL.call_once(|| {
            // SAFETY: `g_type_class_ref` returns the class struct for the type,
            // which stays alive for the process (the ref is intentionally leaked);
            // `WebKitWebContext` is a final type with no subclasses, so replacing
            // its `constructed` vfunc affects exactly the contexts wry creates.
            unsafe {
                let class = g_type_class_ref(webkit_web_context_get_type()) as *mut GObjectClass;
                if class.is_null() {
                    crate::runtime_log::note(
                        "unknown",
                        "g_type_class_ref(WebKitWebContext) returned NULL; the sandbox hook is not installed",
                        serde_json::json!({}),
                    );
                    return;
                }
                if let Some(original) = (*class).constructed {
                    ORIGINAL.store(original as usize, Ordering::SeqCst);
                }
                (*class).constructed = Some(constructed_with_sandbox);
            }
        });
    }

    /// How many contexts the hook has sandboxed so far.
    pub fn hooked_contexts() -> usize {
        HOOKED_CONTEXTS.load(Ordering::SeqCst)
    }
}

#[cfg(target_os = "linux")]
pub use linux::{hooked_contexts, install_sandbox_hook};

/// The channel the WebKitGTK drag observer sends a file drag's paths on.
#[cfg(target_os = "linux")]
const NATIVE_DROP_PATHS_CHANNEL: &str = "system:native-drop-paths";

/// Absolute local paths of the `file://` URIs in a drag's URI list, in order and
/// without duplicates. Other schemes, remote hosts and non-UTF-8 paths are skipped.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn file_paths_from_uris<S: AsRef<str>>(uris: &[S]) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for uri in uris {
        let Ok(url) = Url::parse(uri.as_ref().trim()) else { continue };
        if url.scheme() != "file" || !matches!(url.host_str(), None | Some("") | Some("localhost")) {
            continue;
        }
        let Ok(path) = url.to_file_path() else { continue };
        let Some(path) = path.to_str().filter(|path| Path::new(path).is_absolute()) else { continue };
        if !paths.iter().any(|seen| seen == path) {
            paths.push(path.to_string());
        }
    }
    paths
}

#[cfg(target_os = "linux")]
fn configure_webkit(window: &WebviewWindow, spec: &WindowSpec, ctx: &Arc<AppCtx>) {
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    use glib::prelude::Cast;
    use webkit2gtk::{PermissionRequestExt, SettingsExt, UserMediaPermissionRequestExt, WebContextExt, WebViewExt};

    let label = spec.label();
    let failed_label = label.clone();
    let drop_target = (spec.kind == WindowKind::Main).then(|| (ctx.clone(), spec.win_id));
    let result = window.with_webview(move |platform| {
        let webview = platform.inner();
        // The page never sees a dropped file's path on WebKitGTK, and Tauri's own
        // drop handler stays off because it would take every drop away from HTML5
        // DnD (tab reorder, pane split). This handler only reads the data WebKit
        // already requested and returns nothing, so WebKit's own handling and the
        // page's drag events run unchanged; the page pairs the paths with its drop.
        // Every URI-list drag is reported, an empty list included, so a link drag
        // clears the paths an earlier, abandoned file drag left behind.
        if let Some((ctx, win_id)) = drop_target {
            gtk::prelude::WidgetExt::connect_drag_data_received(&webview, move |_, _, _, _, data, _, _| {
                if data.target().name() != "text/uri-list" {
                    return;
                }
                let paths = file_paths_from_uris(&data.uris());
                ctx.bridge.emit_to_window(win_id, NATIVE_DROP_PATHS_CHANNEL, json!({ "paths": paths }));
            });
        }
        match webview.context() {
            Some(context) if context.is_sandbox_enabled() => {
                context.set_spell_checking_enabled(true);
                let locale = std::env::var("LC_ALL")
                    .or_else(|_| std::env::var("LC_MESSAGES"))
                    .or_else(|_| std::env::var("LANG"))
                    .ok();
                let language = spell_checking_language(locale.as_deref());
                context.set_spell_checking_languages(&[language.as_str()]);
            }
            _ => {
                runtime_log::note(
                    "renderer-process",
                    "the WebKitGTK web-process sandbox is not enabled; refusing to show an unsandboxed window",
                    json!({ "label": label, "hookedContexts": hooked_contexts() }),
                );
                std::process::exit(SANDBOX_MISSING_EXIT_CODE);
            }
        }
        if let Some(settings) = webview.settings() {
            settings.set_enable_media_stream(true);
            settings.set_enable_webaudio(true);
        }
        webview.connect_permission_request(|_, request| {
            match request.downcast_ref::<webkit2gtk::UserMediaPermissionRequest>() {
                Some(media) if media.is_for_audio_device() && !media.is_for_video_device() => request.allow(),
                _ => request.deny(),
            }
            true
        });
        let last_recovery: Mutex<Option<u64>> = Mutex::new(None);
        let crashed_label = label.clone();
        webview.connect_web_process_terminated(move |webview, reason| {
            let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            let mut last = last_recovery.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let reload = should_reload(*last, now_ms);
            runtime_log::note(
                "renderer-process",
                format!("web process of {crashed_label} terminated ({reason:?}); reload={reload}"),
                json!({ "label": crashed_label, "reason": format!("{reason:?}"), "reload": reload }),
            );
            if reload {
                *last = Some(now_ms);
                webview.reload();
            }
        });
    });
    if let Err(error) = result {
        // The sandbox could not be verified; that is as fatal as finding it off.
        runtime_log::note(
            "renderer-process",
            format!("with_webview failed for {failed_label}: {error}; the sandbox cannot be verified, refusing to show the window"),
            json!({ "label": failed_label, "hookedContexts": hooked_contexts() }),
        );
        std::process::exit(SANDBOX_MISSING_EXIT_CODE);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_paths_from_uris_decodes_local_file_uris_in_order_without_duplicates() {
        let uris = [
            "file:///home/u/B%C3%A1o%20c%C3%A1o%201.pdf",
            "file:///home/u/notes.txt\r\n",
            "file://localhost/tmp/a.png",
            "file:///home/u/B%C3%A1o%20c%C3%A1o%201.pdf",
        ];
        assert_eq!(file_paths_from_uris(&uris), ["/home/u/Báo cáo 1.pdf", "/home/u/notes.txt", "/tmp/a.png"]);
    }

    #[test]
    fn file_paths_from_uris_skips_other_schemes_remote_hosts_and_garbage() {
        let uris = ["https://example.com/a.pdf", "file://server/share/b.pdf", "not a uri", "", "# comment"];
        assert!(file_paths_from_uris(&uris).is_empty());
    }

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn allows_the_initial_app_url() {
        assert!(navigation_allowed(&url("tauri://localhost/index.html"), "index.html", None, false));
        assert!(navigation_allowed(&url("tauri://localhost/index.html#top"), "index.html", None, false));
        assert!(navigation_allowed(&url("tauri://localhost/quick-entry.html"), "quick-entry.html", None, false));
        assert!(navigation_allowed(&url("tauri://localhost/"), "index.html", None, false));
        assert!(navigation_allowed(&url("tauri://localhost"), "index.html", None, false));
    }

    #[test]
    fn tauri_localhost_is_the_app_origin_only_on_windows() {
        let windows_origin = navigation_allowed(&url("http://tauri.localhost/quick-entry.html"), "quick-entry.html", None, false);
        assert_eq!(windows_origin, cfg!(windows));
        assert_eq!(navigation_allowed(&url("https://tauri.localhost/index.html"), "index.html", None, false), cfg!(windows));
    }

    #[test]
    fn allows_same_origin_blob_downloads_and_denies_foreign_ones() {
        assert!(navigation_allowed(&url("blob:tauri://localhost/3f1c-uuid"), "index.html", None, false));
        assert!(download_allowed(&url("blob:tauri://localhost/3f1c-uuid"), None, false));
        assert!(!navigation_allowed(&url("blob:https://evil.example/3f1c-uuid"), "index.html", None, false));
        assert!(!download_allowed(&url("blob:https://evil.example/3f1c-uuid"), None, false));
        assert!(!download_allowed(&url("blob:not-a-url"), None, false));
        assert!(!download_allowed(&url("https://example.com/file.zip"), None, false));
        assert!(!download_allowed(&url("file:///etc/passwd"), None, false));
        // The dev server's blobs count only in a debug build, like its pages.
        let dev = url("http://localhost:5183");
        assert!(download_allowed(&url("blob:http://localhost:5183/3f1c-uuid"), Some(&dev), true));
        assert!(!download_allowed(&url("blob:http://localhost:5183/3f1c-uuid"), Some(&dev), false));
        assert!(!download_allowed(&url("blob:http://localhost:9999/3f1c-uuid"), Some(&dev), true));
    }

    #[test]
    fn denies_later_navigations() {
        assert!(!navigation_allowed(&url("https://example.com/"), "index.html", None, false));
        assert!(!navigation_allowed(&url("file:///etc/passwd"), "index.html", None, false));
        assert!(!navigation_allowed(&url("tauri://localhost/other.html"), "index.html", None, false));
        assert!(!navigation_allowed(&url("tauri://evil/index.html"), "index.html", None, false));
        // The bar must not load the chat page and vice versa.
        assert!(!navigation_allowed(&url("tauri://localhost/index.html"), "quick-entry.html", None, false));
        assert!(!navigation_allowed(&url("tauri://localhost"), "quick-entry.html", None, false));
    }

    #[test]
    fn denies_non_http_new_windows() {
        assert_eq!(new_window_action(&url("https://docs.example.com/x")), NewWindowAction::OpenExternally);
        assert_eq!(new_window_action(&url("http://localhost:3000/")), NewWindowAction::OpenExternally);
        assert_eq!(new_window_action(&url("file:///tmp/x")), NewWindowAction::Deny);
        assert_eq!(new_window_action(&url("javascript:alert(1)")), NewWindowAction::Deny);
        assert_eq!(new_window_action(&url("omp://new")), NewWindowAction::Deny);
    }

    #[test]
    fn allows_the_dev_url_only_in_debug() {
        let dev = url("http://localhost:5183");
        let page = url("http://localhost:5183/index.html");
        assert!(navigation_allowed(&page, "index.html", Some(&dev), true));
        assert!(!navigation_allowed(&page, "index.html", Some(&dev), false));
        assert!(!navigation_allowed(&page, "index.html", None, true));
        assert!(!navigation_allowed(&url("http://localhost:9999/index.html"), "index.html", Some(&dev), true));
    }

    #[test]
    fn equal_min_and_max_inner_size_are_applied_and_resizable_is_left_alone() {
        let spec = WindowSpec {
            kind: WindowKind::QuickEntry,
            win_id: WindowId::QUICK_ENTRY,
            url: "quick-entry.html",
            inner_size: (680.0, 168.0),
            min_inner_size: Some((680.0, 168.0)),
            max_inner_size: Some((680.0, 168.0)),
            decorations: false,
            ..WindowSpec::default()
        };
        let calls = spec_calls(&spec);
        assert!(calls.contains(&BuilderCall::MinInnerSize(680.0, 168.0)));
        assert!(calls.contains(&BuilderCall::MaxInnerSize(680.0, 168.0)));
        assert!(!calls.iter().any(|call| matches!(call, BuilderCall::Resizable(_))));
        let fixed = spec_calls(&WindowSpec { resizable: false, ..WindowSpec::default() });
        assert!(fixed.contains(&BuilderCall::Resizable(false)));
    }

    #[test]
    fn security_settings_are_applied_after_the_spec() {
        let spec = WindowSpec { background_color: Some(tauri::window::Color(10, 26, 51, 255)), ..WindowSpec::default() };
        let calls = apply_spec(&spec, PathBuf::from("/profile/webview"));
        let first_security = calls.iter().position(|call| *call == BuilderCall::DataDirectory(PathBuf::from("/profile/webview"))).unwrap();
        let last_spec = calls.iter().rposition(|call| matches!(call, BuilderCall::BackgroundColor(_))).unwrap();
        assert!(last_spec < first_security);
        assert_eq!(
            &calls[first_security..],
            &security_calls(PathBuf::from("/profile/webview"))[..],
            "the security calls are the tail, in a fixed order"
        );
        assert_eq!(calls.last(), Some(&BuilderCall::InitializationScript));
    }

    #[test]
    fn the_label_derives_from_kind_and_id() {
        assert_eq!(WindowSpec { win_id: WindowId(3), ..WindowSpec::default() }.label(), "main-3");
        let bar = WindowSpec { kind: WindowKind::QuickEntry, win_id: WindowId(9), ..WindowSpec::default() };
        assert_eq!(bar.label(), "quick-entry", "the bar's label never carries a number");
        assert_eq!(WindowSpec::default().title, "Sai ATLAS");
        assert_eq!(WindowSpec::default().inner_size, (1400.0, 900.0));
    }

    #[test]
    fn spell_checking_falls_back_to_en_us() {
        assert_eq!(spell_checking_language(Some("vi_VN.UTF-8")), "vi_VN");
        assert_eq!(spell_checking_language(Some("en_GB@euro")), "en_GB");
        assert_eq!(spell_checking_language(Some("C.UTF-8")), "en_US");
        assert_eq!(spell_checking_language(None), "en_US");
    }

    #[test]
    fn crash_reloads_are_limited_to_one_per_cooldown() {
        assert!(should_reload(None, 1_000));
        assert!(!should_reload(Some(1_000), 20_000));
        assert!(should_reload(Some(1_000), 31_000));
    }

    /// Two windows' download handlers over one registry, as on WebKitGTK where
    /// every window's handler hears every download.
    struct TwoWindows {
        staging: tempfile::TempDir,
        host: Arc<crate::testing::FakeHost>,
        main: Downloads,
        bar: Downloads,
    }

    fn two_windows(filesystem_decides: bool) -> TwoWindows {
        let staging = tempfile::tempdir().unwrap();
        let host = Arc::new(crate::testing::FakeHost::new());
        let registry = Arc::new(DownloadRegistry::default());
        let window = |win_id| {
            Downloads::with_registry(
                host.clone(),
                win_id,
                None,
                staging.path().to_path_buf(),
                filesystem_decides,
                registry.clone(),
            )
        };
        let (main, bar) = (window(WindowId(1)), window(WindowId::QUICK_ENTRY));
        TwoWindows { staging, host, main, bar }
    }

    impl TwoWindows {
        /// What wry hands the handler: the suggested name under the Downloads folder.
        fn prefilled(&self, name: &str) -> PathBuf {
            self.staging.path().join(name)
        }

        /// Request `url` through `handler` and have "WebKit" write `body` to the staged path.
        fn download(&self, handler: &Downloads, url: &Url, name: &str, body: &str) -> PathBuf {
            let mut destination = self.prefilled(name);
            assert!(handler.requested(url.clone(), &mut destination));
            std::fs::write(&destination, body).unwrap();
            destination
        }

        fn save_dialogs(&self) -> Vec<String> {
            self.host.log.calls().into_iter().filter(|call| call.starts_with("save_dialog(")).collect()
        }

        fn answer_save_dialog(&self, answer: Option<PathBuf>) {
            self.host.save_dialog_answers.lock().unwrap().push(answer);
        }
    }

    #[test]
    fn every_window_stages_a_download_at_the_same_path() {
        let windows = two_windows(true);
        let blob = url("blob:tauri://localhost/3f1c-uuid");
        let mut first = windows.prefilled("omp-logs.log");
        let mut second = windows.prefilled("omp-logs.log");
        assert!(windows.main.requested(blob.clone(), &mut first));
        assert!(windows.bar.requested(blob, &mut second));
        assert_eq!(first, second, "a later handler must not redirect the file");
        assert_eq!(first.parent(), Some(windows.staging.path()));
        let staged_name = first.file_name().unwrap().to_string_lossy().to_string();
        assert!(staged_name.starts_with(".omp-logs.log.") && staged_name.ends_with(".part"), "{staged_name}");
    }

    #[tokio::test]
    async fn a_finished_download_opens_one_save_dialog_with_the_suggested_name() {
        let windows = two_windows(true);
        let blob = url("blob:tauri://localhost/3f1c-uuid");
        let staged = windows.download(&windows.main, &blob, "omp-logs.log", "log lines");
        let target = windows.staging.path().join("saved.log");
        windows.answer_save_dialog(Some(target.clone()));
        // The bar's handler hears the completion first; it still saves under the page's name.
        let save = windows.bar.finished(blob.clone(), Some(staged.clone()), true).expect("the first completion claims it");
        assert!(windows.main.finished(blob, Some(staged.clone()), true).is_none(), "the second completion is ignored");
        save.await;
        let dialogs = windows.save_dialogs();
        assert_eq!(dialogs.len(), 1, "{dialogs:?}");
        let suggested = format!("{:?}", windows.prefilled("omp-logs.log"));
        assert!(dialogs[0].contains(&suggested), "{dialogs:?}");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "log lines");
        assert!(!staged.exists());
    }

    #[tokio::test]
    async fn concurrent_downloads_are_handled_independently() {
        let windows = two_windows(true);
        let first = url("blob:tauri://localhost/first-uuid");
        let second = url("blob:tauri://localhost/second-uuid");
        let first_staged = windows.download(&windows.main, &first, "a.log", "a");
        let second_staged = windows.download(&windows.main, &second, "b.log", "b");
        assert_ne!(first_staged, second_staged);
        // Both dialogs are cancelled, which discards each staged file.
        let second_save = windows.main.finished(second.clone(), Some(second_staged.clone()), true).unwrap();
        assert!(windows.bar.finished(second, Some(second_staged.clone()), true).is_none());
        second_save.await;
        assert!(!second_staged.exists());
        assert!(first_staged.exists(), "finishing one download leaves the other alone");
        let first_save = windows.bar.finished(first, Some(first_staged.clone()), true).unwrap();
        first_save.await;
        assert!(!first_staged.exists());
        let dialogs = windows.save_dialogs();
        assert_eq!(dialogs.len(), 2, "{dialogs:?}");
        assert!(dialogs[0].contains(&format!("{:?}", windows.prefilled("b.log"))), "{dialogs:?}");
        assert!(dialogs[1].contains(&format!("{:?}", windows.prefilled("a.log"))), "{dialogs:?}");
    }

    #[test]
    fn a_failed_download_removes_its_staged_file_once() {
        let windows = two_windows(false);
        let blob = url("blob:tauri://localhost/3f1c-uuid");
        let staged = windows.download(&windows.main, &blob, "omp-logs.log", "partial");
        assert!(windows.main.finished(blob.clone(), None, false).is_none());
        assert!(!staged.exists(), "the partial file is discarded");
        // A file that shows up at the same path later is not this download's to remove.
        std::fs::write(&staged, "unrelated").unwrap();
        assert!(windows.bar.finished(blob, None, false).is_none());
        assert!(staged.exists(), "the second completion touches nothing");
        assert!(windows.save_dialogs().is_empty());
    }

    #[tokio::test]
    async fn a_complete_file_is_saved_even_when_reported_as_failed_where_the_filesystem_decides() {
        let windows = two_windows(true);
        let blob = url("blob:tauri://localhost/3f1c-uuid");
        let staged = windows.download(&windows.main, &blob, "omp-logs.log", "log lines");
        windows.answer_save_dialog(None);
        windows.main.finished(blob, None, false).expect("the staged file is complete").await;
        assert_eq!(windows.save_dialogs().len(), 1);
        assert!(!staged.exists(), "cancelling the dialog discards the file");
    }

    #[test]
    fn a_download_without_its_file_opens_no_dialog() {
        let windows = two_windows(true);
        let blob = url("blob:tauri://localhost/3f1c-uuid");
        let mut destination = windows.prefilled("omp-logs.log");
        assert!(windows.main.requested(blob.clone(), &mut destination));
        assert!(windows.main.finished(blob, Some(destination), true).is_none());
        assert!(windows.save_dialogs().is_empty());
    }

    #[test]
    fn a_blocked_download_is_never_staged() {
        let windows = two_windows(true);
        let foreign = url("https://example.com/file.zip");
        let mut destination = windows.prefilled("file.zip");
        assert!(!windows.main.requested(foreign.clone(), &mut destination));
        assert_eq!(destination, windows.prefilled("file.zip"));
        assert!(windows.bar.finished(foreign, None, false).is_none());
        assert!(windows.save_dialogs().is_empty());
    }

    #[test]
    fn download_completion_trusts_the_file_where_the_filesystem_decides() {
        assert!(download_completed(false, true, true), "a sticky failure flag does not discard a complete file");
        assert!(!download_completed(true, false, true));
        assert!(download_completed(true, true, false));
        assert!(!download_completed(false, true, false));
        assert!(!download_completed(true, false, false));
    }
}
