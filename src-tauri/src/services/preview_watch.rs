//! Watches the files a window previews, so a preview refreshes by itself
//! after its file changes from any source (`fs:watch-preview`,
//! `fs:unwatch-preview`, `fs:preview-changed`).
//!
//! Each watch observes its file's parent directory non-recursively and keeps
//! only events naming the file, so an atomic rename-over save and a delete
//! plus recreate are both seen. One `notify` watcher serves every watch (an
//! inotify instance per preview would exhaust the per-user instance limit),
//! with a reference count per directory. One worker thread runs the trailing
//! debounce: a watch fires once, `debounce` after its last relevant event.
//!
//! Locks: `entries` is only ever held for bookkeeping; `dirs` is held across
//! `notify` calls, which may block on a slow mount, so the window-facing paths
//! (`unwatch`, `close_window`) never take it: they hand released directories
//! to the worker thread instead.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

use notify::event::{AccessKind, AccessMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};

use crate::bridge::Reply;
use crate::ctx::AppCtx;
use crate::ports::{Caller, WindowId};

use super::fs as workspace_fs;

/// Quiet period after the last change before a watch fires.
pub(crate) const PREVIEW_DEBOUNCE: Duration = Duration::from_millis(1500);
/// A window's watch beyond this closes its oldest one.
pub(crate) const MAX_WATCHES_PER_WINDOW: usize = 8;
/// How long `fs:watch-preview` waits for the watch to be set up (a hung
/// network mount) before answering `unavailable`.
const WATCH_SETUP_TIMEOUT: Duration = Duration::from_secs(10);

/// Called with the window and watch id when a watched file settled after a change.
pub(crate) type ChangeListener = Arc<dyn Fn(WindowId, &str) + Send + Sync>;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // Bookkeeping only; a panic elsewhere must not stop every preview refreshing.
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Entry {
    win_id: WindowId,
    /// The watched file, as the directory watch reports it.
    target: PathBuf,
    dir: PathBuf,
}

#[derive(Default)]
struct Entries {
    by_id: HashMap<String, Entry>,
    /// Each window's watch ids, oldest first.
    by_window: HashMap<WindowId, VecDeque<String>>,
}

impl Entries {
    fn remove(&mut self, watch_id: &str) -> Option<Entry> {
        let entry = self.by_id.remove(watch_id)?;
        if let Some(ids) = self.by_window.get_mut(&entry.win_id) {
            ids.retain(|id| id != watch_id);
            if ids.is_empty() {
                self.by_window.remove(&entry.win_id);
            }
        }
        Some(entry)
    }
}

#[derive(Default)]
struct Dirs {
    watcher: Option<RecommendedWatcher>,
    counts: HashMap<PathBuf, usize>,
}

enum Msg {
    /// These watches saw a relevant event: (re)start their debounce.
    Touch(Vec<String>),
    /// These directories lost one watch each.
    Release(Vec<PathBuf>),
}

struct Inner {
    debounce: Duration,
    on_change: ChangeListener,
    next_id: AtomicU64,
    entries: Mutex<Entries>,
    dirs: Mutex<Dirs>,
    /// The worker's inbox, started with the first watch.
    worker: Mutex<Option<Sender<Msg>>>,
}

/// The registry of every window's preview watches.
pub(crate) struct PreviewWatches {
    inner: Arc<Inner>,
}

impl PreviewWatches {
    pub(crate) fn new(debounce: Duration, on_change: ChangeListener) -> Self {
        Self {
            inner: Arc::new(Inner {
                debounce,
                on_change,
                next_id: AtomicU64::new(1),
                entries: Mutex::default(),
                dirs: Mutex::default(),
                worker: Mutex::new(None),
            }),
        }
    }

