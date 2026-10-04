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

/// `program` with `env` minus anything under `old_appdir` (the running
/// AppImage's mount, `None` outside an AppImage), started in `cwd`, inheriting
/// only stdio. No arguments, so a launch link or workspace is not replayed.
pub(crate) fn relaunch_command(program: &Path, env: Vec<(OsString, OsString)>, old_appdir: Option<&Path>, cwd: &Path) -> Command {
    let mut command = Command::new(program);
    command.env_clear().envs(scrub_env(env, old_appdir)).env_remove(EXIT_AFTER_INSTALL).current_dir(cwd);
    #[cfg(target_os = "linux")]
    close_inherited_fds_on_exec(command.as_std_mut());
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
/// `scrub_env` for the old mount, minus `INHERITED_LAUNCH_ENV`.
#[cfg(target_os = "linux")]
pub(crate) fn launch_env(env: Vec<(OsString, OsString)>, old_appdir: Option<&Path>) -> Vec<(OsString, OsString)> {
    scrub_env(env, old_appdir).into_iter().filter(|(name, _)| !is_inherited_launch_var(name)).collect()
}

/// Whether `path` is `root` or inside it (see `is_under`).
#[cfg(target_os = "linux")]
pub(crate) fn path_is_under(path: &Path, root: &Path) -> bool {
    is_under(path.as_os_str(), root.as_os_str())
}

/// The relaunch's working directory: this process's cwd unless it is gone or
/// lies under the old mount, in which case `home`, else `/`. A .deb relaunch
/// therefore keeps the cwd it always had.
pub(crate) fn relaunch_cwd(current: Option<&Path>, old_appdir: Option<&Path>, home: Option<&Path>) -> PathBuf {
    match current {
        Some(dir) if !old_appdir.is_some_and(|appdir| is_under(dir.as_os_str(), appdir.as_os_str())) => dir.to_path_buf(),
        _ => home.map_or_else(|| PathBuf::from("/"), Path::to_path_buf),
    }
}

/// `env` with every `:`-separated component equal to or under `old_appdir`
/// removed; a variable left with no non-empty component is dropped. Without an
/// old `$APPDIR` (not an AppImage) the environment passes through unchanged.
pub(crate) fn scrub_env(env: Vec<(OsString, OsString)>, old_appdir: Option<&Path>) -> Vec<(OsString, OsString)> {
    let Some(appdir) = old_appdir.filter(|appdir| !normalize(appdir.as_os_str()).is_empty()) else { return env };
    env.into_iter().filter_map(|(key, value)| scrub_value(&value, appdir.as_os_str()).map(|value| (key, value))).collect()
}

#[cfg(unix)]
fn scrub_value(value: &std::ffi::OsStr, appdir: &std::ffi::OsStr) -> Option<OsString> {
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    let components: Vec<&[u8]> = value.as_bytes().split(|byte| *byte == b':').collect();
    let kept: Vec<&[u8]> = components.iter().copied().filter(|component| !is_under(std::ffi::OsStr::from_bytes(component), appdir)).collect();
    if kept.len() == components.len() {
        return Some(value.to_os_string());
    }
    if kept.iter().all(|component| component.is_empty()) {
        return None;
    }
    Some(OsString::from_vec(kept.join(&b':')))
}

/// `$APPDIR` only exists inside a Linux AppImage; elsewhere nothing is scrubbed.
#[cfg(not(unix))]
fn scrub_value(value: &std::ffi::OsStr, _appdir: &std::ffi::OsStr) -> Option<OsString> {
    Some(value.to_os_string())
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
            LaunchRoute::Direct { .. } => "direct",
        }
    }
}

#[cfg(target_os = "linux")]
const SYSTEMD_RUN: &str = "systemd-run";

