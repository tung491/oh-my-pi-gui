//! Reopening the app after a 0.9.x Electron AppImage update.
//!
//! electron-updater replaces the AppImage, then runs the new file once with
//! `APPIMAGE_EXIT_AFTER_INSTALL=true` and waits for it to exit (the install
//! child). The 0.9.x app then asks Electron to relaunch the new file, but
//! Electron's relaunch helper runs with `no_new_privs`, under which the
//! image's setuid `fusermount3` cannot mount it: the new app never starts.
//! The install child (no `no_new_privs`) is the only code of the new version
//! that runs, so it schedules the relaunch itself.
//!
//! It cannot tell whether the user asked to restart: electron-updater starts
//! it the same way when it installs at quit, where the app must stay closed.
//! So it starts a waiter that watches the old app instead. Only a restart
//! makes Electron spawn its `--type=relauncher` helper for the new file before
//! it exits; the waiter starts the new file once the old app is gone, and
//! only if it saw that helper. The waiter is the host's `/bin/sh`, because
//! both AppImage mounts (the old app's and the install child's) disappear
//! within milliseconds, and polls every 10 ms, because the helper lives only
//! for Electron's shutdown.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::{paths, relaunch, runtime_log};

/// The waiter, run as `sh -c WAITER_SCRIPT sh <old app pid> <new image> <new image's file name>`.
///
/// A process counts as alive while its `/proc/<pid>/stat` shows the start
/// time first read and a state other than zombie or dead, so neither an
/// unreaped zombie nor a reused pid keeps it waiting. Children come from
/// `/proc/<pid>/task/*/children`, or from every process's parent pid where the
/// kernel lacks that file. Matching the file name rather than the full path
/// tolerates the two sides resolving the folder differently. Once the helper
/// was seen and the old app is gone, the helper gets up to 3 s to finish its
/// own (failing) attempt before the new image starts.
pub(crate) const WAITER_SCRIPT: &str = r#"pid=$1 img=$2 name=$3 helper= helper_start=
proc_state() {
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  stat=${stat##*) }
  set -- $stat
  echo "$1 ${20}"
}
alive() {
  state=$(proc_state "$1") || return 1
  set -- $state "$2"
  [ "$1" != Z ] && [ "$1" != X ] && [ "$2" = "$3" ]
}
children() {
  cat /proc/"$pid"/task/*/children 2>/dev/null || awk -v p="$pid" '$4 == p { print $1 }' /proc/[0-9]*/stat 2>/dev/null
}
find_helper() {
  for child in $(children); do
    if grep -qsF -e --type=relauncher "/proc/$child/cmdline" && grep -qsF -e "$name" "/proc/$child/cmdline"; then
      helper_start=$(proc_state "$child") || continue
      helper_start=${helper_start#* }
      helper=$child
      return 0
    fi
  done
  return 1
}
start=$(proc_state "$pid") || exit 0
start=${start#* }
while alive "$pid" "$start"; do
  [ -n "$helper" ] || find_helper
  sleep 0.01
done
[ -n "$helper" ] || exit 0
waited=0
while alive "$helper" "$helper_start" && [ "$waited" -lt 300 ]; do
  sleep 0.01
  waited=$((waited + 1))
done
exec "$img"
"#;

/// The host shell the waiter runs in; nothing from either mount.
const HOST_SHELL: &str = "/bin/sh";

/// Why no waiter was started.
#[derive(Debug, PartialEq, Eq)]
enum Skip {
    NoAppImage,
    NoParent,
    ParentUnreadable(String),
}

impl Skip {
    fn describe(&self) -> String {
        match self {
            Skip::NoAppImage => "APPIMAGE does not name the new image".into(),
            Skip::NoParent => "the updater that started this install already exited".into(),
            Skip::ParentUnreadable(error) => format!("the updater's executable cannot be read: {error}"),
        }
    }
}

/// What the waiter needs, read from this process and its parent.
#[derive(Debug, PartialEq, Eq)]
struct Waiter {
    parent: i32,
    image: PathBuf,
    /// The mounts that go away: this process's own and the old app's.
    appdirs: Vec<PathBuf>,
}

impl Waiter {
    fn args(&self) -> Vec<OsString> {
        let name = self.image.file_name().unwrap_or(self.image.as_os_str());
        vec![
            OsString::from("-c"),
            OsString::from(WAITER_SCRIPT),
            OsString::from("sh"),
            OsString::from(self.parent.to_string()),
            self.image.as_os_str().to_os_string(),
            name.to_os_string(),
        ]
    }
}

/// The waiter's inputs: the new image from `APPIMAGE`, the old app as the
/// parent (`parent_exe` is its `/proc/<pid>/exe`), and the mounts to scrub.
/// The old app's environment is not read: Chromium overwrites it.
fn plan(appimage: Option<&OsStr>, own_appdir: Option<&OsStr>, parent: i32, parent_exe: std::io::Result<PathBuf>) -> Result<Waiter, Skip> {
    let image = appimage.filter(|value| !value.is_empty()).map(PathBuf::from).ok_or(Skip::NoAppImage)?;
    if parent <= 1 {
        return Err(Skip::NoParent);
    }
    let parent_exe = parent_exe.map_err(|error| Skip::ParentUnreadable(error.to_string()))?;
    let appdirs = own_appdir.filter(|value| !value.is_empty()).map(PathBuf::from).into_iter().chain(mount_root(&parent_exe)).collect();
    Ok(Waiter { parent, image, appdirs })
}

/// The AppImage mount `exe` runs from: its nearest ancestor named `.mount_*`
/// (the type-2 runtime mounts at `$TMPDIR/.mount_<name><random>`).
fn mount_root(exe: &Path) -> Option<PathBuf> {
    exe.ancestors().find(|dir| dir.file_name().and_then(OsStr::to_str).is_some_and(|name| name.starts_with(".mount_"))).map(Path::to_path_buf)
}

/// Schedule the relaunch from the install child. Never fails: the install
/// must succeed whether or not the waiter starts, so the caller exits 0 either
/// way. One runtime-log line records the outcome.
pub fn schedule_relaunch() {
    let parent = nix::unistd::getppid().as_raw();
    let parent_exe = std::fs::read_link(format!("/proc/{parent}/exe"));
    let waiter = match plan(std::env::var_os("APPIMAGE").as_deref(), std::env::var_os("APPDIR").as_deref(), parent, parent_exe) {
        Ok(waiter) => waiter,
        Err(skip) => return report(&format!("AppImage update: no relaunch scheduled; {}", skip.describe()), json!({ "parentPid": parent })),
    };
    let appdirs: Vec<&Path> = waiter.appdirs.iter().map(PathBuf::as_path).collect();
    let cwd = relaunch::relaunch_cwd(std::env::current_dir().ok().as_deref(), &appdirs, dirs::home_dir().as_deref());
    let mut details = json!({
        "parentPid": waiter.parent,
        "image": waiter.image.display().to_string(),
        "mounts": appdirs.iter().map(|appdir| appdir.display().to_string()).collect::<Vec<_>>().join(":"),
    });
    let message = match relaunch::launch_detached(Path::new(HOST_SHELL), &waiter.args(), std::env::vars_os().collect(), &appdirs, &cwd, "handover") {
        Ok(route) => {
            details["route"] = json!(route.name());
            if let Some(reason) = route.reason() {
                details["fallbackReason"] = json!(reason);
            }
            "AppImage update: waiting for the old app to exit before starting the new one, if it asked to restart".to_string()
        }
        Err(error) => format!("AppImage update: the relaunch waiter could not start: {error}"),
    };
    report(&message, details);
}

/// The log needs a profile directory; without one only stderr gets the line.
fn report(message: &str, details: serde_json::Value) {
    eprintln!("{}: {message}", crate::product::PRODUCT_NAME);
    if paths::resolve_user_data_dir().is_ok() {
        runtime_log::note("unknown", message, details);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    #[test]
    fn finds_the_mount_the_old_app_runs_from() {
        assert_eq!(mount_root(Path::new("/tmp/.mount_Sai-ATalkeHI/sai-atlas")), Some(PathBuf::from("/tmp/.mount_Sai-ATalkeHI")));
        assert_eq!(mount_root(Path::new("/run/user/1000/.mount_SaiATLx/usr/bin/sai-atlas")), Some(PathBuf::from("/run/user/1000/.mount_SaiATLx")));
        assert_eq!(mount_root(Path::new("/usr/bin/sai-atlas")), None);
        assert_eq!(mount_root(Path::new("/home/u/mount_x/sai-atlas")), None);
    }

    #[test]
    fn plans_a_waiter_that_scrubs_both_mounts() {
        let waiter = plan(
            Some(OsStr::new("/home/u/Apps/Sai-ATLAS-0.9.17-x86_64.AppImage")),
            Some(OsStr::new("/tmp/.mount_Sai-ATGlNNdi")),
            4242,
            Ok(PathBuf::from("/tmp/.mount_Sai-ATalkeHI/sai-atlas")),
        )
        .unwrap();
        assert_eq!(waiter.appdirs, [PathBuf::from("/tmp/.mount_Sai-ATGlNNdi"), PathBuf::from("/tmp/.mount_Sai-ATalkeHI")]);
        let args = waiter.args();
        assert_eq!(args[0], "-c");
        assert_eq!(args[1], WAITER_SCRIPT);
        assert_eq!(args[2..], [OsString::from("sh"), "4242".into(), "/home/u/Apps/Sai-ATLAS-0.9.17-x86_64.AppImage".into(), "Sai-ATLAS-0.9.17-x86_64.AppImage".into()]);
    }

    #[test]
    fn plans_nothing_without_an_image_or_a_readable_parent() {
        let exe = || Ok(PathBuf::from("/tmp/.mount_x/sai-atlas"));
        assert_eq!(plan(None, None, 4242, exe()), Err(Skip::NoAppImage));
        assert_eq!(plan(Some(OsStr::new("")), None, 4242, exe()), Err(Skip::NoAppImage));
        assert_eq!(plan(Some(OsStr::new("/a/b.AppImage")), None, 1, exe()), Err(Skip::NoParent));
        let unreadable = plan(Some(OsStr::new("/a/b.AppImage")), None, 4242, Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied)));
        assert!(matches!(unreadable, Err(Skip::ParentUnreadable(_))), "{unreadable:?}");
        // A parent outside any mount still gets a waiter; only this process's mount is scrubbed.
        let plain = plan(Some(OsStr::new("/a/b.AppImage")), None, 4242, Ok(PathBuf::from("/usr/bin/sai-atlas"))).unwrap();
        assert!(plain.appdirs.is_empty());
    }

    /// An executable written by a child process, so no descriptor of this test
    /// process holds it open for writing when a concurrent fork happens (ETXTBSY).
    fn write_script(path: &Path, body: &str) {
        use std::io::Write as _;
        let mut child =
            Command::new("/bin/sh").args(["-c", "cat > \"$1\" && chmod 755 \"$1\"", "sh"]).arg(path).stdin(Stdio::piped()).spawn().expect("spawn /bin/sh");
        child.stdin.take().expect("stdin").write_all(body.as_bytes()).expect("write the script");
        assert!(child.wait().expect("wait").success());
    }

    /// The old app: a shell that lives `seconds`, optionally with a relaunch
    /// helper child that names `helper_target` and lives `helper_seconds`.
    fn fake_old_app(seconds: &str, helper: Option<(&str, &str)>) -> Child {
        let script = match helper {
            // `; :` keeps the shell from exec'ing `sleep`, so the helper's command line stays.
            Some(_) => format!("sh -c 'sleep \"$1\"; :' sh \"$1\" --type=relauncher --no-sandbox --- \"$2\" & sleep {seconds}"),
            None => format!("sleep {seconds}"),
        };
        let (helper_seconds, target) = helper.unwrap_or(("0", ""));
        Command::new("/bin/sh").args(["-c", &script, "sh", helper_seconds, target]).spawn().expect("spawn the fake app")
    }

    fn start_waiter(old_app: &Child, image: &Path) -> Child {
        let name = image.file_name().unwrap();
        Command::new("/bin/sh").args(["-c", WAITER_SCRIPT, "sh"]).arg(old_app.id().to_string()).arg(image).arg(name).spawn().expect("spawn the waiter")
    }

    fn wait_with_timeout(child: &mut Child, timeout: Duration) -> std::process::ExitStatus {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                return status;
            }
            assert!(Instant::now() < deadline, "the waiter did not finish in time");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn the_waiter_starts_the_new_image_after_the_old_app_and_its_helper_are_gone() {
        let dir = tempfile::tempdir().unwrap();
        let (image, marker) = (dir.path().join("Sai-ATLAS-0.9.17-x86_64.AppImage"), dir.path().join("marker"));
        write_script(&image, &format!("#!/bin/sh\necho \"started $#\" > '{}'\n", marker.display()));
        let mut old_app = fake_old_app("0.4", Some(("0.8", "/elsewhere/Sai-ATLAS-0.9.17-x86_64.AppImage")));
        let started = Instant::now();
        let mut waiter = start_waiter(&old_app, &image);
        std::thread::sleep(Duration::from_millis(250));
        assert!(!marker.exists(), "started while the old app still ran");
        old_app.wait().unwrap();
        assert!(wait_with_timeout(&mut waiter, Duration::from_secs(10)).success());
        assert!(started.elapsed() >= Duration::from_millis(750), "did not wait for the helper: {:?}", started.elapsed());
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "started 0\n");
    }

    #[test]
    fn the_waiter_starts_nothing_when_the_old_app_quits_without_a_relaunch_helper() {
        let dir = tempfile::tempdir().unwrap();
        let (image, marker) = (dir.path().join("Sai-ATLAS-0.9.17-x86_64.AppImage"), dir.path().join("marker"));
        write_script(&image, &format!("#!/bin/sh\necho started > '{}'\n", marker.display()));
        let mut old_app = fake_old_app("0.3", None);
        let mut waiter = start_waiter(&old_app, &image);
        old_app.wait().unwrap();
        assert!(wait_with_timeout(&mut waiter, Duration::from_secs(10)).success());
        std::thread::sleep(Duration::from_millis(100));
        assert!(!marker.exists(), "the app reopened after a plain quit");
    }

    #[test]
    fn the_waiter_ignores_a_helper_for_another_image() {
        let dir = tempfile::tempdir().unwrap();
        let (image, marker) = (dir.path().join("Sai-ATLAS-0.9.17-x86_64.AppImage"), dir.path().join("marker"));
        write_script(&image, &format!("#!/bin/sh\necho started > '{}'\n", marker.display()));
        let mut old_app = fake_old_app("0.3", Some(("0.1", "/x/Other.AppImage")));
        let mut waiter = start_waiter(&old_app, &image);
        old_app.wait().unwrap();
        assert!(wait_with_timeout(&mut waiter, Duration::from_secs(10)).success());
        assert!(!marker.exists());
    }

    #[test]
    fn the_waiter_does_not_wait_on_an_unreaped_old_app() {
        // The test never reaps the fake app until the end, so it stays a zombie
        // after it exits; the waiter must treat that as gone.
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("Name.AppImage");
        write_script(&image, "#!/bin/sh\n");
        let mut old_app = fake_old_app("0.2", None);
        let mut waiter = start_waiter(&old_app, &image);
        assert!(wait_with_timeout(&mut waiter, Duration::from_secs(5)).success());
        old_app.wait().unwrap();
    }

    #[test]
    fn the_waiter_exits_at_once_for_a_parent_that_is_already_gone() {
        let mut gone = Command::new("/bin/true").spawn().unwrap();
        gone.wait().unwrap();
        let mut waiter = Command::new("/bin/sh").args(["-c", WAITER_SCRIPT, "sh"]).arg(gone.id().to_string()).args(["/x/Name.AppImage", "Name.AppImage"]).spawn().unwrap();
        assert!(wait_with_timeout(&mut waiter, Duration::from_secs(2)).success());
    }
}
