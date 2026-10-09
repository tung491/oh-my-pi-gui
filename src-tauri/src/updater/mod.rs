//! Module `updater`: GitHub release updates read from electron-builder's yml
//! feeds, with the same renderer-visible state machine as the Electron build.
//!
//! Decisions this port makes where Tauri differs from Electron:
//!
//! - **Install mode.** Every install is `automatic`: the downloaded deb or
//!   AppImage replaces the app itself.
//! - **Linux package kind.** `linux_package_kind` from `APPIMAGE`/`APPDIR`, the
//!   executable path and the `package-type` marker the .deb ships in
//!   `<exe dir>/../lib/Sai ATLAS` (falling back to `/usr/lib/Sai ATLAS` for an
//!   executable started through a compatibility path).
//! - **Download location.** Packages go to a cache directory this module owns
//!   and clears before each download.
//! - **Installs.** A deb runs `pkexec apt-get install -y --no-remove --
//!   <package>` after the quit prompt and relaunches `/usr/bin/sai-atlas`; an AppImage swaps `$APPIMAGE` and
//!   relaunches it. Installs on quit cover every kind but the deb
//!   (`installs_on_quit`).

mod feed;
mod install;
pub mod ipc;
mod state;

use std::any::Any;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::TryStreamExt as _;
use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::io::AsyncWriteExt as _;
use tokio::time::Instant;

use crate::bridge::{spawn_task, Registry, Scope};
use crate::ctx::AppCtx;
use crate::i18n::MainTextKey;
use crate::ports::{CtxRef, UpdaterPort};
use crate::runtime_log;

use feed::{Asset, AssetTarget};
use install::{InstallError, PkexecRunner, PrivilegedRunner};
use state::{
    asks_before_install, installer_partial_path, installs_on_quit, linux_package_kind, package_type_at, plan_installer_transfer,
    settle_incomplete_update_check, sha512_file_base64, LinuxPackageKind, UpdateInstallMode, UpdateStatus,
};

pub const CHANNELS: &[(&str, Scope)] = &[
    ("updater:check", Scope::Main),
    ("updater:download", Scope::Main),
    ("updater:apply", Scope::Main),
    ("updater:getStatus", Scope::Main),
    ("updater:version", Scope::Main),
];

pub const EMITS: &[&str] = &[
    "updater:status",
];

const STATUS_CHANNEL: &str = "updater:status";

pub fn register(reg: &mut Registry) {
    reg.register("updater:check", Scope::Main, ipc::updater_check);
    reg.register("updater:download", Scope::Main, ipc::updater_download);
    reg.register("updater:apply", Scope::Main, ipc::updater_apply);
    reg.register("updater:getStatus", Scope::Main, ipc::updater_get_status);
    reg.register("updater:version", Scope::Main, ipc::updater_version);
}

/// First check once the app settles; then every 4 h, as `updater.ts` schedules.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(3);
const CHECK_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const FEED_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// Everything about this install the updater needs to know, detected once in
/// production and passed in by tests.
pub(crate) struct Config {
    /// The releases page the feed and the packages are fetched from.
    pub release_base: String,
    /// Where packages download to.
    pub download_dir: PathBuf,
    /// The Linux install kind.
    pub kind: LinuxPackageKind,
    /// `$APPIMAGE`: the file an AppImage install replaces and relaunches.
    pub appimage: Option<PathBuf>,
    /// False in dev unless `OMP_DEV_UPDATE_CHECK=1`: checks then settle without a result.
    pub checks_enabled: bool,
    pub privileged: Arc<dyn PrivilegedRunner>,
}

impl Config {
    fn detect() -> Self {
        let appimage = std::env::var_os("APPIMAGE").filter(|value| !value.is_empty()).map(PathBuf::from);
        Self {
            release_base: feed::release_base().to_string(),
            download_dir: dirs::cache_dir().unwrap_or_else(std::env::temp_dir).join("@oh-my-pi").join("omp-gui").join("updates"),
            kind: detect_linux_kind(),
            appimage,
            checks_enabled: !tauri::is_dev() || std::env::var("OMP_DEV_UPDATE_CHECK").as_deref() == Ok("1"),
            privileged: Arc::new(PkexecRunner),
        }
    }
}

/// The .deb's `package-type` marker sits next to the sidecar in the resources
/// directory; the AppImage ships none.
fn detect_linux_kind() -> LinuxPackageKind {
    let exe = std::env::current_exe().ok();
    let resources = Path::new("lib").join(crate::product::PRODUCT_NAME);
    let marker = exe
        .as_deref()
        .and_then(Path::parent)
        .and_then(|dir| package_type_at(&dir.join("..").join(&resources)))
        .or_else(|| package_type_at(&Path::new("/usr").join(&resources)));
    let env = |name: &str| std::env::var(name).ok();
    let exe_path = exe.as_deref().map(|path| path.to_string_lossy().into_owned()).unwrap_or_default();
    linux_package_kind(env("APPIMAGE").as_deref(), env("APPDIR").as_deref(), &exe_path, marker.as_deref())
}

/// The release the last check found.
#[derive(Clone, Debug)]
struct ActiveUpdate {
    version: String,
    asset: Asset,
}

#[derive(Default)]
struct Inner {
    status: Option<UpdateStatus>,
    active: Option<ActiveUpdate>,
    /// The verified package, once a download finished.
    downloaded: Option<PathBuf>,
    /// Set once an install ran, so the exit it triggers does not install again.
    install_done: bool,
}

/// Who asked for a check; decides how a failure shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CheckKind {
    /// The renderer's button or the menu: failures go to the banner.
    Manual,
    /// The first check after start: a failure goes quietly back to idle.
    Startup,
    /// The 4 h timer: a failure stays out of the banner.
    Periodic,
}

impl CheckKind {
    fn is_manual(self) -> bool {
        self == CheckKind::Manual
    }
}

enum CheckOutcome {
    Available { version: String, notes: Option<String>, asset: Asset },
    NotAvailable,
    /// Checks are off (dev build), as electron-updater's inactive updater answered.
    Inactive,
    /// The feed is fine but offers nothing this install can use.
    ReleaseProblem(MainTextKey),
}

/// Production `UpdaterPort`.
pub struct Updater {
    ctx: CtxRef,
    config: Config,
    client: reqwest::Client,
    inner: Mutex<Inner>,
    check_in_flight: AtomicBool,
    install_in_flight: AtomicBool,
}

impl Updater {
    pub fn new(ctx: CtxRef) -> Self {
        Self::with_config(ctx, Config::detect())
    }

    pub(crate) fn with_config(ctx: CtxRef, config: Config) -> Self {
        let client = reqwest::Client::builder().connect_timeout(CONNECT_TIMEOUT).build().unwrap_or_else(|_| reqwest::Client::new());
        Self { ctx, config, client, inner: Mutex::new(Inner::default()), check_in_flight: AtomicBool::new(false), install_in_flight: AtomicBool::new(false) }
    }

