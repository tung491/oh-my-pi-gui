//! The updater's pure state machine and file helpers: the renderer-visible
//! `UpdateStatus`, resumable installer transfers and the Linux package-kind
//! rules that decide how an update installs.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha512};
use tokio::io::AsyncReadExt;

/// How a downloaded update installs: the app replaces itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum UpdateInstallMode {
    Automatic,
}

/// `UpdateStatus` from `src/shared/ipc-types.ts`, serialized with the same
/// `state` tag and camelCase fields the renderer reads.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub(crate) enum UpdateStatus {
    Idle,
    Checking,
    Available {
        version: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        notes: Option<String>,
        mode: UpdateInstallMode,
    },
    Downloading {
        version: String,
        mode: UpdateInstallMode,
        percent: u64,
        bytes_per_second: u64,
        transferred: u64,
        total: u64,
    },
    Downloaded {
        version: String,
        mode: UpdateInstallMode,
        /// The install could not ask for privileges in this process
        /// (`no_new_privs`); the renderer asks the user to quit and reopen the
        /// app, then install the same download.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        reopen_required: bool,
    },
    NotAvailable {
        version: String,
    },
    Error {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        show_in_banner: Option<bool>,
        /// A terminal command that installs the downloaded package by hand: set
        /// when apt could not resolve the package's dependencies, so the
        /// renderer can say what to run instead of only apt's output.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        manual_install_command: Option<String>,
    },
}

/// One entry of a feed's `files` list.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReleaseFile {
    pub url: String,
    pub sha512: String,
    #[serde(default)]
    pub size: Option<u64>,
}

/// The last path segment of `url`, percent-decoded; the raw string when it
/// does not parse (matching `new URL(url, base)` plus `decodeURIComponent`).
pub(crate) fn release_file_name(url: &str) -> String {
    let Ok(base) = reqwest::Url::parse("https://updates.invalid") else {
        return url.to_string();
    };
    let Ok(parsed) = base.join(url) else {
        return url.to_string();
    };
    let pathname = parsed.path();
    let segment = &pathname[pathname.rfind('/').map_or(0, |index| index + 1)..];
    percent_decode(segment).unwrap_or_else(|| url.to_string())
}

/// `decodeURIComponent`: `None` on a malformed escape or invalid UTF-8.
fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = input.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A check that finished without reaching a terminal state must not leave the
/// public state machine stuck in `checking`: a manual check reports
/// `no_result_message`, a background check goes quietly back to idle.
pub(crate) fn settle_incomplete_update_check(status: &UpdateStatus, manual: bool, no_result_message: &str) -> UpdateStatus {
    match status {
        UpdateStatus::Checking if manual => UpdateStatus::Error { message: no_result_message.to_string(), show_in_banner: None, manual_install_command: None },
        UpdateStatus::Checking => UpdateStatus::Idle,
        other => other.clone(),
    }
}

/* ------------------------------------------------ installer transfer files */

const PARTIAL_SUFFIX: &str = ".partial";
const HASH_CHUNK_BYTES: usize = 1024 * 1024;

/// Deterministic name for the in-flight installer, so an interrupted download
/// can be continued after a crash or quit.
pub(crate) fn installer_partial_path(destination_path: &Path) -> PathBuf {
    let mut name = destination_path.as_os_str().to_os_string();
    name.push(PARTIAL_SUFFIX);
    PathBuf::from(name)
}

/// What to do with the bytes already on disk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct InstallerTransferPlan {
    /// Bytes already on disk to keep. 0 restarts the transfer.
    pub offset: u64,
    /// True when the response continues the partial, so bytes append to it.
    pub append: bool,
}

/// A `Range` request is only honored if the server answers 206 *and* starts
/// exactly where the local file ends. Anything else means rewriting from the
/// top, because appending foreign bytes would produce an installer that then
/// fails hashing.
pub(crate) fn plan_installer_transfer(existing_bytes: u64, status: u16, content_range: Option<&str>) -> InstallerTransferPlan {
    let restart = InstallerTransferPlan { offset: 0, append: false };
    if existing_bytes == 0 || status != 206 {
        return restart;
    }
    let start = Regex::new(r"(?i)^bytes\s+(\d+)-").ok().and_then(|pattern| {
        let captures = pattern.captures(content_range?)?;
        captures.get(1)?.as_str().parse::<u64>().ok()
    });
    if start == Some(existing_bytes) {
        InstallerTransferPlan { offset: existing_bytes, append: true }
    } else {
        restart
    }
}

