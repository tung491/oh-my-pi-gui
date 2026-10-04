#![cfg(target_os = "linux")]
// Integration tests may panic on unexpected shapes; that is the assertion.
#![allow(clippy::unwrap_used, clippy::expect_used)]

//! The built binary runs as electron-updater's AppImage install child
//! (`APPIMAGE_EXIT_AFTER_INSTALL=true`, waited for by its parent), and a shell
//! plays the old Electron app: it waits for the install child, then, for a
//! restart, spawns a `--type=relauncher` helper naming the new image before
//! it exits. The "new image" is a marker script, and `XDG_RUNTIME_DIR` is
//! unset, so no service manager is contacted and no real app ever starts.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_sai-atlas");

struct Sandbox {
    dir: tempfile::TempDir,
}

impl Sandbox {
    fn new() -> Self {
        let sandbox = Self { dir: tempfile::tempdir().unwrap() };
        write_script(
            &sandbox.image(),
            &format!(
                "#!/bin/sh\necho \"started $# gdk=${{GDK_BACKEND-unset}} install=${{APPIMAGE_EXIT_AFTER_INSTALL-unset}}\" > '{}'\n",
                sandbox.marker().display()
            ),
        );
        sandbox
    }

    fn image(&self) -> PathBuf {
        self.dir.path().join("Sai-ATLAS-0.9.17-x86_64.AppImage")
    }

    fn marker(&self) -> PathBuf {
        self.dir.path().join("marker")
    }

    fn exit_file(&self) -> PathBuf {
        self.dir.path().join("install-exit")
    }

    fn runtime_log(&self) -> PathBuf {
        self.dir.path().join("config/@oh-my-pi/omp-gui/logs/gui-runtime.jsonl")
    }

    /// The old app: runs the install child to completion, records its exit
    /// status, optionally spawns the relaunch helper, then lives a little longer.
    fn run_old_app(&self, restart: bool, appimage: Option<&Path>) {
        let helper = if restart { r#"sh -c 'sleep 0.3; :' sh --type=relauncher --no-sandbox --- "$APPIMAGE_TARGET" &"# } else { "" };
        let script = format!(r#"APPIMAGE_EXIT_AFTER_INSTALL=true "$0"; echo $? > "$1"; {helper} sleep 0.2"#);
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", &script, BIN])
            .arg(self.exit_file())
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", self.dir.path())
            .env("XDG_CONFIG_HOME", self.dir.path().join("config"))
            .env("APPIMAGE_TARGET", self.image())
            .env("APPIMAGE_SILENT_INSTALL", "true")
            .env("GDK_BACKEND", "x11")
            .current_dir(self.dir.path())
            .stdin(Stdio::null());
        if let Some(appimage) = appimage {
            command.env("APPIMAGE", appimage);
        }
        assert!(command.status().expect("run the fake old app").success());
    }
}

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
fn a_restart_starts_the_new_image_once_the_old_app_exits() {
    let sandbox = Sandbox::new();
    sandbox.run_old_app(true, Some(&sandbox.image()));
    assert_eq!(std::fs::read_to_string(sandbox.exit_file()).unwrap(), "0\n");
    assert_eq!(
        wait_for_file(&sandbox.marker(), Duration::from_secs(10)).as_deref(),
        Some("started 0 gdk=unset install=unset\n"),
        "the new image starts once, with no arguments and none of the updater's settings"
    );
    let log = wait_for_file(&sandbox.runtime_log(), Duration::from_secs(5)).expect("the runtime log line");
    assert!(log.contains(r#""route":"direct""#), "{log}");
}

#[test]
fn an_install_at_quit_leaves_the_app_closed() {
    let sandbox = Sandbox::new();
    sandbox.run_old_app(false, Some(&sandbox.image()));
    assert_eq!(std::fs::read_to_string(sandbox.exit_file()).unwrap(), "0\n");
    // The waiter gives up as soon as the old app is gone; allow it a moment.
    std::thread::sleep(Duration::from_millis(500));
    assert!(!sandbox.marker().exists(), "the app reopened after a plain quit");
}

#[test]
fn the_install_succeeds_when_no_relaunch_can_be_scheduled() {
    let sandbox = Sandbox::new();
    sandbox.run_old_app(true, None);
    assert_eq!(std::fs::read_to_string(sandbox.exit_file()).unwrap(), "0\n");
    let log = wait_for_file(&sandbox.runtime_log(), Duration::from_secs(5)).expect("the runtime log line");
    assert!(log.contains("no relaunch scheduled"), "{log}");
    std::thread::sleep(Duration::from_millis(500));
    assert!(!sandbox.marker().exists());
}