    /// The application context; `None` only while the process shuts down.
    fn ctx(&self) -> Option<Arc<AppCtx>> {
        self.ctx.upgrade()
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        // The state is rebuilt from each status change; a poisoned lock holds nothing worth losing.
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn current(&self) -> UpdateStatus {
        self.inner().status.clone().unwrap_or(UpdateStatus::Idle)
    }

    fn text(&self, key: MainTextKey) -> String {
        self.ctx().map(|ctx| ctx.i18n.t(key)).unwrap_or_default()
    }

    /// Store and publish a status change to every chat window.
    fn set_status(&self, status: UpdateStatus) {
        self.inner().status = Some(status.clone());
        let Some(ctx) = self.ctx() else { return };
        match serde_json::to_value(&status) {
            Ok(value) => ctx.bridge.broadcast_main(STATUS_CHANNEL, value),
            Err(error) => runtime_log::note("main-uncaught", format!("update status could not be serialized: {error}"), json!({})),
        }
    }

    fn error(&self, message: String, show_in_banner: Option<bool>) {
        self.set_status(UpdateStatus::Error { message, show_in_banner, manual_install_command: None });
    }

    // -- check ---------------------------------------------------------------

    /// One update check. Returns the status it left behind.
    async fn check(&self, kind: CheckKind) -> UpdateStatus {
        if self.check_in_flight.swap(true, Ordering::SeqCst) {
            return self.current();
        }
        // A timer must not take the renderer's downloading or downloaded state away.
        if !kind.is_manual() && matches!(self.current(), UpdateStatus::Downloading { .. } | UpdateStatus::Downloaded { .. }) {
            self.check_in_flight.store(false, Ordering::SeqCst);
            return self.current();
        }
        self.set_status(UpdateStatus::Checking);
        match self.run_check().await {
            Ok(CheckOutcome::Available { version, notes, asset }) => {
                let mode = UpdateInstallMode::Automatic;
                {
                    let mut inner = self.inner();
                    inner.active = Some(ActiveUpdate { version: version.clone(), asset });
                    inner.downloaded = None;
                }
                self.set_status(UpdateStatus::Available { version, notes, mode });
            }
            Ok(CheckOutcome::NotAvailable) => {
                let version = self.ctx().map(|ctx| ctx.host.app_version()).unwrap_or_default();
                self.set_status(UpdateStatus::NotAvailable { version });
            }
            Ok(CheckOutcome::ReleaseProblem(key)) => self.error(self.text(key), None),
            Ok(CheckOutcome::Inactive) => {
                let settled = settle_incomplete_update_check(&self.current(), kind.is_manual(), &self.text(MainTextKey::UpdatesNoResult));
                self.set_status(settled);
            }
            Err(message) => match kind {
                CheckKind::Manual => self.error(message, Some(true)),
                CheckKind::Startup => {
                    runtime_log::note("unknown", format!("startup update check failed: {message}"), json!({}));
                    self.set_status(UpdateStatus::Idle);
                }
                CheckKind::Periodic => self.error(message, Some(false)),
            },
        }
        self.check_in_flight.store(false, Ordering::SeqCst);
        self.current()
    }

    async fn run_check(&self) -> Result<CheckOutcome, String> {
        if !self.config.checks_enabled {
            return Ok(CheckOutcome::Inactive);
        }
        let current = self.ctx().map(|ctx| ctx.host.app_version()).ok_or_else(|| "shutting down".to_string())?;
        let client = self.client.clone();
        let feed = tokio::time::timeout(FEED_TIMEOUT, feed::fetch_feed(&client, &feed::feed_url(&self.config.release_base)))
            .await
            .map_err(|_| format!("{} timed out", feed::FEED_FILE))??;
        if !feed::is_newer(&feed.version, &current)? {
            return Ok(CheckOutcome::NotAvailable);
        }
        let Some(asset) = feed::select_asset(&feed.files, self.asset_target()) else {
            return Ok(CheckOutcome::ReleaseProblem(MainTextKey::UpdatesInstallerMissing));
        };
        Ok(CheckOutcome::Available { version: feed.version.clone(), notes: feed.notes(), asset })
    }

    /// The asset this install can use.
    fn asset_target(&self) -> AssetTarget {
        match self.config.kind {
            LinuxPackageKind::Deb => AssetTarget::LinuxDeb,
            LinuxPackageKind::AppImage | LinuxPackageKind::Other => AssetTarget::LinuxAppImage,
        }
    }

    // -- download ------------------------------------------------------------

    /// Start a download if an update is available; the returned future finishes
    /// it. `None` when nothing is available (the handler answers the current status).
    fn begin_download(&self) -> Option<(String, UpdateInstallMode, Asset)> {
        let mut inner = self.inner();
        let Some(UpdateStatus::Available { mode, .. }) = inner.status.clone() else { return None };
        let ActiveUpdate { version, asset } = inner.active.clone()?;
        inner.status = Some(UpdateStatus::Downloading { version: version.clone(), mode, percent: 0, bytes_per_second: 0, transferred: 0, total: asset.size.unwrap_or(0) });
        drop(inner);
        self.set_status(self.current());
        Some((version, mode, asset))
    }

    async fn download(&self) -> UpdateStatus {
        let Some((version, mode, asset)) = self.begin_download() else { return self.current() };
        if let Err(message) = self.run_download(&version, mode, &asset).await {
            self.error(message, Some(true));
        }
        self.current()
    }

    async fn run_download(&self, version: &str, mode: UpdateInstallMode, asset: &Asset) -> Result<(), String> {
        let dir = &self.config.download_dir;
        tokio::fs::create_dir_all(dir).await.map_err(|error| format!("{} could not be created: {error}", dir.display()))?;
        let destination = dir.join(&asset.name);
        let partial = installer_partial_path(&destination);
        clear_private_downloads(dir, &partial).await;

        let mut existing = file_size(&partial).await;
        if asset.size.is_some_and(|size| existing > size) {
            let _ = tokio::fs::remove_file(&partial).await;
            existing = 0;
        }
        let url = feed::download_url(&self.config.release_base, version, &asset.name);
        let mut request = self.client.get(&url);
        if existing > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={existing}-"));
        }
        let failed = |detail: String| format!("{} ({detail})", self.text(MainTextKey::UpdatesDownloadFailed));
        let response = request.send().await.map_err(|error| failed(error.to_string()))?;
        let status = response.status().as_u16();
        let content_range = response.headers().get(reqwest::header::CONTENT_RANGE).and_then(|value| value.to_str().ok()).map(str::to_string);
        let plan = plan_installer_transfer(existing, status, content_range.as_deref());
        if !response.status().is_success() {
            // A 416 means the offset is past the release's bytes, so the partial could
            // never complete; everything else leaves it for the next attempt.
            if status == 416 {
                let _ = tokio::fs::remove_file(&partial).await;
            }
            return Err(failed(status.to_string()));
        }
        let total = asset.size.unwrap_or_else(|| response.content_length().map_or(0, |length| length + plan.offset));

        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(plan.append)
            .write(true)
            .truncate(!plan.append)
            .open(&partial)
            .await
            .map_err(|error| failed(format!("{}: {error}", partial.display())))?;
        let started = Instant::now();
        let mut transferred = plan.offset;
        let mut last_progress: Option<Instant> = None;
        let mut stream = response.bytes_stream();
        // Bytes already written stay on any failure: an interrupted transfer resumes from them.
        let result: Result<(), String> = async {
            while let Some(chunk) = stream.try_next().await.map_err(|error| failed(error.to_string()))? {
                file.write_all(&chunk).await.map_err(|error| failed(error.to_string()))?;
                transferred += chunk.len() as u64;
                let now = Instant::now();
                if last_progress.is_none_or(|last| now.duration_since(last) >= PROGRESS_INTERVAL) || (total > 0 && transferred == total) {
                    let elapsed = now.duration_since(started).as_secs_f64().max(0.001);
                    self.set_status(UpdateStatus::Downloading {
                        version: version.to_string(),
                        mode,
                        percent: if total > 0 { (transferred as f64 / total as f64 * 100.0).round().min(100.0) as u64 } else { 0 },
                        bytes_per_second: (transferred as f64 / elapsed).round() as u64,
                        transferred,
                        total,
                    });
                    last_progress = Some(now);
                }
            }
            file.sync_all().await.map_err(|error| failed(error.to_string()))
        }
        .await;
        drop(file);
        result?;

        let actual = sha512_file_base64(&partial).await.map_err(|error| failed(error.to_string()))?;
        if actual != asset.sha512 {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(self.text(MainTextKey::UpdatesHashMismatch));
        }
        tokio::fs::rename(&partial, &destination).await.map_err(|error| failed(error.to_string()))?;
        self.inner().downloaded = Some(destination.clone());
        self.set_status(UpdateStatus::Downloaded { version: version.to_string(), mode, reopen_required: false });
        Ok(())
    }

