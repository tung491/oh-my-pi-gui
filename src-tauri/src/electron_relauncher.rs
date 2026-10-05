//! The relaunch helper contract of the 0.9.x Electron app, which this binary
//! inherits after a .deb update.
//!
//! Electron's updater installs the new package, then relaunches the app through
//! a helper: it starts `<helper> --type=relauncher <switches> --- <argv>` with
//! the write end of a pipe on fd 3 and blocks reading one byte from it before
//! it quits. The helper is Electron's own executable path,
//! `/opt/Sai ATLAS/sai-atlas`, which the Tauri .deb turns into a link to this
//! binary. So this binary must play the helper: write the byte, wait for
//! Electron to exit, then start the app. Electron quits whatever the helper
//! does, so the worst failure is an app that is not reopened, never two
//! running at once, as long as the start waits for Electron to be gone.
//!
//! Chromium starts the helper with `no_new_privs`, which `pkexec` cannot work
//! under, so the app is started through the user's service manager when one
//! exists (`relaunch::launch_detached`). Nothing here initializes GTK or Tauri
//! or touches the profile beyond appending to the runtime log.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};

use serde_json::json;

use crate::{paths, relaunch, runtime_log};

/// The first argument Electron starts its relaunch helper with.
const RELAUNCHER_ARGV: &str = "--type=relauncher";

/// Separates Electron's helper switches from the command line it asked to relaunch.
const ARGV_SEPARATOR: &str = "---";

/// The descriptor Electron puts its pipe's write end on (`STDERR_FILENO + 1`).
const SYNC_FD: libc::c_int = 3;

/// How long Electron may take to quit after the byte. Past it, the app is not
/// started: Electron still holds the profile, and the next manual start runs
/// the new version anyway.
const PARENT_EXIT_TIMEOUT: Duration = Duration::from_secs(60);

/// Whether this process was started as Electron's relaunch helper.
pub fn is_relauncher_invocation(args: &[OsString]) -> bool {
    args.get(1).is_some_and(|arg| arg == RELAUNCHER_ARGV)
}

/// Play Electron's relaunch helper, then exit. Starts the app with no
/// arguments: a launch link, a workspace or a Chromium switch in the old
/// command line is not replayed.
pub fn run(args: Vec<OsString>) -> ExitCode {
    // Read before the byte goes out: until Electron reads it, Electron is
    // blocked and alive, so the parent pid cannot belong to anything else.
    let parent = nix::unistd::getppid().as_raw();
    let sync = signal_ready(SYNC_FD);
    let (switches, dropped) = split_argv(&args);
    let details = json!({
        "parentPid": parent,
        "syncByte": sync.name(),
        "switches": lossy(switches),
        // Only the count: the old command line may carry an omp:// link with a token in it.
        "droppedArgCount": dropped.len(),
    });
    let outcome = run_protocol(parent, PARENT_EXIT_TIMEOUT, &mut || nix::unistd::getppid().as_raw() == parent, launch_app);
    report(&outcome, details);
    match outcome {
        Outcome::Launched { route: Err(_), .. } => ExitCode::FAILURE,
        _ => ExitCode::SUCCESS,
    }
}

/// What the helper did once the byte was handled.
#[derive(Debug)]
enum Outcome<T> {
    /// The parent was still running at the deadline; nothing was started.
    ParentStayed,
    /// The parent exited after `waited`; `route` is the launch's result.
    Launched { waited: Duration, route: Result<T, String> },
}

/// Wait for `parent` to exit (`alive` reports whether it still runs), then
/// call `launch` once; past `timeout`, never call it.
fn run_protocol<T>(parent: libc::pid_t, timeout: Duration, alive: &mut dyn FnMut() -> bool, launch: impl FnOnce() -> Result<T, String>) -> Outcome<T> {
    let started = Instant::now();
    if !relaunch::wait_for_exit(parent, timeout, alive) {
        return Outcome::ParentStayed;
    }
    Outcome::Launched { waited: started.elapsed(), route: launch() }
}

