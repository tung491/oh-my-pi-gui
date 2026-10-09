//! Sidecar lifecycle manager: spawns
//! `omp --mode rpc-ui` through the supervisor, routes frames to the RPC client
//! and the event batcher, and runs the restart and crash-loop policy.
//!
//! Process tree on Linux and macOS: GUI → supervisor (this binary re-executed
//! with `ports::SUPERVISOR_ARGV`) → omp → tool children. The GUI holds one end
//! of a socketpair; the supervisor inherits the other as fd 3, writes omp's pid
//! on it once, and treats EOF as the GUI's death. Windows spawns omp directly
//! until it gets a Job Object.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, watch};

use super::assistant_pack;
use super::rpc_bridge::{attach_ndjson_parser, supports_rpc_protocol_v2};
use super::rpc_client::RpcClient;
use crate::bridge::spawn_task;
use crate::paths;
use crate::ports::{
    CtxRef, EventBatcher, SessionKind, SidecarError, SidecarEvent, SidecarEvents, SidecarHandle, SidecarOptions, SidecarRefusal, SidecarRestartProgress, SidecarStatus,
    SidecarStatusPayload,
};
use crate::product::PRODUCT_NAME;

const MAX_RESTART_ATTEMPTS: u32 = 3;
const RESTART_DELAYS_MS: [u64; 3] = [1000, 2000, 4000];
/// stderr lines kept per spawn for the crash report.
const STDERR_TAIL_LINES: usize = 20;
/// Cap on the stderr excerpt appended to the user-visible restart reason.
const STDERR_REASON_CHARS: usize = 240;
/// How long the supervisor gets to run its own shutdown sequence after `kill()`.
const SUPERVISOR_EXIT_GRACE: Duration = Duration::from_secs(8);
/// The descriptor the supervisor inherits the control channel on.
#[cfg(unix)]
const CONTROL_FD: std::os::fd::RawFd = 3;

/// Event types routed to the event batcher.
const AGENT_EVENT_TYPES: &[&str] = &[
    "agent_start",
    "agent_end",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "auto_compaction_start",
    "auto_compaction_end",
    "auto_retry_start",
    "auto_retry_end",
    "retry_fallback_applied",
    "retry_fallback_succeeded",
    "model_changed",
    "ttsr_triggered",
    "todo_reminder",
    "todo_auto_clear",
    "irc_message",
    "notice",
    "thinking_level_changed",
    "goal_updated",
    "loop_mode_update",
    "plan_proposal",
    "queue_update",
    "collab_state",
];

/// Resolves the environment overlay (login-shell PATH, API keys, proxy) for a spawn.
pub(crate) type SpawnEnvProvider = Arc<dyn Fn() -> BoxFuture<'static, HashMap<String, String>> + Send + Sync>;

/// One crash-loop step, as handed to the failure reporter.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SidecarFailureReport {
    /// Exit/signal reason with the leading stderr line appended.
    pub(crate) reason: String,
    /// Respawn about to be scheduled, or the exhausted count on the final error.
    pub(crate) attempt: u32,
    pub(crate) max_attempts: u32,
    /// stderr tail captured from this spawn (up to `STDERR_TAIL_LINES`).
    pub(crate) stderr: Vec<String>,
    pub(crate) cwd: String,
}

/// Persists a crash report; production writes `gui-runtime.jsonl`.
pub(crate) type FailureReporter = Arc<dyn Fn(SidecarFailureReport) + Send + Sync>;

/// A start the manager refused before spawning (no binary, an incomplete pack).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SidecarStartRefusalReport {
    pub(crate) message: String,
    pub(crate) cwd: String,
}

pub(crate) type StartRefusalReporter = Arc<dyn Fn(SidecarStartRefusalReport) + Send + Sync>;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The "no omp binary" message, worded for the build that hit it. A dev tree
/// can rebuild the sidecar; a packaged app cannot, so telling its user to run
/// `build:omp` sends them into a source checkout they do not have.
pub(crate) fn missing_sidecar_message(packaged: bool, resources_path: Option<&Path>) -> String {
    if !packaged {
        return "Built-in omp not found. Build it with `bun --cwd=packages/gui run build:omp`, then relaunch.".to_string();
    }
    let target = resources_path.map(|dir| dir.join("omp").display().to_string()).unwrap_or_else(|| "the bundled omp binary".to_string());
    format!("omp is missing from this installation ({target}). Reinstall {PRODUCT_NAME}, then relaunch.")
}

/// Leading stderr line of the crashed spawn: a fatal message comes first and
/// whatever follows is stack or warning noise. The full tail rides on the report.
fn stderr_excerpt(lines: &[String]) -> String {
    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let chars = trimmed.chars().count();
        if chars > STDERR_REASON_CHARS {
            let mut cut: String = trimmed.chars().take(STDERR_REASON_CHARS - 1).collect();
            cut.push('…');
            return cut;
        }
        return trimmed.to_string();
    }
    String::new()
}

