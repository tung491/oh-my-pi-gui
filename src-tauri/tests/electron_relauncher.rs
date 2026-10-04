#![cfg(target_os = "linux")]
// Integration tests may panic on unexpected shapes; that is the assertion.
#![allow(clippy::unwrap_used, clippy::expect_used)]

//! The built binary plays the 0.9.x Electron app's relaunch helper the way
//! Electron starts it: `--type=relauncher … --- <argv>`, with a pipe on fd 3.
//!
//! The app it starts is redirected to a marker script through the AppImage
//! branch (this executable lies under `APPDIR`, `APPIMAGE` names the script),
//! and `XDG_RUNTIME_DIR` is unset, so no service manager is contacted and no
//! real app ever starts. The profile and its runtime log live in a temp dir.

use std::os::fd::{AsRawFd as _, FromRawFd as _, OwnedFd};
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_sai-atlas");

struct Sandbox {
    dir: tempfile::TempDir,
}

impl Sandbox {
    fn new() -> Self {
        let sandbox = Self { dir: tempfile::tempdir().unwrap() };
        write_script(&sandbox.app(), &format!("#!/bin/sh\necho \"args=$# gdk=${{GDK_BACKEND-unset}}\" > '{}'\n", sandbox.marker().display()));
        sandbox
    }

    fn app(&self) -> PathBuf {
        self.dir.path().join("app")
    }

    fn marker(&self) -> PathBuf {
        self.dir.path().join("marker")
    }

    fn runtime_log(&self) -> PathBuf {
        self.dir.path().join("config/@oh-my-pi/omp-gui/logs/gui-runtime.jsonl")
    }

    /// `sh -c <script>` as the helper's parent, in a clean environment.
    fn parent(&self, script: &str, sync_fd: Option<&OwnedFd>) -> Child {
        let appdir = Path::new(BIN).parent().unwrap();
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", script, BIN])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", self.dir.path())
            .env("XDG_CONFIG_HOME", self.dir.path().join("config"))
            .env("APPDIR", appdir)
            .env("APPIMAGE", self.app())
            .env("GDK_BACKEND", "x11")
            .current_dir(self.dir.path())
            .stdin(Stdio::null());
        if let Some(fd) = sync_fd {
            let raw = fd.as_raw_fd();
            // SAFETY: `dup2` and `fcntl` are async-signal-safe. They put the pipe's
            // write end on fd 3, where Electron puts it, without close-on-exec
            // (`dup2` onto itself would keep the flag, hence the `fcntl`).
            unsafe {
                command.pre_exec(move || {
                    if libc::dup2(raw, 3) != 3 || libc::fcntl(3, libc::F_SETFD, 0) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        command.spawn().expect("spawn /bin/sh")
    }
}

/// An executable script written by a child process, so no descriptor of this
/// test process ever holds it open for writing (a concurrent fork inheriting
/// one would make the exec fail with ETXTBSY).
fn write_script(path: &Path, body: &str) {
    use std::io::Write as _;
    let mut child = Command::new("/bin/sh")
        .args(["-c", "cat > \"$1\" && chmod 755 \"$1\"", "sh"])
        .arg(path)
        .stdin(Stdio::piped())
        .spawn()
        .expect("spawn /bin/sh");
    child.stdin.take().expect("stdin").write_all(body.as_bytes()).expect("write the script");
    assert!(child.wait().expect("wait").success());
}

fn pipe() -> (OwnedFd, OwnedFd) {
    let mut fds = [0; 2];
    // SAFETY: `pipe2` writes two descriptors into the array it is given.
    assert_eq!(unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) }, 0, "pipe2: {}", std::io::Error::last_os_error());
    // SAFETY: both descriptors were just created and are owned here.
    unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) }
}

/// One byte from `fd`, waiting up to `timeout`; `None` on timeout or EOF.
fn read_byte(fd: &OwnedFd, timeout: Duration) -> Option<u8> {
    let mut entry = libc::pollfd { fd: fd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
    let millis = libc::c_int::try_from(timeout.as_millis()).unwrap();
    // SAFETY: `poll` reads and writes exactly the one entry it is given.
    if unsafe { libc::poll(&mut entry, 1, millis) } != 1 {
        return None;
    }
    let mut byte = [0u8; 1];
    // SAFETY: the test owns the descriptor; the buffer outlives the call.
    let count = unsafe { libc::read(fd.as_raw_fd(), byte.as_mut_ptr().cast(), 1) };
    (count == 1).then_some(byte[0])
}

fn wait_for_file(path: &Path, timeout: Duration) -> Option<String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(text) = std::fs::read_to_string(path) {
            if text.ends_with('\n') {
                return Some(text);
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    None
}

#[test]
fn answers_electron_then_starts_the_app_without_arguments_once_electron_exits() {
    let sandbox = Sandbox::new();
    let (read, write) = pipe();
    let mut parent = sandbox.parent(
        r#""$0" --type=relauncher --no-sandbox --- "/opt/Sai ATLAS/sai-atlas" omp://x --ozone-platform=x11 & sleep 1.5"#,
        Some(&write),
    );
    drop(write);

    assert_eq!(read_byte(&read, Duration::from_secs(10)), Some(0), "Electron's read gets one zero byte");
    std::thread::sleep(Duration::from_millis(300));
    assert!(!sandbox.marker().exists(), "the app started while its parent still ran");
    assert!(matches!(parent.try_wait(), Ok(None)), "the parent ended before the check");

    assert!(parent.wait().unwrap().success());
    assert_eq!(wait_for_file(&sandbox.marker(), Duration::from_secs(10)).as_deref(), Some("args=0 gdk=unset\n"), "the old command line and Electron's settings are not passed on");
    let log = wait_for_file(&sandbox.runtime_log(), Duration::from_secs(10)).expect("the runtime log line");
    assert!(log.contains(r#""route":"direct""#), "{log}");
    assert!(log.contains(r#""syncByte":"written""#), "{log}");
    assert!(log.contains("omp://x"), "the dropped command line is logged: {log}");
}

#[test]
fn starts_the_app_when_no_pipe_is_on_fd_3() {
    let sandbox = Sandbox::new();
    let mut parent = sandbox.parent(r#""$0" --type=relauncher --- x 3>&- & sleep 0.5"#, None);
    assert!(parent.wait().unwrap().success());
    assert_eq!(wait_for_file(&sandbox.marker(), Duration::from_secs(10)).as_deref(), Some("args=0 gdk=unset\n"));
    let log = wait_for_file(&sandbox.runtime_log(), Duration::from_secs(10)).expect("the runtime log line");
    assert!(log.contains(r#""syncByte":"no descriptor""#), "{log}");
}