/// Start the app through the shared launch primitive.
fn launch_app() -> Result<relaunch::LaunchRoute, String> {
    let appimage = std::env::var_os("APPIMAGE");
    let old_appdir = std::env::var_os("APPDIR").filter(|value| !value.is_empty()).map(PathBuf::from);
    let current_exe = std::env::current_exe().ok();
    let target = launch_target(current_exe.as_deref(), appimage.as_deref(), old_appdir.as_deref())?;
    let appdirs: Vec<&Path> = old_appdir.as_deref().into_iter().collect();
    let cwd = relaunch::relaunch_cwd(std::env::current_dir().ok().as_deref(), &appdirs, dirs::home_dir().as_deref());
    relaunch::launch_detached(&target, &[], std::env::vars_os().collect(), &appdirs, &cwd, "handover")
        .map_err(|error| format!("{} could not be started: {error}", target.display()))
}

/// The program to start. Inside an AppImage (this executable under
/// `$APPDIR`), that is the image file `$APPIMAGE`: the mount this process runs
/// from goes away when it exits, and the image mounts itself afresh. Anywhere
/// else, this executable (`/usr/bin/sai-atlas` for the .deb).
fn launch_target(current_exe: Option<&Path>, appimage: Option<&OsStr>, appdir: Option<&Path>) -> Result<PathBuf, String> {
    let current_exe = current_exe.ok_or_else(|| "this executable's path is unknown".to_string())?;
    match appdir {
        Some(appdir) if relaunch::path_is_under(current_exe, appdir) => match appimage.map(Path::new) {
            Some(image) if image.is_absolute() => Ok(image.to_path_buf()),
            _ => Err("running from an AppImage mount, but APPIMAGE does not name the image".to_string()),
        },
        _ => Ok(current_exe.to_path_buf()),
    }
}

/// Electron's helper switches (before `---`) and the command line it asked to
/// relaunch (after it). Without a separator, everything is a switch.
fn split_argv(args: &[OsString]) -> (&[OsString], &[OsString]) {
    let rest = args.get(2..).unwrap_or_default();
    match rest.iter().position(|arg| arg == ARGV_SEPARATOR) {
        Some(separator) => (&rest[..separator], &rest[separator + 1..]),
        None => (rest, &[]),
    }
}

/// `args` as one JSON-array string: the runtime log keeps only scalar details.
fn lossy(args: &[OsString]) -> String {
    let args: Vec<String> = args.iter().map(|arg| arg.to_string_lossy().into_owned()).collect();
    serde_json::Value::from(args).to_string()
}

/// What happened to the byte Electron waits for.
#[derive(Debug, PartialEq, Eq)]
enum SyncByte {
    /// Written, and the descriptor closed.
    Written,
    /// Nothing open on the descriptor: no Electron is waiting.
    NoDescriptor,
    /// The descriptor is not a pipe, so it is not Electron's; left alone.
    NotAPipe,
    /// A pipe, but the write failed (`EPIPE`: nobody reads; `EAGAIN`: full); closed anyway.
    WriteFailed(i32),
}

impl SyncByte {
    fn name(&self) -> String {
        match self {
            SyncByte::Written => "written".into(),
            SyncByte::NoDescriptor => "no descriptor".into(),
            SyncByte::NotAPipe => "not a pipe".into(),
            SyncByte::WriteFailed(errno) => format!("write failed: {}", std::io::Error::from_raw_os_error(*errno)),
        }
    }
}

/// Write Electron's one `\0` byte to `fd` and close it, when `fd` is a pipe.
/// Never blocks, and never fails the helper: SIGPIPE is ignored in Rust
/// programs, so a pipe nobody reads only yields `EPIPE`.
fn signal_ready(fd: libc::c_int) -> SyncByte {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
    // SAFETY: `fstat` fills the struct it is given, or fails with EBADF for a closed number.
    if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
        return SyncByte::NoDescriptor;
    }
    // SAFETY: `fstat` succeeded, so the struct is initialized (and was zeroed before).
    let mode = unsafe { stat.assume_init() }.st_mode;
    if mode & libc::S_IFMT != libc::S_IFIFO {
        return SyncByte::NotAPipe;
    }
    // SAFETY: plain descriptor calls on a pipe this process holds; the write
    // reads one byte from a live local, and the close gives up this process's copy.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags >= 0 {
            libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
        let byte = [0u8; 1];
        let written = libc::write(fd, byte.as_ptr().cast(), 1);
        let result = if written == 1 { SyncByte::Written } else { SyncByte::WriteFailed(std::io::Error::last_os_error().raw_os_error().unwrap_or(0)) };
        libc::close(fd);
        result
    }
}

