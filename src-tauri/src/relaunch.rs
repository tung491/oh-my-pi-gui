//! The command that starts the updated app once this process has exited.
//!
//! An AppImage relaunch must not hand the new process anything that pins the
//! old image's FUSE mount: the type-2 runtime keeps its mount alive for as long
//! as any process holds the read end of its keepalive pipe (an inherited fd),
//! has its cwd under the mount, or loads libraries through `$APPDIR` entries in
//! `LD_LIBRARY_PATH` and friends. So the relaunch closes every descriptor past
//! stdio on exec, starts outside the old mount, and drops every old-`$APPDIR`
//! component from the environment. The supervisor and the omp sidecar are
//! spawned elsewhere and deliberately keep the pipe, so the mount outlives them.
//!
//! A process running with `no_new_privs` hands the flag to everything it
//! spawns, and the flag stops setuid programs such as `pkexec` from gaining
//! privileges. Such a process therefore starts the app through the user's
//! service manager (`launch_detached`), which starts it without the flag.

#[cfg(target_os = "linux")]
use std::ffi::OsStr;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use tokio::process::Command;

/// The 0.9.x Electron updater sets this so a freshly installed AppImage exits at
/// once (`main.rs`); a relaunched app that inherited it would quit immediately.
const EXIT_AFTER_INSTALL: &str = "APPIMAGE_EXIT_AFTER_INSTALL";

/// `program args` with `env` minus anything under `appdirs` (AppImage mounts
/// that go away; none outside an AppImage), started in `cwd` in a session of
/// its own, inheriting only stdio. A relaunch of the app passes no arguments,
/// so a launch link or workspace is not replayed.
pub(crate) fn relaunch_command(program: &Path, args: &[OsString], env: Vec<(OsString, OsString)>, appdirs: &[&Path], cwd: &Path) -> Command {
    let mut command = Command::new(program);
    command.args(args).env_clear().envs(scrub_env(env, appdirs)).env_remove(EXIT_AFTER_INSTALL).current_dir(cwd);
    #[cfg(target_os = "linux")]
    {
        close_inherited_fds_on_exec(command.as_std_mut());
        start_new_session_on_exec(command.as_std_mut());
    }
    command
}

/// Whether this process runs with `no_new_privs` (`NoNewPrivs: 1` in
/// `/proc/self/status`). The flag is inherited and can never be cleared, so
/// `pkexec` fails ("must be setuid root") until the app is started afresh.
/// Always false where there is no procfs.
pub(crate) fn no_new_privs() -> bool {
    std::fs::read_to_string("/proc/self/status").is_ok_and(|status| parse_no_new_privs(&status))
}

fn parse_no_new_privs(status: &str) -> bool {
    status.lines().find_map(|line| line.strip_prefix("NoNewPrivs:")).is_some_and(|value| value.trim() == "1")
}

/// Variables the launching process set for itself that the app it starts must
/// not inherit. `*` matches any run of characters.
///
/// - Electron and Chromium settings: `GDK_BACKEND=x11` would put the app on
///   XWayland, `NO_AT_BRIDGE=1` turns accessibility off, and `CHROME_*` covers
///   `CHROME_DESKTOP`.
/// - The 0.9.x AppImage updater's install flags (`APPIMAGE_EXIT_AFTER_INSTALL`
///   would make the app quit at once) and the AppImage runtime's own
///   variables, which a started AppImage sets afresh and a .deb must not see.
/// - One-shot startup tokens, and the service manager's bookkeeping for the
///   unit the launching process ran in.
#[cfg(target_os = "linux")]
const INHERITED_LAUNCH_ENV: &[&str] = &[
    "GDK_BACKEND",
    "NO_AT_BRIDGE",
    "FC_FONTATIONS",
    "ELECTRON_*",
    "CHROME_*",
    "ORIGINAL_XDG_CURRENT_DESKTOP",
    "APPIMAGE_*_INSTALL",
    "APPIMAGE",
    "APPDIR",
    "ARGV0",
    "OWD",
    "DESKTOP_STARTUP_ID",
    "XDG_ACTIVATION_TOKEN",
    "GIO_LAUNCHED_*",
    "LISTEN_*",
    "INVOCATION_ID",
    "NOTIFY_SOCKET",
    "MANAGERPID",
    "JOURNAL_STREAM",
];

#[cfg(target_os = "linux")]
fn is_inherited_launch_var(name: &OsStr) -> bool {
    let Some(name) = name.to_str() else { return false };
    INHERITED_LAUNCH_ENV.iter().any(|pattern| match pattern.split_once('*') {
        Some((prefix, suffix)) => name.len() >= prefix.len() + suffix.len() && name.starts_with(prefix) && name.ends_with(suffix),
        None => name == *pattern,
    })
}

/// The environment for an app started on another process's behalf:
/// `scrub_env` for the mounts that go away, minus `INHERITED_LAUNCH_ENV`.
#[cfg(target_os = "linux")]
pub(crate) fn launch_env(env: Vec<(OsString, OsString)>, appdirs: &[&Path]) -> Vec<(OsString, OsString)> {
    scrub_env(env, appdirs).into_iter().filter(|(name, _)| !is_inherited_launch_var(name)).collect()
}

/// Whether `path` is `root` or inside it (see `is_under`).
#[cfg(target_os = "linux")]
pub(crate) fn path_is_under(path: &Path, root: &Path) -> bool {
    is_under(path.as_os_str(), root.as_os_str())
}

/// The relaunch's working directory: this process's cwd unless it is gone or
/// lies under one of `appdirs`, in which case `home`, else `/`. A .deb
/// relaunch therefore keeps the cwd it always had.
pub(crate) fn relaunch_cwd(current: Option<&Path>, appdirs: &[&Path], home: Option<&Path>) -> PathBuf {
    match current {
        Some(dir) if !appdirs.iter().any(|appdir| is_under(dir.as_os_str(), appdir.as_os_str())) => dir.to_path_buf(),
        _ => home.map_or_else(|| PathBuf::from("/"), Path::to_path_buf),
    }
}

/// `env` with every `:`-separated component equal to or under one of
/// `appdirs` removed; a variable left with no non-empty component is dropped.
/// Without a mount (not an AppImage) the environment passes through unchanged.
pub(crate) fn scrub_env(env: Vec<(OsString, OsString)>, appdirs: &[&Path]) -> Vec<(OsString, OsString)> {
    let appdirs: Vec<&std::ffi::OsStr> = appdirs.iter().map(|appdir| appdir.as_os_str()).filter(|appdir| !normalize(appdir).is_empty()).collect();
    if appdirs.is_empty() {
        return env;
    }
    env.into_iter().filter_map(|(key, value)| scrub_value(&value, &appdirs).map(|value| (key, value))).collect()
}