/// Stream a finished installer through SHA-512 without holding it in memory.
pub(crate) async fn sha512_file_base64(file_path: &Path) -> std::io::Result<String> {
    let mut file = tokio::fs::File::open(file_path).await?;
    let mut hash = Sha512::new();
    let mut buffer = vec![0u8; HASH_CHUNK_BYTES];
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(STANDARD.encode(hash.finalize()))
}

/* ------------------------------------------------------ Linux package kinds */

/// The `package-type` marker in `resources_path` ("deb" inside the .deb), if any.
pub(crate) fn package_type_at(resources_path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(resources_path.join("package-type")).ok()?;
    let trimmed = raw.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LinuxPackageKind {
    AppImage,
    Deb,
    Other,
}

/// Which Linux install is running. The AppImage runtime wins over a deb marker.
/// `APPIMAGE` alone is not proof: child processes inherit it, and the AppImage
/// install replaces whatever file it names, so this process must also be
/// running from the mounted `APPDIR`.
pub(crate) fn linux_package_kind(
    appimage: Option<&str>,
    appdir: Option<&str>,
    exec_path: &str,
    package_type: Option<&str>,
) -> LinuxPackageKind {
    let appdir = appdir.map(|dir| dir.trim_end_matches('/'));
    if let (Some(image), Some(dir)) = (appimage, appdir) {
        if !image.is_empty() && !dir.is_empty() && exec_path.starts_with(&format!("{dir}/")) {
            return LinuxPackageKind::AppImage;
        }
    }
    if package_type == Some("deb") {
        LinuxPackageKind::Deb
    } else {
        LinuxPackageKind::Other
    }
}

/// A deb installs through pkexec; that prompt must never start unasked at quit.
pub(crate) fn installs_on_quit(kind: LinuxPackageKind) -> bool {
    kind != LinuxPackageKind::Deb
}

/// Linux installs that replace the app before it quits (a deb's pkexec + apt-get,
/// an AppImage's file swap) must pass the working-tabs quit prompt first: a
/// quit cancelled afterwards would keep the old process running on top of the
/// new install.
pub(crate) fn asks_before_install(kind: LinuxPackageKind) -> bool {
    matches!(kind, LinuxPackageKind::Deb | LinuxPackageKind::AppImage)
}

/// A failure listener handed to `subscribe` in [`capture_install_error`].
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) type InstallErrorListener = Arc<dyn Fn(String) + Send + Sync>;