/// One runtime-log line (and one stderr line) for the whole run. The log needs
/// a profile directory; without one only stderr gets it.
fn report(outcome: &Outcome<relaunch::LaunchRoute>, mut details: serde_json::Value) {
    let message = match outcome {
        Outcome::ParentStayed => {
            format!("Electron relaunch helper: the old app was still running after {} s; not starting the new one", PARENT_EXIT_TIMEOUT.as_secs())
        }
        Outcome::Launched { waited, route } => {
            details["waitedMs"] = json!(waited.as_millis());
            match route {
                Ok(route) => {
                    details["route"] = json!(route.name());
                    match route {
                        relaunch::LaunchRoute::UserManager { unit } => {
                            details["unit"] = json!(unit);
                            "Electron relaunch helper: started the app through the user's service manager".to_string()
                        }
                        relaunch::LaunchRoute::Unconfirmed { unit, reason } => {
                            details["unit"] = json!(unit);
                            details["fallbackReason"] = json!(reason);
                            "Electron relaunch helper: the user's service manager did not answer; the app may still start through it".to_string()
                        }
                        relaunch::LaunchRoute::Direct { reason } => {
                            let no_new_privs = relaunch::no_new_privs();
                            details["fallbackReason"] = json!(reason);
                            details["noNewPrivs"] = json!(no_new_privs);
                            if no_new_privs {
                                "Electron relaunch helper: started the app directly; it keeps no_new_privs until reopened".to_string()
                            } else {
                                "Electron relaunch helper: started the app directly".to_string()
                            }
                        }
                    }
                }
                Err(error) => format!("Electron relaunch helper: the app could not be started: {error}"),
            }
        }
    };
    eprintln!("{}: {message}", crate::product::PRODUCT_NAME);
    if paths::resolve_user_data_dir().is_ok() {
        runtime_log::note("unknown", message, details);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::{AsRawFd as _, FromRawFd as _, OwnedFd};

    fn os(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    /// Close-on-exec, so no child that another test spawns meanwhile keeps
    /// either end open (a held read end turns `EPIPE` into a successful write,
    /// a held write end delays the reader's end-of-file).
    fn pipe() -> (OwnedFd, OwnedFd) {
        let mut fds = [0; 2];
        // SAFETY: `pipe2` writes two descriptors into the array it is given.
        assert_eq!(unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) }, 0, "pipe2: {}", std::io::Error::last_os_error());
        // SAFETY: both descriptors were just created and are owned here.
        unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) }
    }

    /// Read whatever is in the pipe without blocking.
    fn drain(read: &OwnedFd) -> Vec<u8> {
        let mut buffer = [0u8; 16];
        // SAFETY: the test owns the descriptor; the buffer outlives the call.
        unsafe { libc::fcntl(read.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) };
        // SAFETY: as above.
        let count = unsafe { libc::read(read.as_raw_fd(), buffer.as_mut_ptr().cast(), buffer.len()) };
        buffer[..usize::try_from(count).unwrap_or(0)].to_vec()
    }

    /// Whether every write end of the pipe is closed, waiting up to 5 s. This
    /// asks the pipe rather than probing the closed number, which a test
    /// running in parallel may already have reused.
    fn write_end_closed(read: &OwnedFd) -> bool {
        let mut entry = libc::pollfd { fd: read.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            // SAFETY: `poll` reads and writes exactly the one entry it is given.
            if unsafe { libc::poll(&mut entry, 1, 100) } == 1 && entry.revents & libc::POLLHUP != 0 {
                return true;
            }
            drain(read);
        }
        false
    }

    fn sleeper(seconds: &str) -> std::process::Child {
        std::process::Command::new("sleep").arg(seconds).spawn().expect("spawn sleep")
    }

    fn pid_of(child: &std::process::Child) -> libc::pid_t {
        libc::pid_t::try_from(child.id()).unwrap()
    }

    #[test]
    fn recognizes_only_the_relauncher_switch_in_first_position() {
        assert!(is_relauncher_invocation(&os(&["/opt/Sai ATLAS/sai-atlas", "--type=relauncher", "--no-sandbox", "---", "/opt/Sai ATLAS/sai-atlas"])));
        assert!(is_relauncher_invocation(&os(&["sai-atlas", "--type=relauncher"])));
        assert!(!is_relauncher_invocation(&os(&["sai-atlas"])));
        assert!(!is_relauncher_invocation(&os(&["sai-atlas", "--no-sandbox", "--type=relauncher"])));
        assert!(!is_relauncher_invocation(&os(&["sai-atlas", "--type=renderer"])));
        assert!(!is_relauncher_invocation(&os(&["sai-atlas", "omp://--type=relauncher"])));
    }

    #[test]
    fn splits_the_helper_switches_from_the_dropped_command_line() {
        let args = os(&["/opt/Sai ATLAS/sai-atlas", "--type=relauncher", "--no-sandbox", "---", "/opt/Sai ATLAS/sai-atlas", "omp://x", "--ozone-platform=x11", "---"]);
        let (switches, dropped) = split_argv(&args);
        assert_eq!(switches, os(&["--no-sandbox"]).as_slice());
        assert_eq!(dropped, os(&["/opt/Sai ATLAS/sai-atlas", "omp://x", "--ozone-platform=x11", "---"]).as_slice());
    }

    #[test]
    fn treats_everything_as_switches_without_a_separator() {
        let args = os(&["sai-atlas", "--type=relauncher", "--no-sandbox", "--extra"]);
        assert_eq!(split_argv(&args), (os(&["--no-sandbox", "--extra"]).as_slice(), &[][..]));
        let bare = os(&["sai-atlas", "--type=relauncher"]);
        assert_eq!(split_argv(&bare), (&[][..], &[][..]));
        let empty_tail = os(&["sai-atlas", "--type=relauncher", "---"]);
        assert_eq!(split_argv(&empty_tail), (&[][..], &[][..]));
    }

    #[test]
    fn launches_this_executable_outside_an_appimage() {
        let exe = Path::new("/usr/bin/sai-atlas");
        assert_eq!(launch_target(Some(exe), None, None), Ok(exe.to_path_buf()));
        // An APPDIR this executable is not under (left over from Electron's environment) changes nothing.
        assert_eq!(
            launch_target(Some(exe), Some(OsStr::new("/home/u/Sai.AppImage")), Some(Path::new("/tmp/.mount_SaiATLold"))),
            Ok(exe.to_path_buf())
        );
        assert!(launch_target(None, None, None).is_err());
    }

    #[test]
    fn launches_the_image_file_from_inside_an_appimage_mount() {
        let exe = Path::new("/tmp/.mount_SaiATLnew/sai-atlas");
        let appdir = Some(Path::new("/tmp/.mount_SaiATLnew"));
        assert_eq!(launch_target(Some(exe), Some(OsStr::new("/home/u/Apps/Sai ATLAS.AppImage")), appdir), Ok(PathBuf::from("/home/u/Apps/Sai ATLAS.AppImage")));
        assert!(launch_target(Some(exe), None, appdir).is_err());
        assert!(launch_target(Some(exe), Some(OsStr::new("Sai.AppImage")), appdir).is_err());
    }

    #[test]
    fn writes_one_zero_byte_to_the_pipe_and_closes_it() {
        let (read, write) = pipe();
        let raw = write.as_raw_fd();
        // `signal_ready` closes the descriptor itself, as it does with Electron's fd 3.
        std::mem::forget(write);
        assert_eq!(signal_ready(raw), SyncByte::Written);
        assert_eq!(drain(&read), vec![0u8]);
        assert!(write_end_closed(&read), "the write end stays open");
    }

    #[test]
    fn skips_the_byte_when_nothing_or_something_else_is_open() {
        let file = tempfile::tempfile().unwrap();
        assert_eq!(signal_ready(file.as_raw_fd()), SyncByte::NotAPipe);
        // SAFETY: F_GETFD only reads flags; the file must still be open.
        assert!(unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) } >= 0, "a descriptor that is not Electron's pipe is left alone");
        // A number no process can have open (it lies above the kernel's
        // descriptor ceiling), unlike a just-closed one, which another test
        // may reuse at once. The helper with nothing on fd 3 runs in the
        // integration tests.
        assert_eq!(signal_ready(libc::c_int::MAX), SyncByte::NoDescriptor);
    }

    #[test]
    fn closes_a_pipe_it_cannot_write_to() {
        // A full pipe fails the write the same way whoever else holds its read
        // end. The helper on a pipe nobody reads (EPIPE) runs in the integration tests.
        let (read, write) = pipe();
        // SAFETY: plain flag and write calls on descriptors this test owns.
        unsafe {
            libc::fcntl(write.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK);
            let chunk = [0u8; 4096];
            while libc::write(write.as_raw_fd(), chunk.as_ptr().cast(), chunk.len()) > 0 {}
        }
        let raw = write.as_raw_fd();
        // `signal_ready` closes the descriptor itself.
        std::mem::forget(write);
        assert_eq!(signal_ready(raw), SyncByte::WriteFailed(libc::EAGAIN));
        assert!(write_end_closed(&read), "the write end stays open");
    }

    #[test]
    fn launches_only_after_the_parent_exits() {
        let parent = std::cell::RefCell::new(sleeper("0.3"));
        let pid = pid_of(&parent.borrow());
        let (read, write) = pipe();
        let raw = write.as_raw_fd();
        std::mem::forget(write);
        assert_eq!(signal_ready(raw), SyncByte::Written);
        assert_eq!(drain(&read), vec![0u8], "the byte arrives before the wait starts");
        let started = Instant::now();
        let mut parent_exited_first = false;
        let outcome = run_protocol(pid, Duration::from_secs(10), &mut || matches!(parent.borrow_mut().try_wait(), Ok(None)), || {
            parent_exited_first = matches!(parent.borrow_mut().try_wait(), Ok(Some(_)));
            Ok::<_, String>(started.elapsed())
        });
        match outcome {
            Outcome::Launched { waited, route: Ok(at) } => {
                assert!(waited >= Duration::from_millis(250), "{waited:?}");
                assert!(at >= waited, "{at:?} < {waited:?}");
            }
            other => panic!("{other:?}"),
        }
        assert!(parent_exited_first);
    }

    #[test]
    fn never_launches_when_the_parent_outlives_the_timeout() {
        let mut parent = sleeper("30");
        let pid = pid_of(&parent);
        let mut launched = false;
        let started = Instant::now();
        let outcome = run_protocol(pid, Duration::from_millis(200), &mut || matches!(parent.try_wait(), Ok(None)), || {
            launched = true;
            Ok::<_, String>(())
        });
        let elapsed = started.elapsed();
        parent.kill().unwrap();
        parent.wait().unwrap();
        assert!(matches!(outcome, Outcome::ParentStayed), "{outcome:?}");
        assert!(!launched);
        assert!(elapsed >= Duration::from_millis(200) && elapsed < Duration::from_secs(5), "{elapsed:?}");
    }

    #[test]
    fn launches_at_once_when_the_parent_is_already_gone() {
        let mut parent = sleeper("0");
        let pid = pid_of(&parent);
        parent.wait().unwrap();
        let outcome = run_protocol(pid, Duration::from_secs(10), &mut || false, || Ok::<_, String>(()));
        assert!(matches!(outcome, Outcome::Launched { route: Ok(()), waited } if waited < Duration::from_secs(1)), "{outcome:?}");
        // Reparented to init: the parent is gone.
        assert!(matches!(run_protocol(1, Duration::from_secs(10), &mut || true, || Ok::<_, String>(())), Outcome::Launched { .. }));
    }
}
