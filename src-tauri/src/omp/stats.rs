//! The GUI's built-in stats dashboard server and its client, ported from
//! `src/main/stats-server.ts` and `src/main/stats-client.ts`. The server is the
//! same bundled omp binary running `omp stats --no-open` on a private loopback
//! port, spawned by the first dashboard read and killed on quit. No external
//! `omp stats` process is required and none is consulted.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use regex::Regex;
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::oneshot;

use super::manager::SpawnEnvProvider;
use super::stats_restart_policy::{RestartBudget, Revive, MAX_RESTART_ATTEMPTS};
use crate::bridge::spawn_task;

/// Bind a private ephemeral port; separate GUI instances must not share an index or listener.
const DEFAULT_PORT: u16 = 0;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// How much recent stdout the readiness scan keeps.
const STDOUT_WINDOW: usize = 4096;

const VALID_PATHS: &[&str] = &[
    "/api/stats/overview",
    "/api/stats/model-dashboard",
    "/api/stats/costs",
    "/api/stats/behavior",
    "/api/stats/tools",
    "/api/stats/providers",
    "/api/stats/recent",
    "/api/stats/requests",
    "/api/stats/errors",
    "/api/stats/models",
    "/api/stats/folders",
    "/api/stats/timeseries",
    "/api/stats/gain",
    "/api/stats",
    "/api/sync",
];

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as u64).unwrap_or(0)
}

/// Terminal escape sequences, as Node's `stripVTControlCharacters` removes them.
fn strip_vt_control_characters(text: &str) -> String {
    static PATTERN: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(r"[\x1b\x9b][\[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\x07)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))").unwrap_or_else(|_| Regex::new("$^").unwrap_or_else(|_| unreachable!()))
    });
    pattern.replace_all(text, "").into_owned()
}

