//! The sidecar supervisor: `main.rs` re-executes the GUI binary with
//! `ports::SUPERVISOR_ARGV` and hands control here before Tauri starts.
//!
//! The supervisor owns a new session, is a child subreaper, and holds the
//! control channel the GUI passed as fd 3. It spawns omp in its own process
//! group with the GUI's stdio pipes inherited (no frame relay), reports omp's
//! pid on the control channel once, and then waits for omp to exit, SIGTERM,
//! or control-channel EOF (the GUI is gone). While omp runs, every orphan
//! reparented to the supervisor is reaped as it exits, so none lingers as a
//! zombie until the app quits. The shutdown sequence is SIGTERM
//! omp, a 5 s grace, SIGKILL of omp's process group, then a sweep of every
//! process reparented to the supervisor, and it exits with omp's status.
//!
//! This process runs without `--user-data-dir`, so it never touches the
//! runtime log; failures go to stderr with a `supervisor:` prefix.

use std::ffi::OsString;
use std::process::ExitCode;

/// Env var naming the role a test binary plays when it re-executes itself.
#[cfg(test)]
pub(crate) const TEST_ROLE_ENV: &str = "SAI_ATLAS_TEST_ROLE";
/// Env var carrying omp's argv (a JSON array) to the test-binary supervisor.
#[cfg(test)]
pub(crate) const TEST_ARGV_ENV: &str = "SAI_ATLAS_TEST_SUPERVISE_ARGV";
/// The helper test that plays the supervisor when the test binary is re-executed.
#[cfg(test)]
pub(crate) const TEST_SUPERVISOR_HELPER: &str = "omp::supervisor::test_role::supervisor_role_helper";
/// libtest flags for every re-execution of the test binary into a helper role.
/// The child inherits the harness's stdout, which omp (or the stand-in GUI's
/// report) then writes to, so the harness must leave the cursor at a line
/// boundary before the test body runs: the pretty formatter prints
/// `test <name> ... ` with no newline when single-threaded, the terse one
/// (`--quiet`) prints nothing per test. `--nocapture` only lets helper panics
/// reach stderr at once; `--test-threads=1` keeps the helper on one thread.
#[cfg(test)]
pub(crate) const TEST_HARNESS_ARGS: &[&str] = &["--nocapture", "--test-threads=1", "--quiet"];

/// Run as the supervisor for the omp command line in `args[2..]`; never returns to Tauri.
pub fn run(args: Vec<OsString>) -> ExitCode {
    ExitCode::from(run_code(args))
}

/// The exit status `run` ends with, as a number a test helper can `exit` with.
pub(crate) fn run_code(args: Vec<OsString>) -> u8 {
    #[cfg(unix)]
    {
        unix::run(args)
    }
    #[cfg(not(unix))]
    {
        let _ = args;
        warn("the sidecar supervisor is not used on this OS");
        1
    }
}

/// Write one line to stderr; a closed pipe is ignored, never a panic.
fn warn(message: impl std::fmt::Display) {
    use std::io::Write;
    let _ = writeln!(std::io::stderr().lock(), "supervisor: {message}");
}

#[cfg(unix)]
mod unix {
    use super::warn;
    use std::ffi::OsString;
    use std::os::fd::{AsFd, FromRawFd, OwnedFd};
    use std::process::{ExitStatus, Stdio};
    use std::time::{Duration, Instant};

