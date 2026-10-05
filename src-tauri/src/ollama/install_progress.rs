//! Progress for the Linux Ollama installer, read from its stderr. `install.sh`
//! prints each stage as `>>> …` and downloads with `curl --progress-bar`, which
//! redraws its bar in place with `\r` frames such as `######   45.2%`.
//! Everything else (apt/dnf output, curl's `#=#=#` frames) is ignored.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::bridge;

/// Install frames go out at most once per interval (10 Hz); the final frame goes out at once.
pub const INSTALL_PROGRESS_INTERVAL_MS: u64 = 100;

const PARTIAL_MAX: usize = 512;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaInstallProgress {
    /// Latest `>>> …` stage text from the installer, without the `>>> ` prefix; `None` before the first one.
    pub stage: Option<String>,
    /// 0-100 for the current download; -1 while no percentage is known (polkit dialog, non-download stage).
    pub percent: i32,
    /// True on the final frame, sent just before the remedy result resolves.
    pub done: bool,
}

pub fn initial_install_progress() -> OllamaInstallProgress {
    OllamaInstallProgress { stage: None, percent: -1, done: false }
}

/// Folds `>>> stage` lines and curl's redrawn percent into frames.
pub struct InstallProgressParser {
    stage: Option<String>,
    percent: i32,
    partial: String,
}

/// Longest unterminated segment matching an ANSI CSI sequence, stripped before matching stage/percent.
fn strip_ansi(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b && bytes.get(i + 1) == Some(&b'[') {
            let mut j = i + 2;
            while j < bytes.len() && matches!(bytes[j], b'0'..=b'9' | b';' | b'?' | b' '..=b'/') {
                j += 1;
            }
            if j < bytes.len() && matches!(bytes[j], b'@'..=b'~') {
                i = j + 1;
                continue;
            }
        }
        // Safe: we only skip over single-byte ASCII escape runs above; everything else copies verbatim.
        out.push(input[i..].chars().next().unwrap_or_default());
        i += input[i..].chars().next().map_or(1, char::len_utf8);
    }
    out
}

/// A trailing `\d{1,3}(\.\d)?%` with no following characters (the string is already
/// trimmed). Like the regex, this does not require a non-digit boundary before the
/// match: given more than three leading digits, only the last three are read.
fn parse_trailing_percent(segment: &str) -> Option<f64> {
    let without_percent = segment.strip_suffix('%')?;
    let bytes = without_percent.as_bytes();
    let len = bytes.len();
    // Optional one decimal digit after a dot, right before the end.
    let int_end = if len >= 2 && bytes[len - 2] == b'.' && bytes[len - 1].is_ascii_digit() { len - 2 } else { len };
    let mut start = int_end;
    let mut count = 0;
    while start > 0 && bytes[start - 1].is_ascii_digit() && count < 3 {
        start -= 1;
        count += 1;
    }
    if count == 0 {
        return None;
    }
    without_percent[start..].parse::<f64>().ok()
}

impl InstallProgressParser {
    pub fn new() -> Self {
        Self { stage: None, percent: -1, partial: String::new() }
    }

    /// Apply one segment; true when it changed the frame. A segment still being
    /// written may only set the percent.
    fn read(&mut self, raw: &str, complete: bool) -> bool {
        let segment = strip_ansi(raw).trim().to_string();
        if complete {
            if let Some(stage_text) = segment.strip_prefix(">>> ").map(str::trim).filter(|s| !s.is_empty()) {
                let changed = Some(stage_text) != self.stage.as_deref() || self.percent != -1;
                self.stage = Some(stage_text.to_string());
                self.percent = -1;
                return changed;
            }
        }
        let Some(value) = parse_trailing_percent(&segment) else { return false };
        let next = (value.clamp(0.0, 100.0)).floor() as i32;
        if next == self.percent {
            return false;
        }
        self.percent = next;
        true
    }

    fn frame(&self, done: bool) -> OllamaInstallProgress {
        OllamaInstallProgress { stage: self.stage.clone(), percent: self.percent, done }
    }

    /// Feed raw output; returns a frame when the stage or the whole percent changed, else `None`.
    pub fn push(&mut self, chunk: &str) -> Option<OllamaInstallProgress> {
        let combined = format!("{}{chunk}", self.partial);
        let mut segments: Vec<&str> = combined.split(['\r', '\n']).collect();
        let last = segments.pop().unwrap_or("");
        self.partial = take_last_chars(last, PARTIAL_MAX);
        let mut changed = false;
        for segment in segments {
            if self.read(segment, true) {
                changed = true;
            }
        }
        // curl starts each bar frame with `\r`, so the newest one stays unterminated until the next
        // redraw. A trailing `%` means its number is whole, so read it now rather than a frame late.
        let partial = self.partial.clone();
        if self.read(&partial, false) {
            changed = true;
        }
        if changed { Some(self.frame(false)) } else { None }
    }