    /// Watch `target` (an absolute path) for `win_id`. Blocks on the file
    /// system, so callers run it off the window's queue. `Err` carries the
    /// IPC error code.
    pub(crate) fn watch(&self, win_id: WindowId, target: &Path) -> Result<String, &'static str> {
        let target = watch_target(target).ok_or("invalid-path")?;
        let dir = target.parent().ok_or("invalid-path")?.to_path_buf();
        let worker = self.inner.worker_sender().ok_or("unavailable")?;
        self.inner.retain_dir(&dir)?;
        let watch_id = format!("preview-{}", self.inner.next_id.fetch_add(1, Ordering::Relaxed));
        let evicted: Vec<PathBuf> = {
            let mut entries = lock(&self.inner.entries);
            entries.by_id.insert(watch_id.clone(), Entry { win_id, target, dir });
            let ids = entries.by_window.entry(win_id).or_default();
            ids.push_back(watch_id.clone());
            let mut overflow = Vec::new();
            while ids.len() > MAX_WATCHES_PER_WINDOW {
                overflow.extend(ids.pop_front());
            }
            overflow.iter().filter_map(|id| entries.by_id.remove(id)).map(|entry| entry.dir).collect()
        };
        if !evicted.is_empty() {
            let _ = worker.send(Msg::Release(evicted));
        }
        Ok(watch_id)
    }

    /// Stop one watch; an unknown id is a no-op. Never blocks on the file system.
    pub(crate) fn unwatch(&self, watch_id: &str) {
        let removed = lock(&self.inner.entries).remove(watch_id);
        if let Some(entry) = removed {
            self.inner.release(vec![entry.dir]);
        }
    }

    /// Stop every watch of a window that closed or whose page is reloading.
    pub(crate) fn close_window(&self, win_id: WindowId) {
        let dirs: Vec<PathBuf> = {
            let mut entries = lock(&self.inner.entries);
            let ids = entries.by_window.remove(&win_id).unwrap_or_default();
            ids.iter().filter_map(|id| entries.by_id.remove(id)).map(|entry| entry.dir).collect()
        };
        if !dirs.is_empty() {
            self.inner.release(dirs);
        }
    }

    /// Stop every watch and the shared watcher (app shutdown).
    pub(crate) fn stop(&self) {
        *lock(&self.inner.entries) = Entries::default();
        // Dropping the sender ends the worker once it drains its inbox.
        lock(&self.inner.worker).take();
        let watcher = {
            let mut dirs = lock(&self.inner.dirs);
            dirs.counts.clear();
            dirs.watcher.take()
        };
        drop(watcher);
    }

    #[cfg(test)]
    pub(crate) fn watch_count(&self, win_id: WindowId) -> usize {
        lock(&self.inner.entries).by_window.get(&win_id).map_or(0, VecDeque::len)
    }
}

impl Inner {
    /// The worker's inbox, starting the worker on first use.
    fn worker_sender(self: &Arc<Self>) -> Option<Sender<Msg>> {
        let mut worker = lock(&self.worker);
        if let Some(sender) = worker.as_ref() {
            return Some(sender.clone());
        }
        let (sender, inbox) = mpsc::channel();
        let weak = Arc::downgrade(self);
        let debounce = self.debounce;
        std::thread::Builder::new()
            .name("preview-watch".to_string())
            .spawn(move || run_worker(&weak, &inbox, debounce))
            .ok()?;
        *worker = Some(sender.clone());
        Some(sender)
    }