    use nix::sys::signal::{kill, killpg, Signal};
    use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};
    use nix::unistd::Pid;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::process::Command;

    /// How long omp gets after SIGTERM before its process group is SIGKILLed.
    const TERM_GRACE: Duration = Duration::from_secs(5);
    /// How long the orphan sweep keeps making passes.
    const SWEEP_BUDGET: Duration = Duration::from_secs(2);
    const SWEEP_PAUSE: Duration = Duration::from_millis(20);
    /// The status reported when the parent is already gone before omp starts.
    const PARENT_GONE_STATUS: u8 = 143;

    pub(super) fn run(args: Vec<OsString>) -> u8 {
        let argv: Vec<OsString> = args.into_iter().skip(2).collect();
        if argv.is_empty() {
            warn("no command line to supervise");
            return 2;
        }
        if let Err(error) = nix::unistd::setsid() {
            warn(format!("setsid failed: {error}"));
        }
        #[cfg(target_os = "linux")]
        {
            if let Err(error) = nix::sys::prctl::set_child_subreaper(true) {
                warn(format!("PR_SET_CHILD_SUBREAPER failed: {error}"));
            }
            if let Err(error) = nix::sys::prctl::set_pdeathsig(Signal::SIGTERM) {
                warn(format!("PR_SET_PDEATHSIG failed: {error}"));
            }
        }
        // SAFETY: the manager's `pre_exec` installed the GUI's control channel
        // on descriptor 3 before exec, and nothing else in this process owns or
        // uses that descriptor, so taking ownership of it here closes it exactly
        // once. Validity is checked right below before anything reads from it.
        let control = unsafe { OwnedFd::from_raw_fd(3) };
        if nix::fcntl::fcntl(&control, nix::fcntl::FcntlArg::F_GETFD).is_err() {
            warn("control channel is missing; refusing to run unsupervised");
            // Not ours to close: forgetting it leaves an unrelated descriptor alone.
            std::mem::forget(control);
            return 2;
        }
        // The parent may have died between fork and prctl: the death signal was
        // not armed yet, and the control channel is already at EOF.
        if nix::unistd::getppid() == Pid::from_raw(1) || control_at_eof(&control) {
            return PARENT_GONE_STATUS;
        }
        let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(runtime) => runtime,
            Err(error) => {
                warn(format!("could not start the runtime: {error}"));
                return 1;
            }
        };
        runtime.block_on(supervise(argv, control))
    }

    /// True when the GUI's end is already closed (a zero-length read is pending).
    fn control_at_eof(control: &OwnedFd) -> bool {
        use nix::poll::{poll, PollFd, PollFlags, PollTimeout};
        let mut fds = [PollFd::new(control.as_fd(), PollFlags::POLLIN)];
        match poll(&mut fds, PollTimeout::ZERO) {
            Ok(ready) if ready > 0 => {
                let events = fds[0].revents().unwrap_or(PollFlags::empty());
                if events.contains(PollFlags::POLLHUP) {
                    return true;
                }
                if events.contains(PollFlags::POLLIN) {
                    let mut byte = [0u8; 1];
                    return matches!(nix::unistd::read(control, &mut byte), Ok(0));
                }
                false
            }
            _ => false,
        }
    }

    async fn supervise(argv: Vec<OsString>, control: OwnedFd) -> u8 {
        let mut command = Command::new(&argv[0]);
        command.args(&argv[1..]).stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit()).kill_on_drop(false);
        // omp gets its own process group inside the supervisor's session, so a
        // group-wide signal from its own teardown cannot take the supervisor down.
        command.process_group(0);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                warn(format!("failed to start {}: {error}", argv[0].to_string_lossy()));
                return if error.kind() == std::io::ErrorKind::NotFound { 127 } else { 126 };
            }
        };
        let Some(pid) = child.id() else {
            warn("omp exited before its pid could be read");
            let status = child.wait().await;
            return exit_code(status);
        };
        let omp = Pid::from_raw(pid as i32);
        let mut stream = control_stream(control);
        if let Some(stream) = stream.as_mut() {
            let _ = stream.write_all(format!("pid {pid}\n").as_bytes()).await;
        }
        let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();
        if sigterm.is_none() {
            warn("could not listen for SIGTERM; relying on the control channel");
        }
        tokio::select! {
            status = child.wait() => {
                sweep_orphans().await;
                return exit_code(status);
            }
            _ = async { match sigterm.as_mut() { Some(signal) => { signal.recv().await; } None => std::future::pending().await } } => {}
            _ = async { match stream.as_mut() { Some(stream) => wait_for_eof(stream).await, None => std::future::pending().await } } => {}
            _ = reap_orphans_while_running(omp) => {}
        }
        let _ = kill(omp, Signal::SIGTERM);
        let status = match tokio::time::timeout(TERM_GRACE, child.wait()).await {
            Ok(status) => status,
            Err(_) => {
                let _ = killpg(omp, Signal::SIGKILL);
                child.wait().await
            }
        };
        sweep_orphans().await;
        exit_code(status)
    }

    fn control_stream(control: OwnedFd) -> Option<tokio::net::UnixStream> {
        let stream = std::os::unix::net::UnixStream::from(control);
        if let Err(error) = stream.set_nonblocking(true) {
            warn(format!("control channel cannot be made non-blocking: {error}"));
            return None;
        }
        match tokio::net::UnixStream::from_std(stream) {
            Ok(stream) => Some(stream),
            Err(error) => {
                warn(format!("control channel cannot be registered: {error}"));
                None
            }
        }
    }

    /// Resolves when the GUI's end closes; anything written is ignored.
    async fn wait_for_eof(stream: &mut tokio::net::UnixStream) {
        let mut buffer = [0u8; 64];
        loop {
            match stream.read(&mut buffer).await {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
        }
    }

    /// omp's status as the supervisor's exit code: its code, or `128 + signal`.
    fn exit_code(status: std::io::Result<ExitStatus>) -> u8 {
        use std::os::unix::process::ExitStatusExt;
        match status {
            Ok(status) => {
                if let Some(code) = status.code() {
                    return u8::try_from(code).unwrap_or(1);
                }
                status.signal().map(|signal| u8::try_from(128 + signal).unwrap_or(1)).unwrap_or(1)
            }
            Err(error) => {
                warn(format!("waiting for omp failed: {error}"));
                1
            }
        }
    }

    /// Kill every process reparented to this subreaper, in passes, until a pass
    /// finds nothing or the budget is spent. Tool children a native shell put in
    /// their own process groups land here once omp is gone.
    async fn sweep_orphans() {
        let started = Instant::now();
        loop {
            let orphans = live_children_of_self();
            for pid in &orphans {
                let _ = kill(*pid, Signal::SIGKILL);
            }
            reap();
            if orphans.is_empty() || started.elapsed() >= SWEEP_BUDGET {
                return;
            }
            tokio::time::sleep(SWEEP_PAUSE).await;
            reap();
        }
    }

    /// Reap each orphan reparented to this subreaper as it exits, for as long
    /// as omp runs; never resolves. omp itself is left for `child.wait()`.
    async fn reap_orphans_while_running(omp: Pid) {
        let Ok(mut sigchld) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::child()) else {
            warn("could not listen for SIGCHLD; orphans are reaped at shutdown");
            return std::future::pending().await;
        };
        loop {
            if sigchld.recv().await.is_none() {
                return std::future::pending().await;
            }
            reap_orphans(omp);
        }
    }

    /// Collect every exited child except omp without blocking. `WNOWAIT` peeks
    /// first, because collecting omp here would take its status from `child.wait()`.
    #[cfg(target_os = "linux")]
    fn reap_orphans(omp: Pid) {
        use nix::sys::wait::{waitid, Id};
        loop {
            let peeked = waitid(Id::All, WaitPidFlag::WEXITED | WaitPidFlag::WNOHANG | WaitPidFlag::WNOWAIT);
            match peeked.ok().and_then(|status| status.pid()) {
                Some(pid) if pid != omp => {
                    let _ = waitpid(pid, Some(WaitPidFlag::WNOHANG));
                }
                // Nothing has exited, or omp has: `child.wait()` collects omp and the sweep the rest.
                _ => return,
            }
        }
    }

    /// macOS orphans are collected by the shutdown sweep.
    #[cfg(not(target_os = "linux"))]
    fn reap_orphans(_omp: Pid) {}

    /// Collect every exited child without blocking.
    fn reap() {
        loop {
            match waitpid(None, Some(WaitPidFlag::WNOHANG)) {
                Ok(WaitStatus::StillAlive) | Err(_) => return,
                Ok(_) => {}
            }
        }
    }

    /// Pids whose parent is this process and that are not zombies yet (`/proc/<pid>/stat`).
    #[cfg(target_os = "linux")]
    fn live_children_of_self() -> Vec<Pid> {
        let me = nix::unistd::getpid().as_raw();
        let Ok(entries) = std::fs::read_dir("/proc") else { return Vec::new() };
        let mut children = Vec::new();
        for entry in entries.flatten() {
            let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else { continue };
            let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { continue };
            // The command name may contain spaces or parentheses; parse after the last ')'.
            let Some((_, rest)) = stat.rsplit_once(')') else { continue };
            let mut fields = rest.split_whitespace();
            let state = fields.next().unwrap_or("");
            let ppid: i32 = fields.next().and_then(|value| value.parse().ok()).unwrap_or(-1);
            if ppid == me && state != "Z" {
                children.push(Pid::from_raw(pid));
            }
        }
        children
    }

    /// macOS has no `/proc`; the `proc_listchildpids` snapshot arrives with that OS's cutover.
    #[cfg(not(target_os = "linux"))]
    fn live_children_of_self() -> Vec<Pid> {
        Vec::new()
    }
}