    // -- apply ---------------------------------------------------------------

    async fn apply(&self) {
        if self.install_in_flight.swap(true, Ordering::SeqCst) {
            return;
        }
        self.run_apply().await;
        self.install_in_flight.store(false, Ordering::SeqCst);
    }

    async fn run_apply(&self) {
        let (version, mode, path, sha512) = {
            let inner = self.inner();
            let Some(UpdateStatus::Downloaded { version, mode, .. }) = inner.status.clone() else { return };
            if inner.install_done {
                return;
            }
            let Some(path) = inner.downloaded.clone() else {
                drop(inner);
                self.error(self.text(MainTextKey::UpdatesInstallerMissing), Some(true));
                return;
            };
            let Some(active) = inner.active.as_ref() else { return };
            (version, mode, path, active.asset.sha512.clone())
        };
        let Some(ctx) = self.ctx() else { return };
        // pkexec cannot work in this process at all, so asking the user to
        // close their working tabs first would be for nothing.
        if self.config.kind == LinuxPackageKind::Deb && !self.config.privileged.can_elevate() {
            self.ask_for_reopen(version, mode);
            return;
        }
        // A deb runs pkexec + apt-get and an AppImage swaps its file before this
        // process quits, so the working-tabs prompt must come first: a quit
        // cancelled afterwards would keep the old process running on top of
        // the new install.
        let asks = asks_before_install(self.config.kind);
        if asks && !ctx.desktop.approve_quit_before_install().await {
            return;
        }
        match self.install_now(&path, &sha512).await {
            Ok(relaunch) => {
                self.inner().install_done = true;
                // Armed before the exit: `lib.rs` starts it once this process has
                // exited. No arguments, so a launch link or workspace is not replayed.
                if let Some(program) = relaunch {
                    ctx.host.relaunch_after_exit(program);
                }
                ctx.host.exit(0);
            }
            Err(error) => {
                if asks {
                    ctx.desktop.withdraw_quit_approval();
                }
                // The banner can be dismissed, so a failed install also lands in the
                // runtime log, where a user's report can show what apt said.
                match &error {
                    InstallError::ReopenRequired => {}
                    InstallError::UnresolvedDependencies { detail, .. } | InstallError::Failed(detail) => runtime_log::note(
                        "unknown",
                        format!("the update could not be installed: {detail}"),
                        json!({ "version": version, "package": path.display().to_string() }),
                    ),
                }
                match error {
                    InstallError::ReopenRequired => self.ask_for_reopen(version, mode),
                    InstallError::UnresolvedDependencies { detail, command } => self.set_status(UpdateStatus::Error {
                        message: format!("{} ({detail})", self.text(MainTextKey::UpdatesInstallFailed)),
                        show_in_banner: Some(true),
                        manual_install_command: Some(command),
                    }),
                    InstallError::Failed(detail) => self.error(format!("{} ({detail})", self.text(MainTextKey::UpdatesInstallFailed)), Some(true)),
                }
            }
        }
    }

    /// Keep the verified download and ask the user to quit and reopen the app:
    /// this process runs with `no_new_privs`, so pkexec cannot ask for privileges.
    fn ask_for_reopen(&self, version: String, mode: UpdateInstallMode) {
        runtime_log::note("unknown", "the update cannot ask for privileges in this process (no_new_privs); asking for a reopen", json!({ "version": version }));
        self.set_status(UpdateStatus::Downloaded { version, mode, reopen_required: true });
    }

    /// Install the verified package for this install kind. Returns the program
    /// to start once this process has exited.
    async fn install_now(&self, package: &Path, sha512: &str) -> Result<Option<PathBuf>, InstallError> {
        match self.config.kind {
            LinuxPackageKind::Deb => {
                // Verifies the hash itself, right before the privileged call.
                install::install_deb(self.config.privileged.as_ref(), package, sha512).await?;
                Ok(Some(PathBuf::from(install::DEB_BINARY)))
            }
            LinuxPackageKind::AppImage | LinuxPackageKind::Other => {
                install::verify_package(package, sha512).await?;
                let target = install::appimage_target(self.config.appimage.as_deref())?;
                install::replace_appimage(package, &target).await?;
                Ok(Some(target))
            }
        }
    }

    /// The install-on-quit path: swap the AppImage or start the installer
    /// silently, without a relaunch, as electron-updater's `autoInstallOnAppQuit` did.
    async fn install_on_quit(&self, package: &Path, sha512: &str) -> Result<(), String> {
        install::verify_package(package, sha512).await?;
        match self.config.kind {
            LinuxPackageKind::Deb => Err("a deb never installs at quit".into()),
            LinuxPackageKind::AppImage | LinuxPackageKind::Other => {
                let target = install::appimage_target(self.config.appimage.as_deref())?;
                install::replace_appimage(package, &target).await
            }
        }
    }
}