    /// The closing frame (`done: true`), after reading any unterminated last segment.
    pub fn r#final(&mut self) -> OllamaInstallProgress {
        if !self.partial.is_empty() {
            let partial = self.partial.clone();
            self.read(&partial, true);
        }
        self.partial.clear();
        self.frame(true)
    }
}

impl Default for InstallProgressParser {
    fn default() -> Self {
        Self::new()
    }
}

fn take_last_chars(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        return s.to_string();
    }
    s.chars().skip(count - max).collect()
}

struct ThrottleState<T> {
    last_sent_at: Option<Instant>,
    pending: Option<T>,
    generation: u64,
    timer_scheduled: bool,
}

/// Throttles `send` to one frame per `interval`, the latest frame winning. A
/// terminal frame (per `is_terminal`) drops any pending one and goes out immediately.
pub(crate) struct Throttle<T: Clone + Send + 'static> {
    send: Arc<dyn Fn(T) + Send + Sync>,
    is_terminal: Arc<dyn Fn(&T) -> bool + Send + Sync>,
    interval: Duration,
    state: Arc<Mutex<ThrottleState<T>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl<T: Clone + Send + 'static> Throttle<T> {
    pub(crate) fn new(
        interval: Duration,
        is_terminal: impl Fn(&T) -> bool + Send + Sync + 'static,
        send: impl Fn(T) + Send + Sync + 'static,
    ) -> Self {
        Self {
            send: Arc::new(send),
            is_terminal: Arc::new(is_terminal),
            interval,
            state: Arc::new(Mutex::new(ThrottleState { last_sent_at: None, pending: None, generation: 0, timer_scheduled: false })),
        }
    }

    pub(crate) fn push(&self, frame: T) {
        let mut state = lock(&self.state);
        if (self.is_terminal)(&frame) {
            state.generation += 1;
            state.pending = None;
            state.timer_scheduled = false;
            state.last_sent_at = Some(Instant::now());
            drop(state);
            (self.send)(frame);
            return;
        }
        let now = Instant::now();
        let wait = state.last_sent_at.map_or(Duration::ZERO, |sent| (sent + self.interval).saturating_duration_since(now));
        if wait.is_zero() && !state.timer_scheduled {
            state.last_sent_at = Some(now);
            drop(state);
            (self.send)(frame);
            return;
        }
        state.pending = Some(frame);
        if !state.timer_scheduled {
            state.timer_scheduled = true;
            let generation = state.generation;
            let state_arc = self.state.clone();
            let send_arc = self.send.clone();
            drop(state);
            bridge::spawn_task(async move {
                tokio::time::sleep(wait).await;
                let next = {
                    let mut state = lock(&state_arc);
                    if state.generation != generation {
                        None
                    } else {
                        state.timer_scheduled = false;
                        let next = state.pending.take();
                        if next.is_some() {
                            state.last_sent_at = Some(Instant::now());
                        }
                        next
                    }
                };
                if let Some(next) = next {
                    (send_arc)(next);
                }
            });
        }
    }
}

/// Throttle for Linux installer progress (`done` is terminal).
pub(crate) struct InstallProgressThrottle {
    inner: Throttle<OllamaInstallProgress>,
}

impl InstallProgressThrottle {
    pub(crate) fn new(send: impl Fn(OllamaInstallProgress) + Send + Sync + 'static) -> Self {
        Self::with_interval(Duration::from_millis(INSTALL_PROGRESS_INTERVAL_MS), send)
    }

    pub(crate) fn with_interval(interval: Duration, send: impl Fn(OllamaInstallProgress) + Send + Sync + 'static) -> Self {
        Self { inner: Throttle::new(interval, |frame: &OllamaInstallProgress| frame.done, send) }
    }