/// Plays the supervisor when the test binary is re-executed by the manager:
/// the test harness owns `main`, so `--omp-supervise` cannot reach `run`.
/// Every unix test binary needs it, because every supervised spawn in a test
/// goes through it; the tool-tree tests below stay Linux-only until their port.
#[cfg(all(test, unix))]
mod test_role {
    use super::*;

    #[test]
    fn supervisor_role_helper() {
        if std::env::var(TEST_ROLE_ENV).as_deref() != Ok("supervisor") {
            // A module rename would turn the re-exec into `running 0 tests` and exit 0,
            // which the manager would read as a supervisor that died without a pid line.
            let module = module_path!().trim_start_matches("sai_atlas_lib::");
            assert_eq!(TEST_SUPERVISOR_HELPER, format!("{module}::supervisor_role_helper"));
            assert_eq!(run_code(vec![OsString::from("exe"), OsString::from(crate::ports::SUPERVISOR_ARGV)]), 2);
            return;
        }
        let argv: Vec<String> = std::env::var(TEST_ARGV_ENV).ok().and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default();
        let mut args = vec![OsString::from("sai-atlas"), OsString::from(crate::ports::SUPERVISOR_ARGV)];
        args.extend(argv.into_iter().map(OsString::from));
        std::process::exit(i32::from(run_code(args)));
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::omp::manager::{read_pid_line, spawn_supervised};
    use std::path::Path;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    const SLEEP_BIN: &str = "/usr/bin/sleep";
    const TREE_LIMIT: Duration = Duration::from_secs(10);

    fn alive(pid: u32) -> bool {
        std::fs::read_to_string(format!("/proc/{pid}/stat")).map(|stat| !stat.contains(") Z ")).unwrap_or(false)
    }

    fn cmdline(pid: u32) -> Vec<String> {
        std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default().split(|byte| *byte == 0).filter(|part| !part.is_empty()).map(|part| String::from_utf8_lossy(part).into_owned()).collect()
    }

    fn ppid(pid: u32) -> Option<u32> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let (_, rest) = stat.rsplit_once(')')?;
        rest.split_whitespace().nth(1)?.parse().ok()
    }