/// The port in `… http://127.0.0.1:<port>/` or `http://localhost:<port>` followed by whitespace or a slash.
fn ready_port(text: &str) -> Option<u16> {
    static PATTERN: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let pattern = PATTERN.get_or_init(|| Regex::new(r"http://(?:localhost|127\.0\.0\.1):([0-9]+)[\s/]").unwrap_or_else(|_| Regex::new("$^").unwrap_or_else(|_| unreachable!())));
    pattern.captures(text).and_then(|captures| captures.get(1)).and_then(|port| port.as_str().parse::<u16>().ok()).filter(|port| *port > 0)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum StatsEvent {
    /// The server bound its port.
    Ready(u16),
    /// The server left; `Some(0)` is a clean exit, `None` a crash about to be retried (or given up).
    Exit(Option<i32>),
}

pub(crate) type StatsListener = Box<dyn Fn(&StatsEvent) + Send + Sync>;

struct Running {
    id: u64,
    pid: Option<u32>,
    kill_request: Mutex<Option<oneshot::Sender<()>>>,
}

#[derive(Default)]
struct State {
    child: Option<Arc<Running>>,
    /// A spawn was requested and has not produced a child yet.
    spawning: bool,
    budget: RestartBudget,
    restart_pending: bool,
    restart_token: u64,
    disposed: bool,
    port: u16,
    next_id: u64,
}

struct Inner {
    program: PathBuf,
    env: SpawnEnvProvider,
    state: Mutex<State>,
    listeners: Mutex<Vec<StatsListener>>,
}

/// The stats server manager (`StatsServerManager`).
pub(crate) struct StatsServer {
    inner: Arc<Inner>,
}

impl StatsServer {
    pub(crate) fn new(program: PathBuf, env: SpawnEnvProvider) -> Self {
        Self { inner: Arc::new(Inner { program, env, state: Mutex::new(State { port: DEFAULT_PORT, ..State::default() }), listeners: Mutex::new(Vec::new()) }) }
    }

    #[cfg(test)]
    pub(crate) fn port(&self) -> u16 {
        lock(&self.inner.state).port
    }

    /// The running server's pid, so a test can prove `kill()` leaves nothing behind.
    #[cfg(test)]
    pub(crate) fn child_pid_for_test(&self) -> Option<u32> {
        lock(&self.inner.state).child.as_ref().and_then(|child| child.pid)
    }

    pub(crate) fn on_event(&self, listener: StatsListener) {
        lock(&self.inner.listeners).push(listener);
    }

    #[cfg(test)]
    pub(crate) fn start(&self) {
        {
            let mut state = lock(&self.inner.state);
            if state.disposed {
                return;
            }
            state.spawning = true;
        }
        let inner = self.inner.clone();
        spawn_task(async move { inner.spawn().await });
    }

    /// Bring the server up because something now wants to read it. Without
    /// this, a manager that spent its restart budget stays at port 0 for the
    /// rest of the session and every dashboard read answers "not ready" forever.
    pub(crate) fn ensure_running(&self) -> Revive {
        let verdict = {
            let mut state = lock(&self.inner.state);
            if state.disposed {
                return Revive::Exhausted;
            }
            if state.child.is_some() || state.spawning || state.restart_pending {
                return Revive::AlreadyPending;
            }
            let verdict = state.budget.revive(now_ms());
            if verdict == Revive::Scheduled {
                state.spawning = true;
            }
            verdict
        };
        if verdict == Revive::Scheduled {
            let inner = self.inner.clone();
            spawn_task(async move { inner.spawn().await });
        }
        verdict
    }

    /// Stop the server for good.
    pub(crate) fn kill(&self) {
        let child = {
            let mut state = lock(&self.inner.state);
            state.disposed = true;
            state.restart_pending = false;
            state.restart_token += 1;
            state.child.take()
        };
        if let Some(child) = child {
            Inner::terminate(&child);
        }
    }
}

impl Inner {
    fn emit(&self, event: StatsEvent) {
        for listener in lock(&self.listeners).iter() {
            listener(&event);
        }
    }

    fn terminate(child: &Running) {
        #[cfg(unix)]
        if let Some(pid) = child.pid {
            let _ = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), nix::sys::signal::Signal::SIGTERM);
            return;
        }
        let request = lock(&child.kill_request).take();
        if let Some(request) = request {
            let _ = request.send(());
        }
    }

    async fn spawn(self: Arc<Self>) {
        let env = (self.env)().await;
        // The bundled omp registers this flag as --no-open (kebab-case), not the
        // camelCase the oclif property name suggests.
        let args = ["stats", "--host", "127.0.0.1", "--port", &DEFAULT_PORT.to_string(), "--no-open"];
        let mut command = Command::new(&self.program);
        command.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(false);
        command.env_remove("APPIMAGE_EXIT_AFTER_INSTALL");
        for (key, value) in &env {
            command.env(key, value);
        }
        command.env("PI_NOTIFICATIONS", "off");
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                lock(&self.state).spawning = false;
                self.attempt_restart(error.to_string());
                return;
            }
        };
        let (kill_tx, kill_rx) = oneshot::channel();
        let id = {
            let mut state = lock(&self.state);
            state.next_id += 1;
            state.next_id
        };
        let running = Arc::new(Running { id, pid: child.id(), kill_request: Mutex::new(Some(kill_tx)) });
        let disposed = {
            let mut state = lock(&self.state);
            state.spawning = false;
            if !state.disposed {
                state.child = Some(running.clone());
            }
            state.disposed
        };
        if disposed {
            Inner::terminate(&running);
            let _ = child.wait().await;
            return;
        }
        if let Some(mut stdout) = child.stdout.take() {
            let inner = self.clone();
            spawn_task(async move {
                let mut window = String::new();
                let mut buffer = vec![0u8; 4096];
                loop {
                    let read = match stdout.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => read,
                    };
                    window.push_str(&String::from_utf8_lossy(&buffer[..read]));
                    if window.len() > STDOUT_WINDOW {
                        let cut = window.len() - STDOUT_WINDOW;
                        let boundary = (cut..window.len()).find(|index| window.is_char_boundary(*index)).unwrap_or(window.len());
                        window.drain(..boundary);
                    }
                    if let Some(port) = ready_port(&strip_vt_control_characters(&window)) {
                        let current = {
                            let mut state = lock(&inner.state);
                            let current = state.child.as_ref().map(|child| child.id) == Some(id);
                            if current {
                                state.port = port;
                                state.budget.note_ready();
                            }
                            current
                        };
                        if !current {
                            break;
                        }
                        inner.emit(StatsEvent::Ready(port));
                        window.clear();
                    }
                }
            });
        }
        if let Some(mut stderr) = child.stderr.take() {
            spawn_task(async move {
                let mut sink = Vec::new();
                let _ = stderr.read_to_end(&mut sink).await;
            });
        }
        let inner = self.clone();
        spawn_task(async move {
            let status = tokio::select! {
                status = child.wait() => status,
                _ = kill_rx => {
                    let _ = child.start_kill();
                    child.wait().await
                }
            };
            let disposed = {
                let mut state = lock(&inner.state);
                if state.child.as_ref().map(|child| child.id) != Some(id) {
                    return;
                }
                state.child = None;
                state.disposed
            };
            if disposed {
                return;
            }
            match status {
                Ok(status) if status.code() == Some(0) => inner.emit(StatsEvent::Exit(Some(0))),
                Ok(status) => inner.attempt_restart(describe(&status)),
                Err(error) => inner.attempt_restart(error.to_string()),
            }
        });
    }

    fn attempt_restart(self: &Arc<Self>, reason: String) {
        let (delay, token) = {
            let mut state = lock(&self.state);
            state.port = 0;
            let delay = state.budget.next_delay();
            if delay.is_some() {
                state.restart_pending = true;
                state.restart_token += 1;
            }
            (delay, state.restart_token)
        };
        self.emit(StatsEvent::Exit(None));
        let Some(delay) = delay else {
            crate::runtime_log::note("child-process", format!("stats server failed after {MAX_RESTART_ATTEMPTS} attempts: {reason}"), json!({}));
            return;
        };
        let inner = self.clone();
        spawn_task(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            let go = {
                let mut state = lock(&inner.state);
                let go = !state.disposed && state.restart_pending && state.restart_token == token;
                if go {
                    state.restart_pending = false;
                    state.spawning = true;
                }
                go
            };
            if go {
                inner.spawn().await;
            }
        });
    }
}