/// How long `systemd-run` may take to report the started (or failed) exec.
#[cfg(target_os = "linux")]
const SYSTEMD_RUN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Start `program` with no arguments in `cwd`, with `launch_env(env)`, as a
/// transient service of the user's systemd manager, so the app does not
/// inherit this process's `no_new_privs`; when there is no user manager, or
/// `systemd-run` is missing or fails, as a direct child (`relaunch_command`).
/// `purpose` names the unit (`app-<app id>-<purpose>-<unique>.service`) and
/// must be a plain word.
#[cfg(target_os = "linux")]
pub(crate) fn launch_detached(program: &Path, env: Vec<(OsString, OsString)>, old_appdir: Option<&Path>, cwd: &Path, purpose: &str) -> std::io::Result<LaunchRoute> {
    let env = launch_env(env, old_appdir);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.subsec_nanos());
    let unit = unit_name(purpose, std::process::id(), nanos);
    let reason = match start_with_user_manager(&unit, program, &env, cwd) {
        Ok(()) => return Ok(LaunchRoute::UserManager { unit }),
        Err(reason) => reason,
    };
    // Never waited for: this process exits right after the launch, and the
    // reparented child is reaped by init or the session's subreaper.
    relaunch_command(program, env, old_appdir, cwd).as_std_mut().spawn()?;
    Ok(LaunchRoute::Direct { reason })
}

/// A unit name following the XDG `app-<id>-<random>.service` convention.
#[cfg(target_os = "linux")]
fn unit_name(purpose: &str, pid: u32, nanos: u32) -> String {
    format!("app-{}-{purpose}-{pid}-{nanos:08x}.service", crate::product::APP_ID)
}

/// `systemd-run`'s arguments for `program`. `Type=exec` makes `systemd-run`
/// fail when the exec itself fails; `ExitType=cgroup` keeps the unit (and so
/// an app relaunched from it later) alive while any of its processes runs,
/// where the default would stop the unit, killing the rest, when the first
/// process exits. `--setenv=NAME` without a value passes `systemd-run`'s own
/// value, so no value ever appears on a command line.
#[cfg(target_os = "linux")]
fn systemd_run_args<'a>(unit: &str, program: &Path, env_names: impl IntoIterator<Item = &'a OsStr>, cwd: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> =
        ["--user", "--quiet", "--collect", "-p", "Type=exec", "-p", "ExitType=cgroup"].into_iter().map(OsString::from).collect();
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
    args
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