#[cfg(unix)]
fn scrub_value(value: &std::ffi::OsStr, appdirs: &[&std::ffi::OsStr]) -> Option<OsString> {
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    let components: Vec<&[u8]> = value.as_bytes().split(|byte| *byte == b':').collect();
    let kept: Vec<&[u8]> =
        components.iter().copied().filter(|component| !appdirs.iter().any(|appdir| is_under(std::ffi::OsStr::from_bytes(component), appdir))).collect();
    if kept.len() == components.len() {
        return Some(value.to_os_string());
    }
    if kept.iter().all(|component| component.is_empty()) {
        return None;
    }
    Some(OsString::from_vec(kept.join(&b':')))
}

/// Whether `path` is `root` or inside it, ignoring repeated and trailing slashes
/// (AppRun scripts write `$APPDIR//usr/lib`).
fn is_under(path: &std::ffi::OsStr, root: &std::ffi::OsStr) -> bool {
    let (path, root) = (normalize(path), normalize(root));
    !root.is_empty() && (path == root || path.strip_prefix(root.as_str()).is_some_and(|rest| rest.starts_with('/')))
}

/// `path` with runs of `/` collapsed and a trailing `/` dropped. Lossy UTF-8 is
/// fine: a component that is not UTF-8 cannot equal a UTF-8 mount path anyway,
/// and the replacement character never forms a false `/` boundary.
fn normalize(path: &std::ffi::OsStr) -> String {
    let mut out = String::new();
    for ch in path.to_string_lossy().chars() {
        if ch == '/' && out.ends_with('/') {
            continue;
        }
        out.push(ch);
    }
    if out.len() > 1 && out.ends_with('/') {
        out.pop();
    }
    out
}

/// The highest descriptor number the fallback sweep visits, bounded so an
/// unlimited `RLIMIT_NOFILE` cannot make the child spin (the kernel's default
/// `nr_open` is the same 2^20).
#[cfg(target_os = "linux")]
const FD_SWEEP_CAP: libc::c_int = 1 << 20;

/// Mark every descriptor from 3 up close-on-exec in the child, so the new
/// process inherits stdio only. Close-on-exec rather than closing keeps std's
/// own exec-error pipe working until `exec`, so a failed spawn still reports.
#[cfg(target_os = "linux")]
fn close_inherited_fds_on_exec(command: &mut std::process::Command) {
    use std::os::unix::process::CommandExt as _;
    // Read before the fork: `getrlimit` is not on the async-signal-safe list.
    let limit = fd_sweep_limit();
    // SAFETY: `pre_exec` runs in the forked child before `exec`, where only
    // async-signal-safe calls are allowed: the closure makes raw `syscall` and
    // `fcntl` calls and touches no heap or locks. Marking an fd close-on-exec
    // changes nothing until `exec`, so no descriptor std still uses is lost.
    unsafe {
        command.pre_exec(move || {
            mark_cloexec_from(3, limit);
            Ok(())
        });
    }
}

/// Start the child in a session of its own, so job control or a hangup aimed
/// at the launching process's terminal session cannot reach it.
#[cfg(target_os = "linux")]
fn start_new_session_on_exec(command: &mut std::process::Command) {
    use std::os::unix::process::CommandExt as _;
    // SAFETY: `setsid` is async-signal-safe and touches no memory. It fails only
    // for a process group leader, which a freshly forked child never is.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
}

#[cfg(target_os = "linux")]
fn fd_sweep_limit() -> libc::c_int {
    let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    // SAFETY: `getrlimit` only writes the struct it is given.
    let ok = unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } == 0;
    if !ok || limit.rlim_cur == libc::RLIM_INFINITY {
        return FD_SWEEP_CAP;
    }
    libc::c_int::try_from(limit.rlim_cur).map_or(FD_SWEEP_CAP, |soft| soft.min(FD_SWEEP_CAP))
}

/// `close_range(first, ~0, CLOSE_RANGE_CLOEXEC)` (Linux 5.11); on an older
/// kernel (`ENOSYS` before 5.9, `EINVAL` for the flag before 5.11) a bounded
/// `fcntl` sweep up to `limit`. Async-signal-safe.
#[cfg(target_os = "linux")]
fn mark_cloexec_from(first: libc::c_int, limit: libc::c_int) {
    // SAFETY: a raw syscall with plain integer arguments; it only changes descriptor flags.
    let marked = unsafe { libc::syscall(libc::SYS_close_range, first as libc::c_uint, libc::c_uint::MAX, libc::CLOSE_RANGE_CLOEXEC) } == 0;
    if !marked {
        mark_cloexec_by_sweep(first, limit);
    }
}