    /// One more watch on `dir`; the first one adds the directory watch.
    fn retain_dir(self: &Arc<Self>, dir: &Path) -> Result<(), &'static str> {
        let mut dirs = lock(&self.dirs);
        if dirs.watcher.is_none() {
            let weak = Arc::downgrade(self);
            let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if let (Some(inner), Ok(event)) = (weak.upgrade(), event) {
                    inner.on_event(&event);
                }
            })
            .map_err(|_| "unavailable")?;
            dirs.watcher = Some(watcher);
        }
        let count = dirs.counts.get(dir).copied().unwrap_or(0);
        if count == 0 {
            let watcher = dirs.watcher.as_mut().ok_or("unavailable")?;
            watcher.watch(dir, RecursiveMode::NonRecursive).map_err(|_| "unavailable")?;
        }
        dirs.counts.insert(dir.to_path_buf(), count + 1);
        Ok(())
    }

    /// Hand released directories to the worker, which may block on them.
    fn release(&self, dirs: Vec<PathBuf>) {
        if let Some(sender) = lock(&self.worker).as_ref() {
            let _ = sender.send(Msg::Release(dirs));
        }
    }

    /// One less watch on each of `released`; the last one removes the directory watch.
    fn release_dirs(&self, released: &[PathBuf]) {
        let mut dirs = lock(&self.dirs);
        for dir in released {
            let Some(count) = dirs.counts.get_mut(dir) else { continue };
            *count -= 1;
            if *count == 0 {
                dirs.counts.remove(dir);
                if let Some(watcher) = dirs.watcher.as_mut() {
                    // The directory may be gone already, taking its watch with it.
                    let _ = watcher.unwatch(dir);
                }
            }
        }
    }

    fn on_event(&self, event: &notify::Event) {
        if !is_relevant(event.kind) && !event.need_rescan() {
            return;
        }
        let touched: Vec<String> = {
            let entries = lock(&self.entries);
            entries
                .by_id
                .iter()
                .filter(|(_, entry)| event.need_rescan() || event.paths.contains(&entry.target))
                .map(|(id, _)| id.clone())
                .collect()
        };
        if touched.is_empty() {
            return;
        }
        if let Some(sender) = lock(&self.worker).as_ref() {
            let _ = sender.send(Msg::Touch(touched));
        }
    }

    /// Notify the watch's window, unless it was closed meanwhile.
    fn fire(&self, watch_id: &str) {
        let win_id = lock(&self.entries).by_id.get(watch_id).map(|entry| entry.win_id);
        if let Some(win_id) = win_id {
            (self.on_change)(win_id, watch_id);
        }
    }
}

/// Opening or reading the file (the preview's own refresh read among them)
/// is not a change; closing it after writing is.
fn is_relevant(kind: EventKind) -> bool {
    match kind {
        EventKind::Access(AccessKind::Close(AccessMode::Write)) => true,
        EventKind::Access(_) => false,
        _ => true,
    }
}

/// The path the directory watch reports for `path`: its parent resolved
/// through symlinks (the file itself may be missing or replaced later), then
/// the file name. `None` for a path with no file name.
fn watch_target(path: &Path) -> Option<PathBuf> {
    let path = workspace_fs::normalize(path);
    let name = path.file_name()?.to_os_string();
    let parent = path.parent()?;
    let parent = std::fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
    Some(parent.join(name))
}

/// The debounce loop: each touched watch fires `debounce` after its last touch.
fn run_worker(inner: &Weak<Inner>, inbox: &Receiver<Msg>, debounce: Duration) {
    let mut due: HashMap<String, Instant> = HashMap::new();
    loop {
        let message = match due.values().min().copied() {
            None => match inbox.recv() {
                Ok(message) => Some(message),
                Err(_) => return,
            },
            Some(next) => match inbox.recv_timeout(next.saturating_duration_since(Instant::now())) {
                Ok(message) => Some(message),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            },
        };
        match message {
            Some(Msg::Touch(ids)) => {
                let at = Instant::now() + debounce;
                due.extend(ids.into_iter().map(|id| (id, at)));
            }
            Some(Msg::Release(dirs)) => {
                if let Some(inner) = inner.upgrade() {
                    inner.release_dirs(&dirs);
                }
            }
            None => {}
        }
        let now = Instant::now();
        let fired: Vec<String> = due.iter().filter(|(_, at)| **at <= now).map(|(id, _)| id.clone()).collect();
        if fired.is_empty() {
            continue;
        }
        let Some(inner) = inner.upgrade() else { return };
        for id in fired {
            due.remove(&id);
            inner.fire(&id);
        }
    }
}

fn watch_failure(error: &str) -> Value {
    json!({ "ok": false, "error": error })
}