fn describe(status: &std::process::ExitStatus) -> String {
    let code = status.code().map(|code| code.to_string()).unwrap_or_else(|| "null".to_string());
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.signal().map(|signal| format!(" ({})", nix::sys::signal::Signal::try_from(signal).map(|name| name.to_string()).unwrap_or_else(|_| signal.to_string())))
    };
    #[cfg(not(unix))]
    let signal: Option<String> = None;
    format!("exit code {code}{}", signal.unwrap_or_default())
}

/// HTTP client for the private, bundled stats dashboard API (`StatsClient`).
pub(crate) struct StatsClient {
    port: AtomicU16,
    available: AtomicBool,
    requests: AtomicUsize,
    http: reqwest::Client,
}

impl Default for StatsClient {
    fn default() -> Self {
        Self::new(DEFAULT_PORT)
    }
}

impl StatsClient {
    pub(crate) fn new(port: u16) -> Self {
        // Loopback only: never route the dashboard through a proxy env var.
        let http = reqwest::Client::builder().no_proxy().timeout(REQUEST_TIMEOUT).build().unwrap_or_default();
        Self { port: AtomicU16::new(port), available: AtomicBool::new(false), requests: AtomicUsize::new(0), http }
    }

    pub(crate) fn port(&self) -> u16 {
        self.port.load(Ordering::SeqCst)
    }

    pub(crate) fn set_port(&self, port: u16) {
        self.port.store(port, Ordering::SeqCst);
        self.available.store(false, Ordering::SeqCst);
    }

    #[cfg(test)]
    pub(crate) fn available(&self) -> bool {
        self.available.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    /// Requests actually issued; the dashboard must never be probed at port 0.
    pub(crate) fn requests_made(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }

    /// Probe `/api/stats/models` for the `x-omp-stats-dashboard` header.
    pub(crate) async fn probe(&self) -> bool {
        let port = self.port();
        if port == 0 {
            return false;
        }
        self.requests.fetch_add(1, Ordering::SeqCst);
        let available = match self.http.get(format!("http://127.0.0.1:{port}/api/stats/models")).send().await {
            Ok(response) => response.headers().contains_key("x-omp-stats-dashboard"),
            Err(_) => false,
        };
        self.available.store(available, Ordering::SeqCst);
        available
    }

    /// Fetch a known stats endpoint (or `/api/request/:id`), as JSON.
    pub(crate) async fn fetch(&self, path: &str, params: Option<&std::collections::HashMap<String, String>>) -> Result<Value, String> {
        let port = self.port();
        if port == 0 {
            return Err("The bundled stats server is not ready. Please retry shortly.".to_string());
        }
        let is_request_path = path.strip_prefix("/api/request/").map(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit())).unwrap_or(false);
        if !is_request_path && !VALID_PATHS.contains(&path) {
            return Err(format!("Invalid stats path: {path}"));
        }
        let mut url = reqwest::Url::parse(&format!("http://127.0.0.1:{port}{path}")).map_err(|error| error.to_string())?;
        if let Some(params) = params {
            let mut query = url.query_pairs_mut();
            for (key, value) in params {
                query.append_pair(key, value);
            }
        }
        self.requests.fetch_add(1, Ordering::SeqCst);
        let response = self.http.get(url).send().await.map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            let status = response.status();
            return Err(format!("Stats API error: {} {}", status.as_u16(), status.canonical_reason().unwrap_or("")));
        }
        response.json::<Value>().await.map_err(|error| error.to_string())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::path::Path;

    pub(crate) fn no_env() -> SpawnEnvProvider {
        Arc::new(|| Box::pin(std::future::ready(std::collections::HashMap::new())))
    }