/// Set `FD_CLOEXEC` on every open descriptor in `first..limit`; closed numbers
/// fail `F_GETFD` with `EBADF` and are skipped.
#[cfg(target_os = "linux")]
fn mark_cloexec_by_sweep(first: libc::c_int, limit: libc::c_int) {
    for fd in first..limit {
        // SAFETY: `fcntl` on an arbitrary number is harmless: it fails with EBADF when closed.
        unsafe {
            let flags = libc::fcntl(fd, libc::F_GETFD);
            if flags >= 0 && flags & libc::FD_CLOEXEC == 0 {
                libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Starting the app outside this process tree
// ---------------------------------------------------------------------------

/// How `launch_detached` started the app.
#[cfg(target_os = "linux")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum LaunchRoute {
    /// A transient service of the user's systemd manager, free of this process's `no_new_privs`.
    UserManager { unit: String },
    /// `systemd-run` did not answer and the unit could not be stopped: the app
    /// may still start through it late, so it is not started a second time.
    Unconfirmed { unit: String, reason: String },
    /// A direct child of this process, which inherits its `no_new_privs`; `reason` says why
    /// the service manager was not used.
    Direct { reason: String },
}

#[cfg(target_os = "linux")]
impl LaunchRoute {
    /// The route's name in the runtime log.
    pub(crate) fn name(&self) -> &'static str {
        match self {
            LaunchRoute::UserManager { .. } => "systemd-run",
            LaunchRoute::Unconfirmed { .. } => "systemd-run (unconfirmed)",
            LaunchRoute::Direct { .. } => "direct",
        }
    }

    /// Why the service manager did not (verifiably) start the app.
    pub(crate) fn reason(&self) -> Option<&str> {
        match self {
            LaunchRoute::UserManager { .. } => None,
            LaunchRoute::Unconfirmed { reason, .. } | LaunchRoute::Direct { reason } => Some(reason),
        }
    }
}

/// The service-manager tools `launch_detached` runs, by absolute path like
/// the updater's other tools, and how long each may take.
#[cfg(target_os = "linux")]
#[derive(Clone, Debug)]
struct UserManagerTools {
    systemd_run: PathBuf,
    systemctl: PathBuf,
    /// How long `systemd-run` may take to report the started (or failed) exec.
    start_timeout: std::time::Duration,
    /// How long `systemctl stop` may take to cancel a start that timed out.
    stop_timeout: std::time::Duration,
}

#[cfg(target_os = "linux")]
impl UserManagerTools {
    fn system() -> Self {
        Self {
            systemd_run: PathBuf::from("/usr/bin/systemd-run"),
            systemctl: PathBuf::from("/usr/bin/systemctl"),
            start_timeout: std::time::Duration::from_secs(10),
            stop_timeout: std::time::Duration::from_secs(5),
        }
    }
}

/// Start `program args` in `cwd`, with `launch_env(env, appdirs)`, as a
/// transient service of the user's systemd manager, so the app does not
/// inherit this process's `no_new_privs`; when there is no user manager, or
/// `systemd-run` is missing or fails, as a direct child (`relaunch_command`).
/// Either way the app gets none of this process's stdio.
/// `purpose` goes into the unit's instance name and must be alphanumeric.
#[cfg(target_os = "linux")]
pub(crate) fn launch_detached(
    program: &Path,
    args: &[OsString],
    env: Vec<(OsString, OsString)>,
    appdirs: &[&Path],
    cwd: &Path,
    purpose: &str,
) -> std::io::Result<LaunchRoute> {
    launch_detached_with(&UserManagerTools::system(), program, args, env, appdirs, cwd, purpose)
}

#[cfg(target_os = "linux")]
fn launch_detached_with(
    tools: &UserManagerTools,
    program: &Path,
    args: &[OsString],
    env: Vec<(OsString, OsString)>,
    appdirs: &[&Path],
    cwd: &Path,
    purpose: &str,
) -> std::io::Result<LaunchRoute> {
    let env = launch_env(env, appdirs);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.subsec_nanos());
    let unit = unit_name(purpose, std::process::id(), nanos);
    let mut reason = match start_with_user_manager(tools, &unit, program, args, &env, cwd) {
        UserManagerStart::Started => return Ok(LaunchRoute::UserManager { unit }),
        UserManagerStart::Unconfirmed(reason) => return Ok(LaunchRoute::Unconfirmed { unit, reason }),
        UserManagerStart::NotStarted(reason) => reason,
    };
    // The AppImage runtime mounts itself through the setuid fusermount3,
    // which cannot gain privileges under no_new_privs either.
    if !appdirs.is_empty() && no_new_privs() {
        reason.push_str("; an AppImage started under no_new_privs usually cannot mount itself and may exit at once");
    }
    // Never waited for: this process exits right after the launch, and the
    // reparented child is reaped by init or the session's subreaper.
    //
    // No stdio is handed on either. This process's stdio belongs to whoever
    // started it, and that may wait for end-of-file on it: electron-updater
    // runs the AppImage install child through `execFileSync`, which returns
    // only once every holder of the child's stdout and stderr pipes has closed
    // them, so an inheriting waiter would freeze the old app for good. Nobody
    // reads a detached app's output, the app writes its own runtime log, and
    // the systemd-run route gives it the journal rather than these pipes.
    let mut command = relaunch_command(program, args, env, appdirs, cwd);
    command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    command.as_std_mut().spawn()?;
    Ok(LaunchRoute::Direct { reason })
}

/// A transient service name in the XDG `app-<ApplicationID>@<RANDOM>.service`
/// form, from which xdg-desktop-portal reads the app id (`APP_ID`) of the
/// started app; the instance part must be alphanumeric.
#[cfg(target_os = "linux")]
fn unit_name(purpose: &str, pid: u32, nanos: u32) -> String {
    format!("app-{}@{purpose}{pid}{nanos:08x}.service", crate::product::APP_ID)
}

/// `systemd-run`'s arguments for `program`. `Type=exec` makes `systemd-run`
/// fail when the exec itself fails; `ExitType=cgroup` keeps the unit (and so
/// an app relaunched from it later) alive while any of its processes runs,
/// where the default would stop the unit, killing the rest, when the first
/// process exits. `KillMode=mixed` makes a stop (`systemctl --user stop`, or
/// logout) send SIGTERM to the main process only, which is the app itself (the
/// AppImage handover waiter execs the image, whose runtime execs AppRun in
/// place; a `.deb` runs the binary directly), so the app runs its shutdown
/// while the AppImage's FUSE server, a forked child, keeps serving its files;
/// under the default `control-group` the FUSE server got SIGTERM too and the
/// app died of SIGBUS. The FUSE server exits once the app does, and whatever
/// still runs after `TimeoutStopSec=15` gets SIGKILL. `--setenv=NAME` without a value passes `systemd-run`'s own
/// value, so no value ever appears on a command line (the values do land in
/// the transient unit, readable by this user only, until it is collected).
/// The program path is passed as it is: `systemd-run` looks it up itself, so
/// escaping a `$` would name a file that does not exist, and the manager does
/// not expand variables in it. The manager does expand `$NAME` in the
/// arguments after it, so every `$` there is doubled.
#[cfg(target_os = "linux")]
fn systemd_run_args<'a>(unit: &str, program: &Path, program_args: &[OsString], env_names: impl IntoIterator<Item = &'a OsStr>, cwd: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> =
        ["--user", "--quiet", "--collect", "-p", "Type=exec", "-p", "ExitType=cgroup", "-p", "KillMode=mixed", "-p", "TimeoutStopSec=15"]
            .into_iter()
            .map(OsString::from)
            .collect();
    args.push(OsString::from(format!("--unit={unit}")));
    let mut working_directory = OsString::from("--working-directory=");
    working_directory.push(cwd);
    args.push(working_directory);
    for name in env_names {
        let mut setenv = OsString::from("--setenv=");
        setenv.push(name);
        args.push(setenv);
    }
    args.push(OsString::from("--"));
    args.push(program.as_os_str().to_os_string());
    args.extend(program_args.iter().map(|arg| escape_dollars(arg)));
    args
}

/// `arg` with every `$` doubled, which the service manager turns back into one.
#[cfg(target_os = "linux")]
fn escape_dollars(arg: &OsStr) -> OsString {
    use std::os::unix::ffi::{OsStrExt as _, OsStringExt as _};
    let mut escaped = Vec::with_capacity(arg.len());
    for byte in arg.as_bytes() {
        if *byte == b'$' {
            escaped.push(b'$');
        }
        escaped.push(*byte);
    }
    OsString::from_vec(escaped)
}

/// Whether the service manager accepts this variable: a shell-style name and
/// a single-line UTF-8 value. The rest come from the manager's own environment.
#[cfg(target_os = "linux")]
fn passes_to_user_manager(name: &OsStr, value: &OsStr) -> bool {
    let valid_name = name.to_str().is_some_and(|name| {
        let mut chars = name.chars();
        chars.next().is_some_and(|first| first.is_ascii_alphabetic() || first == '_') && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    });
    valid_name && value.to_str().is_some_and(|value| !value.contains('\n'))
}

/// `systemd-run --user` reaches the manager through `$XDG_RUNTIME_DIR`; without it there is none to ask.
#[cfg(target_os = "linux")]
fn has_user_manager(env: &[(OsString, OsString)]) -> bool {
    env.iter().any(|(name, value)| name == "XDG_RUNTIME_DIR" && !value.is_empty())
}

/// What asking the user's service manager to start the app came to.
#[cfg(target_os = "linux")]
#[derive(Debug, PartialEq, Eq)]
enum UserManagerStart {
    Started,
    /// Not started that way, and nothing is left that could start it later.
    NotStarted(String),
    /// No answer, and the queued start could not be cancelled.
    Unconfirmed(String),
}