/// The cache directory holds nothing but packages this module downloaded, so
/// everything except the partial being continued goes, as electron-updater
/// emptied its cache before each download.
async fn clear_private_downloads(dir: &Path, keep: &Path) {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else { return };
    while let Ok(Some(entry)) = entries.next_entry().await {
        if entry.path() != keep {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
}

async fn file_size(path: &Path) -> u64 {
    tokio::fs::metadata(path).await.map(|metadata| metadata.len()).unwrap_or(0)
}

/// The module's state behind the port, for handlers and tasks.
fn of(ctx: &AppCtx) -> Option<&Updater> {
    ctx.updater.as_any().downcast_ref::<Updater>()
}

/// Run a check through a context handle; false once the context is gone.
async fn check_through(ctx: &CtxRef, kind: CheckKind) -> bool {
    let Some(ctx) = ctx.upgrade() else { return false };
    if let Some(updater) = of(&ctx) {
        updater.check(kind).await;
    }
    true
}

async fn schedule_checks(ctx: CtxRef) {
    tokio::time::sleep(FIRST_CHECK_DELAY).await;
    if !check_through(&ctx, CheckKind::Startup).await {
        return;
    }
    loop {
        tokio::time::sleep(CHECK_INTERVAL).await;
        if !check_through(&ctx, CheckKind::Periodic).await {
            return;
        }
    }
}

impl UpdaterPort for Updater {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn check_now(&self) {
        let ctx = self.ctx.clone();
        spawn_task(async move {
            check_through(&ctx, CheckKind::Manual).await;
        });
    }

    fn status(&self) -> Value {
        serde_json::to_value(self.current()).unwrap_or(Value::Null)
    }

    fn shutdown(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let pending = {
                let inner = self.inner();
                match (&inner.status, &inner.downloaded, &inner.active) {
                    (Some(UpdateStatus::Downloaded { .. }), Some(path), Some(active)) if !inner.install_done && installs_on_quit(self.config.kind) => {
                        Some((path.clone(), active.asset.sha512.clone()))
                    }
                    _ => None,
                }
            };
            let Some((path, sha512)) = pending else { return };
            match self.install_on_quit(&path, &sha512).await {
                Ok(()) => self.inner().install_done = true,
                Err(detail) => runtime_log::note("unknown", format!("the update could not be installed at quit: {detail}"), json!({ "package": path.display().to_string() })),
            }
        })
    }
}