/// `fs:watch-preview`: resolves the path as `fs:read-document` does (absolute
/// and `~/` as given, relative confined to the tab's workspace), then sets the
/// watch up on a blocking thread so a slow mount never holds up the window's
/// other calls. `watches` is `None` when the services port is not the
/// production one.
pub(crate) fn watch_reply(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>, watches: Option<Arc<PreviewWatches>>) -> Reply {
    let payload = args.into_iter().next().unwrap_or(Value::Null);
    let Some(path) = payload.get("path").and_then(Value::as_str).filter(|path| !path.is_empty()) else {
        return Reply::ok(watch_failure("invalid-path"));
    };
    let raw = super::ipc::expand_home(path);
    let cwd = if Path::new(&raw).is_absolute() {
        None
    } else {
        let tab_id = payload.get("tabId").and_then(Value::as_str);
        match ctx.tabs.cwd_for(caller, tab_id) {
            Some(cwd) => Some(cwd),
            None => return Reply::ok(watch_failure("no-workspace")),
        }
    };
    let Some(watches) = watches else {
        return Reply::ok(watch_failure("unavailable"));
    };
    let win_id = caller.win_id;
    Reply::Later(Box::pin(async move {
        let registry = watches.clone();
        let setup = tokio::task::spawn_blocking(move || {
            let abs = match cwd {
                None => PathBuf::from(&raw),
                Some(cwd) => workspace_fs::resolve_within(Path::new(&cwd), &raw).ok_or("outside-workspace")?,
            };
            registry.watch(win_id, &abs)
        });
        Ok(settle_watch_setup(setup, WATCH_SETUP_TIMEOUT, watches).await)
    }))
}

/// The setup's answer, or `unavailable` once `timeout` passes first; a watch
/// that completes after the caller gave up is closed again.
async fn settle_watch_setup(
    mut setup: tokio::task::JoinHandle<Result<String, &'static str>>,
    timeout: Duration,
    watches: Arc<PreviewWatches>,
) -> Value {
    match tokio::time::timeout(timeout, &mut setup).await {
        Ok(Ok(Ok(watch_id))) => json!({ "ok": true, "watchId": watch_id }),
        Ok(Ok(Err(error))) => watch_failure(error),
        Ok(Err(_)) => watch_failure("unavailable"),
        Err(_) => {
            crate::bridge::spawn_task(async move {
                if let Ok(Ok(watch_id)) = setup.await {
                    watches.unwatch(&watch_id);
                }
            });
            watch_failure("unavailable")
        }
    }
}