/// How a bounded tool run ended.
#[cfg(target_os = "linux")]
enum ToolRun {
    Exited { status: std::process::ExitStatus, stderr: String },
    TimedOut,
    SpawnFailed(std::io::Error),
}

/// Run `program args` with only `env`, outside any old mount, inheriting no
/// descriptors, and wait up to `timeout`; a run past it is killed.
#[cfg(target_os = "linux")]
fn run_tool(program: &Path, args: &[OsString], env: &[&(OsString, OsString)], timeout: std::time::Duration) -> ToolRun {
    use std::io::Read as _;
    let mut command = std::process::Command::new(program);
    command
        .args(args)
        .env_clear()
        .envs(env.iter().map(|(name, value)| (name, value)))
        .current_dir("/")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    close_inherited_fds_on_exec(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return ToolRun::SpawnFailed(error),
    };
    let pid = libc::pid_t::try_from(child.id()).unwrap_or(libc::pid_t::MAX);
    if !wait_for_exit(pid, timeout, &mut || matches!(child.try_wait(), Ok(None))) {
        let _ = child.kill();
        let _ = child.wait();
        return ToolRun::TimedOut;
    }
    let status = match child.wait() {
        Ok(status) => status,
        Err(error) => return ToolRun::SpawnFailed(error),
    };
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut stderr);
    }
    ToolRun::Exited { status, stderr: stderr.trim().to_string() }
}

/// `systemctl stop` exits with this when the unit is not loaded: no start job
/// was ever queued, or it is gone.
#[cfg(target_os = "linux")]
const SYSTEMCTL_UNIT_NOT_LOADED: i32 = 5;

/// Run `systemd-run` and wait for its answer. A `systemd-run` that times out
/// is killed, but the start job it queued may still run, so the unit is
/// stopped (which cancels a pending start) before anything else starts the app.
#[cfg(target_os = "linux")]
fn start_with_user_manager(tools: &UserManagerTools, unit: &str, program: &Path, program_args: &[OsString], env: &[(OsString, OsString)], cwd: &Path) -> UserManagerStart {
    if !has_user_manager(env) {
        return UserManagerStart::NotStarted("XDG_RUNTIME_DIR is not set, so there is no user service manager".into());
    }
    let passed: Vec<&(OsString, OsString)> = env.iter().filter(|(name, value)| passes_to_user_manager(name, value)).collect();
    let args = systemd_run_args(unit, program, program_args, passed.iter().map(|(name, _)| name.as_os_str()), cwd);
    let tool = tools.systemd_run.display();
    match run_tool(&tools.systemd_run, &args, &passed, tools.start_timeout) {
        ToolRun::Exited { status, .. } if status.success() => UserManagerStart::Started,
        ToolRun::Exited { status, stderr } => UserManagerStart::NotStarted(format!("{tool} failed ({status}): {stderr}")),
        ToolRun::SpawnFailed(error) => UserManagerStart::NotStarted(format!("{tool} could not start: {error}")),
        ToolRun::TimedOut => {
            let timed_out = format!("{tool} did not answer within {} s", tools.start_timeout.as_secs_f32());
            let stop: Vec<OsString> = ["--user", "stop", unit].into_iter().map(OsString::from).collect();
            let stopped = match run_tool(&tools.systemctl, &stop, &passed, tools.stop_timeout) {
                ToolRun::Exited { status, .. } if status.success() || status.code() == Some(SYSTEMCTL_UNIT_NOT_LOADED) => Ok(()),
                ToolRun::Exited { status, stderr } => Err(format!("{status}: {stderr}")),
                ToolRun::TimedOut => Err(format!("no answer within {} s", tools.stop_timeout.as_secs_f32())),
                ToolRun::SpawnFailed(error) => Err(error.to_string()),
            };
            match stopped {
                Ok(()) => UserManagerStart::NotStarted(format!("{timed_out}; {unit} was stopped")),
                Err(error) => UserManagerStart::Unconfirmed(format!("{timed_out}, and stopping {unit} failed ({error})")),
            }
        }
    }
}

/// How often the fallback wait re-checks when the kernel has no `pidfd_open` (before 5.3).
#[cfg(target_os = "linux")]
const EXIT_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);

/// Wait up to `timeout` for process `pid` to exit; true once it has.
/// `alive` reports whether the process is still the one being waited for
/// (for a parent: `getppid()` still names it; for a child: not yet exited).
/// It settles the race between reading a pid and opening a pidfd for it, and
/// drives the polling fallback where `pidfd_open` is missing.
#[cfg(target_os = "linux")]
pub(crate) fn wait_for_exit(pid: libc::pid_t, timeout: std::time::Duration, alive: &mut dyn FnMut() -> bool) -> bool {
    use std::os::fd::{AsRawFd as _, FromRawFd as _, OwnedFd};
    let deadline = std::time::Instant::now() + timeout;
    if pid <= 1 || !alive() {
        return true;
    }
    // SAFETY: a raw syscall with plain integer arguments; it returns a new descriptor or -1.
    let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    let Ok(raw) = libc::c_int::try_from(raw) else { return poll_until_exit(deadline, alive) };
    if raw < 0 {
        return match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::ESRCH) => true,
            _ => poll_until_exit(deadline, alive),
        };
    }
    // SAFETY: `pidfd_open` just returned this descriptor, and nothing else owns it.
    let pidfd = unsafe { OwnedFd::from_raw_fd(raw) };
    // The pid may have been reused between reading it and opening the pidfd;
    // `alive` still true here means the pidfd names the process waited for.
    if !alive() {
        return true;
    }
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return false;
        }
        let millis = libc::c_int::try_from(remaining.as_micros().div_ceil(1000)).unwrap_or(libc::c_int::MAX);
        let mut entry = libc::pollfd { fd: pidfd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        // SAFETY: `poll` reads and writes exactly the one entry it is given.
        let ready = unsafe { libc::poll(&mut entry, 1, millis) };
        if ready > 0 {
            return true;
        }
        if ready < 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            return poll_until_exit(deadline, alive);
        }
    }
}

