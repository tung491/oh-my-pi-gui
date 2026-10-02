//! Tails `omp.*.log` files, ported from `log-watcher.ts`. Lines are batched
//! (delivered via the flush callback at most every [`FLUSH_INTERVAL`] instead
//! of once per line) and kept in a 1,000-line ring buffer.
//!
//! Per the wave rule that a module never resolves the agent directory itself,
//! the logs directory is a constructor parameter; the `Services` port passes
//! `paths::agent_dir().join("..").join("logs")` in production (as
//! `log-watcher.ts:41` computed it) and a temp dir in tests.
//!
//! The TypeScript source combines `fs.watch` with a 15 s poll safety net,
//! because that API is unreliable on some platforms. This port uses one
//! mechanism for both file discovery and new content: a short poll tick well
//! under the flush interval, which is simpler and at least as responsive.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const RING_BUFFER_SIZE: usize = 1000;
const FLUSH_INTERVAL: Duration = Duration::from_millis(150);
const POLL_INTERVAL: Duration = Duration::from_millis(50);

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct WatchedFile {
    offset: u64,
    partial: String,
}

struct State {
    files: HashMap<PathBuf, WatchedFile>,
    buffer: VecDeque<String>,
    pending: Vec<String>,
    sequence: u64,
    flush_due: Option<Instant>,
}

impl State {
    fn new() -> Self {
        Self { files: HashMap::new(), buffer: VecDeque::new(), pending: Vec::new(), sequence: 0, flush_due: None }
    }

    fn push_line(&mut self, line: String) {
        self.sequence += 1;
        self.buffer.push_back(line.clone());
        if self.buffer.len() > RING_BUFFER_SIZE {
            self.buffer.pop_front();
        }
        self.pending.push(line);
        if self.flush_due.is_none() {
            self.flush_due = Some(Instant::now() + FLUSH_INTERVAL);
        }
    }

    fn take_flush(&mut self) -> Option<Vec<String>> {
        let due = self.flush_due?;
        if Instant::now() < due {
            return None;
        }
        self.flush_due = None;
        if self.pending.is_empty() {
            return None;
        }
        Some(std::mem::take(&mut self.pending))
    }

    fn flush_now(&mut self) -> Option<Vec<String>> {
        self.flush_due = None;
        if self.pending.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.pending))
        }
    }
}

pub struct LogSnapshot {
    pub lines: Vec<String>,
    pub next_sequence: u64,
}

/// The flush callback: one batch of complete lines.
type LinesCallback = Box<dyn Fn(Vec<String>) + Send + Sync>;

pub struct LogWatcher {
    logs_dir: PathBuf,
    state: Mutex<State>,
    on_lines: Mutex<Option<LinesCallback>>,
    running: AtomicBool,
}

impl LogWatcher {
    pub fn new(logs_dir: PathBuf) -> Self {
        Self { logs_dir, state: Mutex::new(State::new()), on_lines: Mutex::new(None), running: AtomicBool::new(false) }
    }

    pub fn on_lines(&self, callback: LinesCallback) {
        *lock(&self.on_lines) = Some(callback);
    }

    pub fn snapshot(&self) -> LogSnapshot {
        let state = lock(&self.state);
        LogSnapshot { lines: state.buffer.iter().cloned().collect(), next_sequence: state.sequence }
    }

    /// Start tailing. The initial discovery (every current `omp.*.log` file
    /// starts tailing from its current end) runs synchronously, so a line
    /// written immediately after `start()` returns is never mistaken for
    /// pre-existing content; only the ongoing poll loop runs on the spawning
    /// helper, so it is safe to call `start()` itself from the main thread
    /// during `services::init`.
    pub fn start(self: &Arc<Self>) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        self.poll_once();
        let watcher = self.clone();
        crate::bridge::spawn_task(async move {
            while watcher.running.load(Ordering::SeqCst) {
                tokio::time::sleep(POLL_INTERVAL).await;
                watcher.poll_once();
                if let Some(lines) = lock(&watcher.state).take_flush() {
                    if let Some(callback) = lock(&watcher.on_lines).as_ref() {
                        callback(lines);
                    }
                }
            }
        });
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        let lines = lock(&self.state).flush_now();
        if let Some(lines) = lines {
            if let Some(callback) = lock(&self.on_lines).as_ref() {
                callback(lines);
            }
        }
    }

    fn poll_once(&self) {
        let Ok(entries) = std::fs::read_dir(&self.logs_dir) else { return };
        let mut candidates: Vec<PathBuf> = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("omp.") && name.ends_with(".log") {
                candidates.push(entry.path());
            }
        }
        for path in candidates {
            self.read_new_content(&path);
        }
    }

    fn read_new_content(&self, path: &Path) {
        let Ok(metadata) = std::fs::metadata(path) else { return };
        let size = metadata.len();
        let mut state = lock(&self.state);
        let is_new = !state.files.contains_key(path);
        if is_new {
            // A file is tailed from its current end, whether discovered at
            // start or appearing later: only new content is ever delivered.
            state.files.insert(path.to_path_buf(), WatchedFile { offset: size, partial: String::new() });
            return;
        }
        let watched = state.files.get_mut(path).unwrap_or_else(|| unreachable!("checked above"));
        if size < watched.offset {
            // Rotated or truncated.
            watched.offset = 0;
            watched.partial.clear();
        }
        if size == watched.offset {
            return;
        }
        let Ok(mut file) = std::fs::File::open(path) else { return };
        let length = (size - watched.offset) as usize;
        let mut buffer = vec![0u8; length];
        if file.seek(SeekFrom::Start(watched.offset)).is_err() {
            return;
        }
        let mut read_total = 0usize;
        while read_total < length {
            match file.read(&mut buffer[read_total..]) {
                Ok(0) => break,
                Ok(read) => read_total += read,
                Err(_) => break,
            }
        }
        buffer.truncate(read_total);
        let mut text = std::mem::take(&mut watched.partial);
        text.push_str(&String::from_utf8_lossy(&buffer));
        let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();
        watched.partial = lines.pop().unwrap_or_default();
        watched.offset += read_total as u64;
        for line in lines {
            if !line.trim().is_empty() {
                state.push_line(line);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn opening_logs_later_replays_complete_lines_once_including_split_appends() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("omp.test.log");
        std::fs::write(&file, "previous run\n").unwrap();
        let watcher = Arc::new(LogWatcher::new(dir.path().to_path_buf()));
        let batches: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let batches_clone = batches.clone();
        watcher.on_lines(Box::new(move |lines| lock(&batches_clone).extend(lines)));
        watcher.start();

        std::fs::write(&file, "previous run\n[info] split").unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(watcher.snapshot().lines, Vec::<String>::new());

        let mut contents = std::fs::read_to_string(&file).unwrap();
        contents.push_str(" message\n[error] failed\n");
        std::fs::write(&file, &contents).unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        while watcher.snapshot().lines != vec!["[info] split message".to_string(), "[error] failed".to_string()] {
            if Instant::now() > deadline {
                panic!("timed out waiting for lines; got {:?}", watcher.snapshot().lines);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while lock(&batches).clone() != watcher.snapshot().lines {
            if Instant::now() > deadline {
                panic!("timed out waiting for the callback batch to match the buffer");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let snapshot = watcher.snapshot();
        assert_eq!(snapshot.lines, lock(&batches).clone());
        assert_eq!(snapshot.next_sequence, 2);

        watcher.stop();
    }
}