    fn write_bun_script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        crate::omp::test_support::write_executable(&path, &format!("#!/usr/bin/env bun\n{body}\n"));
        path
    }

    async fn poll_until(limit: Duration, mut condition: impl FnMut() -> bool) -> bool {
        let deadline = std::time::Instant::now() + limit;
        while std::time::Instant::now() < deadline {
            if condition() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        condition()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_live_listener_is_never_respawned_by_a_demand_driven_revive() {
        let dir = tempfile::tempdir().unwrap();
        let binary = write_bun_script(dir.path(), "stats-live.ts", "process.stdout.write(\"Dashboard available at: http://127.0.0.1:55123\\n\");\nawait Bun.sleep(5000);");
        let server = StatsServer::new(binary, no_env());
        server.start();
        assert!(poll_until(Duration::from_secs(5), || server.port() == 55123).await, "port was {}", server.port());
        // Every open dashboard polls; a revive that ignored the live child would
        // stack listeners and hand the client a port nobody owns after the first exit.
        assert_eq!(server.ensure_running(), Revive::AlreadyPending);
        assert_eq!(server.port(), 55123);
        server.kill();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_never_started_server_comes_up_on_the_first_demand_read() {
        let dir = tempfile::tempdir().unwrap();
        let binary = write_bun_script(dir.path(), "stats-lazy.ts", "process.stdout.write(\"Dashboard available at: http://127.0.0.1:55124\\n\");\nawait Bun.sleep(5000);");
        // The app never calls start(): the first dashboard read is what spawns it.
        let server = StatsServer::new(binary, no_env());
        assert_eq!(server.port(), 0);
        assert_eq!(server.ensure_running(), Revive::Scheduled);
        assert!(poll_until(Duration::from_secs(5), || server.port() == 55124).await, "port was {}", server.port());
        assert_eq!(server.ensure_running(), Revive::AlreadyPending);
        server.kill();
    }

    #[tokio::test]
    async fn stats_does_not_contact_an_unrelated_default_server_before_its_own_listener_is_ready() {
        let client = StatsClient::default();
        assert!(!client.probe().await);
        let error = client.fetch("/api/stats/requests", None).await.unwrap_err();
        assert!(error.contains("not ready"), "{error}");
        assert_eq!(client.requests_made(), 0);
        assert!(!client.available());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn split_numeric_loopback_readiness_selects_the_bundled_listener_and_resets_after_exit() {
        let dir = tempfile::tempdir().unwrap();
        // The script exits only once the test has seen Ready, so a loaded machine cannot reap
        // the child before its readiness line is read (a wall-clock pause could not promise that).
        let gate = dir.path().join("exit-gate");
        let binary = write_bun_script(
            dir.path(),
            "stats.ts",
            &format!(
                "const GATE = {:?};\nprocess.stdout.write(\"\\x1b[32mDashboard available at: http://127.0.0.1:54\");\nawait Bun.sleep(30);\nprocess.stdout.write(\"321\\x1b[39m\\n\");\nwhile (!(await Bun.file(GATE).exists())) await Bun.sleep(10);\nprocess.exit(1);",
                gate.display().to_string()
            ),
        );
        let server = StatsServer::new(binary, no_env());
        let ports: Arc<Mutex<Vec<u16>>> = Arc::default();
        let exits: Arc<Mutex<Vec<u16>>> = Arc::default();
        let (ready_log, exit_log) = (ports.clone(), exits.clone());
        let port_at_exit = Arc::new(AtomicU16::new(0));
        let observed = port_at_exit.clone();
        server.on_event(Box::new(move |event| match event {
            StatsEvent::Ready(port) => lock(&ready_log).push(*port),
            StatsEvent::Exit(_) => lock(&exit_log).push(observed.load(Ordering::SeqCst)),
        }));
        // Mirror the TS listener reading `server.port` at exit time: the manager
        // resets the port before it emits, so the observed value is 0.
        server.on_event(Box::new(move |_| {}));
        server.start();
        assert!(poll_until(Duration::from_secs(5), || lock(&ports).as_slice() == [54321]).await, "ready ports {:?}", lock(&ports));
        std::fs::write(&gate, b"").unwrap();
        assert!(poll_until(Duration::from_secs(5), || lock(&exits).len() == 1).await, "exit events {:?}", lock(&exits));
        assert_eq!(server.port(), 0);
        assert_eq!(*lock(&exits), vec![0]);
        server.kill();
    }

    #[test]
    fn readiness_scan_strips_escapes_and_needs_a_delimiter() {
        assert_eq!(ready_port(&strip_vt_control_characters("\x1b[32mhttp://127.0.0.1:54321\x1b[39m\n")), Some(54321));
        assert_eq!(ready_port("http://localhost:4321/"), Some(4321));
        assert_eq!(ready_port("http://127.0.0.1:54"), None);
        assert_eq!(ready_port("http://127.0.0.1:0\n"), None);
    }
}