/// `fs:unwatch-preview`: fire-and-forget; an unknown or malformed id is a no-op.
pub(crate) fn unwatch_reply(args: Vec<Value>, watches: Option<Arc<PreviewWatches>>) -> Reply {
    let watch_id = args.first().and_then(|payload| payload.get("watchId")).and_then(Value::as_str);
    if let (Some(watch_id), Some(watches)) = (watch_id, watches) {
        watches.unwatch(watch_id);
    }
    Reply::ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::Registry;
    use crate::testing::{self, Fakes};
    use serde_json::json;
    use std::sync::Mutex;
    use std::time::Instant;

    const TEST_DEBOUNCE: Duration = Duration::from_millis(300);

    type Fired = Arc<Mutex<Vec<(WindowId, String)>>>;

    fn watches() -> (Arc<PreviewWatches>, Fired) {
        let fired: Fired = Arc::default();
        let sink = fired.clone();
        let listener: ChangeListener = Arc::new(move |win_id, watch_id| sink.lock().unwrap().push((win_id, watch_id.to_string())));
        (Arc::new(PreviewWatches::new(TEST_DEBOUNCE, listener)), fired)
    }

    fn fired_for(fired: &Fired, watch_id: &str) -> usize {
        fired.lock().unwrap().iter().filter(|(_, id)| id == watch_id).count()
    }

    /// Polls until `watch_id` fired at least once or `within` passes.
    fn wait_for(fired: &Fired, watch_id: &str, within: Duration) -> bool {
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            if fired_for(fired, watch_id) > 0 {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        fired_for(fired, watch_id) > 0
    }

    /// Long enough for a debounced event that is coming to have arrived.
    fn settle() {
        std::thread::sleep(TEST_DEBOUNCE * 4);
    }

    #[test]
    fn preview_watch_fires_once_after_changes_settle() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("report.docx");
        std::fs::write(&file, "v0").unwrap();
        let (watches, fired) = watches();
        let id = watches.watch(WindowId(1), &file).unwrap();
        for round in 1..=4 {
            std::fs::write(&file, format!("v{round}")).unwrap();
            std::thread::sleep(TEST_DEBOUNCE / 6);
        }
        assert_eq!(fired_for(&fired, &id), 0, "nothing fires while the writes keep coming");
        assert!(wait_for(&fired, &id, Duration::from_secs(5)), "the watch fires after the writes settle");
        settle();
        assert_eq!(fired.lock().unwrap().clone(), vec![(WindowId(1), id)]);
    }

    #[test]
    fn preview_watch_ignores_other_files_in_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("report.docx");
        std::fs::write(&file, "v0").unwrap();
        let (watches, fired) = watches();
        let id = watches.watch(WindowId(1), &file).unwrap();
        std::fs::write(dir.path().join("other.docx"), "x").unwrap();
        std::fs::write(dir.path().join("report.docx.bak"), "x").unwrap();
        std::fs::read(&file).unwrap();
        settle();
        assert_eq!(fired_for(&fired, &id), 0);
    }

    #[test]
    fn preview_watch_survives_an_atomic_rename_save() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("report.docx");
        std::fs::write(&file, "v0").unwrap();
        let (watches, fired) = watches();
        let id = watches.watch(WindowId(1), &file).unwrap();
        for round in 1..=2 {
            let temp = dir.path().join(format!(".report.docx.tmp{round}"));
            std::fs::write(&temp, format!("v{round}")).unwrap();
            std::fs::rename(&temp, &file).unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while fired_for(&fired, &id) < round && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            assert_eq!(fired_for(&fired, &id), round, "save {round} is seen");
        }
        std::fs::remove_file(&file).unwrap();
        std::fs::write(&file, "recreated").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while fired_for(&fired, &id) < 3 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(fired_for(&fired, &id), 3, "a delete and recreate is seen");
    }

    #[tokio::test]
    async fn preview_watch_refuses_a_relative_path_outside_the_workspace() {
        let fakes = Fakes::default();
        let workspace = tempfile::tempdir().unwrap();
        fakes.tabs.cwds.lock().unwrap().insert(WindowId(1), workspace.path().to_string_lossy().into_owned());
        let ctx = testing::fake_ctx_with(&fakes, Registry::new());
        let (watches, _fired) = watches();
        let reply = watch_reply(&ctx, Caller::main(WindowId(1)), vec![json!({ "path": "../escape.docx", "tabId": "t1" })], Some(watches.clone()));
        assert_eq!(settle_reply(reply).await, json!({ "ok": false, "error": "outside-workspace" }));
        assert_eq!(watches.watch_count(WindowId(1)), 0);

        std::fs::write(workspace.path().join("inside.docx"), "x").unwrap();
        let reply = watch_reply(&ctx, Caller::main(WindowId(1)), vec![json!({ "path": "inside.docx", "tabId": "t1" })], Some(watches.clone()));
        let result = settle_reply(reply).await;
        assert_eq!(result["ok"], json!(true));
        assert!(result["watchId"].as_str().is_some_and(|id| !id.is_empty()));
        assert_eq!(watches.watch_count(WindowId(1)), 1);
    }

    #[tokio::test]
    async fn preview_watch_refuses_an_unknown_tab() {
        let fakes = Fakes::default();
        let ctx = testing::fake_ctx_with(&fakes, Registry::new());
        let (watches, _fired) = watches();
        let reply = watch_reply(&ctx, Caller::main(WindowId(1)), vec![json!({ "path": "report.docx", "tabId": "missing" })], Some(watches.clone()));
        assert_eq!(settle_reply(reply).await, json!({ "ok": false, "error": "no-workspace" }));
        let reply = watch_reply(&ctx, Caller::main(WindowId(1)), vec![json!({ "path": "" })], Some(watches.clone()));
        assert_eq!(settle_reply(reply).await, json!({ "ok": false, "error": "invalid-path" }));
        let reply = watch_reply(&ctx, Caller::main(WindowId(1)), vec![json!({ "path": "/tmp/a.docx" })], None);
        assert_eq!(settle_reply(reply).await, json!({ "ok": false, "error": "unavailable" }));
        assert_eq!(watches.watch_count(WindowId(1)), 0);
    }

    #[test]
    fn preview_watch_closes_the_oldest_beyond_eight_per_window() {
        let dir = tempfile::tempdir().unwrap();
        let (watches, fired) = watches();
        let files: Vec<_> = (0..=MAX_WATCHES_PER_WINDOW).map(|n| dir.path().join(format!("doc{n}.docx"))).collect();
        let mut ids = Vec::new();
        for file in &files {
            std::fs::write(file, "v0").unwrap();
            ids.push(watches.watch(WindowId(1), file).unwrap());
        }
        let other = watches.watch(WindowId(2), &files[0]).unwrap();
        assert_eq!(watches.watch_count(WindowId(1)), MAX_WATCHES_PER_WINDOW);
        assert_eq!(watches.watch_count(WindowId(2)), 1);
        std::fs::write(&files[0], "v1").unwrap();
        std::fs::write(&files[MAX_WATCHES_PER_WINDOW], "v1").unwrap();
        assert!(wait_for(&fired, &ids[MAX_WATCHES_PER_WINDOW], Duration::from_secs(5)));
        assert!(wait_for(&fired, &other, Duration::from_secs(5)), "another window's watch on the same folder stays open");
        settle();
        assert_eq!(fired_for(&fired, &ids[0]), 0, "the oldest watch was closed");
    }

    #[test]
    fn preview_unwatch_stops_further_events() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("report.docx");
        std::fs::write(&file, "v0").unwrap();
        let (watches, fired) = watches();
        let id = watches.watch(WindowId(1), &file).unwrap();
        let pending = watches.watch(WindowId(1), &file).unwrap();
        std::fs::write(&file, "v1").unwrap();
        // Unwatched while its debounce is still running: it never fires.
        watches.unwatch(&pending);
        assert!(wait_for(&fired, &id, Duration::from_secs(5)));
        watches.unwatch(&id);
        watches.unwatch("unknown");
        std::fs::write(&file, "v2").unwrap();
        settle();
        assert_eq!(fired_for(&fired, &id), 1);
        assert_eq!(fired_for(&fired, &pending), 0);
        assert_eq!(watches.watch_count(WindowId(1)), 0);
    }

    #[test]
    fn preview_watches_close_with_their_window() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("report.docx");
        std::fs::write(&file, "v0").unwrap();
        let (watches, fired) = watches();
        let closed = watches.watch(WindowId(1), &file).unwrap();
        let kept = watches.watch(WindowId(2), &file).unwrap();
        watches.close_window(WindowId(1));
        std::fs::write(&file, "v1").unwrap();
        assert!(wait_for(&fired, &kept, Duration::from_secs(5)));
        settle();
        assert_eq!(fired_for(&fired, &closed), 0);
        assert_eq!(watches.watch_count(WindowId(1)), 0);
    }

    #[test]
    fn preview_watch_reports_unavailable_when_the_folder_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let (watches, _fired) = watches();
        assert_eq!(watches.watch(WindowId(1), &dir.path().join("gone").join("a.docx")), Err("unavailable"));
        assert_eq!(watches.watch_count(WindowId(1)), 0);
    }

    #[test]
    fn preview_unwatch_payload_is_a_fire_and_forget_unit() {
        let (watches, _fired) = watches();
        assert!(matches!(unwatch_reply(vec![json!({ "watchId": "nope" })], Some(watches.clone())), Reply::Ready(Ok(Value::Null))));
        assert!(matches!(unwatch_reply(vec![json!(42)], None), Reply::Ready(Ok(Value::Null))));
    }

    async fn settle_reply(reply: Reply) -> Value {
        match reply {
            Reply::Ready(result) => result.unwrap(),
            Reply::Later(future) => future.await.unwrap(),
        }
    }
}