    /// Every `/usr/bin/sleep 600` whose parent is `parent`.
    fn sleeps_under(parent: u32) -> Vec<u32> {
        let Ok(entries) = std::fs::read_dir("/proc") else { return Vec::new() };
        entries
            .flatten()
            .filter_map(|entry| entry.file_name().to_string_lossy().parse::<u32>().ok())
            .filter(|pid| ppid(*pid) == Some(parent) && cmdline(*pid) == [SLEEP_BIN, "600"])
            .collect()
    }

    async fn wait_until(limit: Duration, mut condition: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if condition() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        condition()
    }

    /// The tree every test uses: a stand-in omp that `exec`s into sleep after
    /// leaving a `setsid` sleep behind (a tool that left omp's process group).
    const TOOL_TREE: &str = "setsid /usr/bin/sleep 600 & exec /usr/bin/sleep 600";

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn control_channel_eof_kills_the_child_tree_within_10_s() {
        let args = vec!["-c".to_string(), TOOL_TREE.to_string()];
        let mut supervised = spawn_supervised(Path::new("bash"), &args, |command| {
            command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::inherit());
        })
        .unwrap();
        let omp = read_pid_line(&mut supervised.control_read).await.expect("pid line");
        assert!(wait_until(Duration::from_secs(5), || !sleeps_under(omp).is_empty()).await, "the tool child never appeared");
        let tool = sleeps_under(omp)[0];
        assert_eq!(cmdline(omp), [SLEEP_BIN, "600"]);