pub fn init(ctx: &Arc<AppCtx>, app: &AppHandle) -> tauri::Result<()> {
    let _ = app;
    let weak: CtxRef = Arc::downgrade(ctx);
    spawn_task(schedule_checks(weak));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::{dispatch_for_test, Registry};
    use crate::ports::{Caller, WindowId};
    use crate::testing::{fake_ctx_cyclic, Fakes, RecordingSink};
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;
    use sha2::{Digest, Sha512};
    use std::collections::HashMap;
    use std::sync::Mutex;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::net::TcpListener;

    // -- a local release server --------------------------------------------

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct Request {
        path: String,
        range_start: Option<u64>,
    }

    struct Served {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    /// How the server answers a Range request for an asset.
    #[derive(Clone, Copy)]
    enum RangeMode {
        /// 206 from the requested offset, as GitHub does.
        Honor,
        /// 206 but from the top: a server that misreports its range.
        WrongStart,
        /// 200 with the whole body.
        Ignore,
    }

    struct ReleaseServer {
        requests: Mutex<Vec<Request>>,
        feed: Mutex<Option<String>>,
        assets: Mutex<HashMap<String, Vec<u8>>>,
        range_mode: Mutex<RangeMode>,
    }

    impl ReleaseServer {
        fn answer(&self, request: &Request) -> Served {
            self.requests.lock().unwrap().push(request.clone());
            if request.path.ends_with(&format!("/latest/download/{}", feed::FEED_FILE)) {
                let feed = self.feed.lock().unwrap().clone();
                return match feed {
                    Some(feed) => Served { status: 200, headers: vec![], body: feed.into_bytes() },
                    None => Served { status: 404, headers: vec![], body: b"Not Found".to_vec() },
                };
            }
            let name = request.path.rsplit('/').next().unwrap_or_default().to_string();
            let Some(body) = self.assets.lock().unwrap().get(&name).cloned() else {
                return Served { status: 404, headers: vec![], body: b"Not Found".to_vec() };
            };
            let total = body.len() as u64;
            let range_mode = *self.range_mode.lock().unwrap();
            match (request.range_start, range_mode) {
                (Some(start), RangeMode::Honor) if start >= total => Served { status: 416, headers: vec![("Content-Range".into(), format!("bytes */{total}"))], body: vec![] },
                (Some(start), RangeMode::Honor) => Served {
                    status: 206,
                    headers: vec![("Content-Range".into(), format!("bytes {start}-{}/{total}", total - 1))],
                    body: body[start as usize..].to_vec(),
                },
                (Some(_), RangeMode::WrongStart) => Served { status: 206, headers: vec![("Content-Range".into(), format!("bytes 0-{}/{total}", total - 1))], body },
                _ => Served { status: 200, headers: vec![], body },
            }
        }
    }

    async fn start_server() -> (Arc<ReleaseServer>, String) {
        let server = Arc::new(ReleaseServer { requests: Mutex::new(vec![]), feed: Mutex::new(None), assets: Mutex::new(HashMap::new()), range_mode: Mutex::new(RangeMode::Honor) });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let accepting = server.clone();
        tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let server = accepting.clone();
                tokio::spawn(async move {
                    let mut reader = BufReader::new(socket);
                    let mut line = String::new();
                    if reader.read_line(&mut line).await.is_err() || line.is_empty() {
                        return;
                    }
                    let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let mut range_start = None;
                    loop {
                        let mut header = String::new();
                        if reader.read_line(&mut header).await.is_err() || header == "\r\n" || header.is_empty() {
                            break;
                        }
                        if let Some(value) = header.to_ascii_lowercase().strip_prefix("range:") {
                            range_start = value.trim().strip_prefix("bytes=").and_then(|rest| rest.trim_end_matches('-').parse().ok());
                        }
                    }
                    let served = server.answer(&Request { path, range_start });
                    let reason = match served.status {
                        200 => "OK",
                        206 => "Partial Content",
                        404 => "Not Found",
                        416 => "Range Not Satisfiable",
                        _ => "Unknown",
                    };
                    let mut head = format!("HTTP/1.1 {} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n", served.status, served.body.len());
                    for (name, value) in &served.headers {
                        head.push_str(&format!("{name}: {value}\r\n"));
                    }
                    head.push_str("\r\n");
                    let mut socket = reader.into_inner();
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(&served.body).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        (server, format!("http://127.0.0.1:{port}/releases"))
    }

    fn sha512_base64(bytes: &[u8]) -> String {
        STANDARD.encode(Sha512::digest(bytes))
    }

    const APPIMAGE_NAME: &str = "Sai-ATLAS-0.9.16-x86_64.AppImage";
    const DEB_NAME: &str = "sai-atlas_0.9.16_amd64.deb";

    fn feed_yaml(version: &str, appimage: &[u8], deb: &[u8]) -> String {
        format!(
            "version: {version}\nfiles:\n  - url: {APPIMAGE_NAME}\n    sha512: {}\n    size: {}\n  - url: {DEB_NAME}\n    sha512: {}\n    size: {}\npath: {APPIMAGE_NAME}\nsha512: {}\nreleaseDate: '2026-10-01T00:00:00.000Z'\nreleaseNotes: 'Faster dictation'\n",
            sha512_base64(appimage),
            appimage.len(),
            sha512_base64(deb),
            deb.len(),
            sha512_base64(appimage)
        )
    }

    fn asset_bytes(seed: u8, size: usize) -> Vec<u8> {
        (0..size).map(|index| (index as u8).wrapping_mul(31).wrapping_add(seed)).collect()
    }

    // -- a context with the real updater -------------------------------------

    struct Harness {
        fakes: Fakes,
        ctx: Arc<AppCtx>,
        sink: Arc<RecordingSink>,
        caller: Caller,
        runner: Arc<install::tests::FakeRunner>,
        dir: tempfile::TempDir,
    }

    struct Setup {
        release_base: String,
        kind: LinuxPackageKind,
        appimage: Option<PathBuf>,
        checks_enabled: bool,
    }

    impl Default for Setup {
        fn default() -> Self {
            Self { release_base: "http://127.0.0.1:9/releases".into(), kind: LinuxPackageKind::Deb, appimage: None, checks_enabled: true }
        }
    }

    fn harness(setup: Setup) -> Harness {
        let fakes = Fakes::default();
        let dir = tempfile::tempdir().unwrap();
        let runner = Arc::new(install::tests::FakeRunner::default());
        let config = Config {
            release_base: setup.release_base,
            download_dir: dir.path().join("downloads"),
            kind: setup.kind,
            appimage: setup.appimage,
            checks_enabled: setup.checks_enabled,
            privileged: runner.clone(),
        };
        let mut registry = Registry::new();
        register(&mut registry);
        let ctx = fake_ctx_cyclic(&fakes, registry, |ctx, ports| ports.updater = Some(Arc::new(Updater::with_config(ctx.clone(), config))));
        let caller = Caller::main(WindowId(1));
        let sink = Arc::new(RecordingSink::default());
        ctx.bridge.attach(&ctx, caller, "gen-1".into(), sink.clone());
        Harness { fakes, ctx, sink, caller, runner, dir }
    }

    impl Harness {
        fn updater(&self) -> &Updater {
            of(&self.ctx).unwrap()
        }

        async fn call(&self, channel: &str) -> Value {
            dispatch_for_test(&self.ctx, self.caller, channel, vec![]).await.unwrap()
        }

        fn statuses(&self) -> Vec<Value> {
            self.sink.sent().into_iter().filter(|envelope| envelope.channel == STATUS_CHANNEL).map(|envelope| envelope.payload).collect()
        }

        fn states(&self) -> Vec<String> {
            self.statuses().iter().map(|status| status["state"].as_str().unwrap_or_default().to_string()).collect()
        }

        fn download_dir(&self) -> PathBuf {
            self.dir.path().join("downloads")
        }

        /// Put the updater where a finished download leaves it.
        fn seed_downloaded(&self, mode: UpdateInstallMode, bytes: &[u8], name: &str) -> PathBuf {
            std::fs::create_dir_all(self.download_dir()).unwrap();
            let path = self.download_dir().join(name);
            std::fs::write(&path, bytes).unwrap();
            let updater = self.updater();
            {
                let mut inner = updater.inner();
                inner.active = Some(ActiveUpdate { version: "0.9.16".into(), asset: Asset { name: name.into(), sha512: sha512_base64(bytes), size: Some(bytes.len() as u64) } });
                inner.downloaded = Some(path.clone());
            }
            updater.set_status(UpdateStatus::Downloaded { version: "0.9.16".into(), mode, reopen_required: false });
            path
        }
    }

    async fn wait_until(mut condition: impl FnMut() -> bool) {
        for _ in 0..500 {
            if condition() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition not met in time");
    }

    // -- checks ---------------------------------------------------------------

    #[tokio::test]
    async fn check_reports_an_available_update_with_its_notes() {
        let (server, base) = start_server().await;
        *server.feed.lock().unwrap() = Some(feed_yaml("0.9.16", b"a", b"d"));
        let h = harness(Setup { release_base: base, ..Setup::default() });

        let reply = h.call("updater:check").await;

        assert_eq!(reply, json!({ "state": "available", "version": "0.9.16", "notes": "Faster dictation", "mode": "automatic" }));
        assert_eq!(h.states(), ["checking", "available"]);
        assert_eq!(h.updater().status(), reply);
        assert_eq!(h.updater().inner().active.as_ref().unwrap().asset.name, DEB_NAME);
        assert_eq!(server.requests.lock().unwrap()[0].path, format!("/releases/latest/download/{}", feed::FEED_FILE));
    }

    #[tokio::test]
    async fn check_reports_not_available_when_the_feed_is_not_newer() {
        let (server, base) = start_server().await;
        *server.feed.lock().unwrap() = Some(feed_yaml("0.9.16", b"a", b"d"));
        let h = harness(Setup { release_base: base, ..Setup::default() });
        *h.fakes.host.version.lock().unwrap() = "0.9.16".into();

        assert_eq!(h.call("updater:check").await, json!({ "state": "not-available", "version": "0.9.16" }));

        *h.fakes.host.version.lock().unwrap() = "1.0.0".into();
        assert_eq!(h.call("updater:check").await, json!({ "state": "not-available", "version": "1.0.0" }));
    }

    #[tokio::test]
    async fn manual_check_failures_reach_the_banner_and_background_ones_do_not() {
        let (_server, base) = start_server().await; // no feed: 404
        let h = harness(Setup { release_base: base, ..Setup::default() });

        let reply = h.call("updater:check").await;
        assert_eq!(reply["state"], "error");
        assert_eq!(reply["showInBanner"], true);
        assert!(reply["message"].as_str().unwrap().contains("404"), "{reply}");

        assert_eq!(h.updater().check(CheckKind::Startup).await, UpdateStatus::Idle);
        assert_eq!(h.updater().check(CheckKind::Periodic).await, UpdateStatus::Error { message: format!("{} could not be fetched (404)", feed::FEED_FILE), show_in_banner: Some(false), manual_install_command: None });
    }

    #[tokio::test]
    async fn check_reports_a_release_without_an_installer_for_this_kind() {
        let (server, base) = start_server().await;
        *server.feed.lock().unwrap() = Some("version: 0.9.16\nfiles:\n  - url: Sai-ATLAS-0.9.16.dmg\n    sha512: x\n".into());
        let h = harness(Setup { release_base: base, ..Setup::default() });
        let reply = h.call("updater:check").await;
        assert_eq!(reply, json!({ "state": "error", "message": h.ctx.i18n.t(MainTextKey::UpdatesInstallerMissing) }));
        assert_eq!(h.updater().check(CheckKind::Startup).await, UpdateStatus::Error { message: h.ctx.i18n.t(MainTextKey::UpdatesInstallerMissing), show_in_banner: None, manual_install_command: None });
    }

    #[tokio::test]
    async fn disabled_checks_settle_without_a_result() {
        let h = harness(Setup { checks_enabled: false, ..Setup::default() });
        assert_eq!(h.call("updater:check").await, json!({ "state": "error", "message": h.ctx.i18n.t(MainTextKey::UpdatesNoResult) }));
        assert_eq!(h.updater().check(CheckKind::Startup).await, UpdateStatus::Idle);
        assert_eq!(h.states(), ["checking", "error", "checking", "idle"]);
    }

    #[tokio::test]
    async fn background_checks_leave_a_download_alone() {
        let (server, base) = start_server().await;
        *server.feed.lock().unwrap() = Some(feed_yaml("0.9.16", b"a", b"d"));
        let h = harness(Setup { release_base: base, ..Setup::default() });
        h.seed_downloaded(UpdateInstallMode::Automatic, b"d", DEB_NAME);
        assert_eq!(h.updater().check(CheckKind::Periodic).await, UpdateStatus::Downloaded { version: "0.9.16".into(), mode: UpdateInstallMode::Automatic, reopen_required: false });
        assert!(server.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn check_now_runs_a_manual_check_from_the_menu() {
        let (server, base) = start_server().await;
        *server.feed.lock().unwrap() = Some(feed_yaml("0.9.16", b"a", b"d"));
        let h = harness(Setup { release_base: base, ..Setup::default() });

        h.ctx.updater.check_now();
        wait_until(|| h.states().last().map(String::as_str) == Some("available")).await;

        assert_eq!(h.states(), ["checking", "available"]);
    }

    // -- downloads --------------------------------------------------------------

    #[tokio::test]
    async fn download_is_refused_unless_an_update_is_available() {
        let h = harness(Setup::default());
        assert_eq!(h.call("updater:download").await, json!({ "state": "idle" }));
        assert!(h.states().is_empty());
        assert!(!h.download_dir().exists());
    }

    #[tokio::test]
    async fn download_verifies_the_package_and_reports_progress() {
        let (server, base) = start_server().await;
        let deb = asset_bytes(7, 300_000);
        *server.feed.lock().unwrap() = Some(feed_yaml("0.9.16", b"a", &deb));
        server.assets.lock().unwrap().insert(DEB_NAME.into(), deb.clone());
        let h = harness(Setup { release_base: base, ..Setup::default() });
        std::fs::create_dir_all(h.download_dir()).unwrap();
        std::fs::write(h.download_dir().join("sai-atlas_0.9.15_amd64.deb"), b"stale").unwrap();
        h.call("updater:check").await;

        let reply = h.call("updater:download").await;

        assert_eq!(reply, json!({ "state": "downloaded", "version": "0.9.16", "mode": "automatic" }));
        assert_eq!(std::fs::read(h.download_dir().join(DEB_NAME)).unwrap(), deb);
        assert!(!h.download_dir().join("sai-atlas_0.9.15_amd64.deb").exists(), "the cache is cleared first");
        assert!(!installer_partial_path(&h.download_dir().join(DEB_NAME)).exists());
        let statuses = h.statuses();
        let downloading: Vec<&Value> = statuses.iter().filter(|status| status["state"] == "downloading").collect();
        assert_eq!(downloading.first().map(|status| status["percent"].as_u64()), Some(Some(0)));
        let last = downloading.last().unwrap();
        assert_eq!(last["percent"], 100);
        assert_eq!(last["transferred"], 300_000);
        assert_eq!(last["total"], 300_000);
        assert_eq!(last["mode"], "automatic");
        assert_eq!(server.requests.lock().unwrap().last().unwrap().path, format!("/releases/download/v0.9.16/{DEB_NAME}"));
    }

    #[tokio::test]
    async fn download_resumes_a_partial_when_the_server_continues_it() {
        let (server, base) = start_server().await;
        let deb = asset_bytes(3, 50_000);
        *server.feed.lock().unwrap() = Some(feed_yaml("0.9.16", b"a", &deb));
        server.assets.lock().unwrap().insert(DEB_NAME.into(), deb.clone());
        let h = harness(Setup { release_base: base, ..Setup::default() });
        std::fs::create_dir_all(h.download_dir()).unwrap();
        let partial = installer_partial_path(&h.download_dir().join(DEB_NAME));
        std::fs::write(&partial, &deb[..20_000]).unwrap();
        h.call("updater:check").await;

        assert_eq!(h.call("updater:download").await["state"], "downloaded");

        assert_eq!(std::fs::read(h.download_dir().join(DEB_NAME)).unwrap(), deb);
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.last().unwrap().range_start, Some(20_000));
        let first_progress = h.statuses().into_iter().filter(|status| status["state"] == "downloading").nth(1).unwrap();
        assert!(first_progress["transferred"].as_u64().unwrap() > 20_000, "{first_progress}");
    }

    #[tokio::test]
    async fn download_restarts_when_the_server_answers_a_different_range() {
        let (server, base) = start_server().await;
        let deb = asset_bytes(5, 50_000);
        *server.feed.lock().unwrap() = Some(feed_yaml("0.9.16", b"a", &deb));
        server.assets.lock().unwrap().insert(DEB_NAME.into(), deb.clone());
        for mode in [RangeMode::WrongStart, RangeMode::Ignore] {
            *server.range_mode.lock().unwrap() = mode;
            let h = harness(Setup { release_base: base.clone(), ..Setup::default() });
            std::fs::create_dir_all(h.download_dir()).unwrap();
            std::fs::write(installer_partial_path(&h.download_dir().join(DEB_NAME)), b"garbage that must not be kept").unwrap();
            h.call("updater:check").await;

            assert_eq!(h.call("updater:download").await["state"], "downloaded");
            assert_eq!(std::fs::read(h.download_dir().join(DEB_NAME)).unwrap(), deb);
        }
    }

    #[tokio::test]
    async fn download_removes_the_partial_on_a_hash_mismatch() {
        let (server, base) = start_server().await;
        let deb = asset_bytes(9, 10_000);
        *server.feed.lock().unwrap() = Some(feed_yaml("0.9.16", b"a", &deb));
        server.assets.lock().unwrap().insert(DEB_NAME.into(), asset_bytes(10, 10_000));
        let h = harness(Setup { release_base: base, ..Setup::default() });
        h.call("updater:check").await;

        let reply = h.call("updater:download").await;

        assert_eq!(reply, json!({ "state": "error", "message": h.ctx.i18n.t(MainTextKey::UpdatesHashMismatch), "showInBanner": true }));
        assert!(!installer_partial_path(&h.download_dir().join(DEB_NAME)).exists());
        assert!(!h.download_dir().join(DEB_NAME).exists());
    }

    #[tokio::test]
    async fn download_drops_a_partial_the_release_can_never_complete() {
        let (server, base) = start_server().await;
        let deb = asset_bytes(1, 1_000);
        // The feed does not say the size, so the oversized partial reaches the server, which answers 416.
        *server.feed.lock().unwrap() = Some(format!("version: 0.9.16\nfiles:\n  - url: {DEB_NAME}\n    sha512: {}\n", sha512_base64(&deb)));
        server.assets.lock().unwrap().insert(DEB_NAME.into(), deb);
        let h = harness(Setup { release_base: base, ..Setup::default() });
        std::fs::create_dir_all(h.download_dir()).unwrap();
        let partial = installer_partial_path(&h.download_dir().join(DEB_NAME));
        std::fs::write(&partial, vec![0u8; 5_000]).unwrap();
        h.call("updater:check").await;

        let reply = h.call("updater:download").await;

        assert_eq!(reply["state"], "error");
        assert!(reply["message"].as_str().unwrap().ends_with("(416)"), "{reply}");
        assert!(!partial.exists());
    }

    // -- installs -----------------------------------------------------------------

    #[tokio::test]
    async fn apply_installs_a_deb_and_relaunches_after_approval() {
        let h = harness(Setup::default());
        *h.fakes.desktop.approve_install.lock().unwrap() = true;
        let package = h.seed_downloaded(UpdateInstallMode::Automatic, b"deb bytes", DEB_NAME);

        assert_eq!(h.call("updater:apply").await, Value::Null);

        assert_eq!(h.runner.calls.lock().unwrap().clone(), [["/usr/bin/pkexec", "/usr/bin/apt-get", "install", "-y", "--no-remove", "--", package.to_str().unwrap()]]);
        assert_eq!(*h.fakes.host.relaunches.lock().unwrap(), [PathBuf::from("/usr/bin/sai-atlas")]);
        assert_eq!(*h.fakes.host.exit_codes.lock().unwrap(), [0]);
        assert_eq!(h.fakes.desktop.log.calls(), ["approve_quit_before_install()"]);
        assert!(h.updater().inner().install_done);
        // The exit runs the frozen shutdown order; the install must not run twice.
        h.ctx.updater.shutdown().await;
        assert_eq!(h.runner.calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn apply_does_nothing_when_the_quit_approval_is_declined() {
        let h = harness(Setup::default());
        h.seed_downloaded(UpdateInstallMode::Automatic, b"deb bytes", DEB_NAME);

        h.call("updater:apply").await;

        assert!(h.runner.calls.lock().unwrap().is_empty());
        assert!(h.fakes.host.relaunches.lock().unwrap().is_empty());
        assert!(h.fakes.host.exit_codes.lock().unwrap().is_empty());
        assert_eq!(h.fakes.desktop.log.calls(), ["approve_quit_before_install()"]);
        assert_eq!(h.updater().status()["state"], "downloaded");
    }

    #[tokio::test]
    async fn apply_reports_a_failed_deb_install_and_withdraws_the_approval() {
        let h = harness(Setup::default());
        *h.fakes.desktop.approve_install.lock().unwrap() = true;
        *h.runner.answers.lock().unwrap() = vec![Err(install::RunFailure { code: Some(126), detail: "Request dismissed".into() })];
        h.seed_downloaded(UpdateInstallMode::Automatic, b"deb bytes", DEB_NAME);

        h.call("updater:apply").await;

        assert_eq!(h.fakes.desktop.log.calls(), ["approve_quit_before_install()", "withdraw_quit_approval()"]);
        assert_eq!(h.updater().status(), json!({ "state": "error", "message": format!("{} (Request dismissed)", h.ctx.i18n.t(MainTextKey::UpdatesInstallFailed)), "showInBanner": true }));
        assert!(h.fakes.host.relaunches.lock().unwrap().is_empty());
        assert!(h.fakes.host.exit_codes.lock().unwrap().is_empty());
        assert!(!h.updater().inner().install_done);
    }

    #[tokio::test]
    async fn apply_keeps_the_download_and_asks_for_a_reopen_when_pkexec_cannot_work() {
        let h = harness(Setup::default());
        *h.fakes.desktop.approve_install.lock().unwrap() = true;
        h.runner.no_new_privs.store(true, Ordering::SeqCst);
        let package = h.seed_downloaded(UpdateInstallMode::Automatic, b"deb bytes", DEB_NAME);

        h.call("updater:apply").await;

        assert!(h.runner.calls.lock().unwrap().is_empty(), "pkexec never runs");
        assert!(h.fakes.desktop.log.calls().is_empty(), "no quit prompt for an install that cannot run");
        let reopen = json!({ "state": "downloaded", "version": "0.9.16", "mode": "automatic", "reopenRequired": true });
        assert_eq!(h.updater().status(), reopen);
        assert_eq!(h.statuses().last(), Some(&reopen));
        assert!(h.fakes.host.relaunches.lock().unwrap().is_empty());
        assert!(h.fakes.host.exit_codes.lock().unwrap().is_empty());
        assert!(!h.updater().inner().install_done);
        assert_eq!(h.updater().inner().downloaded.as_deref(), Some(package.as_path()), "the verified download is kept");
        // A timer check leaves the state alone.
        assert_eq!(h.updater().check(CheckKind::Periodic).await, UpdateStatus::Downloaded { version: "0.9.16".into(), mode: UpdateInstallMode::Automatic, reopen_required: true });
    }

    #[tokio::test]
    async fn apply_asks_for_a_reopen_when_pkexec_reports_it_cannot_gain_privileges() {
        let h = harness(Setup::default());
        *h.fakes.desktop.approve_install.lock().unwrap() = true;
        *h.runner.answers.lock().unwrap() = vec![Err(install::RunFailure { code: Some(127), detail: "pkexec must be setuid root".into() })];
        h.seed_downloaded(UpdateInstallMode::Automatic, b"deb bytes", DEB_NAME);

        h.call("updater:apply").await;

        assert_eq!(h.fakes.desktop.log.calls(), ["approve_quit_before_install()", "withdraw_quit_approval()"]);
        assert_eq!(h.updater().status(), json!({ "state": "downloaded", "version": "0.9.16", "mode": "automatic", "reopenRequired": true }));
        assert!(h.fakes.host.exit_codes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn apply_reports_unresolvable_dependencies_with_the_manual_install_command() {
        let h = harness(Setup::default());
        *h.fakes.desktop.approve_install.lock().unwrap() = true;
        let apt = "E: Unable to correct problems, you have held broken packages.";
        *h.runner.answers.lock().unwrap() = vec![Err(install::RunFailure { code: Some(100), detail: apt.into() })];
        let package = h.seed_downloaded(UpdateInstallMode::Automatic, b"deb bytes", DEB_NAME);

        h.call("updater:apply").await;

        assert_eq!(h.runner.calls.lock().unwrap().len(), 1, "no repair command after apt fails");
        assert_eq!(h.fakes.desktop.log.calls(), ["approve_quit_before_install()", "withdraw_quit_approval()"]);
        let expected = json!({
            "state": "error",
            "message": format!("{} ({apt})", h.ctx.i18n.t(MainTextKey::UpdatesInstallFailed)),
            "showInBanner": true,
            "manualInstallCommand": format!("sudo apt install {}", package.to_str().unwrap()),
        });
        assert_eq!(h.updater().status(), expected);
        assert_eq!(h.statuses().last(), Some(&expected));
        assert!(h.fakes.host.relaunches.lock().unwrap().is_empty());
        assert!(h.fakes.host.exit_codes.lock().unwrap().is_empty());
        assert!(!h.updater().inner().install_done);
        let log = std::fs::read_to_string(runtime_log::path()).unwrap_or_default();
        let package = package.display().to_string();
        assert!(
            log.lines().any(|line| line.contains("the update could not be installed: E: Unable to correct problems") && line.contains(&package)),
            "the failure is in the runtime log"
        );
    }

    #[tokio::test]
    async fn apply_refuses_a_deb_whose_bytes_changed_after_the_download() {
        let h = harness(Setup::default());
        *h.fakes.desktop.approve_install.lock().unwrap() = true;
        let package = h.seed_downloaded(UpdateInstallMode::Automatic, b"deb bytes", DEB_NAME);
        std::fs::write(&package, b"swapped").unwrap();

        h.call("updater:apply").await;

        assert!(h.runner.calls.lock().unwrap().is_empty());
        assert_eq!(h.updater().status()["state"], "error");
        assert!(h.updater().status()["message"].as_str().unwrap().contains("SHA-512"));
        assert_eq!(h.fakes.desktop.log.calls(), ["approve_quit_before_install()", "withdraw_quit_approval()"]);
    }

    #[tokio::test]
    async fn apply_replaces_the_appimage_and_relaunches_it() {
        let dir = tempfile::tempdir().unwrap();
        let appimage = dir.path().join("Applications").join("Sai ATLAS.AppImage");
        std::fs::create_dir_all(appimage.parent().unwrap()).unwrap();
        std::fs::write(&appimage, b"old image").unwrap();
        let h = harness(Setup { kind: LinuxPackageKind::AppImage, appimage: Some(appimage.clone()), ..Setup::default() });
        *h.fakes.desktop.approve_install.lock().unwrap() = true;
        h.seed_downloaded(UpdateInstallMode::Automatic, b"new image", APPIMAGE_NAME);

        h.call("updater:apply").await;

        assert_eq!(std::fs::read(&appimage).unwrap(), b"new image");
        assert_eq!(*h.fakes.host.relaunches.lock().unwrap(), [appimage]);
        assert_eq!(*h.fakes.host.exit_codes.lock().unwrap(), [0]);
        assert!(h.runner.calls.lock().unwrap().is_empty());
        assert_eq!(h.fakes.desktop.log.calls(), ["approve_quit_before_install()"]);
    }

    #[tokio::test]
    async fn apply_reports_a_missing_appimage_path() {
        let h = harness(Setup { kind: LinuxPackageKind::Other, appimage: None, ..Setup::default() });
        h.seed_downloaded(UpdateInstallMode::Automatic, b"new image", APPIMAGE_NAME);

        h.call("updater:apply").await;

        assert_eq!(h.updater().status(), json!({ "state": "error", "message": format!("{} (APPIMAGE is not defined)", h.ctx.i18n.t(MainTextKey::UpdatesInstallFailed)), "showInBanner": true }));
        assert!(h.fakes.desktop.log.calls().is_empty(), "an install that cannot replace the app asks nothing");
        assert!(h.fakes.host.exit_codes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn apply_ignores_states_other_than_downloaded() {
        let h = harness(Setup::default());
        assert_eq!(h.call("updater:apply").await, Value::Null);
        h.updater().set_status(UpdateStatus::Available { version: "0.9.16".into(), notes: None, mode: UpdateInstallMode::Automatic });
        assert_eq!(h.call("updater:apply").await, Value::Null);
        assert!(h.fakes.desktop.log.calls().is_empty());
        assert!(h.runner.calls.lock().unwrap().is_empty());
    }

    // -- install on quit ----------------------------------------------------------

    #[tokio::test]
    async fn shutdown_installs_a_downloaded_appimage_without_relaunching() {
        let dir = tempfile::tempdir().unwrap();
        let appimage = dir.path().join("Sai ATLAS.AppImage");
        std::fs::write(&appimage, b"old image").unwrap();
        let h = harness(Setup { kind: LinuxPackageKind::AppImage, appimage: Some(appimage.clone()), ..Setup::default() });
        h.seed_downloaded(UpdateInstallMode::Automatic, b"new image", APPIMAGE_NAME);

        h.ctx.updater.shutdown().await;

        assert_eq!(std::fs::read(&appimage).unwrap(), b"new image");
        assert!(h.fakes.host.relaunches.lock().unwrap().is_empty());
        assert!(h.fakes.host.exit_codes.lock().unwrap().is_empty());
        assert!(h.fakes.desktop.log.calls().is_empty());
        assert!(h.updater().inner().install_done);
        h.ctx.updater.shutdown().await;
        assert_eq!(std::fs::read(&appimage).unwrap(), b"new image");
    }

    #[tokio::test]
    async fn shutdown_never_installs_a_deb_and_skips_undownloaded_updates() {
        let h = harness(Setup::default());
        h.seed_downloaded(UpdateInstallMode::Automatic, b"deb bytes", DEB_NAME);
        h.ctx.updater.shutdown().await;
        assert!(h.runner.calls.lock().unwrap().is_empty());
        assert!(!h.updater().inner().install_done);

        let h = harness(Setup { kind: LinuxPackageKind::AppImage, ..Setup::default() });
        h.updater().set_status(UpdateStatus::Available { version: "0.9.16".into(), notes: None, mode: UpdateInstallMode::Automatic });
        h.ctx.updater.shutdown().await;
        assert!(!h.updater().inner().install_done);
    }

    // -- status and version handlers -------------------------------------------------

    #[tokio::test]
    async fn get_status_and_version_answer_the_port_and_the_host() {
        let h = harness(Setup::default());
        assert_eq!(h.call("updater:getStatus").await, json!({ "state": "idle" }));
        assert_eq!(h.call("updater:version").await, json!("0.0.0-test"));

        h.updater().set_status(UpdateStatus::Downloading { version: "0.9.16".into(), mode: UpdateInstallMode::Automatic, percent: 42, bytes_per_second: 1_000, transferred: 420, total: 1_000 });
        let status = h.call("updater:getStatus").await;
        assert_eq!(status, json!({ "state": "downloading", "version": "0.9.16", "mode": "automatic", "percent": 42, "bytesPerSecond": 1_000, "transferred": 420, "total": 1_000 }));
        assert_eq!(status, h.ctx.updater.status());
        *h.fakes.host.version.lock().unwrap() = "0.9.15".into();
        assert_eq!(h.call("updater:version").await, json!("0.9.15"));
    }

    #[test]
    fn detects_the_install_configuration_without_touching_the_profile() {
        let config = Config::detect();
        assert!(!config.release_base.is_empty());
        assert!(config.download_dir.ends_with(Path::new("@oh-my-pi").join("omp-gui").join("updates")));
    }
}