/// Run `systemd-run` and wait for its answer. `Err` carries why the app was
/// not started that way. A `systemd-run` that times out is killed, but its
/// start job may still run; a second launch is then handed to the first by
/// the single-instance plugin.
#[cfg(target_os = "linux")]
fn start_with_user_manager(unit: &str, program: &Path, env: &[(OsString, OsString)], cwd: &Path) -> Result<(), String> {
    use std::io::Read as _;
    if !has_user_manager(env) {
        return Err("XDG_RUNTIME_DIR is not set, so there is no user service manager".into());
    }
    let passed: Vec<&(OsString, OsString)> = env.iter().filter(|(name, value)| passes_to_user_manager(name, value)).collect();
    let mut command = std::process::Command::new(SYSTEMD_RUN);
    command
        .args(systemd_run_args(unit, program, passed.iter().map(|(name, _)| name.as_os_str()), cwd))
        .env_clear()
        .envs(passed.iter().map(|(name, value)| (name, value)))
        .current_dir("/")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    close_inherited_fds_on_exec(&mut command);
    let mut child = command.spawn().map_err(|error| format!("{SYSTEMD_RUN} could not start: {error}"))?;
    let pid = libc::pid_t::try_from(child.id()).unwrap_or(libc::pid_t::MAX);
    if !wait_for_exit(pid, SYSTEMD_RUN_TIMEOUT, &mut || matches!(child.try_wait(), Ok(None))) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("{SYSTEMD_RUN} did not answer within {} s", SYSTEMD_RUN_TIMEOUT.as_secs()));
    }
    let status = child.wait().map_err(|error| format!("{SYSTEMD_RUN} could not be waited for: {error}"))?;
    if status.success() {
        return Ok(());
    }
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut stderr);
    }
    Err(format!("{SYSTEMD_RUN} failed ({status}): {}", stderr.trim()))
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
        scrub_env(pairs(entries), Some(Path::new(APPDIR)))
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
        assert_eq!(scrub_env(entries.clone(), None), entries);
        assert_eq!(scrub_env(entries.clone(), Some(Path::new(""))), entries);
    }

    #[test]
    fn relaunch_cwd_leaves_the_old_mount() {
        let (appdir, home) = (Some(Path::new(APPDIR)), Some(Path::new("/home/user")));
        assert_eq!(relaunch_cwd(Some(Path::new("/tmp/.mount_SaiATLabc123/usr/bin")), appdir, home), PathBuf::from("/home/user"));
        assert_eq!(relaunch_cwd(Some(Path::new(APPDIR)), appdir, None), PathBuf::from("/"));
        assert_eq!(relaunch_cwd(None, appdir, home), PathBuf::from("/home/user"));
    }

    #[test]
    fn relaunch_cwd_keeps_a_cwd_outside_the_mount() {
        let projects = Path::new("/home/user/projects");
        assert_eq!(relaunch_cwd(Some(projects), Some(Path::new(APPDIR)), Some(Path::new("/home/user"))), projects);
        assert_eq!(relaunch_cwd(Some(projects), None, Some(Path::new("/home/user"))), projects);
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
        let output = relaunch_command(Path::new("/bin/sh"), env, None, Path::new("/")).arg("-c").arg(script).output().await.expect("spawn /bin/sh");
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
            relaunch_command(Path::new("/bin/sh"), env, Some(Path::new(APPDIR)), Path::new("/")).arg("-c").arg(script).output().await.expect("spawn /bin/sh");
        assert!(output.status.success(), "{output:?}");
        assert_eq!(String::from_utf8_lossy(&output.stdout), "unset|yes|unset|/");
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
        let names: Vec<String> = launch_env(env, None).into_iter().map(|(name, _)| name.to_string_lossy().into_owned()).collect();
        assert_eq!(names, kept);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn launch_env_also_scrubs_the_old_mount() {
        let env = pairs(&[("LD_LIBRARY_PATH", "/tmp/.mount_SaiATLabc123/usr/lib:/opt/lib"), ("APPDIR", APPDIR), ("GDK_BACKEND", "x11"), ("HOME", "/home/u")]);
        assert_eq!(launch_env(env, Some(Path::new(APPDIR))), pairs(&[("LD_LIBRARY_PATH", "/opt/lib"), ("HOME", "/home/u")]));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn systemd_run_starts_a_transient_service_that_outlives_its_first_process() {
        let names = [OsStr::new("DISPLAY"), OsStr::new("PATH")];
        let args = systemd_run_args("app-vn.io.vif.saiatlas-handover-42-0000abcd.service", Path::new("/usr/bin/sai-atlas"), names, Path::new("/home/u/my projects"));
        let expected: Vec<OsString> = [
            "--user",
            "--quiet",
            "--collect",
            "-p",
            "Type=exec",
            "-p",
            "ExitType=cgroup",
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
        assert_eq!(unit_name("handover", 4242, 0xabc), "app-vn.io.vif.saiatlas-handover-4242-00000abc.service");
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

    #[cfg(target_os = "linux")]
    #[test]
    fn launch_detached_falls_back_to_a_direct_child_without_a_user_manager() {
        let dir = tempfile::tempdir().unwrap();
        let (script, marker) = (dir.path().join("app"), dir.path().join("marker"));
        write_script(&script, &format!("#!/bin/sh\necho \"$#|$KEEP|${{GDK_BACKEND-unset}}|$(pwd)\" > '{}'\n", marker.display()));
        let env = pairs(&[("PATH", "/usr/bin:/bin"), ("KEEP", "yes"), ("GDK_BACKEND", "x11")]);
        let route = launch_detached(&script, env, None, dir.path(), "test").unwrap();
        assert!(matches!(&route, LaunchRoute::Direct { reason } if reason.contains("XDG_RUNTIME_DIR")), "{route:?}");
        assert_eq!(wait_for_file(&marker), format!("0|yes|unset|{}\n", dir.path().display()));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn launch_detached_falls_back_when_systemd_run_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let (script, marker) = (dir.path().join("app"), dir.path().join("marker"));
        write_script(&script, &format!("#!/bin/sh\necho started > '{}'\n", marker.display()));
        // No systemd-run on this PATH; the runtime dir exists but is never contacted.
        let env = pairs(&[("PATH", dir.path().to_str().unwrap()), ("XDG_RUNTIME_DIR", dir.path().to_str().unwrap())]);
        let route = launch_detached(&script, env, None, dir.path(), "test").unwrap();
        assert!(matches!(&route, LaunchRoute::Direct { reason } if reason.contains("could not start")), "{route:?}");
        assert_eq!(route.name(), "direct");
        assert_eq!(wait_for_file(&marker), "started\n");
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