        let started = Instant::now();
        drop(supervised.control_write);
        drop(supervised.control_read);
        let gone = wait_until(TREE_LIMIT, || !alive(omp) && !alive(tool)).await;
        let elapsed = started.elapsed();
        let status = tokio::time::timeout(Duration::from_secs(5), supervised.child.wait()).await.expect("supervisor exits").unwrap();
        assert!(gone, "omp alive={} tool alive={}", alive(omp), alive(tool));
        assert!(elapsed < TREE_LIMIT, "took {elapsed:?}");
        // sleep died on SIGKILL after the grace period would have been needed for a
        // stand-in that ignores SIGTERM; plain sleep exits on SIGTERM at once.
        assert_eq!(status.code(), Some(143));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_orphan_that_exits_is_reaped_while_omp_runs() {
        // The subshell exits at once, so its `sleep 1` is reparented to the supervisor.
        let args = vec!["-c".to_string(), "(/usr/bin/sleep 1 &); exec /usr/bin/sleep 600".to_string()];
        let mut supervised = spawn_supervised(Path::new("bash"), &args, |command| {
            command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::inherit());
        })
        .unwrap();
        let omp = read_pid_line(&mut supervised.control_read).await.expect("pid line");
        let supervisor = supervised.child.id().expect("supervisor pid");
        let orphan_of_supervisor = || {
            std::fs::read_dir("/proc")
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(|entry| entry.file_name().to_string_lossy().parse::<u32>().ok())
                .find(|pid| ppid(*pid) == Some(supervisor) && cmdline(*pid) == [SLEEP_BIN, "1"])
        };
        let mut orphan = None;
        assert!(
            wait_until(Duration::from_secs(5), || {
                orphan = orphan_of_supervisor();
                orphan.is_some()
            })
            .await,
            "the orphan was never reparented to the supervisor"
        );
        let orphan = orphan.unwrap();
        let reaped = wait_until(Duration::from_secs(5), || !Path::new(&format!("/proc/{orphan}")).exists()).await;
        assert!(reaped, "the exited orphan is still in the process table: {:?}", std::fs::read_to_string(format!("/proc/{orphan}/stat")));
        assert!(alive(omp), "omp must keep running");

        // omp's own status still reaches the supervisor's exit code.
        let _ = nix::sys::signal::kill(nix::unistd::Pid::from_raw(omp as i32), nix::sys::signal::Signal::SIGKILL);
        let status = tokio::time::timeout(Duration::from_secs(10), supervised.child.wait()).await.expect("supervisor exits").unwrap();
        assert_eq!(status.code(), Some(137));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sigterm_runs_the_grace_period_before_the_kill() {
        let script = r#"trap "sleep 1; exit 143" TERM; /usr/bin/sleep 600 & wait"#;
        let args = vec!["-c".to_string(), script.to_string()];
        let mut supervised = spawn_supervised(Path::new("bash"), &args, |command| {
            command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::inherit());
        })
        .unwrap();
        let omp = read_pid_line(&mut supervised.control_read).await.expect("pid line");
        assert!(wait_until(Duration::from_secs(5), || !sleeps_under(omp).is_empty()).await, "the background sleep never appeared");
        let orphan = sleeps_under(omp)[0];
        let supervisor = supervised.child.id().unwrap();