/// Run an install and return the first failure it reported, whether through
/// the subscribed listener or as its own error. `subscribe` returns the
/// unsubscribe function, which runs once the install returns.
///
/// Some installers report failures as events next to the return value; these
/// return their failure directly, so only the ported test exercises this.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn capture_install_error<S, U, I>(subscribe: S, install: I) -> Option<String>
where
    S: FnOnce(InstallErrorListener) -> U,
    U: FnOnce(),
    I: FnOnce() -> Result<(), String>,
{
    let failure: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let sink = failure.clone();
    let unsubscribe = subscribe(Arc::new(move |error: String| {
        let mut slot = sink.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        slot.get_or_insert(error);
    }));
    let result = install();
    unsubscribe();
    let mut slot = failure.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Err(error) = result {
        slot.get_or_insert(error);
    }
    slot.take()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const NO_RESULT: &str = "Update check completed without a result.";

    // update check terminal state

    #[test]
    fn does_not_leave_a_completed_manual_check_spinning_forever() {
        assert_eq!(
            settle_incomplete_update_check(&UpdateStatus::Checking, true, NO_RESULT),
            UpdateStatus::Error { message: NO_RESULT.into(), show_in_banner: None, manual_install_command: None }
        );
        assert_eq!(
            serde_json::to_value(settle_incomplete_update_check(&UpdateStatus::Checking, true, NO_RESULT)).unwrap(),
            serde_json::json!({ "state": "error", "message": NO_RESULT })
        );
    }

    #[test]
    fn keeps_real_updater_terminal_states_intact_and_makes_background_misses_silent() {
        let available = UpdateStatus::Available { version: "0.7.2".into(), notes: None, mode: UpdateInstallMode::Automatic };
        assert_eq!(settle_incomplete_update_check(&available, true, NO_RESULT), available);
        assert_eq!(settle_incomplete_update_check(&UpdateStatus::Checking, false, NO_RESULT), UpdateStatus::Idle);
    }

    // manual installer transfer

    #[test]
    fn continues_a_partial_only_when_the_server_answers_for_exactly_the_bytes_it_holds() {
        assert_eq!(plan_installer_transfer(500, 206, Some("bytes 500-999/1000")), InstallerTransferPlan { offset: 500, append: true });
    }

    #[test]
    fn rewrites_from_the_top_whenever_appended_bytes_would_corrupt_the_installer() {
        let restarts = [
            plan_installer_transfer(0, 206, Some("bytes 0-999/1000")),
            plan_installer_transfer(500, 200, None),
            plan_installer_transfer(500, 206, None),
            plan_installer_transfer(500, 206, Some("bytes 0-999/1000")),
        ];
        for plan in restarts {
            assert_eq!(plan, InstallerTransferPlan { offset: 0, append: false });
        }
    }

    #[tokio::test]
    async fn hashes_every_byte_of_an_installer_larger_than_its_read_buffer() {
        let dir = tempfile::tempdir().unwrap();
        for size in [1024 * 1024 + 7, 2 * 1024 * 1024] {
            let bytes: Vec<u8> = (0..size).map(|index| (index % 251) as u8).collect();
            let path = dir.path().join(format!("blob-{size}"));
            fs::write(&path, &bytes).unwrap();
            assert_eq!(sha512_file_base64(&path).await.unwrap(), STANDARD.encode(Sha512::digest(&bytes)));
        }
    }

    // Linux package kind and deb installs

    #[test]
    fn reads_the_deb_marker_electron_builder_writes_into_resources() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(package_type_at(dir.path()), None);
        fs::write(dir.path().join("package-type"), "deb\n").unwrap();
        assert_eq!(package_type_at(dir.path()).as_deref(), Some("deb"));
    }

    #[test]
    fn trusts_appimage_only_when_this_process_runs_from_the_mounted_image() {
        let (image, mount) = (Some("/home/u/Applications/omp.AppImage"), Some("/tmp/.mount_ompAbC"));
        // A leaked deb marker inside the AppImage loses to the runtime.
        assert_eq!(linux_package_kind(image, mount, "/tmp/.mount_ompAbC/omp-gui", Some("deb")), LinuxPackageKind::AppImage);
        // A .deb install launched from another AppImage app's terminal inherits its variables.
        let (other, other_mount) = (Some("/home/u/Applications/Editor.AppImage"), Some("/tmp/.mount_EditorX"));
        assert_eq!(linux_package_kind(other, other_mount, "/opt/omp/omp-gui", Some("deb")), LinuxPackageKind::Deb);
        assert_eq!(linux_package_kind(Some("/home/u/x.AppImage"), None, "/opt/omp/omp-gui", Some("deb")), LinuxPackageKind::Deb);
        assert_eq!(linux_package_kind(None, None, "/opt/omp/omp-gui", Some("deb")), LinuxPackageKind::Deb);
        assert_eq!(linux_package_kind(None, None, "/opt/omp/omp-gui", None), LinuxPackageKind::Other);
    }

    #[test]
    fn never_starts_a_deb_s_privileged_install_at_quit() {
        assert!(!installs_on_quit(LinuxPackageKind::Deb));
        assert!(installs_on_quit(LinuxPackageKind::AppImage));
        assert!(installs_on_quit(LinuxPackageKind::Other));
    }

    #[test]
    fn asks_the_quit_prompt_before_a_linux_install_replaces_the_app() {
        assert!(asks_before_install(LinuxPackageKind::Deb));
        assert!(asks_before_install(LinuxPackageKind::AppImage));
        assert!(!asks_before_install(LinuxPackageKind::Other));
    }

    #[test]
    fn returns_the_failure_an_install_reported_as_an_event() {
        let listeners: Arc<Mutex<Vec<InstallErrorListener>>> = Arc::new(Mutex::new(Vec::new()));
        let subscribe = |listener: InstallErrorListener| {
            listeners.lock().unwrap().push(listener);
            let listeners = listeners.clone();
            move || listeners.lock().unwrap().clear()
        };
        let emit = |message: &str| {
            for listener in listeners.lock().unwrap().iter() {
                listener(message.to_string());
            }
        };
        let failure = capture_install_error(subscribe, || {
            emit("pkexec dismissed");
            Ok(())
        });
        assert_eq!(failure.as_deref(), Some("pkexec dismissed"));
        assert_eq!(capture_install_error(subscribe, || Ok(())), None);
        assert_eq!(listeners.lock().unwrap().len(), 0);
    }
}
