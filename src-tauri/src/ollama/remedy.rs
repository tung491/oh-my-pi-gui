//! The privileged fixes the onboarding screen may run, as a closed set owned by
//! main: the renderer names an `OllamaRemedyId` and can never supply a command.
//! Linux only, authorised through polkit (`pkexec`).

use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};
use tokio::sync::{Notify, OnceCell};

use super::install_progress::{InstallProgressParser, OllamaInstallProgress};
use super::probe::{OllamaRemedyId, OllamaState, OllamaStatus};
use crate::bridge;

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// The official installer. It downloads and runs remote code as root; that is
/// the user-chosen behaviour, it is shown verbatim before running, and polkit
/// asks for authorisation.
pub const INSTALL_LINE: &str = "curl -fsSL https://ollama.com/install.sh | sh";

/// Turns off Ollama's online features (`OLLAMA_NO_CLOUD=1`) for its systemd
/// service through a drop-in Sai ATLAS owns (`sai-atlas.conf`, written only
/// when missing or different; no other drop-in and never the unit itself),
/// then reloads systemd and (re)starts the service so the setting takes
/// effect. Each step runs only when the one before it succeeded. The renderer
/// shows the same text from `OLLAMA_REMEDY_COMMANDS` in `src/shared/ollama-types.ts`.
const NO_CLOUD_STEPS: &str = concat!(
    "mkdir -p /etc/systemd/system/ollama.service.d &&\n",
    "f=/etc/systemd/system/ollama.service.d/sai-atlas.conf &&\n",
    "s=$(printf '[Service]\\nEnvironment=\"OLLAMA_NO_CLOUD=1\"') &&\n",
    "{ [ \"$(cat \"$f\" 2>/dev/null)\" = \"$s\" ] || printf '%s\\n' \"$s\" > \"$f\"; } &&\n",
    "systemctl daemon-reload &&\n",
    "systemctl restart ollama.service",
);

/// The fixed root script of a remedy, exactly as the screen shows it.
fn remedy_script(id: OllamaRemedyId) -> String {
    match id {
        OllamaRemedyId::LinuxStart => NO_CLOUD_STEPS.to_string(),
        OllamaRemedyId::LinuxInstall => format!("{INSTALL_LINE} &&\n{NO_CLOUD_STEPS}"),
    }
}

#[derive(Clone, Debug)]
struct RemedyCommand {
    file: &'static str,
    args: Vec<String>,
    timeout: Duration,
}

/// The only commands a remedy can run: the fixed script, as one root shell
/// behind one polkit prompt. Timeouts include time spent in the polkit dialog.
fn remedy_command(id: OllamaRemedyId) -> RemedyCommand {
    let timeout = match id {
        OllamaRemedyId::LinuxStart => Duration::from_secs(120),
        OllamaRemedyId::LinuxInstall => Duration::from_secs(900),
    };
    RemedyCommand { file: "pkexec", args: vec!["sh".to_string(), "-c".to_string(), remedy_script(id)], timeout }
}