        let started = Instant::now();
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(supervisor as i32), nix::sys::signal::Signal::SIGTERM).unwrap();
        let status = tokio::time::timeout(Duration::from_secs(8), supervised.child.wait()).await.expect("supervisor exits").unwrap();
        let elapsed = started.elapsed();
        assert_eq!(status.code(), Some(143));
        assert!(elapsed >= Duration::from_secs(1) && elapsed < Duration::from_secs(5), "took {elapsed:?}");
        assert!(wait_until(Duration::from_secs(2), || !alive(orphan)).await, "the orphaned sleep survived");
        assert!(!alive(omp));
    }

    /// The S7b gate: `kill -9` of the GUI leaves no supervisor, no omp and no tool child.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sigkill_of_the_parent_kills_the_child_tree_within_10_s() {
        let mut gui = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "omp::supervisor::tests::gui_role_helper"])
            .args(TEST_HARNESS_ARGS)
            .env(TEST_ROLE_ENV, "gui")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdout = gui.stdout.take().unwrap();
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        let mut pids: Option<(u32, u32)> = None;
        let deadline = tokio::time::sleep(Duration::from_secs(20));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                line = lines.next_line() => match line {
                    Ok(Some(line)) => {
                        if let Some(rest) = line.strip_prefix("tree ") {
                            let mut parts = rest.split_whitespace().filter_map(|part| part.parse::<u32>().ok());
                            pids = Some((parts.next().unwrap(), parts.next().unwrap()));
                            break;
                        }
                    }
                    _ => break,
                },
                _ = &mut deadline => break,
            }
        }
        let (supervisor, omp) = pids.expect("the stand-in GUI reported its tree");
        assert!(wait_until(Duration::from_secs(5), || !sleeps_under(omp).is_empty()).await, "the tool child never appeared");
        let tool = sleeps_under(omp)[0];
        let gui_pid = gui.id().unwrap();
        assert_eq!(ppid(supervisor), Some(gui_pid));

        let started = Instant::now();
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(gui_pid as i32), nix::sys::signal::Signal::SIGKILL).unwrap();
        let _ = gui.wait().await;
        let gone = wait_until(TREE_LIMIT, || !alive(supervisor) && !alive(omp) && !alive(tool)).await;
        let elapsed = started.elapsed();
        assert!(gone, "supervisor alive={} omp alive={} tool alive={}", alive(supervisor), alive(omp), alive(tool));
        assert!(elapsed < TREE_LIMIT, "took {elapsed:?}");
    }

    use tokio::io::AsyncBufReadExt;

    /// Stand-in GUI for the S7b gate: spawns the tool tree through the manager's
    /// supervised spawn, reports the pids on stdout and sleeps until killed.
    /// Without the role variable (a plain `cargo test`) it only checks its own wiring.
    #[test]
    fn gui_role_helper() {
        if std::env::var(TEST_ROLE_ENV).as_deref() != Ok("gui") {
            return;
        }
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let args = vec!["-c".to_string(), TOOL_TREE.to_string()];
            let mut supervised = spawn_supervised(Path::new("bash"), &args, |command| {
                command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::inherit());
            })
            .unwrap();
            let omp = read_pid_line(&mut supervised.control_read).await.unwrap();
            let supervisor = supervised.child.id().unwrap();
            println!("tree {supervisor} {omp}");
            tokio::time::sleep(Duration::from_secs(600)).await;
        });
    }

    /// The harness flags leave omp's first byte at the start of a line: the
    /// supervised child's own output must come back as a clean line.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_test_relaunch_keeps_omp_stdout_line_aligned() {
        let args = vec!["marker".to_string()];
        let mut supervised = spawn_supervised(Path::new("/bin/echo"), &args, |command| {
            command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::inherit());
        })
        .unwrap();
        let stdout = supervised.child.stdout.take().unwrap();
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        let mut seen = Vec::new();
        while let Ok(Some(line)) = lines.next_line().await {
            seen.push(line);
        }
        let status = supervised.child.wait().await.unwrap();
        assert_eq!(status.code(), Some(0));
        assert!(seen.iter().any(|line| line == "marker"), "stdout lines were {seen:?}");
    }
}