/// The context limits overlay beside `prefs_path` (the profile directory),
/// created empty when missing so the sidecar's settings watcher has a file to
/// follow. `None` when it neither exists nor can be created: the sidecar then
/// runs at the global cap alone. An existing file is never touched; the
/// `ollama` module owns its contents.
fn context_limits_overlay(prefs_path: &Path) -> Option<PathBuf> {
    let path = paths::context_limits_overlay_path(prefs_path.parent()?);
    let created = std::fs::create_dir_all(path.parent()?).and_then(|()| {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
        std::io::Write::write_all(&mut file, paths::EMPTY_CONTEXT_LIMITS_OVERLAY.as_bytes())
    });
    match created {
        Ok(()) => Some(path),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Some(path),
        Err(error) => {
            crate::runtime_log::note(
                "unknown",
                format!("could not create {}: {error}; sidecars run at the global context cap", path.display()),
                json!({}),
            );
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Launch profiles (`src/shared/launch-profile.ts`)
// ---------------------------------------------------------------------------

/// Profile flags that pass to omp as a bare switch.
const ALLOWED_BARE_FLAGS: &[&str] = &["--no-lsp"];
/// Profile flags that pass with the next token as their value.
const ALLOWED_VALUED_FLAGS: &[&str] = &["--session-dir"];

/// Keep only the launch flags a profile may pass: `--no-lsp`, and
/// `--session-dir` with its value as the next token. Neither changes what an
/// assistant session loads, resumes or approves; every other token is dropped,
/// whatever its spelling (`--flag=value`, short options, a bare `--` or `--=x`,
/// which omp reads as end-of-options, and stray positionals). The value of
/// `--session-dir` is data and passes verbatim, even when it looks like a
/// flag; a `--session-dir` with no value after it is dropped.
pub(crate) fn allowed_launch_flags(flags: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut index = 0;
    while index < flags.len() {
        let token = &flags[index];
        index += 1;
        if ALLOWED_BARE_FLAGS.contains(&token.as_str()) {
            out.push(token.clone());
        } else if ALLOWED_VALUED_FLAGS.contains(&token.as_str()) {
            if let Some(value) = flags.get(index) {
                out.push(token.clone());
                out.push(value.clone());
                index += 1;
            }
        }
    }
    out
}

fn trimmed_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty()).map(str::to_string)
}

/// Sanitize untrusted prefs JSON into agent CLI flags in the fixed profile order.
/// Unknown keys (a hand-edited `"--session"`) never reach the mapping, and only
/// the fields that cannot change what an assistant session loads or approves
/// still map (`--no-lsp`, `--session-dir`).
pub(crate) fn launch_profile_to_flags(raw: &Value) -> Vec<String> {
    let Some(record) = raw.as_object() else { return Vec::new() };
    let mut flags = Vec::new();
    if record.get("noLsp") == Some(&Value::Bool(true)) {
        flags.push("--no-lsp".to_string());
    }
    if let Some(dir) = trimmed_string(record.get("sessionDir")) {
        flags.extend(["--session-dir".to_string(), dir]);
    }
    flags
}

/// `launchProfiles.<cwd>` from prefs, mapped to flags; any failure means no flags.
fn launch_profile_flags(ctx: &CtxRef, cwd: &str) -> Vec<String> {
    let Some(ctx) = ctx.upgrade() else { return Vec::new() };
    let Some(profiles) = ctx.prefs.get("launchProfiles") else { return Vec::new() };
    profiles.get(cwd).map(launch_profile_to_flags).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Supervised spawn
// ---------------------------------------------------------------------------

/// The command that runs `program args…` under the supervisor on Linux and
/// macOS, or directly on Windows. The caller sets cwd, env and stdio.
fn supervised_command(program: &Path, args: &[String]) -> std::io::Result<Command> {
    #[cfg(unix)]
    {
        let launcher = supervisor_launcher()?;
        let mut command = Command::new(&launcher.program);
        command.args(&launcher.args);
        for (key, value) in &launcher.env {
            command.env(key, value);
        }
        launcher.append_omp_argv(&mut command, program, args);
        Ok(command)
    }
    #[cfg(not(unix))]
    {
        let mut command = Command::new(program);
        command.args(args);
        Ok(command)
    }
}

/// How this process re-executes itself as the supervisor.
#[cfg(unix)]
struct SupervisorLauncher {
    program: PathBuf,
    args: Vec<String>,
    env: Vec<(String, String)>,
}

#[cfg(unix)]
impl SupervisorLauncher {
    /// omp's command line follows the reserved argument.
    #[cfg(not(test))]
    fn append_omp_argv(&self, command: &mut Command, program: &Path, args: &[String]) {
        command.arg(program);
        command.args(args);
    }

    /// Test binaries cannot take omp's argv positionally (libtest reads it), so it travels in an env var.
    #[cfg(test)]
    fn append_omp_argv(&self, command: &mut Command, program: &Path, args: &[String]) {
        let mut argv = vec![program.to_string_lossy().into_owned()];
        argv.extend(args.iter().cloned());
        command.env(super::supervisor::TEST_ARGV_ENV, serde_json::to_string(&argv).unwrap_or_default());
    }
}

/// Production: the GUI binary with the reserved first argument, which `main.rs`
/// routes to `supervisor::run` before Tauri starts.
#[cfg(all(unix, not(test)))]
fn supervisor_launcher() -> std::io::Result<SupervisorLauncher> {
    Ok(SupervisorLauncher { program: std::env::current_exe()?, args: vec![crate::ports::SUPERVISOR_ARGV.to_string()], env: Vec::new() })
}

/// Tests: the test binary has libtest's `main`, so the supervisor role is a
/// helper test selected with `--exact`, and omp's argv travels in an env var.
#[cfg(all(unix, test))]
fn supervisor_launcher() -> std::io::Result<SupervisorLauncher> {
    Ok(SupervisorLauncher {
        program: std::env::current_exe()?,
        args: ["--exact", super::supervisor::TEST_SUPERVISOR_HELPER].iter().chain(super::supervisor::TEST_HARNESS_ARGS).map(|arg| arg.to_string()).collect(),
        env: vec![(super::supervisor::TEST_ROLE_ENV.to_string(), "supervisor".to_string())],
    })
}

/// A spawned supervisor (or, on Windows, omp itself) with the GUI-side control channel.
pub(crate) struct Supervised {
    pub(crate) child: Child,
    #[cfg(unix)]
    pub(crate) control_read: tokio::net::unix::OwnedReadHalf,
    #[cfg(unix)]
    pub(crate) control_write: tokio::net::unix::OwnedWriteHalf,
}

/// Spawn `program args…` under the supervisor. `configure` sets cwd, env and
/// stdio on the command before it runs. Must run inside a tokio runtime.
pub(crate) fn spawn_supervised(program: &Path, args: &[String], configure: impl FnOnce(&mut Command)) -> std::io::Result<Supervised> {
    let mut command = supervised_command(program, args)?;
    configure(&mut command);
    command.kill_on_drop(false);
    #[cfg(unix)]
    {
        use nix::sys::socket::{socketpair, AddressFamily, SockFlag, SockType};
        use std::os::fd::AsRawFd;
        let (gui_end, omp_end) = socketpair(AddressFamily::Unix, SockType::Stream, None, SockFlag::SOCK_CLOEXEC)?;
        let raw = omp_end.as_raw_fd();
        // SAFETY: `pre_exec` runs in the forked child before `exec`, where only
        // async-signal-safe calls are allowed; `dup2` and `fcntl` are. `raw` is
        // the omp-side end of the socketpair, kept open in the parent until the
        // spawn returns, so the number is valid at fork time. The dup to
        // `CONTROL_FD` clears close-on-exec on the new descriptor, which is how
        // the supervisor inherits exactly that one end.
        unsafe {
            command.pre_exec(move || {
                if raw == CONTROL_FD {
                    if libc::fcntl(raw, libc::F_SETFD, 0) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                } else if libc::dup2(raw, CONTROL_FD) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn()?;
        drop(omp_end);
        let stream = std::os::unix::net::UnixStream::from(gui_end);
        stream.set_nonblocking(true)?;
        let (control_read, control_write) = tokio::net::UnixStream::from_std(stream)?.into_split();
        Ok(Supervised { child, control_read, control_write })
    }
    #[cfg(not(unix))]
    {
        Ok(Supervised { child: command.spawn()? })
    }
}

/// The `pid <n>` line the supervisor writes right after spawning omp; `None` at EOF.
#[cfg(unix)]
pub(crate) async fn read_pid_line(control: &mut tokio::net::unix::OwnedReadHalf) -> Option<u32> {
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match control.read(&mut byte).await {
            Ok(0) | Err(_) => return None,
            Ok(_) if byte[0] == b'\n' => break,
            Ok(_) => line.push(byte[0]),
        }
    }
    let text = String::from_utf8_lossy(&line);
    text.strip_prefix("pid ").and_then(|pid| pid.trim().parse().ok())
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/// A live spawn cycle.
struct Spawned {
    id: u64,
    /// The direct child: the supervisor on Linux and macOS, omp itself on Windows.
    direct_pid: Option<u32>,
    stdin: mpsc::UnboundedSender<Vec<u8>>,
    #[cfg(unix)]
    control_write: Mutex<Option<tokio::net::unix::OwnedWriteHalf>>,
    /// Asks the wait task to `Child::kill` (SIGKILL) the direct child.
    kill_request: Mutex<Option<oneshot::Sender<()>>>,
    exited: watch::Receiver<bool>,
}

struct State {
    options: SidecarOptions,
    status: SidecarStatus,
    /// The last status payload, whole, for a window that subscribes after it was pushed.
    last_status: SidecarStatusPayload,
    child: Option<Arc<Spawned>>,
    rpc: Option<Arc<RpcClient>>,
    batcher: Option<Arc<dyn EventBatcher>>,
    restart_count: u32,
    /// Bumped by every `kill()`; a pending restart timer fires only when it still matches.
    restart_token: u64,
    restart_pending: bool,
    /// Spawn-cycle counter, bumped whenever a cycle is torn down or started, so a
    /// dead child can never report `ready` or reset the crash-loop counter.
    generation: u64,
    /// `start()` calls in flight; a superseded env resolution must not spawn.
    start_seq: u64,
    last_stderr: Vec<String>,
    spawn_env: HashMap<String, String>,
    /// Pack directory checked by the last `start()`; every spawn of this cycle loads it.
    pack_dir: PathBuf,
    resume_session_path: Option<String>,
    fresh_launch_pending: bool,
    disposed: bool,
    omp_pid: Option<u32>,
    supervisor_pid: Option<u32>,
}

struct Inner {
    ctx: CtxRef,
    state: Mutex<State>,
    events: mpsc::UnboundedSender<SidecarEvent>,
    spawn_env: SpawnEnvProvider,
    report_failure: FailureReporter,
    report_refusal: StartRefusalReporter,
}

pub(crate) struct SidecarManager {
    inner: Arc<Inner>,
}

impl SidecarManager {
    pub(crate) fn new(ctx: CtxRef, options: SidecarOptions, spawn_env: SpawnEnvProvider) -> (Arc<Self>, SidecarEvents) {
        Self::with_reporters(ctx, options, spawn_env, Arc::new(report_to_runtime_log), Arc::new(report_refusal_to_runtime_log))
    }

    pub(crate) fn with_reporters(
        ctx: CtxRef,
        options: SidecarOptions,
        spawn_env: SpawnEnvProvider,
        report_failure: FailureReporter,
        report_refusal: StartRefusalReporter,
    ) -> (Arc<Self>, SidecarEvents) {
        let (events, receiver) = mpsc::unbounded_channel();
        let fresh = options.fresh;
        let resume = options.resume_session_path.clone();
        let last_status = SidecarStatusPayload { status: SidecarStatus::Asleep, message: None, cwd: options.cwd.clone(), restart: None, refusal: None };
        let state = State {
            options,
            status: SidecarStatus::Asleep,
            last_status,
            child: None,
            rpc: None,
            batcher: None,
            restart_count: 0,
            restart_token: 0,
            restart_pending: false,
            generation: 0,
            start_seq: 0,
            last_stderr: Vec::new(),
            spawn_env: HashMap::new(),
            pack_dir: PathBuf::new(),
            resume_session_path: resume,
            fresh_launch_pending: fresh,
            disposed: false,
            omp_pid: None,
            supervisor_pid: None,
        };
        let inner = Arc::new(Inner { ctx, state: Mutex::new(state), events, spawn_env, report_failure, report_refusal });
        (Arc::new(Self { inner }), receiver)
    }
}

/// Roots searched for `resources/assistant-pack` when no pack sits beside the
/// binary: only dev and e2e builds, whose fixture sidecar lives outside the
/// tree. A shipped build loads the pack it bundles.
fn pack_search_from() -> Vec<PathBuf> {
    if tauri::is_dev() || cfg!(feature = "e2e-hooks") {
        vec![PathBuf::from(env!("CARGO_MANIFEST_DIR"))]
    } else {
        Vec::new()
    }
}

/// The production failure reporter: one `sidecar-restart` entry in `gui-runtime.jsonl`.
fn report_to_runtime_log(report: SidecarFailureReport) {
    let entry = json!({
        "source": "sidecar-restart",
        "message": report.reason,
        "details": { "attempt": report.attempt, "maxAttempts": report.max_attempts, "stderr": report.stderr },
    });
    crate::runtime_log::write(&entry, None, Some(&report.cwd));
}

/// The production refusal reporter: one `child-process` entry in `gui-runtime.jsonl`
/// (the log keeps only its listed sources and files any other as `unknown`).
fn report_refusal_to_runtime_log(report: SidecarStartRefusalReport) {
    let entry = json!({ "source": "child-process", "message": report.message });
    crate::runtime_log::write(&entry, None, Some(&report.cwd));
}

impl Inner {
    fn emit(&self, event: SidecarEvent) {
        let _ = self.events.send(event);
    }

    fn set_status(&self, status: SidecarStatus, message: Option<String>, restart: Option<SidecarRestartProgress>) {
        self.set_status_with_refusal(status, message, restart, None);
    }

    fn set_status_with_refusal(&self, status: SidecarStatus, message: Option<String>, restart: Option<SidecarRestartProgress>, refusal: Option<SidecarRefusal>) {
        let payload = {
            let mut state = lock(&self.state);
            state.status = status;
            state.last_status = SidecarStatusPayload { status, message, cwd: state.options.cwd.clone(), restart, refusal };
            state.last_status.clone()
        };
        self.emit(SidecarEvent::Status(payload));
    }

    /// An install problem stops the start before any spawn: the tab shows the
    /// message and the runtime log keeps it, since no process will write one.
    fn refuse_start(&self, message: String) {
        let cwd = lock(&self.state).options.cwd.clone();
        self.set_status(SidecarStatus::Error, Some(message.clone()), None);
        (self.report_refusal)(SidecarStartRefusalReport { message, cwd });
    }

    /// Continuation guard: false once the cycle that captured `generation` was torn down or replaced.
    fn is_live(&self, generation: u64) -> bool {
        let state = lock(&self.state);
        !state.disposed && state.generation == generation
    }

    fn start(self: &Arc<Self>) {
        let (packaged, binary) = {
            let state = lock(&self.state);
            if state.disposed {
                return;
            }
            (state.options.packaged, state.options.binary_path.clone())
        };
        // Closed loop: only the bundled binary may run. Missing it is an
        // actionable error, never an external fallback.
        if binary.as_os_str().is_empty() {
            self.refuse_start(missing_sidecar_message(packaged, None));
            return;
        }
        // The session is only an assistant with the whole pack: omp skips a missing
        // extension silently and reads a missing prompt path as literal text.
        let pack_dir = assistant_pack::resolve_pack_dir(&binary, &pack_search_from());
        if let Some(file) = assistant_pack::missing_pack_file(&pack_dir) {
            self.refuse_start(assistant_pack::missing_pack_message(file, packaged));
            return;
        }
        let resume = {
            let mut state = lock(&self.state);
            state.pack_dir = pack_dir;
            state.resume_session_path.clone()
        };
        // A chat-stamped file resumes without the pack's tools and fails startup:
        // refuse it, so the tab tells the user to start a new task instead.
        if let Some(session) = resume.filter(|session| assistant_pack::is_chat_stamped_session(Path::new(session))) {
            let message = format!("The session file is stamped chat: {session}");
            self.set_status_with_refusal(SidecarStatus::Error, Some(message), None, Some(SidecarRefusal::KindMismatch));
            return;
        }
        self.set_status(SidecarStatus::Starting, None, None);
        // Env resolution takes up to 4 s. A restart()/start() landing inside that
        // window supersedes this pending spawn, so spawning here would orphan the
        // newer child and tear it down with the session it just opened.
        let seq = {
            let mut state = lock(&self.state);
            state.start_seq += 1;
            state.start_seq
        };
        let inner = self.clone();
        let resolve = (self.spawn_env)();
        spawn_task(async move {
            let env = resolve.await;
            {
                let mut state = lock(&inner.state);
                if state.disposed || state.start_seq != seq {
                    return;
                }
                state.spawn_env = env;
            }
            inner.spawn().await;
        });
    }

    async fn spawn(self: &Arc<Self>) {
        // One live child per manager. Anything still attached means a previous
        // spawn was never retired: kill it through the normal teardown.
        let superseded = {
            let mut state = lock(&self.state);
            let superseded = state.child.take();
            if superseded.is_some() {
                self.cleanup_locked(&mut state);
            }
            superseded
        };
        if let Some(superseded) = superseded {
            Inner::terminate(&superseded);
        }
        let (options, mut args, generation, env) = {
            let mut state = lock(&self.state);
            state.generation += 1;
            state.last_stderr.clear();
            let mut args = vec!["--mode".to_string(), "rpc-ui".to_string()];
            if let Some(session) = &state.resume_session_path {
                args.extend(["--session".to_string(), session.clone()]);
            } else if state.fresh_launch_pending {
                args.push("--no-auto-resume".to_string());
            }
            args.extend(assistant_pack::pack_flags(&state.pack_dir, std::env::consts::OS));
            (state.options.clone(), args, state.generation, state.spawn_env.clone())
        };
        // Each local model's measured context limit, loaded after the pack's
        // config and watched by the sidecar, so a new limit applies without a restart.
        if let Some(overlay) = self.ctx.upgrade().and_then(|ctx| context_limits_overlay(&ctx.prefs.path())) {
            args.extend(["--config".to_string(), overlay.to_string_lossy().into_owned()]);
        }
        // `en` covers a context already gone at shutdown.
        let language = self.ctx.upgrade().map_or("en", |ctx| ctx.i18n.language().code());
        // User-controllable flags ride the extra_flags seam plus the launch
        // profile. Only the allowlisted flags of both are appended, so neither can
        // override the code-controlled argv above, while a --session-dir value that
        // merely looks like a protected flag survives intact.
        let mut user_flags = options.extra_flags.clone();
        user_flags.extend(launch_profile_flags(&self.ctx, &options.cwd));
        args.extend(allowed_launch_flags(&user_flags));

        let cwd = options.cwd.clone();
        let spawned = spawn_supervised(&options.binary_path, &args, |command| {
            command.current_dir(&cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
            command.env_remove("APPIMAGE_EXIT_AFTER_INSTALL");
            for (key, value) in &env {
                command.env(key, value);
            }
            command.env("PI_RPC_EMIT_TITLE", "1").env("PI_NO_PTY", "1").env("PI_NOTIFICATIONS", "off");
            // Ollama's native api carries `num_ctx`; over the OpenAI-compatible one
            // the server keeps its default context, below the agent's first request.
            command.env("PI_OLLAMA_API", "ollama-chat");
            // The window sent as `num_ctx` (capped at the model's trained context);
            // a user-set value, inherited or from the login shell, wins.
            if std::env::var_os("OLLAMA_CONTEXT_LENGTH").is_none() && !env.contains_key("OLLAMA_CONTEXT_LENGTH") {
                command.env("OLLAMA_CONTEXT_LENGTH", paths::SIDECAR_DEFAULT_OLLAMA_CONTEXT.to_string());
            }
            // No startup file may ride along into the pack tools' system programs,
            // no profile or role override may redirect omp away from the pack's
            // settings, and no online provider credential may reach the session.
            for key in assistant_pack::REMOVED_ENV {
                command.env_remove(key);
            }
            for (key, value) in assistant_pack::pack_env(language) {
                command.env(key, value);
            }
        });
        let mut supervised = match spawned {
            Ok(supervised) => supervised,
            Err(error) => {
                // A spawn failure (ENOENT, EACCES) is a sidecar failure plus retry.
                self.attempt_restart(error.to_string());
                return;
            }
        };
        let direct_pid = supervised.child.id();
        let (stdin_tx, stdin_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (exited_tx, exited_rx) = watch::channel(false);
        let (kill_tx, kill_rx) = oneshot::channel();
        let spawned = Arc::new(Spawned {
            id: generation,
            direct_pid,
            stdin: stdin_tx.clone(),
            #[cfg(unix)]
            control_write: Mutex::new(Some(supervised.control_write)),
            kill_request: Mutex::new(Some(kill_tx)),
            exited: exited_rx,
        });
        let sender: Arc<dyn Fn(Value) + Send + Sync> = Arc::new(move |frame: Value| {
            let mut bytes = serde_json::to_vec(&frame).unwrap_or_default();
            bytes.push(b'\n');
            let _ = stdin_tx.send(bytes);
        });
        let events = self.events.clone();
        let batcher: Arc<dyn EventBatcher> = Arc::new(super::event_batcher::Batcher::new(Box::new(move |batch| {
            let _ = events.send(SidecarEvent::Events(batch));
        })));
        {
            let mut state = lock(&self.state);
            state.child = Some(spawned.clone());
            state.rpc = Some(Arc::new(RpcClient::new(sender)));
            state.batcher = Some(batcher);
            #[cfg(unix)]
            {
                state.supervisor_pid = direct_pid;
                state.omp_pid = None;
            }
            #[cfg(not(unix))]
            {
                state.supervisor_pid = None;
                state.omp_pid = direct_pid;
            }
        }

        if let Some(mut stdin) = supervised.child.stdin.take() {
            let mut rx = stdin_rx;
            spawn_task(async move {
                while let Some(bytes) = rx.recv().await {
                    if stdin.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
            });
        }
        if let Some(stdout) = supervised.child.stdout.take() {
            let inner = self.clone();
            spawn_task(async move {
                attach_ndjson_parser(stdout, |frame| inner.route_frame(generation, frame)).await;
            });
        }
        if let Some(mut stderr) = supervised.child.stderr.take() {
            let inner = self.clone();
            spawn_task(async move {
                let mut buffer = vec![0u8; 8192];
                loop {
                    match stderr.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => inner.on_stderr(generation, &buffer[..read]),
                    }
                }
            });
        }
        #[cfg(unix)]
        {
            let inner = self.clone();
            let mut control_read = supervised.control_read;
            spawn_task(async move {
                let pid = read_pid_line(&mut control_read).await;
                let mut state = lock(&inner.state);
                if state.child.as_ref().map(|child| child.id) == Some(generation) {
                    state.omp_pid = pid;
                }
            });
        }
        let inner = self.clone();
        let mut child = supervised.child;
        spawn_task(async move {
            let status = tokio::select! {
                status = child.wait() => status,
                _ = kill_rx => {
                    let _ = child.start_kill();
                    child.wait().await
                }
            };
            let _ = exited_tx.send(true);
            inner.on_exit(generation, status);
        });
    }

    fn on_stderr(&self, spawn_id: u64, chunk: &[u8]) {
        let text = String::from_utf8_lossy(chunk);
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        {
            let mut state = lock(&self.state);
            if state.child.as_ref().map(|child| child.id) != Some(spawn_id) {
                return;
            }
            for line in text.split('\n') {
                state.last_stderr.push(line.to_string());
                if state.last_stderr.len() > STDERR_TAIL_LINES {
                    state.last_stderr.remove(0);
                }
            }
        }
        self.emit(SidecarEvent::Stderr(text.to_string()));
    }

    fn route_frame(self: &Arc<Self>, spawn_id: u64, frame: Value) {
        let Some(object) = frame.as_object() else { return };
        let (rpc, batcher) = {
            let state = lock(&self.state);
            if state.child.as_ref().map(|child| child.id) != Some(spawn_id) {
                return;
            }
            (state.rpc.clone(), state.batcher.clone())
        };
        let kind = object.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "ready" => {
                self.handle_ready(&frame);
                return;
            }
            "response" if rpc.as_ref().map(|rpc| rpc.on_response(&frame)).unwrap_or(false) => return,
            _ => {}
        }
        let typed = match kind {
            "extension_ui_request" => Some(SidecarEvent::ExtensionUi(frame.clone())),
            "host_tool_call" => Some(SidecarEvent::HostToolCall(frame.clone())),
            "host_uri_request" => Some(SidecarEvent::HostUriRequest(frame.clone())),
            "subagent_lifecycle" | "subagent_progress" | "subagent_event" => Some(SidecarEvent::SubagentFrame(frame.clone())),
            "available_commands_update" => Some(SidecarEvent::CommandsUpdate(object.get("commands").and_then(Value::as_array).cloned().unwrap_or_default())),
            "model_catalog_update" => Some(SidecarEvent::ModelCatalogUpdate(frame.clone())),
            "config_update" => Some(SidecarEvent::ConfigUpdate(frame.clone())),
            "prompt_result" => Some(SidecarEvent::PromptResult(frame.clone())),
            "command_output" => Some(SidecarEvent::CommandOutput(frame.clone())),
            "session_info_update" => Some(SidecarEvent::SessionInfoUpdate(frame.clone())),
            "extension_error" => Some(SidecarEvent::ExtensionError(frame.clone())),
            "live_update" => Some(SidecarEvent::LiveUpdate(frame.clone())),
            _ => None,
        };
        if let Some(event) = typed {
            self.emit(event);
            self.emit(SidecarEvent::Frame(frame));
            return;
        }
        if AGENT_EVENT_TYPES.contains(&kind) {
            if let Some(batcher) = batcher {
                batcher.push(frame.clone());
            }
            self.emit(SidecarEvent::Frame(frame));
            return;
        }
        // Other extension/host frames not consumed directly by the renderer.
        self.emit(SidecarEvent::Frame(frame));
    }

    fn handle_ready(self: &Arc<Self>, ready: &Value) {
        let (generation, rpc) = {
            let mut state = lock(&self.state);
            state.resume_session_path = None;
            // Freshness is a creation contract, not a restart policy: once the tab
            // has booted, later restarts may auto-resume the session it opened.
            state.fresh_launch_pending = false;
            (state.generation, state.rpc.clone())
        };
        // Stay on v1 when an older sidecar omits the negotiation fields or
        // advertises limits this decoder cannot honor. Negotiation settles after
        // this frame, and when the sidecar dies on boot the pending command is
        // rejected on a generation that is already gone: the guard keeps that
        // rejection from announcing "ready" and zeroing the restart counter.
        if supports_rpc_protocol_v2(ready) {
            if let Some(rpc) = rpc {
                let negotiate = rpc.command(json!({ "type": "negotiate_protocol", "protocolVersion": 2 }), None);
                let inner = self.clone();
                spawn_task(async move {
                    let _ = negotiate.await;
                    inner.announce_ready(generation);
                });
                return;
            }
        }
        self.announce_ready(generation);
    }

    fn announce_ready(&self, generation: u64) {
        if !self.is_live(generation) {
            return;
        }
        lock(&self.state).restart_count = 0;
        self.set_status(SidecarStatus::Ready, None, None);
    }

    fn on_exit(self: &Arc<Self>, spawn_id: u64, status: std::io::Result<std::process::ExitStatus>) {
        let disposed = {
            let mut state = lock(&self.state);
            if state.child.as_ref().map(|child| child.id) != Some(spawn_id) {
                return;
            }
            self.cleanup_locked(&mut state);
            state.disposed
        };
        if disposed {
            return;
        }
        match status {
            Ok(status) if status.code() == Some(0) => self.set_status(SidecarStatus::Exited, Some("Normal shutdown".to_string()), None),
            Ok(status) => self.attempt_restart(describe_exit(&status)),
            Err(error) => self.attempt_restart(error.to_string()),
        }
    }

    fn attempt_restart(self: &Arc<Self>, reason: String) {
        let (detail, exhausted, attempt, report) = {
            let state = lock(&self.state);
            // The exit code alone is never the diagnosis; the spawn's stderr carries it.
            let excerpt = stderr_excerpt(&state.last_stderr);
            let detail = if excerpt.is_empty() { reason } else { format!("{reason} — {excerpt}") };
            let exhausted = state.restart_count >= MAX_RESTART_ATTEMPTS;
            let attempt = if exhausted { MAX_RESTART_ATTEMPTS } else { state.restart_count + 1 };
            let report = SidecarFailureReport { reason: detail.clone(), attempt, max_attempts: MAX_RESTART_ATTEMPTS, stderr: state.last_stderr.clone(), cwd: state.options.cwd.clone() };
            (detail, exhausted, attempt, report)
        };
        (self.report_failure)(report);
        let progress = SidecarRestartProgress { attempt, max_attempts: MAX_RESTART_ATTEMPTS };
        if exhausted {
            self.set_status(SidecarStatus::Error, Some(detail), Some(progress));
            return;
        }
        let delay = RESTART_DELAYS_MS.get((attempt - 1) as usize).copied().unwrap_or(4000);
        let token = {
            let mut state = lock(&self.state);
            state.restart_count = attempt;
            state.restart_token += 1;
            state.restart_pending = true;
            state.restart_token
        };
        self.set_status(SidecarStatus::Restarting, Some(detail), Some(progress));
        let inner = self.clone();
        spawn_task(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            let go = {
                let mut state = lock(&inner.state);
                let go = !state.disposed && state.restart_pending && state.restart_token == token;
                if go {
                    state.restart_pending = false;
                }
                go
            };
            if go {
                inner.spawn().await;
            }
        });
    }

    /// Retire the current cycle's parser, batcher and client. Any async
    /// continuation of the cycle is stale from here on.
    fn cleanup_locked(&self, state: &mut State) {
        state.generation += 1;
        if let Some(batcher) = state.batcher.take() {
            batcher.flush_now();
            batcher.dispose();
        }
        if let Some(rpc) = state.rpc.take() {
            rpc.reject_all("Sidecar disconnected");
        }
        state.child = None;
        state.omp_pid = None;
        state.supervisor_pid = None;
    }

    /// Start the stop: close the control channel and SIGTERM the supervisor,
    /// which runs its own SIGTERM → grace → SIGKILL → sweep sequence.
    fn terminate(child: &Spawned) {
        #[cfg(unix)]
        {
            drop(lock(&child.control_write).take());
            if let Some(pid) = child.direct_pid {
                let _ = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), nix::sys::signal::Signal::SIGTERM);
            }
        }
        #[cfg(not(unix))]
        {
            if let Some(request) = lock(&child.kill_request).take() {
                let _ = request.send(());
            }
        }
    }

    fn kill(self: &Arc<Self>) -> BoxFuture<'static, ()> {
        let child = {
            let mut state = lock(&self.state);
            state.restart_token += 1;
            state.restart_pending = false;
            let child = state.child.take();
            self.cleanup_locked(&mut state);
            child
        };
        let Some(child) = child else { return Box::pin(std::future::ready(())) };
        Inner::terminate(&child);
        let cwd = lock(&self.state).options.cwd.clone();
        Box::pin(async move {
            let mut exited = child.exited.clone();
            if tokio::time::timeout(SUPERVISOR_EXIT_GRACE, exited.wait_for(|done| *done)).await.is_err() {
                crate::runtime_log::note(
                    "child-process",
                    "sidecar supervisor ignored SIGTERM; sending SIGKILL",
                    json!({ "cwd": cwd, "graceMs": SUPERVISOR_EXIT_GRACE.as_millis() as u64 }),
                );
                let request = lock(&child.kill_request).take();
                if let Some(request) = request {
                    let _ = request.send(());
                }
                let _ = exited.wait_for(|done| *done).await;
            }
        })
    }
}

fn describe_exit(status: &std::process::ExitStatus) -> String {
    let code = status.code().map(|code| code.to_string()).unwrap_or_else(|| "null".to_string());
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.signal().map(|signal| match nix::sys::signal::Signal::try_from(signal) {
            Ok(name) => format!(" (signal: {name})"),
            Err(_) => format!(" (signal: {signal})"),
        })
    };
    #[cfg(not(unix))]
    let signal: Option<String> = None;
    format!("Exit code {code}{}", signal.unwrap_or_default())
}

impl SidecarHandle for SidecarManager {
    fn status(&self) -> SidecarStatus {
        lock(&self.inner.state).status
    }

    fn status_payload(&self) -> SidecarStatusPayload {
        let state = lock(&self.inner.state);
        // The folder may have moved since (`adopt_cwd`); report where the sidecar runs now.
        SidecarStatusPayload { cwd: state.options.cwd.clone(), ..state.last_status.clone() }
    }

    fn cwd(&self) -> String {
        lock(&self.inner.state).options.cwd.clone()
    }

    fn kind(&self) -> SessionKind {
        lock(&self.inner.state).options.kind
    }

    fn omp_pid(&self) -> Option<u32> {
        lock(&self.inner.state).omp_pid
    }

    fn supervisor_pid(&self) -> Option<u32> {
        lock(&self.inner.state).supervisor_pid
    }

    fn has_rpc_client(&self) -> bool {
        lock(&self.inner.state).rpc.is_some()
    }

    fn start(&self) {
        self.inner.start();
    }

    fn request(&self, command: Value, timeout_ms: Option<u64>) -> BoxFuture<'static, Result<Value, SidecarError>> {
        let rpc = lock(&self.inner.state).rpc.clone();
        match rpc {
            Some(rpc) => rpc.command(command, timeout_ms),
            None => Box::pin(std::future::ready(Err(SidecarError::NotRunning))),
        }
    }

    fn send_side_channel(&self, frame: Value) {
        let child = lock(&self.inner.state).child.clone();
        if let Some(child) = child {
            let mut bytes = serde_json::to_vec(&frame).unwrap_or_default();
            bytes.push(b'\n');
            let _ = child.stdin.send(bytes);
        }
    }

    fn mark_unhealthy(&self, reason: &str) {
        self.inner.set_status(SidecarStatus::Error, Some(reason.to_string()), None);
    }

    /// Adopt a new logical cwd without a respawn: `switch_session` onto a file
    /// rooted in another workspace re-roots the agent, and every consumer
    /// (status payloads, plain restarts, launch-profile lookup) follows it.
    fn adopt_cwd(&self, cwd: &str) -> bool {
        let mut state = lock(&self.inner.state);
        if state.options.cwd == cwd {
            return false;
        }
        state.options.cwd = cwd.to_string();
        true
    }

    fn restart(&self, cwd: Option<&str>, resume_session_path: Option<&str>) {
        // The stop is initiated synchronously; the old supervisor finishes on its own.
        drop(self.inner.kill());
        {
            let mut state = lock(&self.inner.state);
            if let Some(cwd) = cwd {
                state.options.cwd = cwd.to_string();
            }
            state.resume_session_path = resume_session_path.map(str::to_string);
            state.restart_count = 0;
        }
        self.inner.start();
    }

    fn kill(&self) -> BoxFuture<'static, ()> {
        self.inner.kill()
    }

    fn dispose(&self) -> BoxFuture<'static, ()> {
        lock(&self.inner.state).disposed = true;
        self.inner.kill()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::bridge::Registry;
    use crate::testing::{fake_ctx_with, Fakes};
    use std::sync::Weak;

    pub(crate) fn fixture_path() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("e2e").join("sidecar-fixture.ts").canonicalize().unwrap()
    }

    pub(crate) fn fixed_env(pairs: &[(&str, &str)]) -> SpawnEnvProvider {
        let env: HashMap<String, String> = pairs.iter().map(|(key, value)| (key.to_string(), value.to_string())).collect();
        Arc::new(move || Box::pin(std::future::ready(env.clone())))
    }

    pub(crate) fn options(binary: PathBuf, cwd: &Path) -> SidecarOptions {
        SidecarOptions { binary_path: binary, cwd: cwd.to_string_lossy().into_owned(), extra_flags: Vec::new(), packaged: false, fresh: false, kind: SessionKind::Agent, resume_session_path: None }
    }

    /// The pack a fixture sidecar outside the tree resolves through the dev fallback.
    fn dev_pack() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("resources").join("assistant-pack")
    }

    /// The `--tools` value of the spawn contract for the platform running the suite.
    fn pack_tools() -> &'static str {
        if cfg!(target_os = "linux") {
            "read,glob,write,ask,diagnose,system_status,open_item,os_setting,office_report,office_slides,office_clean"
        } else {
            "read,glob,write,ask,office_report,office_slides,office_clean"
        }
    }

    /// The pack part of the spawn argv, written out so the test does not restate the code it checks.
    fn expected_pack_flags(pack: &Path) -> Vec<String> {
        vec![
            "--no-extensions".to_string(),
            "--no-rules".to_string(),
            "--no-context-files".to_string(),
            "--extension".to_string(),
            pack.to_string_lossy().into_owned(),
            "--tools".to_string(),
            pack_tools().to_string(),
            "--system-prompt".to_string(),
            pack.join("system-prompt.md").to_string_lossy().into_owned(),
            "--append-system-prompt".to_string(),
            pack.join("append-system-prompt.md").to_string_lossy().into_owned(),
            "--config".to_string(),
            pack.join("config.yml").to_string_lossy().into_owned(),
            "--approval-mode".to_string(),
            "always-ask".to_string(),
        ]
    }

    fn argv(head: &[&str], pack: &Path, tail: &[&str]) -> Vec<String> {
        let mut argv: Vec<String> = head.iter().map(|arg| arg.to_string()).collect();
        argv.extend(expected_pack_flags(pack));
        argv.extend(tail.iter().map(|arg| arg.to_string()));
        argv
    }

    /// A bun script standing in for omp, as the TS tests write them.
    fn write_script(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("fake-sidecar.ts");
        crate::omp::test_support::write_executable(&path, &format!("#!/usr/bin/env bun\n{body}\n"));
        path
    }

    fn manager(options: SidecarOptions) -> (Arc<SidecarManager>, SidecarEvents) {
        SidecarManager::new(Weak::new(), options, fixed_env(&[]))
    }

    async fn wait_for_ready(events: &mut SidecarEvents) {
        tokio::time::timeout(Duration::from_secs(20), async {
            while let Some(event) = events.recv().await {
                if matches!(event, SidecarEvent::Status(ref payload) if payload.status == SidecarStatus::Ready) {
                    return;
                }
            }
            panic!("event stream closed before ready");
        })
        .await
        .expect("sidecar became ready");
    }

    async fn wait_for_pid(sidecar: &SidecarManager) -> u32 {
        for _ in 0..200 {
            if let Some(pid) = sidecar.omp_pid() {
                return pid;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the supervisor never reported omp's pid");
    }

    /// omp's argv after the fixture path, from `/proc`.
    async fn launch_argv(sidecar: &SidecarManager) -> Vec<String> {
        let pid = wait_for_pid(sidecar).await;
        let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap();
        let args: Vec<String> = cmdline.split(|byte| *byte == 0).filter(|part| !part.is_empty()).map(|part| String::from_utf8_lossy(part).into_owned()).collect();
        let start = args.iter().position(|arg| arg == "--mode").expect("--mode in argv");
        args[start..].to_vec()
    }

    async fn collect_until<F: Fn(&SidecarStatusPayload) -> bool>(events: &mut SidecarEvents, timeout: Duration, done: F) -> Vec<SidecarStatusPayload> {
        let mut statuses = Vec::new();
        let _ = tokio::time::timeout(timeout, async {
            while let Some(event) = events.recv().await {
                if let SidecarEvent::Status(payload) = event {
                    let finished = done(&payload);
                    statuses.push(payload);
                    if finished {
                        return;
                    }
                }
            }
        })
        .await;
        statuses
    }

    fn strip(flags: &[&str]) -> Vec<String> {
        allowed_launch_flags(&flags.iter().map(|flag| flag.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn keeps_only_the_allowed_launch_flags_pair_aware() {
        // The value of an allowed valued flag is data, even when it looks like a flag.
        assert_eq!(strip(&["--session", "x", "--session-dir", "--session", "--mode=print", "--no-lsp", "positional"]), vec!["--session-dir", "--session", "--no-lsp"]);
        assert_eq!(strip(&["--session", "--session-dir", "/s"]), vec!["--session-dir", "/s"]);
        // Bare flags that change what a session loads or approves.
        for flag in ["--no-tools", "--no-extensions", "--no-skills", "--auto-approve", "--yolo", "--plan-yolo", "--no-rules", "--no-context-files", "--chat"] {
            assert_eq!(strip(&[flag, "--no-lsp"]), vec!["--no-lsp"], "{flag}");
            assert_eq!(strip(&[&format!("{flag}=1"), "--no-lsp"]), vec!["--no-lsp"], "{flag}=1");
        }
        // Valued ones lose their value too, in both forms.
        for flag in [
            "--extension",
            "--hook",
            "--tools",
            "--system-prompt",
            "--system-prompt-template",
            "--append-system-prompt",
            "--config",
            "--approval-mode",
            "--skills",
            "--plugin-dir",
            "--trusted-extension",
            "--profile",
            "--plan-yolo-into",
            "--add-dir",
        ] {
            assert_eq!(strip(&[flag, "/value", "--no-lsp"]), vec!["--no-lsp"], "{flag}");
            assert_eq!(strip(&[&format!("{flag}=/value"), "--no-lsp"]), vec!["--no-lsp"], "{flag}=");
        }
        assert_eq!(strip(&["--config", "--mode=text"]), Vec::<String>::new());
        // No short option is allowed, and a dropped flag's value never stays behind as a positional.
        assert_eq!(strip(&["-e", "/y", "--no-lsp"]), vec!["--no-lsp"]);
        assert_eq!(strip(&["-e/y", "--session-dir", "/s"]), vec!["--session-dir", "/s"]);
        assert_eq!(strip(&["-x", "value", "--no-lsp"]), vec!["--no-lsp"]);
        assert_eq!(strip(&["stray", "--no-lsp", "-", "--"]), vec!["--no-lsp"]);
        // Only --no-lsp and --session-dir with its value are allowed: every other
        // flag goes, `--=x` (omp's end-of-options marker plus a value) included.
        for tokens in [
            &["--=x"][..],
            &["--continue"],
            &["--from-claude", "/claude/session"],
            &["--from-codex", "/codex/session"],
            &["--advisor"],
            &["--alias", "name"],
            &["--allow-home"],
            &["--model", "gpt"],
        ] {
            let mut flags = tokens.to_vec();
            flags.extend(["--no-lsp", "--session-dir", "/s"]);
            assert_eq!(strip(&flags), vec!["--no-lsp", "--session-dir", "/s"], "{tokens:?}");
        }
        assert_eq!(strip(&["--no-lsp", "--session-dir", "/s"]), vec!["--no-lsp", "--session-dir", "/s"]);
        assert_eq!(strip(&["--no-lsp=1", "--session-dir=/s", "--session-dir"]), Vec::<String>::new());
        // A stored profile maps only the fields that cannot change what a session loads.
        let profile = json!({
            "systemPrompt": "s",
            "appendSystemPrompt": "a",
            "noRules": true,
            "addDirs": ["/a"],
            "tools": ["bash"],
            "noLsp": true,
            "planYolo": true,
            "profile": "p",
            "sessionDir": " /s ",
            "config": "/c.yml",
        });
        assert_eq!(launch_profile_to_flags(&profile), vec!["--no-lsp", "--session-dir", "/s"]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn passes_the_active_session_path_on_a_manual_restart() {
        let dir = tempfile::tempdir().unwrap();
        let session_path = dir.path().join("session.jsonl");
        let (sidecar, mut events) = manager(options(fixture_path(), dir.path()));
        sidecar.start();
        wait_for_ready(&mut events).await;
        sidecar.restart(None, Some(&session_path.to_string_lossy()));
        wait_for_ready(&mut events).await;
        let launch = launch_argv(&sidecar).await;
        sidecar.dispose().await;
        assert_eq!(launch, argv(&["--mode", "rpc-ui", "--session", &session_path.to_string_lossy()], &dev_pack(), &[]));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn spawns_every_sidecar_with_the_assistant_pack_flags_and_never_chat() {
        let dir = tempfile::tempdir().unwrap();
        let mut options = options(fixture_path(), dir.path());
        // A tab created as a chat still gets the pack: the chat branch is gone.
        options.kind = SessionKind::Chat;
        options.fresh = true;
        // Shell startup files, omp profile selectors, role model overrides and
        // online provider credentials reaching the spawn env are removed; the
        // local Ollama address survives; the app language is set last (`en`
        // without an app context).
        let (sidecar, mut events) = SidecarManager::new(
            Weak::new(),
            options,
            fixed_env(&[
                ("BASH_ENV", "/rc/bash_env"),
                ("ENV", "/rc/env"),
                ("OMP_PROFILE", "work"),
                ("PI_PROFILE", "work"),
                ("PI_SMOL_MODEL", "anthropic/claude-haiku-4-5"),
                ("ANTHROPIC_API_KEY", "sk-ant"),
                ("OPENAI_API_KEY", "sk-openai"),
                ("OLLAMA_CLOUD_API_KEY", "cloud"),
                ("OLLAMA_HOST", "127.0.0.1:11434"),
                ("SAI_ATLAS_LANG", "xx"),
            ]),
        );
        sidecar.start();
        wait_for_ready(&mut events).await;
        let launch = launch_argv(&sidecar).await;
        let pid = wait_for_pid(&sidecar).await;
        let environ = std::fs::read(format!("/proc/{pid}/environ")).unwrap_or_default();
        sidecar.dispose().await;
        let child_env: HashMap<String, String> = environ
            .split(|byte| *byte == 0)
            .filter_map(|entry| String::from_utf8_lossy(entry).split_once('=').map(|(key, value)| (key.to_string(), value.to_string())))
            .collect();
        assert_eq!(child_env.get("SAI_ATLAS_LANG").map(String::as_str), Some("en"));
        assert_eq!(child_env.get("BASH_ENV"), None);
        assert_eq!(child_env.get("ENV"), None);
        assert_eq!(child_env.get("OMP_PROFILE"), None);
        assert_eq!(child_env.get("PI_PROFILE"), None);
        assert_eq!(child_env.get("PI_SMOL_MODEL"), None);
        assert_eq!(child_env.get("ANTHROPIC_API_KEY"), None);
        assert_eq!(child_env.get("OPENAI_API_KEY"), None);
        assert_eq!(child_env.get("OLLAMA_CLOUD_API_KEY"), None);
        assert_eq!(child_env.get("OLLAMA_HOST").map(String::as_str), Some("127.0.0.1:11434"));
        let pack = dev_pack();
        let expected = vec![
            "--mode".to_string(),
            "rpc-ui".to_string(),
            "--no-auto-resume".to_string(),
            "--no-extensions".to_string(),
            "--no-rules".to_string(),
            "--no-context-files".to_string(),
            "--extension".to_string(),
            pack.to_string_lossy().into_owned(),
            "--tools".to_string(),
            pack_tools().to_string(),
            "--system-prompt".to_string(),
            pack.join("system-prompt.md").to_string_lossy().into_owned(),
            "--append-system-prompt".to_string(),
            pack.join("append-system-prompt.md").to_string_lossy().into_owned(),
            "--config".to_string(),
            pack.join("config.yml").to_string_lossy().into_owned(),
            "--approval-mode".to_string(),
            "always-ask".to_string(),
        ];
        assert_eq!(launch, expected);
        assert!(!launch.iter().any(|arg| arg == "--chat"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn refuses_to_resume_a_chat_stamped_session_without_spawning() {
        let dir = tempfile::tempdir().unwrap();
        let spawned = dir.path().join("spawned");
        let script = write_script(
            dir.path(),
            &format!(
                r#"import * as fs from "node:fs";
fs.writeFileSync({spawned:?}, "1");
process.stdout.write(JSON.stringify({{ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }}) + "\n");
process.stdin.resume();"#,
                spawned = spawned.to_string_lossy()
            ),
        );
        let session_path = dir.path().join("old-chat.jsonl");
        std::fs::write(&session_path, "{\"title\":\"Old chat\"}\n{\"type\":\"session\",\"id\":\"c\",\"kind\":\"chat\"}\n").unwrap();
        let (sidecar, mut events) = manager(options(script, dir.path()));
        // A restored tab resumes its file this way the first time it is shown.
        sidecar.restart(None, Some(&session_path.to_string_lossy()));
        let first = events.try_recv().expect("a status right away");
        assert_eq!(sidecar.status(), SidecarStatus::Error);
        // Asking again for the same file stays refused.
        sidecar.restart(None, Some(&session_path.to_string_lossy()));
        let second = events.try_recv().expect("a second status right away");
        tokio::time::sleep(Duration::from_millis(500)).await;
        let later: Vec<SidecarEvent> = std::iter::from_fn(|| events.try_recv().ok()).collect();
        let has_rpc = sidecar.has_rpc_client();
        sidecar.dispose().await;
        for event in [first, second] {
            let SidecarEvent::Status(payload) = event else { panic!("expected a status") };
            assert_eq!(payload.status, SidecarStatus::Error);
            assert_eq!(payload.refusal, Some(SidecarRefusal::KindMismatch));
        }
        assert!(later.iter().all(|event| !matches!(event, SidecarEvent::Status(_))));
        assert!(!has_rpc);
        assert!(!spawned.exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn surfaces_a_reinstall_instruction_when_a_pack_file_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let spawned = dir.path().join("spawned");
        let script = write_script(
            dir.path(),
            &format!(
                r#"import * as fs from "node:fs";
fs.writeFileSync({spawned:?}, "1");
process.stdout.write(JSON.stringify({{ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }}) + "\n");
process.stdin.resume();"#,
                spawned = spawned.to_string_lossy()
            ),
        );
        // The directory exists with one listed file left out, so no fallback applies.
        let pack = dir.path().join("assistant-pack");
        for file in crate::omp::assistant_pack::ASSISTANT_PACK_FILES.iter().filter(|file| **file != "config.yml") {
            let path = pack.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "x").unwrap();
        }
        std::fs::create_dir_all(&pack).unwrap();
        let mut options = options(script, dir.path());
        options.packaged = true;
        let (sidecar, mut events) = manager(options);
        sidecar.start();
        let first = events.try_recv().expect("a status right away");
        tokio::time::sleep(Duration::from_millis(500)).await;
        let later: Vec<SidecarEvent> = std::iter::from_fn(|| events.try_recv().ok()).collect();
        let has_rpc = sidecar.has_rpc_client();
        sidecar.dispose().await;
        let SidecarEvent::Status(payload) = first else { panic!("expected a status") };
        assert_eq!(payload.status, SidecarStatus::Error);
        let message = payload.message.unwrap_or_default();
        assert!(message.contains("config.yml"), "{message}");
        assert!(message.contains("Reinstall Sai ATLAS"), "{message}");
        assert!(later.iter().all(|event| !matches!(event, SidecarEvent::Status(_))));
        assert!(!has_rpc);
        assert!(!spawned.exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn forces_a_freshly_created_tab_to_bypass_the_cli_auto_resume_setting() {
        let dir = tempfile::tempdir().unwrap();
        let mut options = options(fixture_path(), dir.path());
        options.fresh = true;
        let (sidecar, mut events) = manager(options);
        sidecar.start();
        wait_for_ready(&mut events).await;
        let launch = launch_argv(&sidecar).await;
        assert_eq!(launch, argv(&["--mode", "rpc-ui", "--no-auto-resume"], &dev_pack(), &[]));
        sidecar.restart(None, None);
        wait_for_ready(&mut events).await;
        let restart_launch = launch_argv(&sidecar).await;
        sidecar.dispose().await;
        assert_eq!(restart_launch, argv(&["--mode", "rpc-ui"], &dev_pack(), &[]));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn routes_prompt_results_and_text_mode_command_output_as_dedicated_frames() {
        let dir = tempfile::tempdir().unwrap();
        let script = write_script(
            dir.path(),
            r#"process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\n");
process.stdout.write(JSON.stringify({ type: "prompt_result", id: "local-command", agentInvoked: false }) + "\n");
process.stdout.write(JSON.stringify({ type: "command_output", text: "Enabled models" }) + "\n");
process.stdin.resume();"#,
        );
        let (sidecar, mut events) = manager(options(script, dir.path()));
        sidecar.start();
        let mut prompt_result = None;
        let mut command_output = None;
        tokio::time::timeout(Duration::from_secs(20), async {
            while let Some(event) = events.recv().await {
                match event {
                    SidecarEvent::PromptResult(frame) => prompt_result = Some(frame),
                    SidecarEvent::CommandOutput(frame) => command_output = Some(frame),
                    _ => {}
                }
                if prompt_result.is_some() && command_output.is_some() {
                    return;
                }
            }
        })
        .await
        .unwrap();
        sidecar.dispose().await;
        assert_eq!(prompt_result, Some(json!({ "type": "prompt_result", "id": "local-command", "agentInvoked": false })));
        assert_eq!(command_output, Some(json!({ "type": "command_output", "text": "Enabled models" })));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn appends_the_workspace_launch_profile_flags_at_spawn_denylist_proof() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let fakes = Fakes::default();
        let ctx = fake_ctx_with(&fakes, Registry::new());
        let cwd = workspace.to_string_lossy().into_owned();
        ctx.prefs
            .set(
                "launchProfiles",
                json!({
                    cwd.clone(): {
                        "appendSystemPrompt": "GUI injected",
                        "noRules": true,
                        "addDirs": ["/data/extra"],
                        "tools": ["edit"],
                        "config": "/x",
                        "noLsp": true,
                        "sessionDir": "/data/sessions",
                        // Smuggled keys that could reach code-controlled flags are dropped before the mapping.
                        "--session": "hijack",
                        "session": "hijack",
                    }
                }),
            )
            .unwrap();
        // The extra-flags seam carries what a stored profile cannot express.
        let smuggled = ["--tools", "edit", "--yolo", "--config", "/x", "-e", "/y", "--hook", "/z", "--no-context-files"];
        let mut options = options(fixture_path(), &workspace);
        options.extra_flags = smuggled.iter().map(|flag| flag.to_string()).collect();
        let (sidecar, mut events) = SidecarManager::new(Arc::downgrade(&ctx), options, fixed_env(&[]));
        sidecar.start();
        wait_for_ready(&mut events).await;
        let launch = launch_argv(&sidecar).await;
        sidecar.dispose().await;
        // Only the profile flags that cannot change what the session loads survive,
        // after the app's own context limits overlay.
        let overlay = fakes.dir.path().join("ollama-context-limits.yml").to_string_lossy().into_owned();
        assert_eq!(launch, argv(&["--mode", "rpc-ui"], &dev_pack(), &["--config", &overlay, "--no-lsp", "--session-dir", "/data/sessions"]));
        // Flags the pack passes itself, so a profile's copy shows up as a second occurrence.
        let pack_owned = ["--tools", "--config", "--append-system-prompt", "--no-rules", "--no-context-files"];
        for token in smuggled.iter().chain(["GUI injected", "--append-system-prompt", "--no-rules", "--add-dir", "/data/extra"].iter()) {
            if pack_owned.contains(token) {
                continue;
            }
            assert!(!launch.iter().any(|arg| arg == token), "{token} survived");
        }
        // The pack's own flags appear once each (`--config` once more for the
        // app's overlay); the profile's copies are gone.
        for flag in pack_owned {
            let expected = if flag == "--config" { 2 } else { 1 };
            assert_eq!(launch.iter().filter(|arg| *arg == flag).count(), expected, "{flag}");
        }
        assert!(!launch.iter().any(|arg| arg == "/x"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn passes_the_context_limits_overlay_after_the_pack_config_and_creates_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let fakes = Fakes::default();
        let ctx = fake_ctx_with(&fakes, Registry::new());
        let overlay = fakes.dir.path().join("ollama-context-limits.yml");
        assert!(!overlay.exists());
        let (sidecar, mut events) = SidecarManager::new(Arc::downgrade(&ctx), options(fixture_path(), dir.path()), fixed_env(&[]));
        sidecar.start();
        wait_for_ready(&mut events).await;
        let launch = launch_argv(&sidecar).await;
        let created = std::fs::read_to_string(&overlay).unwrap_or_default();
        // A second spawn finds the file and leaves what the ollama module wrote alone.
        let limits = "ollama:\n  contextLimits:\n    \"qwen3:8b\": 32768\n";
        std::fs::write(&overlay, limits).unwrap();
        sidecar.restart(None, None);
        wait_for_ready(&mut events).await;
        let relaunch = launch_argv(&sidecar).await;
        sidecar.dispose().await;
        let overlay_arg = overlay.to_string_lossy().into_owned();
        assert_eq!(launch, argv(&["--mode", "rpc-ui"], &dev_pack(), &["--config", &overlay_arg]));
        let pack_config = launch.iter().position(|arg| arg.ends_with("config.yml")).unwrap();
        let overlay_at = launch.iter().position(|arg| *arg == overlay_arg).unwrap();
        assert!(overlay_at > pack_config);
        assert_eq!(created, "ollama:\n  contextLimits: {}\n");
        assert_eq!(relaunch, launch);
        assert_eq!(std::fs::read_to_string(&overlay).unwrap(), limits);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn adoptcwd_re_roots_the_reported_cwd_and_plain_restarts_spawn_there() {
        let dir = tempfile::tempdir().unwrap();
        let adopted = tempfile::tempdir().unwrap();
        let adopted_cwd = adopted.path().canonicalize().unwrap();
        let (sidecar, mut events) = manager(options(fixture_path(), dir.path()));
        assert!(!sidecar.adopt_cwd(&dir.path().to_string_lossy()));
        assert!(sidecar.adopt_cwd(&adopted_cwd.to_string_lossy()));
        assert_eq!(sidecar.cwd(), adopted_cwd.to_string_lossy());
        // A plain restart (crash recovery, manual session resume) respawns in the
        // adopted cwd: the session's workspace, not the stale spawn cwd.
        sidecar.restart(None, None);
        wait_for_ready(&mut events).await;
        let pid = wait_for_pid(&sidecar).await;
        let spawn_cwd = std::fs::read_link(format!("/proc/{pid}/cwd")).unwrap();
        let launch = launch_argv(&sidecar).await;
        sidecar.dispose().await;
        assert_eq!(spawn_cwd, adopted_cwd);
        assert_eq!(launch, argv(&["--mode", "rpc-ui"], &dev_pack(), &[]));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn keeps_a_boot_crashing_sidecar_in_the_restart_loop_instead_of_a_false_ready() {
        let dir = tempfile::tempdir().unwrap();
        // Advertises protocol v2, never answers `negotiate_protocol`, then dies.
        let script = write_script(
            dir.path(),
            r#"process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 2, supportedProtocolVersions: [2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 }) + "\n");
setTimeout(() => process.exit(3), 120);"#,
        );
        let (sidecar, mut events) = manager(options(script, dir.path()));
        sidecar.start();
        let statuses = collect_until(&mut events, Duration::from_secs(9), |payload| payload.status == SidecarStatus::Restarting).await;
        // The rejected negotiation settles after the status push.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let late: Vec<SidecarEvent> = std::iter::from_fn(|| events.try_recv().ok()).collect();
        sidecar.dispose().await;
        let last = statuses.last().expect("a restarting status");
        assert_eq!(last.status, SidecarStatus::Restarting);
        assert_eq!(last.restart, Some(SidecarRestartProgress { attempt: 1, max_attempts: 3 }));
        assert!(last.message.as_deref().unwrap_or("").contains("Exit code 3"));
        assert!(statuses.iter().all(|payload| payload.status != SidecarStatus::Ready));
        assert!(late.iter().all(|event| !matches!(event, SidecarEvent::Status(payload) if payload.status == SidecarStatus::Ready)));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn drops_a_spawn_whose_env_resolution_was_superseded_by_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let pid_path = dir.path().join("pids.txt");
        let script = write_script(
            dir.path(),
            &format!(
                r#"import * as fs from "node:fs/promises";
await fs.appendFile({pid_path:?}, String(process.pid) + "\n");
process.stdout.write(JSON.stringify({{ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }}) + "\n");
process.stdin.resume();"#,
                pid_path = pid_path.to_string_lossy()
            ),
        );
        let slow_env: SpawnEnvProvider = Arc::new(|| {
            Box::pin(async {
                tokio::time::sleep(Duration::from_millis(200)).await;
                HashMap::new()
            })
        });
        let (sidecar, mut events) = SidecarManager::new(Weak::new(), options(script, dir.path()), slow_env);
        let read_pids = || std::fs::read_to_string(&pid_path).unwrap_or_default().lines().filter(|line| !line.is_empty()).count();
        sidecar.start();
        // Inside the first env window: restart() has no child to kill yet, so
        // without the guard both pending resolutions would spawn.
        tokio::time::sleep(Duration::from_millis(50)).await;
        sidecar.restart(None, None);
        wait_for_ready(&mut events).await;
        let deadline = std::time::Instant::now() + Duration::from_secs(9);
        while read_pids() < 1 && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // Both resolutions are 50 ms apart, so a superseded spawn that was going
        // to happen has long since written its pid by now.
        tokio::time::sleep(Duration::from_secs(1)).await;
        let count = read_pids();
        sidecar.dispose().await;
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn surfaces_a_reinstall_instruction_not_a_build_instruction_when_the_packaged_binary_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let mut options = options(PathBuf::new(), dir.path());
        options.packaged = true;
        let (sidecar, mut events) = manager(options);
        sidecar.start();
        let first = events.try_recv().unwrap();
        sidecar.dispose().await;
        let SidecarEvent::Status(payload) = first else { panic!("expected a status") };
        assert_eq!(payload.status, SidecarStatus::Error);
        let message = payload.message.unwrap_or_default();
        assert!(message.contains("Reinstall"));
        // A packaged user has no source checkout: `build:omp` is an instruction they cannot follow.
        assert!(!message.contains("build:omp"));
    }

    #[tokio::test]
    async fn keeps_the_build_instruction_for_a_dev_tree_with_no_sidecar_binary() {
        let dir = tempfile::tempdir().unwrap();
        let (sidecar, mut events) = manager(options(PathBuf::new(), dir.path()));
        sidecar.start();
        let first = events.try_recv().unwrap();
        sidecar.dispose().await;
        let SidecarEvent::Status(payload) = first else { panic!("expected a status") };
        assert_eq!(payload.status, SidecarStatus::Error);
        assert!(payload.message.unwrap_or_default().contains("build:omp"));
    }

    /// An `assistant-pack/` in `dir` holding every listed file except `leave_out`.
    fn pack_fixture(dir: &Path, leave_out: Option<&str>) {
        let pack = dir.join("assistant-pack");
        for file in crate::omp::assistant_pack::ASSISTANT_PACK_FILES.iter().filter(|file| Some(**file) != leave_out) {
            let path = pack.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "x").unwrap();
        }
        std::fs::create_dir_all(&pack).unwrap();
    }

    #[tokio::test]
    async fn keeps_the_whole_refused_start_status_for_a_window_that_subscribes_late() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_string_lossy().into_owned();
        let script = write_script(dir.path(), "process.stdin.resume();");
        let session_path = dir.path().join("old-chat.jsonl");
        std::fs::write(&session_path, "{\"title\":\"Old chat\"}\n{\"type\":\"session\",\"id\":\"c\",\"kind\":\"chat\"}\n").unwrap();
        let mut no_binary_options = options(PathBuf::new(), dir.path());
        no_binary_options.packaged = true;
        let (no_binary, _no_binary_events) = manager(no_binary_options);
        let mut partial_options = options(script.clone(), dir.path());
        partial_options.packaged = true;
        let (partial_pack, _partial_events) = manager(partial_options);
        let (chat, _chat_events) = manager(options(script, dir.path()));
        // Before any start, the payload is the asleep status in the sidecar's folder.
        assert_eq!(no_binary.status_payload(), SidecarStatusPayload { status: SidecarStatus::Asleep, message: None, cwd: cwd.clone(), restart: None, refusal: None });
        // Nothing listens while these starts are refused: the payload is all a late window gets.
        no_binary.start();
        let no_binary_payload = no_binary.status_payload();
        pack_fixture(dir.path(), Some("config.yml"));
        partial_pack.start();
        let partial_payload = partial_pack.status_payload();
        std::fs::write(dir.path().join("assistant-pack").join("config.yml"), "x").unwrap();
        chat.restart(None, Some(&session_path.to_string_lossy()));
        let chat_payload = chat.status_payload();
        for sidecar in [no_binary, partial_pack, chat] {
            sidecar.dispose().await;
        }
        assert_eq!(
            no_binary_payload,
            SidecarStatusPayload { status: SidecarStatus::Error, message: Some(missing_sidecar_message(true, None)), cwd: cwd.clone(), restart: None, refusal: None }
        );
        assert_eq!((partial_payload.status, partial_payload.cwd.as_str(), partial_payload.refusal), (SidecarStatus::Error, cwd.as_str(), None));
        assert!(partial_payload.message.unwrap_or_default().contains("config.yml"));
        assert_eq!(
            chat_payload,
            SidecarStatusPayload {
                status: SidecarStatus::Error,
                message: Some(format!("The session file is stamped chat: {}", session_path.to_string_lossy())),
                cwd,
                restart: None,
                refusal: Some(SidecarRefusal::KindMismatch),
            }
        );
    }

    #[tokio::test]
    async fn writes_each_refused_start_to_the_runtime_log_once() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_string_lossy().into_owned();
        let script = write_script(dir.path(), "process.stdin.resume();");
        pack_fixture(dir.path(), Some("config.yml"));
        let reports: Arc<Mutex<Vec<SidecarStartRefusalReport>>> = Arc::default();
        let refused = |binary: PathBuf| {
            let sink = reports.clone();
            let mut options = options(binary, dir.path());
            options.packaged = true;
            SidecarManager::with_reporters(Weak::new(), options, fixed_env(&[]), Arc::new(|_| {}), Arc::new(move |report| lock(&sink).push(report)))
        };
        let (no_binary, _no_binary_events) = refused(PathBuf::new());
        let (partial_pack, _partial_events) = refused(script);
        no_binary.start();
        partial_pack.start();
        let expected = vec![
            SidecarStartRefusalReport { message: no_binary.status_payload().message.unwrap_or_default(), cwd: cwd.clone() },
            SidecarStartRefusalReport { message: partial_pack.status_payload().message.unwrap_or_default(), cwd },
        ];
        no_binary.dispose().await;
        partial_pack.dispose().await;
        let reports = lock(&reports).clone();
        assert_eq!(reports, expected);
        assert!(reports[1].message.contains("config.yml"));
    }

    #[test]
    fn names_the_missing_packaged_binary_by_path_and_the_app_to_reinstall() {
        let message = missing_sidecar_message(true, Some(Path::new("/Applications/Sai ATLAS.app/Contents/Resources")));
        assert!(message.contains("/Applications/Sai ATLAS.app/Contents/Resources/omp"));
        assert!(message.contains("Reinstall Sai ATLAS"));
        assert!(missing_sidecar_message(true, None).contains("the bundled omp binary"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn carries_the_crashed_spawn_s_stderr_into_the_restart_reason_and_the_crash_report() {
        let dir = tempfile::tempdir().unwrap();
        let script = write_script(
            dir.path(),
            r#"process.stderr.write("dyld: Library not loaded: pi_natives\n  Referenced by: omp\n");
setTimeout(() => process.exit(4), 120);"#,
        );
        let reports: Arc<Mutex<Vec<SidecarFailureReport>>> = Arc::default();
        let sink = reports.clone();
        let (sidecar, mut events) = SidecarManager::with_reporters(Weak::new(), options(script, dir.path()), fixed_env(&[]), Arc::new(move |report| lock(&sink).push(report)), Arc::new(|_| {}));
        sidecar.start();
        let statuses = collect_until(&mut events, Duration::from_secs(9), |payload| payload.status == SidecarStatus::Restarting).await;
        sidecar.dispose().await;
        let reason = statuses.last().and_then(|payload| payload.message.clone()).unwrap_or_default();
        assert!(reason.contains("Exit code 4"), "reason was {reason:?}");
        assert!(reason.contains("dyld: Library not loaded: pi_natives"));
        // Stack-ish continuation lines stay out of the one-line reason.
        assert!(!reason.contains("Referenced by"));
        let report = lock(&reports).first().cloned().expect("a crash report");
        assert_eq!((report.attempt, report.max_attempts, report.cwd.as_str()), (1, 3, dir.path().to_string_lossy().as_ref()));
        assert_eq!(report.stderr, vec!["dyld: Library not loaded: pi_natives", "  Referenced by: omp"]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dispose_stops_the_supervisor_and_the_fixture() {
        let dir = tempfile::tempdir().unwrap();
        let (sidecar, mut events) = manager(options(fixture_path(), dir.path()));
        sidecar.start();
        wait_for_ready(&mut events).await;
        let omp = wait_for_pid(&sidecar).await;
        let supervisor = sidecar.supervisor_pid().unwrap();
        assert!(sidecar.has_rpc_client());
        let response = sidecar.request(json!({ "type": "get_state" }), Some(5_000)).await.unwrap();
        assert_eq!(response["success"], true);
        let started = std::time::Instant::now();
        sidecar.dispose().await;
        assert!(started.elapsed() < Duration::from_secs(8));
        assert!(!sidecar.has_rpc_client());
        assert_eq!(sidecar.omp_pid(), None);
        for pid in [omp, supervisor] {
            let alive = std::fs::read_to_string(format!("/proc/{pid}/stat")).map(|stat| !stat.contains(") Z ")).unwrap_or(false);
            assert!(!alive, "pid {pid} survived dispose");
        }
    }
}