pub fn is_remedy_id(value: Option<&str>) -> bool {
    matches!(value, Some("linux-start") | Some("linux-install"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OllamaRemedyOutcome {
    Applied,
    Cancelled,
    Unavailable,
    Failed,
    /// This process cannot gain privileges (`no_new_privs`, inherited from
    /// Electron's relaunch helper): the user must quit and reopen the app.
    ReopenRequired,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaRemedyResult {
    pub outcome: OllamaRemedyOutcome,
    pub status: OllamaStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fault: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
struct Attempt {
    outcome: OllamaRemedyOutcome,
    fault: Option<String>,
}

const STDERR_TAIL: usize = 500;
/// Enough stderr kept for the tail after trimming curl's trailing bar redraws.
const STDERR_KEEP: usize = 16 * STDERR_TAIL;

fn no_auth_agent(stderr: &str) -> bool {
    stderr.to_lowercase().contains("no authentication agent")
}

/// pkexec's words when it cannot gain privileges under `no_new_privs`.
fn pkexec_not_setuid(stderr: &str) -> bool {
    stderr.contains("must be setuid root")
}

/// The attempt when pkexec cannot work in this process at all.
fn reopen_required() -> Attempt {
    Attempt {
        outcome: OllamaRemedyOutcome::ReopenRequired,
        fault: Some("this process runs with no_new_privs, so pkexec cannot ask for administrator access until the app is reopened".to_string()),
    }
}

/// Each `\r` redraw replaces the line it is on, as a terminal would show it.
fn tail(text: &str) -> String {
    let joined: String = text.split('\n').map(|line| match line.rfind('\r') { Some(pos) => &line[pos + 1..], None => line }).collect::<Vec<_>>().join("\n");
    let trimmed = joined.trim();
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() > STDERR_TAIL {
        chars[chars.len() - STDERR_TAIL..].iter().collect()
    } else {
        trimmed.to_string()
    }
}

enum ExitOutcome {
    /// The command could not be started at all (e.g. `pkexec` missing).
    SpawnFailed(String),
    Exited { code: Option<i32>, killed_by_us: bool },
}

/// pkexec's contract: 126 = dialog dismissed / not authorised, 127 = could not authenticate (or no agent).
fn classify_exit(outcome: &ExitOutcome, stderr: &str, file: &str) -> Attempt {
    match outcome {
        ExitOutcome::SpawnFailed(message) => {
            crate::runtime_log::note("ollama", format!("{file} did not start: {message}"), serde_json::json!({}));
            Attempt { outcome: OllamaRemedyOutcome::Unavailable, fault: Some(format!("{file} is not installed")) }
        }
        ExitOutcome::Exited { code: Some(0), killed_by_us: false } => Attempt { outcome: OllamaRemedyOutcome::Applied, fault: None },
        ExitOutcome::Exited { code: Some(126), killed_by_us: false } => Attempt { outcome: OllamaRemedyOutcome::Cancelled, fault: None },
        ExitOutcome::Exited { code: Some(127), killed_by_us: false } => {
            if pkexec_not_setuid(stderr) {
                reopen_required()
            } else if no_auth_agent(stderr) {
                let fault = tail(stderr);
                Attempt {
                    outcome: OllamaRemedyOutcome::Unavailable,
                    fault: Some(if fault.is_empty() { "No polkit authentication agent".to_string() } else { fault }),
                }
            } else {
                Attempt { outcome: OllamaRemedyOutcome::Cancelled, fault: None }
            }
        }
        ExitOutcome::Exited { killed_by_us: true, .. } => {
            let stderr_trimmed = stderr.trim();
            let fault = if stderr_trimmed.is_empty() { "Timed out".to_string() } else { format!("Timed out: {}", tail(stderr)) };
            Attempt { outcome: OllamaRemedyOutcome::Failed, fault: Some(fault) }
        }
        ExitOutcome::Exited { code, killed_by_us: false } => {
            let fault = tail(stderr);
            let fault = if !fault.is_empty() {
                fault
            } else {
                match code {
                    Some(c) => format!("{file} exited with code {c}"),
                    None => format!("{file} exited with a signal"),
                }
            };
            Attempt { outcome: OllamaRemedyOutcome::Failed, fault: Some(fault) }
        }
    }
}

// ---------------------------------------------------------------------------
// Process spawning, injectable for tests
// ---------------------------------------------------------------------------

enum ProcEvent {
    Stderr(String),
    Exited(Option<i32>),
    SpawnError(String),
}

struct SpawnedHandle {
    events: UnboundedReceiver<ProcEvent>,
    /// Signal the process (SIGTERM on Unix). A failure (e.g. `EPERM` once the
    /// process re-executed as root through polkit) is not itself an error: the
    /// process keeps running, so its own exit decides the outcome.
    kill: Box<dyn FnMut() + Send>,
}

type Spawner = Arc<dyn Fn(&'static str, Vec<String>) -> SpawnedHandle + Send + Sync>;

fn spawn_real(file: &'static str, args: Vec<String>) -> SpawnedHandle {
    let (tx, rx) = unbounded_channel();
    match Command::new(file).args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(mut child) => {
            let pid = child.id();
            if let Some(mut stderr) = child.stderr.take() {
                let tx = tx.clone();
                bridge::spawn_task(async move {
                    let mut buf = [0u8; 4096];
                    loop {
                        match stderr.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                let _ = tx.send(ProcEvent::Stderr(String::from_utf8_lossy(&buf[..n]).into_owned()));
                            }
                        }
                    }
                });
            }
            if let Some(mut stdout) = child.stdout.take() {
                bridge::spawn_task(async move {
                    let mut buf = [0u8; 4096];
                    loop {
                        match stdout.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {}
                        }
                    }
                });
            }
            let tx2 = tx;
            bridge::spawn_task(async move {
                let status = child.wait().await;
                let code = status.ok().and_then(|s| s.code());
                let _ = tx2.send(ProcEvent::Exited(code));
            });
            SpawnedHandle {
                events: rx,
                kill: Box::new(move || {
                    #[cfg(unix)]
                    {
                        if let Some(pid) = pid {
                            use nix::sys::signal::{kill, Signal};
                            use nix::unistd::Pid;
                            let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
                        }
                    }
                }),
            }
        }
        Err(error) => {
            let _ = tx.send(ProcEvent::SpawnError(error.to_string()));
            SpawnedHandle { events: rx, kill: Box::new(|| {}) }
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Report one frame, isolating a misbehaving listener (a closed window, a
/// renderer that threw) so the remedy keeps running regardless.
fn report(on_progress: &(dyn Fn(OllamaInstallProgress) + Send + Sync), frame: OllamaInstallProgress) {
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| on_progress(frame))).is_err() {
        crate::runtime_log::note("ollama", "install progress listener failed", serde_json::json!({}));
    }
}

/// Run `command` through `spawner`, feeding its stderr chunks to `on_stderr` as
/// they arrive, and classify how it ended. Killed with SIGTERM when it
/// outlives `command.timeout`.
async fn run(spawner: &Spawner, command: &RemedyCommand, mut on_stderr: Option<impl FnMut(&str) + Send>) -> Attempt {
    let mut handle = (spawner)(command.file, command.args.clone());
    let mut stderr_buf = String::new();
    let sleep = tokio::time::sleep(command.timeout);
    tokio::pin!(sleep);
    // `kill_attempted` is sticky: the timer fires at most once. `killed_by_us`
    // is reset when the kill signal itself failed (the process re-executed as
    // root through polkit and this process may no longer signal it), so its
    // real exit, not the failed kill, decides the outcome.
    let mut kill_attempted = false;
    let mut killed_by_us = false;
    loop {
        tokio::select! {
            biased;
            () = &mut sleep, if !kill_attempted => {
                kill_attempted = true;
                killed_by_us = true;
                (handle.kill)();
            }
            event = handle.events.recv() => {
                match event {
                    Some(ProcEvent::Stderr(chunk)) => {
                        stderr_buf.push_str(&chunk);
                        if stderr_buf.len() > STDERR_KEEP {
                            let overflow = stderr_buf.len() - STDERR_KEEP;
                            stderr_buf.drain(..overflow);
                        }
                        if let Some(cb) = on_stderr.as_mut() {
                            cb(&chunk);
                        }
                    }
                    Some(ProcEvent::Exited(code)) => {
                        return classify_exit(&ExitOutcome::Exited { code, killed_by_us }, &stderr_buf, command.file);
                    }
                    Some(ProcEvent::SpawnError(message)) => {
                        if killed_by_us {
                            killed_by_us = false;
                            continue;
                        }
                        return classify_exit(&ExitOutcome::SpawnFailed(message), &stderr_buf, command.file);
                    }
                    None => {
                        return Attempt { outcome: OllamaRemedyOutcome::Failed, fault: Some("the command ended unexpectedly".to_string()) };
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Settle and run
// ---------------------------------------------------------------------------

pub type ProbeFn = Arc<dyn Fn() -> BoxFuture<OllamaStatus> + Send + Sync>;

/// After a successful remedy the daemon may need a moment to listen; how often and how long to re-probe.
#[derive(Clone, Copy)]
pub struct SettleOptions {
    pub interval: Duration,
    pub attempts: u32,
}

impl Default for SettleOptions {
    fn default() -> Self {
        Self { interval: Duration::from_millis(500), attempts: 10 }
    }
}

/// Re-probe after the command, waiting for the daemon when the command succeeded.
async fn settle(probe: &ProbeFn, options: SettleOptions, attempt: Attempt) -> OllamaRemedyResult {
    let mut status = (probe)().await;
    if attempt.outcome == OllamaRemedyOutcome::Applied {
        let mut i = 1;
        while i < options.attempts && status.state != OllamaState::Ok {
            tokio::time::sleep(options.interval).await;
            status = (probe)().await;
            i += 1;
        }
        if status.state != OllamaState::Ok {
            return OllamaRemedyResult {
                outcome: OllamaRemedyOutcome::Failed,
                status,
                fault: Some("Ollama is still not answering after the command finished".to_string()),
            };
        }
    }
    OllamaRemedyResult { outcome: attempt.outcome, status, fault: attempt.fault }
}

/// Run the remedy `id` maps to, then re-probe. Rejects only on programming
/// errors: an id outside the closed set (caught earlier, at `is_remedy_id`),
/// or a platform without remedies.
async fn run_remedy(
    spawner: &Spawner,
    id: OllamaRemedyId,
    platform: &str,
    probe: &ProbeFn,
    options: SettleOptions,
    on_progress: Option<&(dyn Fn(OllamaInstallProgress) + Send + Sync)>,
) -> Result<OllamaRemedyResult, String> {
    run_remedy_command(spawner, id, remedy_command(id), platform, probe, options, on_progress).await
}

/// `run_remedy`, with the command's timeout overridable (tests only: the
/// production timeouts are minutes long).
async fn run_remedy_command(
    spawner: &Spawner,
    id: OllamaRemedyId,
    command: RemedyCommand,
    platform: &str,
    probe: &ProbeFn,
    options: SettleOptions,
    on_progress: Option<&(dyn Fn(OllamaInstallProgress) + Send + Sync)>,
) -> Result<OllamaRemedyResult, String> {
    if platform != "linux" {
        return Err(format!("Ollama remedies run on Linux only, not {platform}"));
    }
    let on_progress = if id == OllamaRemedyId::LinuxInstall { on_progress } else { None };

    let Some(on_progress) = on_progress else {
        let attempt = run(spawner, &command, None::<fn(&str)>).await;
        return Ok(settle(probe, options, attempt).await);
    };

    report(on_progress, super::install_progress::initial_install_progress());
    let parser = Arc::new(Mutex::new(InstallProgressParser::new()));
    let parser_for_stderr = parser.clone();
    let attempt = run(
        spawner,
        &command,
        Some(move |chunk: &str| {
            let mut parser = lock(&parser_for_stderr);
            if let Some(frame) = parser.push(chunk) {
                drop(parser);
                report(on_progress, frame);
            }
        }),
    )
    .await;
    // `finally`-equivalent: the done frame goes out whether `settle` (via a
    // misbehaving `probe`) succeeds or panics, matching the TS source's
    // `try { … } finally { report(parser.final()) }`.
    let settled = std::panic::AssertUnwindSafe(settle(probe, options, attempt)).catch_unwind().await;
    let final_frame = lock(&parser).r#final();
    report(on_progress, final_frame);
    match settled {
        Ok(result) => Ok(result),
        Err(payload) => std::panic::resume_unwind(payload),
    }
}

// ---------------------------------------------------------------------------
// The remedy gate: one at a time; repeats of the running id join it
// ---------------------------------------------------------------------------

struct ActiveRemedy {
    id: OllamaRemedyId,
    result: OnceCell<Result<OllamaRemedyResult, String>>,
    ready: Notify,
}

/// The IPC entry for remedies. Re-probes and runs `id` only when it is the
/// remedy the current status offers, so a stale or forged request cannot raise
/// a root prompt the screen never showed. One remedy runs at a time: a repeat
/// of the running id joins it and gets the same result; any other id is
/// refused until it ends.
pub struct RemedyGate {
    active: Mutex<Option<Arc<ActiveRemedy>>>,
}

impl RemedyGate {
    pub fn new() -> Self {
        Self { active: Mutex::new(None) }
    }

    pub async fn run(
        &self,
        id: OllamaRemedyId,
        probe: &ProbeFn,
        attempt_fn: impl FnOnce() -> BoxFuture<Result<OllamaRemedyResult, String>>,
    ) -> Result<OllamaRemedyResult, String> {
        let (active, is_new) = {
            let mut guard = lock(&self.active);
            match guard.as_ref() {
                Some(active) if active.id == id => (active.clone(), false),
                Some(_) => return Err("Another Ollama fix is already running".to_string()),
                None => {
                    let fresh = Arc::new(ActiveRemedy { id, result: OnceCell::new(), ready: Notify::new() });
                    *guard = Some(fresh.clone());
                    (fresh, true)
                }
            }
        };
        if !is_new {
            return Self::await_result(&active).await;
        }
        let status = (probe)().await;
        let outcome = if status.remedy != Some(id) {
            Err("That fix no longer matches Ollama's state; check again".to_string())
        } else {
            attempt_fn().await
        };
        {
            let mut guard = lock(&self.active);
            if guard.as_ref().is_some_and(|current| Arc::ptr_eq(current, &active)) {
                *guard = None;
            }
        }
        let _ = active.result.set(outcome.clone());
        active.ready.notify_waiters();
        outcome
    }

    async fn await_result(active: &Arc<ActiveRemedy>) -> Result<OllamaRemedyResult, String> {
        loop {
            let notified = active.ready.notified();
            if let Some(result) = active.result.get() {
                return result.clone();
            }
            notified.await;
        }
    }
}

impl Default for RemedyGate {
    fn default() -> Self {
        Self::new()
    }
}

/// `run_remedy`, unless this process cannot gain privileges (`can_elevate`
/// false under `no_new_privs`): pkexec would only fail, so nothing runs and
/// the user is asked to reopen the app.
async fn run_remedy_if_elevatable(
    spawner: &Spawner,
    id: OllamaRemedyId,
    platform: &str,
    probe: &ProbeFn,
    options: SettleOptions,
    on_progress: Option<&(dyn Fn(OllamaInstallProgress) + Send + Sync)>,
    can_elevate: bool,
) -> Result<OllamaRemedyResult, String> {
    if can_elevate || platform != "linux" {
        return run_remedy(spawner, id, platform, probe, options, on_progress).await;
    }
    Ok(settle(probe, options, reopen_required()).await)
}

/// `run_remedy` with the real process spawner, for production use.
pub async fn run_remedy_real(
    id: OllamaRemedyId,
    platform: &str,
    probe: &ProbeFn,
    options: SettleOptions,
    on_progress: Option<&(dyn Fn(OllamaInstallProgress) + Send + Sync)>,
) -> Result<OllamaRemedyResult, String> {
    let spawner: Spawner = Arc::new(spawn_real);
    run_remedy_if_elevatable(&spawner, id, platform, probe, options, on_progress, !crate::relaunch::no_new_privs()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn status(state: OllamaState) -> OllamaStatus {
        OllamaStatus {
            state,
            base_url: "http://127.0.0.1:11434".to_string(),
            version: None,
            model_count: 0,
            installed_tags: vec![],
            platform: "linux".to_string(),
            remedy: if state == OllamaState::Ok { None } else { Some(OllamaRemedyId::LinuxStart) },
            fault: None,
        }
    }

    fn probe_sequence(states: Vec<OllamaState>) -> (ProbeFn, Arc<AtomicU32>) {
        let states = Arc::new(states);
        let i = Arc::new(AtomicU32::new(0));
        let i2 = i.clone();
        let probe: ProbeFn = Arc::new(move || {
            let states = states.clone();
            let i = i2.clone();
            Box::pin(async move {
                let index = i.fetch_add(1, Ordering::SeqCst) as usize;
                let state = *states.get(index.min(states.len() - 1)).unwrap_or(&OllamaState::Stopped);
                status(state)
            })
        });
        (probe, i)
    }

    enum Ending {
        ExitOk,
        Exit(Option<i32>),
        SpawnError(&'static str),
        Hang,
    }

    type SpawnCall = (&'static str, Vec<String>);

    fn fake_spawn(ending: Ending, stderr_chunks: Vec<&'static str>) -> (Spawner, Arc<Mutex<Vec<SpawnCall>>>, Arc<AtomicU32>) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let kills = Arc::new(AtomicU32::new(0));
        let ending = Arc::new(ending);
        let stderr_chunks = Arc::new(stderr_chunks);
        let calls2 = calls.clone();
        let kills2 = kills.clone();
        let spawner: Spawner = Arc::new(move |file, args| {
            lock(&calls2).push((file, args.clone()));
            let (tx, rx) = unbounded_channel();
            let ending_for_task = ending.clone();
            let stderr_chunks = stderr_chunks.clone();
            let tx_for_task = tx.clone();
            bridge::spawn_task(async move {
                for chunk in stderr_chunks.iter() {
                    tokio::task::yield_now().await;
                    let _ = tx_for_task.send(ProcEvent::Stderr((*chunk).to_string()));
                }
                tokio::task::yield_now().await;
                match ending_for_task.as_ref() {
                    Ending::Hang => {}
                    Ending::ExitOk => {
                        let _ = tx_for_task.send(ProcEvent::Exited(Some(0)));
                    }
                    Ending::Exit(code) => {
                        let _ = tx_for_task.send(ProcEvent::Exited(*code));
                    }
                    Ending::SpawnError(message) => {
                        let _ = tx_for_task.send(ProcEvent::SpawnError((*message).to_string()));
                    }
                }
            });
            let kills3 = kills2.clone();
            let ending_for_kill = ending.clone();
            let tx_for_kill = tx;
            SpawnedHandle {
                events: rx,
                kill: Box::new(move || {
                    kills3.fetch_add(1, Ordering::SeqCst);
                    if matches!(ending_for_kill.as_ref(), Ending::Hang) {
                        let tx = tx_for_kill.clone();
                        bridge::spawn_task(async move {
                            let _ = tx.send(ProcEvent::Exited(None));
                        });
                    }
                }),
            }
        });
        (spawner, calls, kills)
    }

    fn test_command(timeout: Duration) -> RemedyCommand {
        RemedyCommand { timeout, ..remedy_command(OllamaRemedyId::LinuxStart) }
    }

    fn install_command(timeout: Duration) -> RemedyCommand {
        RemedyCommand { timeout, ..remedy_command(OllamaRemedyId::LinuxInstall) }
    }

    fn sh_c(script: String) -> Vec<String> {
        vec!["sh".to_string(), "-c".to_string(), script]
    }

    /// The no-cloud steps both remedies end with, as the screen shows them.
    const NO_CLOUD_SCRIPT: &str = "mkdir -p /etc/systemd/system/ollama.service.d &&
f=/etc/systemd/system/ollama.service.d/sai-atlas.conf &&
s=$(printf '[Service]\\nEnvironment=\"OLLAMA_NO_CLOUD=1\"') &&
{ [ \"$(cat \"$f\" 2>/dev/null)\" = \"$s\" ] || printf '%s\\n' \"$s\" > \"$f\"; } &&
systemctl daemon-reload &&
systemctl restart ollama.service";

    #[tokio::test]
    async fn runs_the_start_script_as_one_pkexec_sh_c_and_waits_for_the_daemon_to_answer() {
        let (spawner, calls, _kills) = fake_spawn(Ending::ExitOk, vec![]);
        let (probe, _) = probe_sequence(vec![OllamaState::Stopped, OllamaState::Stopped, OllamaState::Ok]);
        let settle_options = SettleOptions { interval: Duration::ZERO, attempts: 5 };
        let result = run_remedy(&spawner, OllamaRemedyId::LinuxStart, "linux", &probe, settle_options, None).await.expect("the remedy runs");
        assert_eq!(*lock(&calls), vec![("pkexec", sh_c(remedy_script(OllamaRemedyId::LinuxStart)))]);
        assert_eq!(result, OllamaRemedyResult { outcome: OllamaRemedyOutcome::Applied, status: status(OllamaState::Ok), fault: None });
    }

    #[tokio::test]
    async fn runs_the_install_line_and_the_no_cloud_steps_as_one_pkexec_sh_c() {
        let (spawner, calls, _kills) = fake_spawn(Ending::ExitOk, vec![]);
        let (probe, _) = probe_sequence(vec![OllamaState::Ok]);
        run_remedy(&spawner, OllamaRemedyId::LinuxInstall, "linux", &probe, SettleOptions { interval: Duration::ZERO, attempts: 5 }, None)
            .await
            .expect("the remedy runs");
        assert_eq!(*lock(&calls), vec![("pkexec", sh_c(remedy_script(OllamaRemedyId::LinuxInstall)))]);
    }

    #[test]
    fn runs_exactly_the_command_the_screen_shows_the_user() {
        for id in [OllamaRemedyId::LinuxStart, OllamaRemedyId::LinuxInstall] {
            let command = remedy_command(id);
            assert_eq!(command.file, "pkexec");
            assert_eq!(command.args, sh_c(remedy_script(id)));
        }
    }

    #[test]
    fn spells_out_the_privileged_scripts_word_for_word() {
        assert_eq!(remedy_script(OllamaRemedyId::LinuxStart), NO_CLOUD_SCRIPT);
        assert_eq!(remedy_script(OllamaRemedyId::LinuxInstall), format!("curl -fsSL https://ollama.com/install.sh | sh &&\n{NO_CLOUD_SCRIPT}"));
    }

    #[tokio::test]
    async fn reports_failed_when_the_command_succeeds_but_the_daemon_never_comes_up() {
        let (spawner, _calls, _kills) = fake_spawn(Ending::ExitOk, vec![]);
        let (probe, probes) = probe_sequence(vec![OllamaState::Stopped]);
        let result = run_remedy(&spawner, OllamaRemedyId::LinuxStart, "linux", &probe, SettleOptions { interval: Duration::ZERO, attempts: 5 }, None)
            .await
            .expect("the remedy runs");
        assert_eq!(
            result,
            OllamaRemedyResult {
                outcome: OllamaRemedyOutcome::Failed,
                status: status(OllamaState::Stopped),
                fault: Some("Ollama is still not answering after the command finished".to_string()),
            }
        );
        assert_eq!(probes.load(Ordering::SeqCst), 5);
    }

    #[tokio::test]
    async fn maps_s_to_s_cases() {
        let cases: Vec<(Ending, Vec<&'static str>, OllamaRemedyOutcome)> = vec![
            (Ending::SpawnError("ENOENT"), vec![], OllamaRemedyOutcome::Unavailable),
            (Ending::Exit(Some(126)), vec![], OllamaRemedyOutcome::Cancelled),
            (Ending::Exit(Some(127)), vec!["Error executing command as another user: Not authorized"], OllamaRemedyOutcome::Cancelled),
            (
                Ending::Exit(Some(127)),
                vec!["Error executing command as another user: No authentication agent found."],
                OllamaRemedyOutcome::Unavailable,
            ),
            (Ending::Exit(Some(5)), vec!["Failed to start ollama.service: Unit ollama.service not found."], OllamaRemedyOutcome::Failed),
            (Ending::Exit(None), vec![], OllamaRemedyOutcome::Failed),
        ];
        for (ending, stderr, outcome) in cases {
            let (spawner, _calls, _kills) = fake_spawn(ending, stderr.clone());
            let (probe, _) = probe_sequence(vec![OllamaState::Stopped]);
            let result =
                run_remedy(&spawner, OllamaRemedyId::LinuxStart, "linux", &probe, SettleOptions { interval: Duration::ZERO, attempts: 5 }, None)
                    .await
                    .expect("the remedy runs");
            assert_eq!(result.outcome, outcome);
            assert_eq!(result.status, status(OllamaState::Stopped));
            if outcome == OllamaRemedyOutcome::Failed && !stderr.is_empty() {
                assert_eq!(result.fault.as_deref(), Some(stderr[0]));
            }
            if outcome == OllamaRemedyOutcome::Cancelled {
                assert_eq!(result.fault, None);
            }
        }
    }

    #[tokio::test]
    async fn asks_for_a_reopen_without_running_pkexec_under_no_new_privs() {
        for id in [OllamaRemedyId::LinuxStart, OllamaRemedyId::LinuxInstall] {
            let (spawner, calls, _kills) = fake_spawn(Ending::ExitOk, vec![]);
            let (probe, _) = probe_sequence(vec![OllamaState::Stopped]);
            let frames = Arc::new(Mutex::new(Vec::new()));
            let frames2 = frames.clone();
            let on_progress: &(dyn Fn(OllamaInstallProgress) + Send + Sync) = &move |frame| lock(&frames2).push(frame);
            let result = run_remedy_if_elevatable(&spawner, id, "linux", &probe, SettleOptions { interval: Duration::ZERO, attempts: 5 }, Some(on_progress), false)
                .await
                .expect("the remedy answers");
            assert!(lock(&calls).is_empty(), "pkexec never runs");
            assert!(lock(&frames).is_empty(), "no install progress for a command that never ran");
            assert_eq!(result.outcome, OllamaRemedyOutcome::ReopenRequired);
            assert_eq!(result.status, status(OllamaState::Stopped));
            assert!(result.fault.as_deref().is_some_and(|fault| fault.contains("no_new_privs")));
        }
        // Able to elevate: the command runs as before.
        let (spawner, calls, _kills) = fake_spawn(Ending::ExitOk, vec![]);
        let (probe, _) = probe_sequence(vec![OllamaState::Ok]);
        let result =
            run_remedy_if_elevatable(&spawner, OllamaRemedyId::LinuxStart, "linux", &probe, SettleOptions { interval: Duration::ZERO, attempts: 5 }, None, true)
                .await
                .expect("the remedy runs");
        assert_eq!(lock(&calls).len(), 1);
        assert_eq!(result.outcome, OllamaRemedyOutcome::Applied);
        // Off Linux the platform error still wins.
        let (probe, _) = probe_sequence(vec![OllamaState::Stopped]);
        assert!(run_remedy_if_elevatable(&spawner, OllamaRemedyId::LinuxStart, "darwin", &probe, SettleOptions::default(), None, false).await.is_err());
    }

    #[tokio::test]
    async fn reads_pkexec_s_setuid_failure_as_a_reopen_not_a_cancel() {
        let (spawner, _calls, _kills) = fake_spawn(Ending::Exit(Some(127)), vec!["pkexec must be setuid root\n"]);
        let (probe, _) = probe_sequence(vec![OllamaState::Stopped]);
        let result = run_remedy(&spawner, OllamaRemedyId::LinuxStart, "linux", &probe, SettleOptions { interval: Duration::ZERO, attempts: 5 }, None)
            .await
            .expect("the remedy runs");
        assert_eq!(result.outcome, OllamaRemedyOutcome::ReopenRequired);
        assert_eq!(serde_json::to_value(result.outcome).unwrap(), serde_json::json!("reopen-required"));
    }

    #[tokio::test]
    async fn stops_the_command_with_sigterm_when_it_outlives_its_timeout() {
        let (spawner, _calls, kills) = fake_spawn(Ending::Hang, vec!["still downloading"]);
        let (probe, _) = probe_sequence(vec![OllamaState::Stopped]);
        let attempt = run(&spawner, &test_command(Duration::from_millis(15)), None::<fn(&str)>).await;
        assert_eq!(kills.load(Ordering::SeqCst), 1);
        assert_eq!(attempt.outcome, OllamaRemedyOutcome::Failed);
        assert_eq!(attempt.fault.as_deref(), Some("Timed out: still downloading"));
        let _ = probe;
    }

    #[tokio::test]
    async fn waits_for_a_root_installer_it_cannot_signal_and_sends_nothing_after_the_done_frame() {
        // The process never reports its own exit until the test's `driver`
        // sends it below; `kill()` reports an `EPERM`-equivalent failure (the
        // command re-executed as root through polkit, so this process cannot
        // signal it), and the process keeps running regardless.
        let exit_tx_holder: Arc<Mutex<Option<tokio::sync::mpsc::UnboundedSender<ProcEvent>>>> = Arc::new(Mutex::new(None));
        let exit_tx_holder2 = exit_tx_holder.clone();
        let spawner: Spawner = Arc::new(move |_file, _args| {
            let (evt_tx, evt_rx) = unbounded_channel();
            *lock(&exit_tx_holder2) = Some(evt_tx.clone());
            SpawnedHandle {
                events: evt_rx,
                kill: Box::new(move || {
                    let _ = evt_tx.send(ProcEvent::SpawnError("kill EPERM".to_string()));
                }),
            }
        });
        let frames = Arc::new(Mutex::new(Vec::new()));
        let frames2 = frames.clone();
        let on_progress: &(dyn Fn(OllamaInstallProgress) + Send + Sync) = &move |frame| lock(&frames2).push(frame);
        let (probe, _) = probe_sequence(vec![OllamaState::Ok]);
        let command = RemedyCommand { timeout: Duration::from_millis(10), ..install_command(Duration::ZERO) };

        let remedy_future = run_remedy_command(
            &spawner,
            OllamaRemedyId::LinuxInstall,
            command,
            "linux",
            &probe,
            SettleOptions { interval: Duration::ZERO, attempts: 5 },
            Some(on_progress),
        );
        tokio::pin!(remedy_future);
        let driver = async {
            // Give the internal timeout (and its EPERM-equivalent kill attempt) time to fire.
            tokio::time::sleep(Duration::from_millis(30)).await;
            assert!(!lock(&frames).iter().any(|f| f.done));
            let tx = lock(&exit_tx_holder).clone().expect("the process was spawned");
            let _ = tx.send(ProcEvent::Stderr(">>> Install complete.\n".to_string()));
            let _ = tx.send(ProcEvent::Exited(Some(0)));
        };
        let (result, ()) = tokio::join!(remedy_future, driver);
        let result = result.expect("the remedy runs");
        assert_eq!(result, OllamaRemedyResult { outcome: OllamaRemedyOutcome::Applied, status: status(OllamaState::Ok), fault: None });
        assert!(lock(&frames).last().is_some_and(|f| f.done));
    }

    #[tokio::test]
    async fn keeps_the_last_redraw_of_each_curl_bar_line_in_the_fault() {
        let (spawner, _calls, _kills) =
            fake_spawn(Ending::Exit(Some(1)), vec!["\r##   10.0%\r#####  50.0%\ncurl: (56) connection reset\n"]);
        let (probe, _) = probe_sequence(vec![OllamaState::Stopped]);
        let result = run_remedy(&spawner, OllamaRemedyId::LinuxInstall, "linux", &probe, SettleOptions::default(), None).await.expect("the remedy runs");
        assert_eq!(result.fault.as_deref(), Some("#####  50.0%\ncurl: (56) connection reset"));
    }

    #[tokio::test]
    async fn keeps_only_the_stderr_tail_as_the_fault() {
        let first = "x".repeat(9000);
        let second = format!("{}END", "x".repeat(2000));
        let chunks: Vec<&'static str> = vec![Box::leak(first.into_boxed_str()), Box::leak(second.into_boxed_str())];
        let (spawner, _calls, _kills) = fake_spawn(Ending::Exit(Some(1)), chunks);
        let (probe, _) = probe_sequence(vec![OllamaState::Stopped]);
        let result = run_remedy(&spawner, OllamaRemedyId::LinuxInstall, "linux", &probe, SettleOptions::default(), None).await.expect("the remedy runs");
        let fault = result.fault.expect("a fault is reported");
        assert_eq!(fault.chars().count(), 500);
        assert!(fault.ends_with("END"));
    }

    #[tokio::test]
    async fn rejects_ids_outside_the_closed_set_without_running_anything() {
        assert!(!is_remedy_id(Some("rm -rf /")));
        assert!(!is_remedy_id(Some("toString")));
    }

    #[tokio::test]
    async fn rejects_off_linux() {
        let (spawner, calls, _kills) = fake_spawn(Ending::ExitOk, vec![]);
        let (probe, _) = probe_sequence(vec![OllamaState::Ok]);
        let error = run_remedy(&spawner, OllamaRemedyId::LinuxStart, "darwin", &probe, SettleOptions::default(), None).await.unwrap_err();
        assert!(error.contains("Linux"));
        assert!(lock(&calls).is_empty());
    }

    #[tokio::test]
    async fn streams_the_installer_s_stages_and_download_percent_then_a_done_frame() {
        let chunks = vec![
            ">>> Installing ollama to /usr/local\n",
            ">>> Downloading ollama-linux-amd64.tar.zst\n",
            "\r#=#=#  ",
            "\r#######                       10.0%",
            "\r#################       55",
            ".3%",
            "\r############################ 100.0%\n",
            ">>> Enabling and starting ollama service...\n",
        ];
        let (spawner, _calls, _kills) = fake_spawn(Ending::ExitOk, chunks);
        let (probe, _) = probe_sequence(vec![OllamaState::Ok]);
        let frames = Arc::new(Mutex::new(Vec::new()));
        let frames2 = frames.clone();
        let on_progress: &(dyn Fn(OllamaInstallProgress) + Send + Sync) = &move |frame| lock(&frames2).push(frame);
        let result = run_remedy(&spawner, OllamaRemedyId::LinuxInstall, "linux", &probe, SettleOptions::default(), Some(on_progress)).await.expect("the remedy runs");
        assert_eq!(result, OllamaRemedyResult { outcome: OllamaRemedyOutcome::Applied, status: status(OllamaState::Ok), fault: None });
        let got = lock(&frames).clone();
        assert_eq!(got.len(), 8);
        assert_eq!(got[0].stage, None);
        assert_eq!(got[0].percent, -1);
        assert_eq!(got[1].stage.as_deref(), Some("Installing ollama to /usr/local"));
        assert_eq!(got[2].stage.as_deref(), Some("Downloading ollama-linux-amd64.tar.zst"));
        assert_eq!(got[3].percent, 10);
        assert_eq!(got[4].percent, 55);
        assert_eq!(got[5].percent, 100);
        assert_eq!(got[6].stage.as_deref(), Some("Enabling and starting ollama service..."));
        assert!(got[7].done);
    }

    #[tokio::test]
    async fn sends_the_indeterminate_frame_before_the_command_starts() {
        let (spawner, _calls, _kills) = fake_spawn(Ending::ExitOk, vec![]);
        let (probe, _) = probe_sequence(vec![OllamaState::Ok]);
        let frames = Arc::new(Mutex::new(Vec::new()));
        let frames2 = frames.clone();
        let on_progress: &(dyn Fn(OllamaInstallProgress) + Send + Sync) = &move |frame| lock(&frames2).push(frame);
        run_remedy(&spawner, OllamaRemedyId::LinuxInstall, "linux", &probe, SettleOptions::default(), Some(on_progress)).await.expect("the remedy runs");
        assert!(lock(&frames).first().is_some_and(|f| f.stage.is_none() && f.percent == -1));
        assert!(lock(&frames).last().is_some_and(|f| f.done));
    }

    #[tokio::test]
    async fn still_ends_with_a_done_frame_when_the_install_is_s_cases() {
        let cases: Vec<(OllamaRemedyOutcome, Ending)> = vec![
            (OllamaRemedyOutcome::Cancelled, Ending::Exit(Some(126))),
            (OllamaRemedyOutcome::Unavailable, Ending::SpawnError("ENOENT")),
            (OllamaRemedyOutcome::Failed, Ending::Exit(Some(1))),
        ];
        for (expected, ending) in cases {
            let (spawner, _calls, _kills) = fake_spawn(ending, vec![]);
            let (probe, _) = probe_sequence(vec![OllamaState::Absent]);
            let frames = Arc::new(Mutex::new(Vec::new()));
            let frames2 = frames.clone();
            let on_progress: &(dyn Fn(OllamaInstallProgress) + Send + Sync) = &move |frame| lock(&frames2).push(frame);
            let result =
                run_remedy(&spawner, OllamaRemedyId::LinuxInstall, "linux", &probe, SettleOptions::default(), Some(on_progress)).await.expect("the remedy runs");
            assert_eq!(result.outcome, expected);
            let got = lock(&frames).clone();
            assert_eq!(got.len(), 2);
            assert!(got[0].stage.is_none() && got[0].percent == -1 && !got[0].done);
            assert!(got[1].stage.is_none() && got[1].percent == -1 && got[1].done);
        }
    }

    #[tokio::test]
    async fn sends_the_done_frame_only_after_the_daemon_settle_finishes() {
        let (spawner, _calls, _kills) = fake_spawn(Ending::ExitOk, vec![]);
        let (probe_inner, probes) = probe_sequence(vec![OllamaState::Stopped]);
        let frames = Arc::new(Mutex::new(Vec::new()));
        let frames2 = frames.clone();
        let frames_check = frames.clone();
        let probe: ProbeFn = Arc::new(move || {
            let probe_inner = probe_inner.clone();
            let frames_check = frames_check.clone();
            Box::pin(async move {
                let status = probe_inner().await;
                assert!(!lock(&frames_check).iter().any(|f: &super::super::install_progress::OllamaInstallProgress| f.done));
                status
            })
        });
        let on_progress: &(dyn Fn(OllamaInstallProgress) + Send + Sync) = &move |frame| lock(&frames2).push(frame);
        let result =
            run_remedy(&spawner, OllamaRemedyId::LinuxInstall, "linux", &probe, SettleOptions { interval: Duration::ZERO, attempts: 5 }, Some(on_progress))
                .await
                .expect("the remedy runs");
        assert_eq!(probes.load(Ordering::SeqCst), 5);
        assert_eq!(result.outcome, OllamaRemedyOutcome::Failed);
        assert!(lock(&frames).last().is_some_and(|f| f.stage.is_none() && f.percent == -1 && f.done));
    }

    #[tokio::test]
    async fn sends_a_done_frame_even_when_the_re_probe_throws() {
        let (spawner, _calls, _kills) = fake_spawn(Ending::ExitOk, vec![]);
        let frames = Arc::new(Mutex::new(Vec::new()));
        let frames2 = frames.clone();
        let probe: ProbeFn = Arc::new(|| Box::pin(async move { panic!("probe broke") }));
        let on_progress: &(dyn Fn(OllamaInstallProgress) + Send + Sync) = &move |frame| lock(&frames2).push(frame);
        let outcome = std::panic::AssertUnwindSafe(run_remedy(
            &spawner,
            OllamaRemedyId::LinuxInstall,
            "linux",
            &probe,
            SettleOptions::default(),
            Some(on_progress),
        ))
        .catch_unwind()
        .await;
        assert!(outcome.is_err(), "the probe panic propagates");
        assert!(lock(&frames).last().is_some_and(|f| f.done));
    }

    #[tokio::test]
    async fn keeps_running_when_the_progress_listener_throws() {
        let chunks = vec![
            ">>> Installing ollama to /usr/local\n",
            ">>> Downloading ollama-linux-amd64.tar.zst\n",
            "\r#=#=#  ",
            "\r#######                       10.0%",
            "\r#################       55",
            ".3%",
            "\r############################ 100.0%\n",
            ">>> Enabling and starting ollama service...\n",
        ];
        let (spawner, _calls, _kills) = fake_spawn(Ending::ExitOk, chunks);
        let (probe, _) = probe_sequence(vec![OllamaState::Ok]);
        // `report` isolates a panicking listener (the TS source's `try`/`catch`
        // around one frame), so `run_remedy` stays infallible on its account.
        let on_progress: &(dyn Fn(OllamaInstallProgress) + Send + Sync) = &|_frame| panic!("window gone");
        let result = run_remedy(&spawner, OllamaRemedyId::LinuxInstall, "linux", &probe, SettleOptions::default(), Some(on_progress)).await.expect("the remedy runs");
        assert_eq!(result.outcome, OllamaRemedyOutcome::Applied);
    }

    #[tokio::test]
    async fn sends_nothing_for_the_start_remedy() {
        let (spawner, _calls, _kills) = fake_spawn(Ending::ExitOk, vec!["ignored"]);
        let (probe, _) = probe_sequence(vec![OllamaState::Ok]);
        let frames = Arc::new(Mutex::new(Vec::new()));
        let frames2 = frames.clone();
        let on_progress: &(dyn Fn(OllamaInstallProgress) + Send + Sync) = &move |frame| lock(&frames2).push(frame);
        run_remedy(&spawner, OllamaRemedyId::LinuxStart, "linux", &probe, SettleOptions::default(), Some(on_progress)).await.expect("the remedy runs");
        assert!(lock(&frames).is_empty());
    }

    const DROP_IN_DIR: &str = "/etc/systemd/system/ollama.service.d";
    const DROP_IN: &str = "[Service]\nEnvironment=\"OLLAMA_NO_CLOUD=1\"\n";

    /// A scratch directory standing in for the drop-in directory, with fake
    /// `systemctl` and `curl` that only log their arguments. PATH holds nothing
    /// else, so the script under test can reach neither the real systemctl nor /etc.
    #[cfg(unix)]
    struct Sandbox {
        root: tempfile::TempDir,
    }

    #[cfg(unix)]
    impl Sandbox {
        fn new() -> Self {
            use std::os::unix::fs::PermissionsExt as _;
            let root = tempfile::Builder::new().prefix("sai-atlas-remedy-").tempdir().expect("a scratch dir");
            let bin = root.path().join("bin");
            std::fs::create_dir(&bin).expect("bin dir");
            for tool in ["sh", "cat", "mkdir"] {
                let real = ["/bin", "/usr/bin"].iter().map(|dir| std::path::Path::new(dir).join(tool)).find(|file| file.exists()).expect("tool on the host");
                std::os::unix::fs::symlink(real, bin.join(tool)).expect("link the tool");
            }
            for (name, body) in [
                ("systemctl", "#!/bin/sh\necho \"systemctl $*\" >> \"$CALLS\"\n"),
                ("curl", "#!/bin/sh\necho \"curl $*\" >> \"$CALLS\"\necho \"exit $INSTALLER_STATUS\"\n"),
            ] {
                std::fs::write(bin.join(name), body).expect("write a fake");
                std::fs::set_permissions(bin.join(name), std::fs::Permissions::from_mode(0o755)).expect("make it executable");
            }
            Sandbox { root }
        }

        fn drop_in_dir(&self) -> std::path::PathBuf {
            self.root.path().join("ollama.service.d")
        }

        fn run(&self, id: OllamaRemedyId, installer_status: i32) -> (Option<i32>, Vec<String>) {
            let dir = self.drop_in_dir().to_str().expect("a UTF-8 path").to_string();
            assert!(dir.chars().all(|c| c.is_ascii_alphanumeric() || "/._-".contains(c)), "unquotable scratch path {dir}");
            let script = remedy_script(id).replace(DROP_IN_DIR, &dir);
            assert!(!script.contains("/etc/"));
            let bin = self.root.path().join("bin");
            let log = self.root.path().join("calls.log");
            let output = std::process::Command::new(bin.join("sh"))
                .args(["-c", &script])
                .env_clear()
                .env("PATH", &bin)
                .env("CALLS", &log)
                .env("INSTALLER_STATUS", installer_status.to_string())
                .output()
                .expect("run the script");
            let calls = std::fs::read_to_string(&log).map(|text| text.trim().lines().map(str::to_string).collect()).unwrap_or_default();
            (output.status.code(), calls)
        }
    }

    #[cfg(unix)]
    fn entries(dir: &std::path::Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir).expect("read the dir").map(|entry| entry.expect("an entry").file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    #[cfg(unix)]
    #[test]
    fn writes_exactly_the_no_cloud_drop_in_and_reloads_systemd_before_restarting_ollama() {
        for id in [OllamaRemedyId::LinuxStart, OllamaRemedyId::LinuxInstall] {
            let sandbox = Sandbox::new();
            let (code, calls) = sandbox.run(id, 0);
            assert_eq!(code, Some(0));
            assert_eq!(entries(&sandbox.drop_in_dir()), vec!["sai-atlas.conf"]);
            assert_eq!(std::fs::read_to_string(sandbox.drop_in_dir().join("sai-atlas.conf")).expect("the drop-in"), DROP_IN);
            let mut expected: Vec<String> = if id == OllamaRemedyId::LinuxInstall { vec!["curl -fsSL https://ollama.com/install.sh".to_string()] } else { vec![] };
            expected.extend(["systemctl daemon-reload".to_string(), "systemctl restart ollama.service".to_string()]);
            assert_eq!(calls, expected);
        }
    }

    #[cfg(unix)]
    #[test]
    fn leaves_other_drop_ins_and_an_identical_drop_in_untouched() {
        let past = std::time::UNIX_EPOCH + Duration::from_secs(1_577_836_800);
        let set_mtime = |path: &std::path::Path| std::fs::File::options().write(true).open(path).expect("open").set_modified(past).expect("set mtime");
        let mtime = |path: &std::path::Path| std::fs::metadata(path).expect("stat").modified().expect("mtime");
        for id in [OllamaRemedyId::LinuxStart, OllamaRemedyId::LinuxInstall] {
            let sandbox = Sandbox::new();
            std::fs::create_dir(sandbox.drop_in_dir()).expect("drop-in dir");
            let other = sandbox.drop_in_dir().join("override.conf");
            let ours = sandbox.drop_in_dir().join("sai-atlas.conf");
            std::fs::write(&other, "[Service]\nEnvironment=\"OLLAMA_HOST=0.0.0.0\"\n").expect("write override");
            std::fs::write(&ours, DROP_IN).expect("write ours");
            set_mtime(&other);
            set_mtime(&ours);
            assert_eq!(sandbox.run(id, 0).0, Some(0));
            assert_eq!(std::fs::read_to_string(&other).expect("override"), "[Service]\nEnvironment=\"OLLAMA_HOST=0.0.0.0\"\n");
            assert_eq!(mtime(&other), past);
            assert_eq!(mtime(&ours), past);
            assert_eq!(entries(&sandbox.drop_in_dir()), vec!["override.conf", "sai-atlas.conf"]);
        }
    }

    #[cfg(unix)]
    #[test]
    fn rewrites_a_sai_atlas_drop_in_whose_content_differs() {
        let sandbox = Sandbox::new();
        std::fs::create_dir(sandbox.drop_in_dir()).expect("drop-in dir");
        std::fs::write(sandbox.drop_in_dir().join("sai-atlas.conf"), "[Service]\n").expect("write a stale drop-in");
        assert_eq!(sandbox.run(OllamaRemedyId::LinuxStart, 0).0, Some(0));
        assert_eq!(std::fs::read_to_string(sandbox.drop_in_dir().join("sai-atlas.conf")).expect("the drop-in"), DROP_IN);
    }

    #[cfg(unix)]
    #[test]
    fn touches_neither_the_drop_in_nor_systemd_when_the_installer_fails() {
        let sandbox = Sandbox::new();
        let (code, calls) = sandbox.run(OllamaRemedyId::LinuxInstall, 3);
        assert_eq!(code, Some(3));
        assert!(!sandbox.drop_in_dir().exists());
        assert_eq!(calls, vec!["curl -fsSL https://ollama.com/install.sh".to_string()]);
    }

    #[test]
    fn accepts_only_the_closed_set() {
        assert!(is_remedy_id(Some("linux-start")));
        assert!(is_remedy_id(Some("linux-install")));
        assert!(!is_remedy_id(Some("constructor")));
        assert!(!is_remedy_id(None));
    }

    fn offering(remedy: Option<OllamaRemedyId>) -> OllamaStatus {
        let mut s = status(if remedy.is_none() { OllamaState::Ok } else { OllamaState::Stopped });
        s.remedy = remedy;
        s
    }

    fn probe_offering(remedy: Option<OllamaRemedyId>) -> ProbeFn {
        Arc::new(move || Box::pin(async move { offering(remedy) }))
    }

    #[tokio::test]
    async fn runs_the_remedy_the_current_status_offers() {
        let gate = RemedyGate::new();
        let probe = probe_offering(Some(OllamaRemedyId::LinuxStart));
        let result = gate
            .run(OllamaRemedyId::LinuxStart, &probe, || Box::pin(async { Ok(OllamaRemedyResult { outcome: OllamaRemedyOutcome::Applied, status: status(OllamaState::Ok), fault: None }) }))
            .await
            .expect("the remedy runs");
        assert_eq!(result.outcome, OllamaRemedyOutcome::Applied);
    }

    #[tokio::test]
    async fn refuses_a_remedy_the_current_status_does_not_offer_without_running_it() {
        let gate = RemedyGate::new();
        let ran = Arc::new(AtomicU32::new(0));
        let ran2 = ran.clone();
        let probe = probe_offering(None);
        let error = gate
            .run(OllamaRemedyId::LinuxInstall, &probe, move || {
                ran2.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(OllamaRemedyResult { outcome: OllamaRemedyOutcome::Applied, status: status(OllamaState::Ok), fault: None }) })
            })
            .await
            .unwrap_err();
        assert!(error.contains("no longer"));
        let gate2 = RemedyGate::new();
        let probe2 = probe_offering(Some(OllamaRemedyId::LinuxStart));
        let ran3 = ran.clone();
        let error2 = gate2
            .run(OllamaRemedyId::LinuxInstall, &probe2, move || {
                ran3.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(OllamaRemedyResult { outcome: OllamaRemedyOutcome::Applied, status: status(OllamaState::Ok), fault: None }) })
            })
            .await
            .unwrap_err();
        assert!(error2.contains("no longer"));
        assert_eq!(ran.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn joins_a_repeat_of_the_running_remedy_and_refuses_a_different_one_until_it_ends() {
        let gate = Arc::new(RemedyGate::new());
        let probe = probe_offering(Some(OllamaRemedyId::LinuxStart));
        let run_count = Arc::new(AtomicU32::new(0));
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let release_rx = Arc::new(Mutex::new(Some(release_rx)));
        let run_count2 = run_count.clone();
        let gate2 = gate.clone();
        let probe2 = probe.clone();
        let first = tokio::spawn(async move {
            gate2
                .run(OllamaRemedyId::LinuxStart, &probe2, move || {
                    run_count2.fetch_add(1, Ordering::SeqCst);
                    Box::pin(async move {
                        let rx = lock(&release_rx).take().expect("one waiter");
                        let _ = rx.await;
                        Ok(OllamaRemedyResult { outcome: OllamaRemedyOutcome::Applied, status: status(OllamaState::Ok), fault: None })
                    })
                })
                .await
        });
        tokio::task::yield_now().await;
        let gate3 = gate.clone();
        let probe3 = probe.clone();
        let second = tokio::spawn(async move { gate3.run(OllamaRemedyId::LinuxStart, &probe3, || unreachable!("joins the running attempt, never starts a new one")).await });
        tokio::task::yield_now().await;
        let error = gate.run(OllamaRemedyId::LinuxInstall, &probe, || unreachable!("refused while another remedy is running")).await.unwrap_err();
        assert!(error.contains("already running"));

        let _ = release_tx.send(());
        let first_result = first.await.expect("the first task completes").expect("the remedy runs");
        let second_result = second.await.expect("the second task completes").expect("the remedy runs");
        assert_eq!(first_result.outcome, OllamaRemedyOutcome::Applied);
        assert_eq!(second_result.outcome, OllamaRemedyOutcome::Applied);
        assert_eq!(run_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn frees_the_gate_after_a_refused_or_failed_attempt() {
        let gate = RemedyGate::new();
        let probe = probe_offering(Some(OllamaRemedyId::LinuxStart));
        let first = gate.run(OllamaRemedyId::LinuxStart, &probe, || Box::pin(async { Err("boom".to_string()) })).await;
        assert_eq!(first, Err("boom".to_string()));
        let second = gate.run(OllamaRemedyId::LinuxStart, &probe, || Box::pin(async { Err("boom".to_string()) })).await;
        assert_eq!(second, Err("boom".to_string()));
    }
}
