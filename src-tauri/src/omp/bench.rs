//! The benchmark runner, ported from `src/main/benchmark-runner.ts`: one
//! `omp bench <models> --profile <p> --json` per window, with an 8 MiB output
//! cap, a 15 minute timeout and the summary schema the GUI's results table reads.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::watch;

use crate::bridge::spawn_task;

const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const BENCHMARK_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// How long a terminated benchmark gets to exit on SIGTERM before SIGKILL.
const TERMINATE_GRACE: Duration = Duration::from_secs(2);
const PROFILES: &[&str] = &["mix", "chat", "prefill", "generation"];

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `IpcBenchmarkRunOptions`. Numbers arrive as JSON numbers and are range-checked like the TS.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IpcBenchmarkRunOptions {
    pub(crate) models: Vec<String>,
    pub(crate) profile: String,
    pub(crate) runs: f64,
    pub(crate) parallel: f64,
    #[serde(default)]
    pub(crate) max_tokens: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IpcBenchmarkMetricStats {
    pub(crate) mean: f64,
    pub(crate) min: f64,
    pub(crate) p50: f64,
    pub(crate) p95: f64,
    pub(crate) max: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IpcBenchmarkStats {
    pub(crate) ttft_ms: IpcBenchmarkMetricStats,
    pub(crate) duration_ms: IpcBenchmarkMetricStats,
    pub(crate) tokens_per_second: IpcBenchmarkMetricStats,
    pub(crate) generation_tps: IpcBenchmarkMetricStats,
    pub(crate) prefill_tps: IpcBenchmarkMetricStats,
    pub(crate) input_tokens: f64,
    pub(crate) output_tokens: f64,
    pub(crate) cost: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IpcBenchmarkRunOutcome {
    pub(crate) ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IpcBenchmarkModelReport {
    pub(crate) selector: String,
    pub(crate) model: String,
    pub(crate) stats: Option<IpcBenchmarkStats>,
    #[serde(default)]
    pub(crate) by_challenge: BTreeMap<String, IpcBenchmarkStats>,
    pub(crate) results: Vec<IpcBenchmarkRunOutcome>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum IpcBenchmarkProfile {
    Mix,
    Chat,
    Prefill,
    Generation,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IpcBenchmarkSummary {
    pub(crate) runs: u64,
    pub(crate) failures: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) profile: Option<IpcBenchmarkProfile>,
    pub(crate) models: Vec<IpcBenchmarkModelReport>,
}

/// `IpcBenchmarkRunResult`: the discriminated union the renderer reads.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum IpcBenchmarkRunResult {
    Success { summary: IpcBenchmarkSummary, exit_code: Option<i32>, stderr: Option<String> },
    Failure { error: String, stderr: Option<String> },
}

impl IpcBenchmarkRunResult {
    fn failure(error: impl Into<String>, stderr: Option<String>) -> Self {
        Self::Failure { error: error.into(), stderr }
    }

    pub(crate) fn to_value(&self) -> Value {
        match self {
            Self::Success { summary, exit_code, stderr } => {
                let mut value = json!({ "success": true, "summary": summary, "exitCode": exit_code });
                if let Some(stderr) = stderr {
                    value["stderr"] = Value::String(stderr.clone());
                }
                value
            }
            Self::Failure { error, stderr } => {
                let mut value = json!({ "success": false, "error": error });
                if let Some(stderr) = stderr {
                    value["stderr"] = Value::String(stderr.clone());
                }
                value
            }
        }
    }
}

fn bounded_integer(name: &str, value: f64, min: i64, max: i64) -> Result<i64, String> {
    if !value.is_finite() || value.fract() != 0.0 || value < min as f64 || value > max as f64 {
        return Err(format!("{name} must be between {min} and {max}"));
    }
    Ok(value as i64)
}

/// The argv for `omp bench`, validated and bounded like the TS source.
pub(crate) fn benchmark_args(options: &IpcBenchmarkRunOptions) -> Result<Vec<String>, String> {
    if options.models.is_empty() || options.models.len() > 8 {
        return Err("Select between 1 and 8 models".to_string());
    }
    if !PROFILES.contains(&options.profile.as_str()) {
        return Err("Invalid benchmark profile".to_string());
    }
    let mut models: Vec<String> = Vec::new();
    for model in &options.models {
        let value = model.trim();
        if value.is_empty() || value.len() > 200 || value.starts_with('-') {
            return Err("Invalid model selector".to_string());
        }
        if !models.iter().any(|seen| seen == value) {
            models.push(value.to_string());
        }
    }
    let mut args = vec!["bench".to_string()];
    args.extend(models);
    args.extend([
        "--profile".to_string(),
        options.profile.clone(),
        "--runs".to_string(),
        bounded_integer("runs", options.runs, 1, 20)?.to_string(),
        "--par".to_string(),
        bounded_integer("parallel", options.parallel, 1, 8)?.to_string(),
        "--json".to_string(),
    ]);
    if let Some(max_tokens) = options.max_tokens {
        args.extend(["--max-tokens".to_string(), bounded_integer("maxTokens", max_tokens, 1, 8192)?.to_string()]);
    }
    Ok(args)
}

/// The summary `omp bench --json` printed; a syntax error keeps the parser's
/// message, a shape the GUI cannot render is "malformed JSON".
pub(crate) fn parse_benchmark_summary(stdout: &str) -> Result<IpcBenchmarkSummary, String> {
    let value: Value = serde_json::from_str(stdout).map_err(|error| error.to_string())?;
    let summary: IpcBenchmarkSummary = serde_json::from_value(value).map_err(|_| "Benchmark returned malformed JSON".to_string())?;
    if summary.runs == 0 {
        return Err("Benchmark returned malformed JSON".to_string());
    }
    Ok(summary)
}

/// Why a run is being stopped, set once by whichever limit fires first.
#[derive(Default)]
struct Termination {
    reason: Option<String>,
    sender: Option<watch::Sender<bool>>,
}

/// One window's benchmark slot: at most one `omp bench` at a time.
#[derive(Default)]
pub(crate) struct BenchRunner {
    running: Arc<Mutex<Option<Arc<Mutex<Termination>>>>>,
}

impl BenchRunner {
    pub(crate) fn running(&self) -> bool {
        lock(&self.running).is_some()
    }

    pub(crate) fn abort(&self) -> bool {
        self.terminate("Benchmark cancelled")
    }

    fn terminate(&self, reason: &str) -> bool {
        let Some(termination) = lock(&self.running).clone() else { return false };
        Self::terminate_run(&termination, reason);
        true
    }

    fn terminate_run(termination: &Mutex<Termination>, reason: &str) {
        let mut termination = lock(termination);
        termination.reason = Some(reason.to_string());
        if let Some(sender) = &termination.sender {
            let _ = sender.send(true);
        }
    }

    /// Run `binary bench …` in `cwd` with `env` overlaid on the process
    /// environment. The slot is taken before this returns; the spawn and the
    /// wait happen in the returned future.
    pub(crate) fn run(&self, binary: PathBuf, cwd: String, options: IpcBenchmarkRunOptions, env: Vec<(String, String)>) -> BoxFuture<'static, IpcBenchmarkRunResult> {
        let (terminate_tx, terminate_rx) = watch::channel(false);
        let termination = {
            let mut slot = lock(&self.running);
            if slot.is_some() {
                return Box::pin(std::future::ready(IpcBenchmarkRunResult::failure("A benchmark is already running", None)));
            }
            let args = match benchmark_args(&options) {
                Ok(args) => args,
                Err(error) => return Box::pin(std::future::ready(IpcBenchmarkRunResult::failure(error, None))),
            };
            let termination = Arc::new(Mutex::new(Termination { reason: None, sender: Some(terminate_tx) }));
            *slot = Some(termination.clone());
            (termination, args)
        };
        let (termination, args) = termination;
        let slot = self.running.clone();
        Box::pin(async move {
            let result = run_child(&binary, &cwd, &args, &env, termination.clone(), terminate_rx).await;
            let mut slot = lock(&slot);
            if slot.as_ref().map(|current| Arc::ptr_eq(current, &termination)).unwrap_or(false) {
                *slot = None;
            }
            result
        })
    }
}

#[derive(Default)]
struct Output {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    bytes: usize,
}

fn stderr_text(output: &Output) -> Option<String> {
    let text = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

async fn run_child(binary: &Path, cwd: &str, args: &[String], env: &[(String, String)], termination: Arc<Mutex<Termination>>, mut terminate_rx: watch::Receiver<bool>) -> IpcBenchmarkRunResult {
    let mut command = Command::new(binary);
    command.args(args).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    command.env_remove("APPIMAGE_EXIT_AFTER_INSTALL");
    for (key, value) in env {
        command.env(key, value);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return IpcBenchmarkRunResult::failure(error.to_string(), None),
    };
    let output: Arc<Mutex<Output>> = Arc::default();
    let (done_tx, mut done_rx) = tokio::sync::mpsc::channel::<()>(2);
    for (stream, is_stdout) in [(child.stdout.take().map(Stream::Out), true), (child.stderr.take().map(Stream::Err), false)] {
        let Some(stream) = stream else { continue };
        let output = output.clone();
        let termination = termination.clone();
        let done = done_tx.clone();
        spawn_task(async move {
            let mut stream = stream;
            let mut buffer = vec![0u8; 16 * 1024];
            loop {
                let read = match stream.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => read,
                };
                let over_limit = {
                    let mut output = lock(&output);
                    output.bytes += read;
                    if output.bytes > MAX_OUTPUT_BYTES {
                        true
                    } else {
                        if is_stdout {
                            output.stdout.extend_from_slice(&buffer[..read]);
                        } else {
                            output.stderr.extend_from_slice(&buffer[..read]);
                        }
                        false
                    }
                };
                if over_limit {
                    BenchRunner::terminate_run(&termination, "Benchmark output exceeded 8 MiB");
                }
            }
            let _ = done.send(()).await;
        });
    }
    drop(done_tx);
    let pid = child.id();
    let status = tokio::select! {
        status = child.wait() => status,
        _ = tokio::time::sleep(BENCHMARK_TIMEOUT) => {
            BenchRunner::terminate_run(&termination, "Benchmark timed out after 15 minutes");
            stop_child(&mut child, pid).await
        }
        _ = async { let _ = terminate_rx.wait_for(|requested| *requested).await; } => stop_child(&mut child, pid).await,
    };
    // Both readers finish once the pipes close.
    while done_rx.recv().await.is_some() {}
    let (stdout, stderr) = {
        let output = lock(&output);
        (String::from_utf8_lossy(&output.stdout).into_owned(), stderr_text(&output))
    };
    let reason = lock(&termination).reason.clone();
    if let Some(reason) = reason {
        return IpcBenchmarkRunResult::failure(reason, stderr);
    }
    let exit_code = match status {
        Ok(status) => status.code(),
        Err(error) => return IpcBenchmarkRunResult::failure(error.to_string(), stderr),
    };
    match parse_benchmark_summary(&stdout) {
        Ok(summary) => IpcBenchmarkRunResult::Success { summary, exit_code, stderr },
        Err(error) => IpcBenchmarkRunResult::failure(error, stderr),
    }
}

enum Stream {
    Out(tokio::process::ChildStdout),
    Err(tokio::process::ChildStderr),
}

impl Stream {
    async fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Stream::Out(stream) => stream.read(buffer).await,
            Stream::Err(stream) => stream.read(buffer).await,
        }
    }
}

/// SIGTERM, a short grace, then SIGKILL.
async fn stop_child(child: &mut tokio::process::Child, pid: Option<u32>) -> std::io::Result<std::process::ExitStatus> {
    #[cfg(unix)]
    if let Some(pid) = pid {
        let _ = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), nix::sys::signal::Signal::SIGTERM);
    }
    #[cfg(not(unix))]
    let _ = pid;
    match tokio::time::timeout(TERMINATE_GRACE, child.wait()).await {
        Ok(status) => status,
        Err(_) => {
            let _ = child.start_kill();
            child.wait().await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(models: &[&str], profile: &str, runs: f64, parallel: f64) -> IpcBenchmarkRunOptions {
        IpcBenchmarkRunOptions { models: models.iter().map(|model| model.to_string()).collect(), profile: profile.to_string(), runs, parallel, max_tokens: None }
    }

    #[test]
    fn builds_a_bounded_argv_only_bench_invocation() {
        assert_eq!(
            benchmark_args(&options(&["anthropic/opus", "openai/gpt-5.6"], "mix", 3.0, 2.0)).unwrap(),
            vec!["bench", "anthropic/opus", "openai/gpt-5.6", "--profile", "mix", "--runs", "3", "--par", "2", "--json"]
        );
        assert_eq!(benchmark_args(&options(&["--help"], "chat", 1.0, 1.0)), Err("Invalid model selector".to_string()));
        assert_eq!(benchmark_args(&options(&[], "chat", 1.0, 1.0)), Err("Select between 1 and 8 models".to_string()));
        assert_eq!(benchmark_args(&options(&["m"], "fast", 1.0, 1.0)), Err("Invalid benchmark profile".to_string()));
        assert_eq!(benchmark_args(&options(&["m"], "chat", 21.0, 1.0)), Err("runs must be between 1 and 20".to_string()));
        assert_eq!(benchmark_args(&options(&["m"], "chat", 1.5, 1.0)), Err("runs must be between 1 and 20".to_string()));
        let mut with_tokens = options(&["m", "m"], "chat", 1.0, 1.0);
        with_tokens.max_tokens = Some(512.0);
        assert_eq!(benchmark_args(&with_tokens).unwrap(), vec!["bench", "m", "--profile", "chat", "--runs", "1", "--par", "1", "--json", "--max-tokens", "512"]);
    }

    #[test]
    fn accepts_the_summary_shape_consumed_by_the_gui() {
        let summary = parse_benchmark_summary(r#"{"runs":1,"models":[],"failures":0}"#).unwrap();
        assert_eq!(summary, IpcBenchmarkSummary { runs: 1, failures: 0, profile: None, models: Vec::new() });
        assert_eq!(serde_json::to_value(&summary).unwrap(), json!({ "runs": 1, "models": [], "failures": 0 }));
        let full = parse_benchmark_summary(
            r#"{"runs":2,"failures":1,"profile":"chat","models":[{"selector":"a","model":"a-1","stats":null,"results":[{"ok":true},{"ok":false,"error":"boom"}]}]}"#,
        )
        .unwrap();
        assert_eq!(full.models[0].results[1].error.as_deref(), Some("boom"));
        assert_eq!(full.profile, Some(IpcBenchmarkProfile::Chat));
        assert!(full.models[0].by_challenge.is_empty());
    }

    #[test]
    fn rejects_malformed_nested_reports_before_the_results_table_can_crash() {
        let nested = json!({ "runs": 1, "models": [{ "model": "one", "results": null }], "failures": 0 }).to_string();
        assert_eq!(parse_benchmark_summary(&nested), Err("Benchmark returned malformed JSON".to_string()));
        assert_eq!(parse_benchmark_summary("null"), Err("Benchmark returned malformed JSON".to_string()));
        assert_eq!(parse_benchmark_summary(r#"{"runs":0,"models":[],"failures":0}"#), Err("Benchmark returned malformed JSON".to_string()));
        assert!(parse_benchmark_summary("not json").unwrap_err().contains("expected"));
    }

    #[test]
    fn results_serialize_like_the_typescript_union() {
        let failure = IpcBenchmarkRunResult::failure("A benchmark is already running", None).to_value();
        assert_eq!(failure, json!({ "success": false, "error": "A benchmark is already running" }));
        let summary = IpcBenchmarkSummary { runs: 1, failures: 0, profile: None, models: Vec::new() };
        let success = IpcBenchmarkRunResult::Success { summary, exit_code: Some(0), stderr: Some("warn".into()) }.to_value();
        assert_eq!(success, json!({ "success": true, "summary": { "runs": 1, "failures": 0, "models": [] }, "exitCode": 0, "stderr": "warn" }));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn abort_stops_a_running_benchmark_and_frees_the_slot() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake-bench.sh");
        std::fs::write(&script, "#!/bin/sh\nexec /usr/bin/sleep 600\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let runner = BenchRunner::default();
        assert!(!runner.abort());
        let run = runner.run(script, dir.path().to_string_lossy().into_owned(), options(&["m"], "chat", 1.0, 1.0), Vec::new());
        assert!(runner.running());
        let second = runner.run(PathBuf::from("/bin/true"), ".".into(), options(&["m"], "chat", 1.0, 1.0), Vec::new()).await;
        assert_eq!(second, IpcBenchmarkRunResult::failure("A benchmark is already running", None));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(runner.abort());
        let result = tokio::time::timeout(Duration::from_secs(5), run).await.unwrap();
        assert_eq!(result, IpcBenchmarkRunResult::failure("Benchmark cancelled", None));
        assert!(!runner.running());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_finished_benchmark_reports_its_summary_exit_code_and_stderr() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake-bench.sh");
        std::fs::write(&script, "#!/bin/sh\necho 'warming up' >&2\nprintf '%s' '{\"runs\":1,\"models\":[],\"failures\":0}'\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let runner = BenchRunner::default();
        let result = runner.run(script, dir.path().to_string_lossy().into_owned(), options(&["m"], "chat", 1.0, 1.0), vec![("PI_TEST".into(), "1".into())]).await;
        let summary = IpcBenchmarkSummary { runs: 1, failures: 0, profile: None, models: Vec::new() };
        assert_eq!(result, IpcBenchmarkRunResult::Success { summary, exit_code: Some(0), stderr: Some("warming up".into()) });
    }
}