#[cfg(target_os = "linux")]
fn poll_until_exit(deadline: std::time::Instant, alive: &mut dyn FnMut() -> bool) -> bool {
    loop {
        if !alive() {
            return true;
        }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return false;
        }
        // A plain sleep: this runs before any async runtime exists, or at exit after it stopped.
        std::thread::sleep(remaining.min(EXIT_POLL_INTERVAL));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const APPDIR: &str = "/tmp/.mount_SaiATLabc123";

    fn pairs(entries: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        entries.iter().map(|(key, value)| (OsString::from(key), OsString::from(value))).collect()
    }

    fn scrubbed(entries: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        scrub_env(pairs(entries), &[Path::new(APPDIR)])
    }

    #[test]
    fn scrub_env_trims_old_appdir_components_and_keeps_the_rest() {
        let env = scrubbed(&[
            ("LD_LIBRARY_PATH", "/tmp/.mount_SaiATLabc123/usr/lib:/opt/lib"),
            ("XDG_DATA_DIRS", "/tmp/.mount_SaiATLabc123/usr/share:/usr/local/share:/usr/share"),
        ]);
        assert_eq!(env, pairs(&[("LD_LIBRARY_PATH", "/opt/lib"), ("XDG_DATA_DIRS", "/usr/local/share:/usr/share")]));
    }

    #[test]
    fn scrub_env_drops_a_variable_left_empty() {
        let env = scrubbed(&[
            ("GST_PLUGIN_SYSTEM_PATH_1_0", "/tmp/.mount_SaiATLabc123/usr/lib/gstreamer-1.0"),
            ("PYTHONPATH", "/tmp/.mount_SaiATLabc123/usr/share/pyshared:"),
            ("HOME", "/home/user"),
        ]);
        assert_eq!(env, pairs(&[("HOME", "/home/user")]));
    }

    #[test]
    fn scrub_env_drops_a_value_equal_to_appdir() {
        assert!(scrubbed(&[("APPDIR", APPDIR), ("OWD", "/tmp/.mount_SaiATLabc123/")]).is_empty());
    }

    #[test]
    fn scrub_env_matches_the_double_slash_form() {
        let env = scrubbed(&[("GTK_PATH", "/tmp/.mount_SaiATLabc123//usr/lib/gtk-3.0:/usr/lib/gtk-3.0"), ("PERLLIB", "/tmp//.mount_SaiATLabc123/usr/share/perl5")]);
        assert_eq!(env, pairs(&[("GTK_PATH", "/usr/lib/gtk-3.0")]));
    }

    #[test]
    fn scrub_env_leaves_unrelated_and_lookalike_values_untouched() {
        let entries = [
            ("APPIMAGE", "/home/user/Applications/Sai-ATLAS.AppImage"),
            ("DISPLAY", ":0"),
            ("PATH", "/usr/bin::/bin"),
            ("SIBLING", "/tmp/.mount_SaiATLabc1234/usr/lib"),
        ];
        assert_eq!(scrubbed(&entries), pairs(&entries));
    }

    #[test]
    fn scrub_env_without_an_old_appdir_is_the_identity() {
        let entries = pairs(&[("LD_LIBRARY_PATH", "/tmp/.mount_SaiATLabc123/usr/lib"), ("APPDIR", APPDIR)]);
        assert_eq!(scrub_env(entries.clone(), &[]), entries);
        assert_eq!(scrub_env(entries.clone(), &[Path::new("")]), entries);
    }

    #[test]
    fn scrub_env_drops_components_of_every_mount() {
        let install_child = Path::new("/tmp/.mount_Sai-ATGlNNdi");
        let env = pairs(&[
            ("PATH", "/tmp/.mount_Sai-ATGlNNdi/usr/bin:/tmp/.mount_SaiATLabc123/usr/bin:/usr/bin:/bin"),
            ("XDG_DATA_DIRS", "/tmp/.mount_SaiATLabc123/usr/share:/usr/share"),
            ("GTK_PATH", "/tmp/.mount_Sai-ATGlNNdi/usr/lib/gtk-3.0"),
            ("HOME", "/home/u"),
        ]);
        assert_eq!(
            scrub_env(env, &[install_child, Path::new(APPDIR)]),
            pairs(&[("PATH", "/usr/bin:/bin"), ("XDG_DATA_DIRS", "/usr/share"), ("HOME", "/home/u")])
        );
        assert_eq!(relaunch_cwd(Some(Path::new("/tmp/.mount_Sai-ATGlNNdi/usr")), &[Path::new(APPDIR), install_child], None), PathBuf::from("/"));
    }

    #[test]
    fn relaunch_cwd_leaves_the_old_mount() {
        let (appdir, home) = (&[Path::new(APPDIR)][..], Some(Path::new("/home/user")));
        assert_eq!(relaunch_cwd(Some(Path::new("/tmp/.mount_SaiATLabc123/usr/bin")), appdir, home), PathBuf::from("/home/user"));
        assert_eq!(relaunch_cwd(Some(Path::new(APPDIR)), appdir, None), PathBuf::from("/"));
        assert_eq!(relaunch_cwd(None, appdir, home), PathBuf::from("/home/user"));
    }

    #[test]
    fn relaunch_cwd_keeps_a_cwd_outside_the_mount() {
        let projects = Path::new("/home/user/projects");
        assert_eq!(relaunch_cwd(Some(projects), &[Path::new(APPDIR)], Some(Path::new("/home/user"))), projects);
        assert_eq!(relaunch_cwd(Some(projects), &[], Some(Path::new("/home/user"))), projects);
    }

    /// A pipe whose ends are inheritable, like the AppImage runtime's keepalive pipe.
    #[cfg(target_os = "linux")]
    fn inheritable_pipe() -> [libc::c_int; 2] {
        let mut fds = [0; 2];
        // SAFETY: `pipe` writes two descriptors into the array it is given.
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0, "pipe: {}", std::io::Error::last_os_error());
        fds
    }

    #[cfg(target_os = "linux")]
    fn close_pipe(fds: [libc::c_int; 2]) {
        for fd in fds {
            // SAFETY: the test owns both descriptors.
            unsafe { libc::close(fd) };
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn relaunch_command_inherits_only_stdio() {
        let pipe = inheritable_pipe();
        // `[ -e ]` filters the directory fd the glob itself opened and closed
        // (inside `if`, so a filtered last entry does not fail the loop).
        let script = r#"for f in /proc/self/fd/*; do if [ -e "$f" ]; then printf '%s ' "${f##*/}"; fi; done"#;
        let env = vec![(OsString::from("PATH"), OsString::from("/usr/bin:/bin"))];
        let output = relaunch_command(Path::new("/bin/sh"), &[], env, &[], Path::new("/")).arg("-c").arg(script).output().await.expect("spawn /bin/sh");
        close_pipe(pipe);
        assert!(output.status.success(), "{output:?}");
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim_end(), "0 1 2", "inherited pipe fds were {pipe:?}");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn relaunch_command_scrubs_env_and_starts_in_cwd() {
        let env = pairs(&[("LD_LIBRARY_PATH", "/tmp/.mount_SaiATLabc123/usr/lib"), ("KEEP", "yes"), (EXIT_AFTER_INSTALL, "1"), ("PATH", "/usr/bin:/bin")]);
        let script = r#"printf '%s|%s|%s|%s' "${LD_LIBRARY_PATH-unset}" "$KEEP" "${APPIMAGE_EXIT_AFTER_INSTALL-unset}" "$(pwd)""#;
        let output =
            relaunch_command(Path::new("/bin/sh"), &[], env, &[Path::new(APPDIR)], Path::new("/")).arg("-c").arg(script).output().await.expect("spawn /bin/sh");
        assert!(output.status.success(), "{output:?}");
        assert_eq!(String::from_utf8_lossy(&output.stdout), "unset|yes|unset|/");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn relaunch_command_passes_args_and_starts_a_new_session() {
        let env = vec![(OsString::from("PATH"), OsString::from("/usr/bin:/bin"))];
        let args: Vec<OsString> = ["-c", r#"printf '%s|%s|' "$1" "$2"; read -r stat < /proc/$$/stat; set -- $stat; echo "$6 $1""#, "sh", "one", "two $x"].into_iter().map(OsString::from).collect();
        let output = relaunch_command(Path::new("/bin/sh"), &args, env, &[], Path::new("/")).output().await.expect("spawn /bin/sh");
        assert!(output.status.success(), "{output:?}");
        let text = String::from_utf8_lossy(&output.stdout);
        let (printed, ids) = text.split_at(text.rfind('|').unwrap() + 1);
        assert_eq!(printed, "one|two $x|");
        let ids: Vec<&str> = ids.split_whitespace().collect();
        assert_eq!(ids.len(), 2, "{text}");
        assert_eq!(ids[0], ids[1], "the child leads its own session: {text}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_fallback_sweep_marks_open_fds_close_on_exec() {
        let pipe = inheritable_pipe();
        let (low, high) = (pipe[0].min(pipe[1]), pipe[0].max(pipe[1]));
        mark_cloexec_by_sweep(low, high + 1);
        // SAFETY: the test owns both descriptors.
        let flags: Vec<libc::c_int> = pipe.iter().map(|fd| unsafe { libc::fcntl(*fd, libc::F_GETFD) }).collect();
        close_pipe(pipe);
        assert!(flags.iter().all(|flags| *flags >= 0 && flags & libc::FD_CLOEXEC != 0), "{flags:?}");
    }

    #[test]
    fn reads_no_new_privs_from_proc_status() {
        assert!(parse_no_new_privs("Name:\tsai-atlas\nSeccomp:\t0\nNoNewPrivs:\t1\nSpeculation_Store_Bypass:\tthread vulnerable\n"));
        assert!(!parse_no_new_privs("Name:\tsai-atlas\nNoNewPrivs:\t0\n"));
        assert!(!parse_no_new_privs("Name:\tsai-atlas\n"), "a kernel without the field has no flag");
        assert!(!parse_no_new_privs(""));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn launch_env_drops_what_electron_and_the_launcher_set_for_themselves() {
        let dropped = [
            "GDK_BACKEND",
            "NO_AT_BRIDGE",
            "CHROME_DESKTOP",
            "FC_FONTATIONS",
            "ELECTRON_RUN_AS_NODE",
            "ELECTRON_NO_ATTACH_CONSOLE",
            "CHROME_WRAPPER",
            "ORIGINAL_XDG_CURRENT_DESKTOP",
            "APPIMAGE_EXIT_AFTER_INSTALL",
            "APPIMAGE_SILENT_INSTALL",
            "APPIMAGE",
            "APPDIR",
            "ARGV0",
            "OWD",
            "DESKTOP_STARTUP_ID",
            "XDG_ACTIVATION_TOKEN",
            "GIO_LAUNCHED_DESKTOP_FILE",
            "GIO_LAUNCHED_DESKTOP_FILE_PID",
            "LISTEN_PID",
            "LISTEN_FDS",
            "LISTEN_FDNAMES",
            "INVOCATION_ID",
            "NOTIFY_SOCKET",
            "MANAGERPID",
            "JOURNAL_STREAM",
        ];
        let kept = [
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "XAUTHORITY",
            "XDG_RUNTIME_DIR",
            "XDG_SESSION_TYPE",
            "XDG_CURRENT_DESKTOP",
            "XDG_DATA_DIRS",
            "XDG_CONFIG_HOME",
            "DBUS_SESSION_BUS_ADDRESS",
            "LANG",
            "LC_ALL",
            "HOME",
            "PATH",
            "SSH_AUTH_SOCK",
            "GTK_THEME",
            "QT_IM_MODULE",
            "XMODIFIERS",
            "GDK_SCALE",
            "GDK_DPI_SCALE",
            "XCURSOR_SIZE",
            "APPIMAGELAUNCHER_DISABLE",
            "APPIMAGE_INSTALL",
        ];
        let env: Vec<(OsString, OsString)> = dropped.iter().chain(kept.iter()).map(|name| (OsString::from(name), OsString::from("1"))).collect();
        let names: Vec<String> = launch_env(env, &[]).into_iter().map(|(name, _)| name.to_string_lossy().into_owned()).collect();
        assert_eq!(names, kept);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn launch_env_also_scrubs_the_old_mount() {
        let env = pairs(&[("LD_LIBRARY_PATH", "/tmp/.mount_SaiATLabc123/usr/lib:/opt/lib"), ("APPDIR", APPDIR), ("GDK_BACKEND", "x11"), ("HOME", "/home/u")]);
        assert_eq!(launch_env(env, &[Path::new(APPDIR)]), pairs(&[("LD_LIBRARY_PATH", "/opt/lib"), ("HOME", "/home/u")]));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn systemd_run_starts_a_transient_service_that_outlives_its_first_process() {
        let names = [OsStr::new("DISPLAY"), OsStr::new("PATH")];
        let args = systemd_run_args("app-vn.io.vif.saiatlas-handover-42-0000abcd.service", Path::new("/usr/bin/sai-atlas"), &[], names, Path::new("/home/u/my projects"));
        let expected: Vec<OsString> = [
            "--user",
            "--quiet",
            "--collect",
            "-p",
            "Type=exec",
            "-p",
            "ExitType=cgroup",
            "-p",
            "KillMode=mixed",
            "-p",
            "TimeoutStopSec=15",
            "--unit=app-vn.io.vif.saiatlas-handover-42-0000abcd.service",
            "--working-directory=/home/u/my projects",
            "--setenv=DISPLAY",
            "--setenv=PATH",
            "--",
            "/usr/bin/sai-atlas",
        ]
        .into_iter()
        .map(OsString::from)
        .collect();
        assert_eq!(args, expected);
        assert!(!args.iter().any(|arg| arg == "--scope"), "a scope would run the app under this process's no_new_privs");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn systemd_run_passes_program_arguments_after_the_program_with_dollars_doubled() {
        let program_args: Vec<OsString> = ["-c", r#"echo "$1" ${HOME}"#, "sh", "/x/Sai ATLAS.AppImage"].into_iter().map(OsString::from).collect();
        let args = systemd_run_args("app-vn.io.vif.saiatlas@handover1.service", Path::new("/bin/sh"), &program_args, [OsStr::new("PATH")], Path::new("/"));
        let separator = args.iter().position(|arg| arg == "--").unwrap();
        let tail: Vec<&OsStr> = args[separator + 1..].iter().map(OsString::as_os_str).collect();
        assert_eq!(tail, [OsStr::new("/bin/sh"), OsStr::new("-c"), OsStr::new(r#"echo "$$1" $${HOME}"#), OsStr::new("sh"), OsStr::new("/x/Sai ATLAS.AppImage")]);
        // The program path itself is never escaped: systemd-run looks it up as written.
        let dollar_program = systemd_run_args("u.service", Path::new("/opt/a$b/app"), &[], [], Path::new("/"));
        assert_eq!(dollar_program.last().map(OsString::as_os_str), Some(OsStr::new("/opt/a$b/app")));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn only_shell_style_names_with_single_line_utf8_values_reach_the_service_manager() {
        assert!(passes_to_user_manager(OsStr::new("DISPLAY"), OsStr::new(":0")));
        assert!(passes_to_user_manager(OsStr::new("_X1"), OsStr::new("")));
        assert!(!passes_to_user_manager(OsStr::new("1X"), OsStr::new("v")));
        assert!(!passes_to_user_manager(OsStr::new("A-B"), OsStr::new("v")));
        assert!(!passes_to_user_manager(OsStr::new(""), OsStr::new("v")));
        assert!(!passes_to_user_manager(OsStr::new("A"), OsStr::new("two\nlines")));
        use std::os::unix::ffi::OsStrExt as _;
        assert!(!passes_to_user_manager(OsStr::new("A"), OsStr::from_bytes(b"\xff")));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unit_names_follow_the_xdg_app_convention() {
        let name = unit_name("handover", 4242, 0xabc);
        assert_eq!(name, "app-vn.io.vif.saiatlas@handover424200000abc.service");
        // xdg-desktop-portal's rule for a host app's id from its systemd unit.
        let portal = regex::Regex::new(r"^app-(?:[[:alnum:]]+\-)?(.+?)(?:@[[:alnum:]]*|\-autostart)?\.service$").unwrap();
        let app_id = portal.captures(&name).and_then(|captures| captures.get(1)).map(|id| id.as_str());
        assert_eq!(app_id, Some(crate::product::APP_ID));
        assert!(has_user_manager(&pairs(&[("XDG_RUNTIME_DIR", "/run/user/1000")])));
        assert!(!has_user_manager(&pairs(&[("XDG_RUNTIME_DIR", "")])));
        assert!(!has_user_manager(&pairs(&[("HOME", "/home/u")])));
    }

    /// An executable script written by a child process, so no descriptor of
    /// this test process ever holds it open for writing (a concurrent fork
    /// inheriting one would make the exec fail with ETXTBSY).
    #[cfg(target_os = "linux")]
    fn write_script(path: &Path, body: &str) {
        use std::io::Write as _;
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "cat > \"$1\" && chmod 755 \"$1\"", "sh"])
            .arg(path)
            .stdin(std::process::Stdio::piped())
            .spawn()
            .expect("spawn /bin/sh");
        child.stdin.take().expect("stdin").write_all(body.as_bytes()).expect("write the script");
        assert!(child.wait().expect("wait").success());
    }

    #[cfg(target_os = "linux")]
    fn wait_for_file(path: &Path) -> String {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            if let Ok(text) = std::fs::read_to_string(path) {
                if text.ends_with('\n') {
                    return text;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!("{} never appeared", path.display());
    }

    /// Service-manager tools that are fakes in `dir` (or absent), with short timeouts.
    #[cfg(target_os = "linux")]
    fn fake_tools(dir: &Path) -> UserManagerTools {
        UserManagerTools {
            systemd_run: dir.join("systemd-run"),
            systemctl: dir.join("systemctl"),
            start_timeout: std::time::Duration::from_millis(300),
            stop_timeout: std::time::Duration::from_secs(5),
        }
    }

    /// A launch target that records its argument count into `marker`.
    #[cfg(target_os = "linux")]
    fn marker_app(dir: &Path) -> (PathBuf, PathBuf) {
        let (script, marker) = (dir.join("app"), dir.join("marker"));
        write_script(&script, &format!("#!/bin/sh\necho \"started $#\" > '{}'\n", marker.display()));
        (script, marker)
    }

    #[cfg(target_os = "linux")]
    fn manager_env(dir: &Path) -> Vec<(OsString, OsString)> {
        pairs(&[("PATH", "/usr/bin:/bin"), ("XDG_RUNTIME_DIR", dir.to_str().unwrap()), ("SECRET", "s3cr3t value"), ("GDK_BACKEND", "x11")])
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn launch_detached_falls_back_to_a_direct_child_without_a_user_manager() {
        let dir = tempfile::tempdir().unwrap();
        let (script, marker) = (dir.path().join("app"), dir.path().join("marker"));
        write_script(&script, &format!("#!/bin/sh\necho \"$#|$KEEP|${{GDK_BACKEND-unset}}|$(pwd)\" > '{}'\n", marker.display()));
        let env = pairs(&[("PATH", "/usr/bin:/bin"), ("KEEP", "yes"), ("GDK_BACKEND", "x11")]);
        let route = launch_detached_with(&fake_tools(dir.path()), &script, &[], env, &[], dir.path(), "test").unwrap();
        assert!(matches!(&route, LaunchRoute::Direct { reason } if reason.contains("XDG_RUNTIME_DIR")), "{route:?}");
        assert_eq!(wait_for_file(&marker), format!("0|yes|unset|{}\n", dir.path().display()));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn launch_detached_falls_back_when_systemd_run_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let (script, marker) = marker_app(dir.path());
        let route = launch_detached_with(&fake_tools(dir.path()), &script, &[], manager_env(dir.path()), &[], dir.path(), "test").unwrap();
        assert!(matches!(&route, LaunchRoute::Direct { reason } if reason.contains("could not start")), "{route:?}");
        assert_eq!(route.name(), "direct");
        assert_eq!(wait_for_file(&marker), "started 0\n");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn launch_detached_hands_systemd_run_variable_names_and_values_only_through_its_environment() {
        let dir = tempfile::tempdir().unwrap();
        let (script, marker) = marker_app(dir.path());
        let (args_file, env_file) = (dir.path().join("args"), dir.path().join("env"));
        write_script(
            &dir.path().join("systemd-run"),
            &format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nenv > '{}'\n", args_file.display(), env_file.display()),
        );
        let tools = fake_tools(dir.path());
        let route = launch_detached_with(&tools, &script, &[], manager_env(dir.path()), &[], dir.path(), "test").unwrap();
        let LaunchRoute::UserManager { unit } = &route else { panic!("{route:?}") };
        assert_eq!(route.name(), "systemd-run");
        let args = std::fs::read_to_string(&args_file).unwrap();
        assert!(args.lines().any(|line| line == format!("--unit={unit}")), "{args}");
        assert!(args.lines().any(|line| line == "--setenv=SECRET"), "{args}");
        assert!(!args.contains("s3cr3t"), "a value reached the command line: {args}");
        assert!(!args.contains("GDK_BACKEND"), "{args}");
        assert_eq!(args.lines().last(), Some(script.to_str().unwrap()));
        let env = std::fs::read_to_string(&env_file).unwrap();
        assert!(env.lines().any(|line| line == "SECRET=s3cr3t value"), "{env}");
        assert!(!env.contains("GDK_BACKEND"), "{env}");
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(!marker.exists(), "the app was started a second time, directly");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn launch_detached_puts_the_program_arguments_after_the_program() {
        let dir = tempfile::tempdir().unwrap();
        let args_file = dir.path().join("args");
        write_script(&dir.path().join("systemd-run"), &format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n", args_file.display()));
        let program_args: Vec<OsString> = ["-c", "exec \"$2\"", "sh", "4242", "/x/Name.AppImage"].into_iter().map(OsString::from).collect();
        let route =
            launch_detached_with(&fake_tools(dir.path()), Path::new("/bin/sh"), &program_args, manager_env(dir.path()), &[], dir.path(), "handover").unwrap();
        assert!(matches!(route, LaunchRoute::UserManager { .. }), "{route:?}");
        let args = std::fs::read_to_string(&args_file).unwrap();
        let tail: Vec<&str> = args.lines().skip_while(|line| *line != "--").collect();
        assert_eq!(tail, ["--", "/bin/sh", "-c", "exec \"$$2\"", "sh", "4242", "/x/Name.AppImage"]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn launch_detached_hands_no_stdio_to_a_direct_child() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("marker");
        let program_args: Vec<OsString> =
            // Read inside a substitution: dash points its own fd 1 at a redirect's file while the command runs.
            ["-c", "fds=$(readlink /proc/$$/fd/0 /proc/$$/fd/1 /proc/$$/fd/2) && echo \"$fds\" > \"$1.tmp\" && mv \"$1.tmp\" \"$1\"", "sh", marker.to_str().unwrap()]
                .into_iter()
                .map(OsString::from)
                .collect();
        let route = launch_detached_with(&fake_tools(dir.path()), Path::new("/bin/sh"), &program_args, manager_env(dir.path()), &[], dir.path(), "test").unwrap();
        assert!(matches!(route, LaunchRoute::Direct { .. }), "{route:?}");
        assert_eq!(wait_for_file(&marker), "/dev/null\n/dev/null\n/dev/null\n");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn launch_detached_passes_the_program_arguments_on_the_direct_route() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("marker");
        let program_args: Vec<OsString> =
            ["-c", "echo \"$1 $2\" > \"$3\"", "sh", "first", "$second", marker.to_str().unwrap()].into_iter().map(OsString::from).collect();
        let route = launch_detached_with(&fake_tools(dir.path()), Path::new("/bin/sh"), &program_args, manager_env(dir.path()), &[], dir.path(), "test").unwrap();
        assert!(matches!(route, LaunchRoute::Direct { .. }), "{route:?}");
        assert_eq!(wait_for_file(&marker), "first $second\n");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn launch_detached_falls_back_when_systemd_run_fails() {
        let dir = tempfile::tempdir().unwrap();
        let (script, marker) = marker_app(dir.path());
        write_script(&dir.path().join("systemd-run"), "#!/bin/sh\necho 'Failed to connect to bus' >&2\nexit 1\n");
        let route = launch_detached_with(&fake_tools(dir.path()), &script, &[], manager_env(dir.path()), &[], dir.path(), "test").unwrap();
        assert!(matches!(&route, LaunchRoute::Direct { reason } if reason.contains("Failed to connect to bus")), "{route:?}");
        assert_eq!(wait_for_file(&marker), "started 0\n");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn launch_detached_stops_a_unit_that_timed_out_before_starting_the_app_directly() {
        let dir = tempfile::tempdir().unwrap();
        let (script, marker) = marker_app(dir.path());
        let stop_file = dir.path().join("stop");
        write_script(&dir.path().join("systemd-run"), "#!/bin/sh\nexec sleep 30\n");
        write_script(&dir.path().join("systemctl"), &format!("#!/bin/sh\necho \"$@\" > '{}'\n", stop_file.display()));
        let started = std::time::Instant::now();
        let route = launch_detached_with(&fake_tools(dir.path()), &script, &[], manager_env(dir.path()), &[], dir.path(), "test").unwrap();
        assert!(started.elapsed() < std::time::Duration::from_secs(10), "{:?}", started.elapsed());
        let LaunchRoute::Direct { reason } = &route else { panic!("{route:?}") };
        assert!(reason.contains("did not answer") && reason.contains("was stopped"), "{reason}");
        let stop = std::fs::read_to_string(&stop_file).unwrap();
        assert!(stop.starts_with("--user stop app-vn.io.vif.saiatlas@test"), "{stop}");
        assert_eq!(wait_for_file(&marker), "started 0\n");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn launch_detached_starts_nothing_more_when_a_timed_out_unit_cannot_be_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let (script, marker) = marker_app(dir.path());
        write_script(&dir.path().join("systemd-run"), "#!/bin/sh\nexec sleep 30\n");
        write_script(&dir.path().join("systemctl"), "#!/bin/sh\necho 'Failed to stop' >&2\nexit 1\n");
        let route = launch_detached_with(&fake_tools(dir.path()), &script, &[], manager_env(dir.path()), &[], dir.path(), "test").unwrap();
        assert!(matches!(&route, LaunchRoute::Unconfirmed { reason, .. } if reason.contains("Failed to stop")), "{route:?}");
        assert_eq!(route.name(), "systemd-run (unconfirmed)");
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(!marker.exists(), "the app was started directly while the unit may still start it");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_unloaded_unit_counts_as_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let (script, marker) = marker_app(dir.path());
        write_script(&dir.path().join("systemd-run"), "#!/bin/sh\nexec sleep 30\n");
        write_script(&dir.path().join("systemctl"), "#!/bin/sh\necho 'Unit not loaded.' >&2\nexit 5\n");
        let route = launch_detached_with(&fake_tools(dir.path()), &script, &[], manager_env(dir.path()), &[], dir.path(), "test").unwrap();
        assert!(matches!(&route, LaunchRoute::Direct { .. }), "{route:?}");
        assert_eq!(wait_for_file(&marker), "started 0\n");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn wait_for_exit_returns_when_the_process_exits() {
        let mut child = std::process::Command::new("sleep").arg("0.2").spawn().unwrap();
        let pid = libc::pid_t::try_from(child.id()).unwrap();
        let started = std::time::Instant::now();
        assert!(wait_for_exit(pid, std::time::Duration::from_secs(10), &mut || matches!(child.try_wait(), Ok(None))));
        let waited = started.elapsed();
        assert!(waited >= std::time::Duration::from_millis(150) && waited < std::time::Duration::from_secs(5), "{waited:?}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn wait_for_exit_gives_up_at_the_timeout() {
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let pid = libc::pid_t::try_from(child.id()).unwrap();
        let started = std::time::Instant::now();
        let exited = wait_for_exit(pid, std::time::Duration::from_millis(150), &mut || matches!(child.try_wait(), Ok(None)));
        let waited = started.elapsed();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!exited);
        assert!(waited >= std::time::Duration::from_millis(150) && waited < std::time::Duration::from_secs(5), "{waited:?}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_exit_wait_polls_where_there_is_no_pidfd() {
        let mut checks = 0;
        assert!(poll_until_exit(std::time::Instant::now() + std::time::Duration::from_secs(5), &mut || {
            checks += 1;
            checks < 3
        }));
        assert_eq!(checks, 3);
        let started = std::time::Instant::now();
        assert!(!poll_until_exit(started + std::time::Duration::from_millis(120), &mut || true));
        assert!(started.elapsed() >= std::time::Duration::from_millis(120));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_sweep_limit_is_bounded() {
        let limit = fd_sweep_limit();
        assert!(limit > 2 && limit <= FD_SWEEP_CAP, "{limit}");
    }
}
