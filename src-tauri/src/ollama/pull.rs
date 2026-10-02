//! Downloads one Ollama model at a time through `POST /api/pull`, folding the
//! NDJSON stream into `PullProgress` frames the way sai-welcome does
//! (`welcome/backend/pull.go`): per-layer totals summed, `completed` clamped
//! to `total`, percent -1 until a size is known and capped at 99 until `success`.
//!
//! `pull` never hangs the caller past the request itself: a busy slot and
//! cancellation both resolve as a frame. Cancelling aborts the request; Ollama
//! keeps finished layers, so pulling the same tag again resumes.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Notify;

use super::install_progress::Throttle;
use crate::ports::WindowId;

/// Progress listeners hear at most one frame per interval (10 Hz); terminal frames go out at once.
pub const PULL_PROGRESS_INTERVAL_MS: u64 = 100;

const MAX_TAG_LENGTH: usize = 200;

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// A model reference as `ollama pull` takes it: `name[:tag]`, optionally namespaced.
pub fn is_valid_model_tag(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_TAG_LENGTH {
        return false;
    }
    let mut chars = value.chars();
    let Some(first) = chars.next() else { return false };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '-'))
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullProgress {
    pub tag: String,
    /// Ollama's own status line (`pulling manifest`, `downloading`, `success`, ...).
    pub status: String,
    pub completed: u64,
    pub total: u64,
    /// -1 while the size is unknown (indeterminate); capped at 99 until `done`.
    pub percent: i32,
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn idle_frame(tag: &str, status: &str) -> PullProgress {
    PullProgress { tag: tag.to_string(), status: status.to_string(), completed: 0, total: 0, percent: -1, done: false, error: None }
}

#[derive(Default, Clone, Copy)]
struct Layer {
    completed: u64,
    total: u64,
}

fn count(value: Option<&Value>) -> u64 {
    match value.and_then(Value::as_f64) {
        Some(v) if v.is_finite() && v > 0.0 => v as u64,
        _ => 0,
    }
}

/// Folds pull stream lines into frames; one instance per pull.
pub struct PullAggregator {
    tag: String,
    layers: HashMap<String, Layer>,
    status: String,
}

impl PullAggregator {
    pub fn new(tag: impl Into<String>) -> Self {
        Self { tag: tag.into(), layers: HashMap::new(), status: "pulling manifest".to_string() }
    }

    /// The frame after `line`; an `error` line yields a terminal error frame.
    pub fn apply(&mut self, line: &Value) -> PullProgress {
        let Some(obj) = line.as_object() else { return self.frame() };
        if let Some(error) = obj.get("error").and_then(Value::as_str) {
            let mut frame = self.frame();
            frame.error = Some(error.to_string());
            return frame;
        }
        if let Some(status) = obj.get("status").and_then(Value::as_str) {
            self.status = status.to_string();
        }
        if let Some(digest) = obj.get("digest").and_then(Value::as_str) {
            if !digest.is_empty() {
                let layer = self.layers.entry(digest.to_string()).or_default();
                let total = count(obj.get("total"));
                if total > 0 {
                    layer.total = total;
                }
                layer.completed = layer.completed.max(count(obj.get("completed")));
                if layer.total > 0 {
                    layer.completed = layer.completed.min(layer.total);
                }
            }
        }
        self.frame()
    }

    pub fn frame(&self) -> PullProgress {
        let mut completed = 0u64;
        let mut total = 0u64;
        for layer in self.layers.values() {
            if layer.total == 0 {
                continue;
            }
            total += layer.total;
            completed += layer.completed;
        }
        let done = self.status == "success";
        let percent: i32 = if done {
            100
        } else {
            match (completed * 100).checked_div(total) {
                Some(p) => p.min(99) as i32,
                None => -1,
            }
        };
        PullProgress { tag: self.tag.clone(), status: self.status.clone(), completed, total, percent, done, error: None }
    }
}

struct ActivePull {
    tag: String,
    cancelled: AtomicBool,
    cancel_notify: Notify,
    listeners: Mutex<Vec<WindowId>>,
    last: Mutex<PullProgress>,
    result: tokio::sync::OnceCell<PullProgress>,
    result_ready: Notify,
}

impl ActivePull {
    fn new(tag: String) -> Self {
        let last = idle_frame(&tag, "pulling manifest");
        Self {
            tag,
            cancelled: AtomicBool::new(false),
            cancel_notify: Notify::new(),
            listeners: Mutex::new(Vec::new()),
            last: Mutex::new(last),
            result: tokio::sync::OnceCell::new(),
            result_ready: Notify::new(),
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Resolves `tag` to its download base URL; errors never occur, matching the
/// TS `baseUrl: () => Promise<string>` seam.
pub type BaseUrlFn = Arc<dyn Fn() -> BoxFuture<String> + Send + Sync>;

/// Where progress for one listener window goes (`ctx.bridge.emit_to_window` in `ipc.rs`).
pub type ProgressSink = Arc<dyn Fn(WindowId, PullProgress) + Send + Sync>;

/// One download at a time; a second tag while one runs resolves at once with a `busy` frame.
pub struct OllamaPuller {
    base_url: BaseUrlFn,
    interval: Duration,
    progress_sink: ProgressSink,
    active: Mutex<Option<Arc<ActivePull>>>,
}

async fn response_error(response: reqwest::Response) -> String {
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let text = text.trim();
    if let Ok(body) = serde_json::from_str::<Value>(text) {
        if let Some(error) = body.get("error").and_then(Value::as_str) {
            return error.to_string();
        }
    }
    if text.is_empty() {
        format!("HTTP {}", status.as_u16())
    } else {
        format!("HTTP {}: {}", status.as_u16(), &text[..text.len().min(300)])
    }
}

impl OllamaPuller {
    pub fn new(base_url: BaseUrlFn, progress_sink: ProgressSink) -> Self {
        Self::with_interval(base_url, Duration::from_millis(PULL_PROGRESS_INTERVAL_MS), progress_sink)
    }

    pub fn with_interval(base_url: BaseUrlFn, interval: Duration, progress_sink: ProgressSink) -> Self {
        Self { base_url, interval, progress_sink, active: Mutex::new(None) }
    }

    #[cfg(test)]
    pub fn active_tag(&self) -> Option<String> {
        lock(&self.active).as_ref().map(|active| active.tag.clone())
    }

    /// Start pulling `tag`, or join the running pull of the same tag. A
    /// different tag while one runs resolves at once with a `busy` error frame.
    /// `listener` is the caller's window: every throttled and terminal frame
    /// for this pull reaches it (and every other listener) through `progress_sink`.
    pub async fn pull(&self, tag: &str, listener: Option<WindowId>) -> PullProgress {
        if !is_valid_model_tag(tag) {
            let mut frame = idle_frame(tag, "invalid");
            frame.error = Some("Invalid model name".to_string());
            return frame;
        }
        let (active, is_new) = {
            let mut guard = lock(&self.active);
            match guard.as_ref() {
                Some(active) if active.tag == tag => {
                    if let Some(win) = listener {
                        lock(&active.listeners).push(win);
                    }
                    (active.clone(), false)
                }
                Some(active) => {
                    let mut frame = idle_frame(tag, "busy");
                    frame.error = Some(format!("Another model is downloading ({}). Wait for it or cancel it first.", active.tag));
                    return frame;
                }
                None => {
                    let run = Arc::new(ActivePull::new(tag.to_string()));
                    if let Some(win) = listener {
                        lock(&run.listeners).push(win);
                    }
                    *guard = Some(run.clone());
                    (run, true)
                }
            }
        };
        if is_new {
            self.drive(active).await
        } else {
            Self::await_result(&active).await
        }
    }

    /// Abort the running pull; it resolves with its last frame and emits nothing further.
    pub fn cancel(&self) {
        if let Some(active) = lock(&self.active).clone() {
            active.cancelled.store(true, Ordering::SeqCst);
            active.cancel_notify.notify_one();
        }
    }

    async fn await_result(active: &Arc<ActivePull>) -> PullProgress {
        loop {
            let notified = active.result_ready.notified();
            if let Some(frame) = active.result.get() {
                return frame.clone();
            }
            notified.await;
        }
    }

    async fn drive(&self, active: Arc<ActivePull>) -> PullProgress {
        let cancel_fut = active.cancel_notify.notified();
        tokio::pin!(cancel_fut);
        let work = self.run(&active);
        tokio::pin!(work);
        let final_frame = tokio::select! {
            biased;
            () = &mut cancel_fut => lock(&active.last).clone(),
            frame = &mut work => frame,
        };
        {
            let mut guard = lock(&self.active);
            if guard.as_ref().is_some_and(|current| Arc::ptr_eq(current, &active)) {
                *guard = None;
            }
        }
        let _ = active.result.set(final_frame.clone());
        active.result_ready.notify_waiters();
        final_frame
    }

    async fn run(&self, active: &Arc<ActivePull>) -> PullProgress {
        let mut aggregator = PullAggregator::new(active.tag.clone());
        let base_url = (self.base_url)().await;
        let client = reqwest::Client::new();
        let response = match client
            .post(format!("{base_url}/api/pull"))
            .header("content-type", "application/json")
            .json(&serde_json::json!({ "model": active.tag, "stream": true }))
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                return self.finish(active, {
                    let mut f = lock(&active.last).clone();
                    f.error = Some(super::probe::fault_text(&error));
                    f
                });
            }
        };
        if !response.status().is_success() {
            let error = response_error(response).await;
            let mut frame = aggregator.frame();
            frame.error = Some(error);
            return self.finish(active, frame);
        }
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        while let Some(chunk) = stream.next().await {
            let Ok(chunk) = chunk else {
                break;
            };
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(newline) = buffer.find('\n') {
                let line = buffer[..newline].trim().to_string();
                buffer = buffer[newline + 1..].to_string();
                let Some(frame) = Self::apply_line(&mut aggregator, &line) else { continue };
                if frame.error.is_some() || frame.done {
                    return self.finish(active, frame);
                }
                self.emit(active, frame);
            }
        }
        let tail = Self::apply_line(&mut aggregator, buffer.trim());
        let final_frame = tail.unwrap_or_else(|| aggregator.frame());
        if final_frame.done || final_frame.error.is_some() {
            return self.finish(active, final_frame);
        }
        if active.cancelled.load(Ordering::SeqCst) {
            return lock(&active.last).clone();
        }
        let mut frame = final_frame;
        frame.error = Some("The download ended before Ollama reported success".to_string());
        self.finish(active, frame)
    }

    fn apply_line(aggregator: &mut PullAggregator, line: &str) -> Option<PullProgress> {
        if line.is_empty() {
            return None;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(parsed) => Some(aggregator.apply(&parsed)),
            Err(_) => None,
        }
    }

    /// Throttled progress: the latest frame wins and goes out at most once per interval.
    fn emit(&self, active: &Arc<ActivePull>, frame: PullProgress) {
        *lock(&active.last) = frame.clone();
        if active.cancelled.load(Ordering::SeqCst) {
            return;
        }
        self.throttle_for(active).push(frame);
    }

    /// Terminal frame: send it now regardless of throttling.
    fn finish(&self, active: &Arc<ActivePull>, frame: PullProgress) -> PullProgress {
        if active.cancelled.load(Ordering::SeqCst) {
            return lock(&active.last).clone();
        }
        *lock(&active.last) = frame.clone();
        self.send(active, frame.clone());
        frame
    }

    fn throttle_for(&self, active: &Arc<ActivePull>) -> Throttle<PullProgress> {
        let active = active.clone();
        let sink = self.progress_sink.clone();
        Throttle::new(self.interval, |frame: &PullProgress| frame.done || frame.error.is_some(), move |frame| {
            broadcast(&active, &sink, frame);
        })
    }

    fn send(&self, active: &Arc<ActivePull>, frame: PullProgress) {
        broadcast(active, &self.progress_sink, frame);
    }
}

/// Every listener window of `active` hears `frame`.
fn broadcast(active: &Arc<ActivePull>, sink: &ProgressSink, frame: PullProgress) {
    for win in lock(&active.listeners).iter() {
        sink(*win, frame.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ollama::test_fake_ollama::{closed_port_url, send_json, start_fake_ollama, start_raw_fake_ollama, write_head_streaming};
    use tokio::io::AsyncWriteExt;

    const TWO_LAYERS: [(&str, &str, Option<u64>, Option<u64>); 8] = [
        ("pulling manifest", "", None, None),
        ("pulling aaa", "sha256:aaa", None, None),
        ("pulling aaa", "sha256:aaa", Some(1000), Some(0)),
        ("pulling aaa", "sha256:aaa", Some(1000), Some(1500)),
        ("pulling bbb", "sha256:bbb", Some(1000), Some(500)),
        ("verifying sha256 digest", "", None, None),
        ("writing manifest", "", None, None),
        ("success", "", None, None),
    ];

    fn two_layers_json() -> Vec<Value> {
        TWO_LAYERS
            .iter()
            .map(|(status, digest, total, completed)| {
                let mut row = serde_json::json!({ "status": status });
                if !digest.is_empty() {
                    row["digest"] = Value::String(digest.to_string());
                }
                if let Some(total) = total {
                    row["total"] = Value::from(*total);
                }
                if let Some(completed) = completed {
                    row["completed"] = Value::from(*completed);
                }
                row
            })
            .collect()
    }

    fn no_sink() -> ProgressSink {
        Arc::new(|_win, _frame| {})
    }

    /// A sink that forwards every frame (regardless of listener window) to a channel,
    /// so a test can observe progress without racing a wall-clock sleep.
    fn channel_sink() -> (ProgressSink, tokio::sync::mpsc::UnboundedReceiver<PullProgress>) {
        let (progress_tx, progress_rx) = tokio::sync::mpsc::unbounded_channel();
        let sink: ProgressSink = Arc::new(move |_win, frame| {
            let _ = progress_tx.send(frame);
        });
        (sink, progress_rx)
    }

    fn immediate_base_url(url: String) -> BaseUrlFn {
        Arc::new(move || {
            let url = url.clone();
            Box::pin(async move { url })
        })
    }

    #[test]
    fn stays_indeterminate_until_a_size_is_known_clamps_and_caps_at_99_until_success() {
        let mut aggregator = PullAggregator::new("qwen3:4b");
        let percents: Vec<i32> = two_layers_json().iter().map(|row| aggregator.apply(row).percent).collect();
        assert_eq!(percents, vec![-1, -1, 0, 99, 75, 75, 75, 100]);
        let frame = aggregator.frame();
        assert_eq!(frame.tag, "qwen3:4b");
        assert_eq!(frame.status, "success");
        assert_eq!(frame.completed, 1500);
        assert_eq!(frame.total, 2000);
        assert_eq!(frame.percent, 100);
        assert!(frame.done);
    }

    #[test]
    fn turns_an_error_line_into_an_error_frame() {
        let mut aggregator = PullAggregator::new("x");
        let frame = aggregator.apply(&serde_json::json!({ "error": "pull model manifest: file does not exist" }));
        assert!(!frame.done);
        assert_eq!(frame.error.as_deref(), Some("pull model manifest: file does not exist"));
    }

    #[tokio::test]
    async fn streams_a_two_layer_pull_and_resolves_with_the_success_frame() {
        let rows = two_layers_json();
        let fake = start_raw_fake_ollama(move |request, mut stream| {
            let rows = rows.clone();
            async move {
                if request.path != "/api/pull" {
                    crate::ollama::test_fake_ollama::write_json(&mut stream, 404, &serde_json::json!({})).await;
                    return;
                }
                let body: Value = serde_json::from_str(&request.body).unwrap_or(Value::Null);
                assert_eq!(body, serde_json::json!({ "model": "qwen3:4b", "stream": true }));
                write_head_streaming(&mut stream, 200, "application/x-ndjson").await;
                let text: String = rows.iter().map(|row| format!("{row}\n")).collect();
                let cut = text.len() / 2;
                let _ = stream.write_all(&text.as_bytes()[..cut]).await;
                tokio::time::sleep(Duration::from_millis(20)).await;
                let _ = stream.write_all(&text.as_bytes()[cut..]).await;
                let _ = stream.shutdown().await;
            }
        })
        .await;
        let puller = OllamaPuller::with_interval(immediate_base_url(fake.url.clone()), Duration::ZERO, no_sink());
        let final_frame = puller.pull("qwen3:4b", None).await;
        assert_eq!(final_frame.status, "success");
        assert!(final_frame.done);
        assert_eq!(final_frame.percent, 100);
        assert_eq!(final_frame.completed, 1500);
        assert_eq!(final_frame.total, 2000);
        assert_eq!(puller.active_tag(), None);
        fake.close().await;
    }

    #[tokio::test]
    async fn throttles_progress_but_sends_the_terminal_frame_at_once() {
        let fake = start_raw_fake_ollama(|_request, mut stream| async move {
            write_head_streaming(&mut stream, 200, "application/x-ndjson").await;
            for i in 1..=50u64 {
                let line = serde_json::json!({ "status": "pulling a", "digest": "a", "total": 100, "completed": i });
                let _ = stream.write_all(format!("{line}\n").as_bytes()).await;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
            let _ = stream.write_all(format!("{}\n", serde_json::json!({ "status": "success" })).as_bytes()).await;
            let _ = stream.shutdown().await;
        })
        .await;
        let (progress_sink, mut progress_rx) = channel_sink();
        let puller = OllamaPuller::with_interval(immediate_base_url(fake.url.clone()), Duration::from_millis(100), progress_sink);
        let final_frame = puller.pull("qwen3:4b", Some(WindowId(1))).await;
        assert!(final_frame.done);
        // `finish` sends the terminal frame synchronously, so it is already queued
        // by the time `pull()` resolves.
        let mut frames = Vec::new();
        while let Ok(frame) = progress_rx.try_recv() {
            frames.push(frame);
        }
        assert_eq!(frames.last().map(|frame| frame.done), Some(true));
        fake.close().await;
    }

    #[tokio::test]
    async fn cancels_mid_stream_resolves_with_the_last_frame_and_emits_nothing_after() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = start_raw_fake_ollama(move |request, stream| {
            let tx = tx.clone();
            async move {
                let body: Value = serde_json::from_str(&request.body).unwrap_or(Value::Null);
                let _ = tx.send((body, stream));
            }
        })
        .await;
        let (progress_sink, mut progress_rx) = channel_sink();
        let puller = Arc::new(OllamaPuller::with_interval(immediate_base_url(fake.url.clone()), Duration::ZERO, progress_sink));
        let puller2 = puller.clone();
        let pending = tokio::spawn(async move { puller2.pull("qwen3:8b", Some(WindowId(1))).await });
        let (_body, mut stream) = rx.recv().await.expect("the pull request arrives");
        write_head_streaming(&mut stream, 200, "application/x-ndjson").await;
        let line = serde_json::json!({ "status": "pulling aaa", "digest": "aaa", "total": 1000, "completed": 250 });
        let _ = stream.write_all(format!("{line}\n").as_bytes()).await;

        // Wait for the parser to have actually observed the frame before cancelling,
        // instead of hoping a fixed sleep outlasts scheduling under load.
        loop {
            let frame = tokio::time::timeout(Duration::from_secs(5), progress_rx.recv())
                .await
                .expect("a progress frame arrives before the timeout")
                .expect("the progress channel stays open");
            if frame.status == "pulling aaa" {
                break;
            }
        }

        puller.cancel();
        let final_frame = pending.await.expect("the pull task completes");
        assert_eq!(
            final_frame,
            PullProgress { tag: "qwen3:8b".to_string(), status: "pulling aaa".to_string(), completed: 250, total: 1000, percent: 25, done: false, error: None }
        );
        assert_eq!(puller.active_tag(), None);
        assert!(matches!(progress_rx.try_recv(), Err(tokio::sync::mpsc::error::TryRecvError::Empty)));
        drop(stream);

        // Pulling again starts a fresh request (Ollama resumes from its kept layers).
        let again = tokio::spawn({
            let puller = puller.clone();
            async move { puller.pull("qwen3:8b", None).await }
        });
        let (second_body, mut second_stream) = rx.recv().await.expect("the second pull request arrives");
        assert_eq!(second_body, serde_json::json!({ "model": "qwen3:8b", "stream": true }));
        write_head_streaming(&mut second_stream, 200, "application/x-ndjson").await;
        let _ = second_stream.write_all(format!("{}\n", serde_json::json!({ "status": "success" })).as_bytes()).await;
        let _ = second_stream.shutdown().await;
        assert!(again.await.expect("the second pull completes").done);
        fake.close().await;
    }

    #[tokio::test]
    async fn rejects_a_different_tag_with_a_busy_frame_and_attaches_the_same_tag() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = start_raw_fake_ollama(move |_request, stream| {
            let tx = tx.clone();
            async move {
                let _ = tx.send(stream);
            }
        })
        .await;
        let puller = Arc::new(OllamaPuller::with_interval(immediate_base_url(fake.url.clone()), Duration::ZERO, no_sink()));
        let puller2 = puller.clone();
        let first = tokio::spawn(async move { puller2.pull("qwen3:4b", None).await });
        let mut stream = rx.recv().await.expect("the pull request arrives");

        let busy = puller.pull("qwen3:14b", None).await;
        assert_eq!(busy.tag, "qwen3:14b");
        assert_eq!(busy.status, "busy");
        assert!(busy.error.as_deref().is_some_and(|e| e.contains("qwen3:4b")));

        let puller3 = puller.clone();
        let joined = tokio::spawn(async move { puller3.pull("qwen3:4b", None).await });
        tokio::time::sleep(Duration::from_millis(10)).await;
        write_head_streaming(&mut stream, 200, "application/x-ndjson").await;
        let _ = stream.write_all(format!("{}\n", serde_json::json!({ "status": "success" })).as_bytes()).await;
        let _ = stream.shutdown().await;
        let a = first.await.expect("the first pull completes");
        let b = joined.await.expect("the joined pull completes");
        assert_eq!(a, b);
        assert!(a.done);
        fake.close().await;
    }

    #[tokio::test]
    async fn resolves_an_error_line_as_a_final_error_frame() {
        let fake = start_raw_fake_ollama(|_request, mut stream| async move {
            write_head_streaming(&mut stream, 200, "application/x-ndjson").await;
            let _ = stream.write_all(format!("{}\n", serde_json::json!({ "status": "pulling manifest" })).as_bytes()).await;
            let _ = stream
                .write_all(format!("{}\n", serde_json::json!({ "error": "pull model manifest: file does not exist" })).as_bytes())
                .await;
            // Leave the stream open: the error alone must end the pull.
            tokio::time::sleep(Duration::from_millis(200)).await;
        })
        .await;
        let final_frame = OllamaPuller::with_interval(immediate_base_url(fake.url.clone()), Duration::ZERO, no_sink()).pull("nope:1b", None).await;
        assert!(!final_frame.done);
        assert_eq!(final_frame.error.as_deref(), Some("pull model manifest: file does not exist"));
        fake.close().await;
    }

    #[tokio::test]
    async fn resolves_an_http_error_status_with_ollama_s_message() {
        let fake = start_fake_ollama(|_req, _body| send_json(serde_json::json!({ "error": "model is required" }), 400)).await;
        let final_frame = OllamaPuller::new(immediate_base_url(fake.url.clone()), no_sink()).pull("qwen3:4b", None).await;
        assert_eq!(final_frame.error.as_deref(), Some("model is required"));
        fake.close().await;
    }

    #[tokio::test]
    async fn resolves_a_refused_connection_as_an_error_frame() {
        let url = closed_port_url().await;
        let final_frame = OllamaPuller::new(immediate_base_url(url), no_sink()).pull("qwen3:4b", None).await;
        assert!(!final_frame.done);
        assert!(final_frame.error.is_some());
    }

    #[tokio::test]
    async fn reports_a_stream_that_ends_without_success() {
        let fake = start_raw_fake_ollama(|_request, mut stream| async move {
            write_head_streaming(&mut stream, 200, "application/x-ndjson").await;
            let line = serde_json::json!({ "status": "pulling a", "digest": "a", "total": 10, "completed": 5 });
            let _ = stream.write_all(format!("{line}\n").as_bytes()).await;
            let _ = stream.shutdown().await;
        })
        .await;
        let final_frame = OllamaPuller::new(immediate_base_url(fake.url.clone()), no_sink()).pull("qwen3:4b", None).await;
        assert_eq!(final_frame.percent, 50);
        assert!(!final_frame.done);
        assert!(final_frame.error.is_some());
        fake.close().await;
    }

    #[tokio::test]
    async fn refuses_an_invalid_tag_without_a_request() {
        let final_frame = OllamaPuller::new(immediate_base_url("http://127.0.0.1:1".to_string()), no_sink()).pull("; rm -rf /", None).await;
        assert!(final_frame.error.is_some());
    }

    #[test]
    fn accepts_ollama_references_and_rejects_anything_else() {
        for tag in ["qwen3:4b", "gpt-oss:20b", "library/qwen3:latest", "hf.co/org/model:Q4_K_M"] {
            assert!(is_valid_model_tag(tag), "{tag} should be valid");
        }
        for tag in ["", " qwen3", "-x", "a b", "x;y", &"a".repeat(201)] {
            assert!(!is_valid_model_tag(tag), "{tag} should be invalid");
        }
    }
}
