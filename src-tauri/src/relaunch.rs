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
    close_inherited_fds_on_exec(&mut command);
    command
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
fn close_inherited_fds_on_exec(command: &mut Command) {
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

    #[cfg(target_os = "linux")]
    #[test]
    fn the_sweep_limit_is_bounded() {
        let limit = fd_sweep_limit();
        assert!(limit > 2 && limit <= FD_SWEEP_CAP, "{limit}");
    }
}