    pub(crate) fn push(&self, frame: OllamaInstallProgress) {
        self.inner.push(frame);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(stage: Option<&str>, percent: i32, done: bool) -> OllamaInstallProgress {
        OllamaInstallProgress { stage: stage.map(str::to_string), percent, done }
    }

    struct Fed {
        frames: Vec<OllamaInstallProgress>,
        last: OllamaInstallProgress,
    }

    fn feed(chunks: &[&str]) -> Fed {
        let mut parser = InstallProgressParser::new();
        let mut frames = Vec::new();
        for chunk in chunks {
            if let Some(next) = parser.push(chunk) {
                frames.push(next);
            }
        }
        Fed { frames, last: parser.r#final() }
    }

    #[test]
    fn starts_indeterminate_with_no_stage() {
        assert_eq!(initial_install_progress(), frame(None, -1, false));
        assert_eq!(InstallProgressParser::new().r#final(), frame(None, -1, true));
    }

    #[test]
    fn reads_s_cases() {
        let cases: Vec<(&[&str], Vec<OllamaInstallProgress>)> = vec![
            (&[">>> Installing ollama to /usr/local\n"], vec![frame(Some("Installing ollama to /usr/local"), -1, false)]),
            (
                &[">>> Install", "ing ollama to /usr", "/local\n"],
                vec![frame(Some("Installing ollama to /usr/local"), -1, false)],
            ),
            (&[">>> Installing ollama\r\n"], vec![frame(Some("Installing ollama"), -1, false)]),
            (
                &[">>> Downloading x\n", "\r#=#=#   ", "\r##     10.0%", "\r######    45.2%", "\r##########100.0%\n"],
                vec![
                    frame(Some("Downloading x"), -1, false),
                    frame(Some("Downloading x"), 10, false),
                    frame(Some("Downloading x"), 45, false),
                    frame(Some("Downloading x"), 100, false),
                ],
            ),
            (
                &[">>> Downloading x\n", "\r####  5", "5.3%"],
                vec![frame(Some("Downloading x"), -1, false), frame(Some("Downloading x"), 55, false)],
            ),
            (
                &[">>> Downloading a\n", "\r#### 80.0%", "\r######## 100.0%\n", ">>> Downloading b\n", "\r## 20.0%"],
                vec![
                    frame(Some("Downloading a"), -1, false),
                    frame(Some("Downloading a"), 80, false),
                    frame(Some("Downloading a"), 100, false),
                    frame(Some("Downloading b"), -1, false),
                    frame(Some("Downloading b"), 20, false),
                ],
            ),
            (&["Reading package lists...\n", "\n", "\r#=#=#\r##O#-#\r", "Get:1 http://archive jammy InRelease\n"], vec![]),
            (
                &["\x1b[1m>>> \x1b[0mInstalling ollama\x1b[0m\n", "\r\x1b[32m####  33.3%\x1b[0m"],
                vec![frame(Some("Installing ollama"), -1, false), frame(Some("Installing ollama"), 33, false)],
            ),
        ];
        for (chunks, expected) in cases {
            assert_eq!(feed(chunks).frames, expected, "chunks: {chunks:?}");
        }
    }

    #[test]
    fn reports_a_frame_only_when_the_stage_or_the_whole_percent_changes() {
        let fed = feed(&[">>> Downloading x\n", "\r## 10.1%", "\r## 10.9%", "\r### 11.0%\n", ">>> Downloading x\n"]);
        assert_eq!(
            fed.frames,
            vec![
                frame(Some("Downloading x"), -1, false),
                frame(Some("Downloading x"), 10, false),
                frame(Some("Downloading x"), 11, false),
                frame(Some("Downloading x"), -1, false),
            ]
        );
    }

    #[test]
    fn clamps_the_percent_to_0_100() {
        assert_eq!(feed(&[">>> x\n", "\r## 250%"]).frames.last(), Some(&frame(Some("x"), 100, false)));
    }

    #[test]
    fn ends_on_the_last_state_reading_an_unterminated_final_stage() {
        assert_eq!(feed(&[">>> Downloading x\n", "\r## 40.0%"]).last, frame(Some("Downloading x"), 40, true));
        assert_eq!(feed(&[">>> Enabling service"]).last, frame(Some("Enabling service"), -1, true));
    }

    #[test]
    fn bounds_an_unterminated_segment_and_still_reads_its_percent() {
        let bar = "#".repeat(100_000);
        assert_eq!(feed(&[">>> x\n", &format!("\r{bar} 30.0%")]).frames.last(), Some(&frame(Some("x"), 30, false)));
    }

    #[tokio::test(start_paused = true)]
    async fn sends_at_most_one_frame_per_interval_the_latest_winning() {
        let sent = Arc::new(Mutex::new(Vec::<OllamaInstallProgress>::new()));
        let sent2 = sent.clone();
        let throttle = InstallProgressThrottle::with_interval(Duration::from_millis(100), move |f| lock(&sent2).push(f));
        throttle.push(frame(None, -1, false));
        throttle.push(frame(Some("a"), 1, false));
        throttle.push(frame(Some("a"), 2, false));
        assert_eq!(*lock(&sent), vec![frame(None, -1, false)]);
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(100)).await;
        tokio::task::yield_now().await;
        assert_eq!(*lock(&sent), vec![frame(None, -1, false), frame(Some("a"), 2, false)]);
        tokio::time::advance(Duration::from_millis(500)).await;
        tokio::task::yield_now().await;
        assert_eq!(lock(&sent).len(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn flushes_the_done_frame_at_once_and_drops_the_pending_one() {
        let sent = Arc::new(Mutex::new(Vec::<OllamaInstallProgress>::new()));
        let sent2 = sent.clone();
        let throttle = InstallProgressThrottle::with_interval(Duration::from_millis(100), move |f| lock(&sent2).push(f));
        throttle.push(frame(None, -1, false));
        throttle.push(frame(Some("a"), 50, false));
        throttle.push(frame(Some("a"), 50, true));
        assert_eq!(*lock(&sent), vec![frame(None, -1, false), frame(Some("a"), 50, true)]);
        tokio::time::advance(Duration::from_millis(500)).await;
        tokio::task::yield_now().await;
        assert_eq!(lock(&sent).len(), 2);
    }
}
