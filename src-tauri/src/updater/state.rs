//! The updater's pure state machine and file helpers: the renderer-visible
//! `UpdateStatus`, macOS installer selection, resumable installer transfers,
//! installer debris cleanup and the Linux package-kind rules that decide how
//! an update installs.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha512};
use tokio::io::AsyncReadExt;

/// How a downloaded update installs: `automatic` replaces the app itself,
/// `manual` hands an installer to the user (ad-hoc-signed macOS builds).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum UpdateInstallMode {
    Automatic,
    Manual,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reopen_required: Option<bool>,
    },
    NotAvailable {
        version: String,
    },
    Error {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        show_in_banner: Option<bool>,
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

/// The DMG chosen for this Mac.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MacInstallerAsset {
    pub name: String,
    pub sha512: String,
    pub size: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MacInstallerArchitecture {
    Arm64,
    X64,
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

/// Select only the exact DMG produced for the running Mac architecture.
pub(crate) fn select_mac_installer(
    files: &[ReleaseFile],
    version: &str,
    architecture: MacInstallerArchitecture,
) -> Option<MacInstallerAsset> {
    let expected = match architecture {
        MacInstallerArchitecture::Arm64 => format!("Sai-ATLAS-{version}-arm64.dmg"),
        MacInstallerArchitecture::X64 => format!("Sai-ATLAS-{version}.dmg"),
    };
    files
        .iter()
        .find(|file| release_file_name(&file.url) == expected)
        .map(|file| MacInstallerAsset { name: expected.clone(), sha512: file.sha512.clone(), size: file.size })
}

/// A certificate-backed signature has both an authority chain and a team.
/// Ad-hoc signatures explicitly report `Signature=adhoc` and no team.
///
/// The Tauri macOS bundle is ad-hoc signed and has no Squirrel flow, so the
/// install mode is always manual there and nothing reads `codesign` output;
/// the rule stays for its ported test.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn has_stable_mac_signing_identity(codesign_details: &str) -> bool {
    let lines = || codesign_details.lines().map(str::trim);
    if lines().any(|line| line == "Signature=adhoc" || line == "TeamIdentifier=not set") {
        return false;
    }
    let has_authority = lines().any(|line| line.strip_prefix("Authority=").is_some_and(|rest| !rest.is_empty()));
    let has_team = lines().any(|line| line.strip_prefix("TeamIdentifier=").is_some_and(|rest| !rest.is_empty() && rest != "not set"));
    has_authority && has_team
}

/// A check that finished without reaching a terminal state must not leave the
/// public state machine stuck in `checking`: a manual check reports
/// `no_result_message`, a background check goes quietly back to idle.
pub(crate) fn settle_incomplete_update_check(status: &UpdateStatus, manual: bool, no_result_message: &str) -> UpdateStatus {
    match status {
        UpdateStatus::Checking if manual => UpdateStatus::Error { message: no_result_message.to_string(), show_in_banner: None },
        UpdateStatus::Checking => UpdateStatus::Idle,
        other => other.clone(),
    }
}

/* ------------------------------------------------ installer transfer files */

const PARTIAL_SUFFIX: &str = ".partial";
const HASH_CHUNK_BYTES: usize = 1024 * 1024;

/// Only names an updater could have written: `Sai-ATLAS-<version>[-arm64][ (n)].dmg`,
/// or the `omp-` form 0.9.x releases downloaded before the rename, plus a partial
/// suffix. Downloads is the user's directory, so anything else, including a
/// lookalike like `holiday.dmg.partial`, must survive the sweep.
fn installer_debris() -> Option<Regex> {
    Regex::new(r"^(?:omp|Sai-ATLAS)-[\d.]+(?:-arm64)?(?: \(\d+\))?\.dmg(?:\.partial|\.download-\d+)$").ok()
}

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

/// Delete installer debris: PID-keyed partials written by older builds (never
/// resumable) and, once a fresh download names its own partial, `.partial`
/// files belonging to a superseded release. Without a current download there is
/// no way to tell a resumable partial from an abandoned one, so startup removes
/// only the old debris. Everything else in Downloads belongs to the user.
pub(crate) async fn sweep_installer_partials(directory: &Path, active_partial: Option<&Path>) -> Vec<String> {
    let mut removed = Vec::new();
    let Some(debris) = installer_debris() else { return removed };
    let active_name = active_partial.and_then(Path::file_name).map(|name| name.to_string_lossy().into_owned());
    let Ok(mut entries) = tokio::fs::read_dir(directory).await else { return removed };
    loop {
        let entry = match entries.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) | Err(_) => break,
        };
        let Ok(name) = entry.file_name().into_string() else { continue };
        if !debris.is_match(&name) || active_name.as_deref() == Some(name.as_str()) {
            continue;
        }
        if active_name.is_none() && name.ends_with(PARTIAL_SUFFIX) {
            continue;
        }
        // A file still open by a racing transfer stays; the next launch retries.
        if tokio::fs::remove_file(entry.path()).await.is_ok() {
            removed.push(name);
        }
    }
    removed
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
pub(crate) fn installs_on_quit(mode: UpdateInstallMode, kind: Option<LinuxPackageKind>) -> bool {
    mode == UpdateInstallMode::Automatic && kind != Some(LinuxPackageKind::Deb)
}

/// Linux installs that replace the app before it quits (a deb's pkexec + dpkg,
/// an AppImage's file swap) must pass the working-tabs quit prompt first: a
/// quit cancelled afterwards would keep the old process running on top of the
/// new install.
pub(crate) fn asks_before_install(kind: Option<LinuxPackageKind>) -> bool {
    matches!(kind, Some(LinuxPackageKind::Deb | LinuxPackageKind::AppImage))
}

/// A failure listener handed to `subscribe` in [`capture_install_error`].
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) type InstallErrorListener = Arc<dyn Fn(String) + Send + Sync>;

/// Run an install and return the first failure it reported, whether through
/// the subscribed listener or as its own error. `subscribe` returns the
/// unsubscribe function, which runs once the install returns.
///
/// electron-updater reported install failures as events next to the return
/// value; the Rust installers return their failure directly, so only the
/// ported test exercises this.
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

    fn file(url: &str, sha512: &str, size: Option<u64>) -> ReleaseFile {
        ReleaseFile { url: url.into(), sha512: sha512.into(), size }
    }

    fn mac_files() -> Vec<ReleaseFile> {
        vec![
            file("Sai-ATLAS-0.8.4-arm64-mac.zip", "arm-zip", None),
            file("Sai-ATLAS-0.8.4-arm64.dmg", "arm-dmg", Some(120)),
            file("https://example.test/Sai-ATLAS-0.8.4-mac.zip", "x64-zip", None),
            file("https://example.test/Sai-ATLAS-0.8.4.dmg", "x64-dmg", Some(140)),
        ]
    }

    // update check terminal state

    #[test]
    fn does_not_leave_a_completed_manual_check_spinning_forever() {
        assert_eq!(
            settle_incomplete_update_check(&UpdateStatus::Checking, true, NO_RESULT),
            UpdateStatus::Error { message: NO_RESULT.into(), show_in_banner: None }
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

    // manual macOS installer selection

    #[test]
    fn selects_the_exact_dmg_for_each_supported_architecture() {
        let files = mac_files();
        assert_eq!(
            select_mac_installer(&files, "0.8.4", MacInstallerArchitecture::Arm64),
            Some(MacInstallerAsset { name: "Sai-ATLAS-0.8.4-arm64.dmg".into(), sha512: "arm-dmg".into(), size: Some(120) })
        );
        assert_eq!(
            select_mac_installer(&files, "0.8.4", MacInstallerArchitecture::X64),
            Some(MacInstallerAsset { name: "Sai-ATLAS-0.8.4.dmg".into(), sha512: "x64-dmg".into(), size: Some(140) })
        );
    }

    #[test]
    fn rejects_zips_and_installers_for_a_different_release() {
        let files = mac_files();
        assert_eq!(select_mac_installer(&files, "0.8.5", MacInstallerArchitecture::Arm64), None);
        let zips: Vec<ReleaseFile> = files.into_iter().filter(|file| file.url.ends_with(".zip")).collect();
        assert_eq!(select_mac_installer(&zips, "0.8.4", MacInstallerArchitecture::X64), None);
    }

    #[test]
    fn no_longer_installs_the_old_name_bridge_copies_of_a_release() {
        let bridge = vec![file("omp-0.8.4-arm64.dmg", "arm-dmg", None), file("omp-0.8.4.dmg", "x64-dmg", None)];
        assert_eq!(select_mac_installer(&bridge, "0.8.4", MacInstallerArchitecture::Arm64), None);
        assert_eq!(select_mac_installer(&bridge, "0.8.4", MacInstallerArchitecture::X64), None);
    }

    // macOS signing identity

    #[test]
    fn keeps_squirrel_only_for_a_certificate_backed_stable_identity() {
        assert!(has_stable_mac_signing_identity("Authority=Developer ID Application: Example Corp (TEAM123456)\nTeamIdentifier=TEAM123456"));
        assert!(!has_stable_mac_signing_identity("Signature=adhoc\nTeamIdentifier=not set"));
        assert!(!has_stable_mac_signing_identity("TeamIdentifier=TEAM123456"));
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

    // installer debris sweep

    // 0.9.x wrote omp- names; later releases write Sai-ATLAS- names.
    const ENTRIES: &[&str] = &[
        "omp-0.9.7.dmg.download-4242",
        "Sai-ATLAS-0.9.8.dmg.download-99",
        "omp-0.9.8.dmg.partial",
        "Sai-ATLAS-0.9.7 (1).dmg.partial",
        "holiday.dmg.partial",
        "notes.partial",
        "install-omp.dmg.download-1",
        "Sai-ATLAS-notes.dmg.partial",
        "Sai-ATLAS-0.9.9-arm64.dmg",
    ];

    fn downloads() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for name in ENTRIES {
            fs::write(dir.path().join(name), "x").unwrap();
        }
        dir
    }

    fn sorted(mut names: Vec<String>) -> Vec<String> {
        names.sort();
        names
    }

    #[tokio::test]
    async fn clears_pid_keyed_orphans_that_no_restart_could_ever_continue() {
        let dir = downloads();
        assert_eq!(
            sorted(sweep_installer_partials(dir.path(), None).await),
            vec!["Sai-ATLAS-0.9.8.dmg.download-99".to_string(), "omp-0.9.7.dmg.download-4242".to_string()]
        );
    }

    #[tokio::test]
    async fn keeps_every_current_name_partial_while_nothing_is_downloading() {
        let dir = downloads();
        sweep_installer_partials(dir.path(), None).await;
        assert!(dir.path().join("omp-0.9.8.dmg.partial").exists());
        assert!(dir.path().join("Sai-ATLAS-0.9.7 (1).dmg.partial").exists());
    }

    #[tokio::test]
    async fn drops_a_superseded_release_s_partial_once_the_current_download_names_its_own() {
        let dir = downloads();
        let active = installer_partial_path(&dir.path().join("Sai-ATLAS-0.9.9-arm64.dmg"));
        fs::write(&active, "x").unwrap();
        let removed = sweep_installer_partials(dir.path(), Some(&active)).await;
        assert_eq!(
            sorted(removed),
            vec![
                "Sai-ATLAS-0.9.7 (1).dmg.partial".to_string(),
                "Sai-ATLAS-0.9.8.dmg.download-99".to_string(),
                "omp-0.9.7.dmg.download-4242".to_string(),
                "omp-0.9.8.dmg.partial".to_string(),
            ]
        );
        assert!(active.exists());
    }

    #[tokio::test]
    async fn leaves_files_the_updater_never_wrote_where_they_are() {
        let dir = downloads();
        let active = installer_partial_path(&dir.path().join("Sai-ATLAS-0.9.9-arm64.dmg"));
        sweep_installer_partials(dir.path(), Some(&active)).await;
        sweep_installer_partials(dir.path(), None).await;
        for name in ["holiday.dmg.partial", "notes.partial", "install-omp.dmg.download-1", "Sai-ATLAS-notes.dmg.partial", "Sai-ATLAS-0.9.9-arm64.dmg"] {
            assert!(dir.path().join(name).exists(), "{name}");
        }
    }

    #[tokio::test]
    async fn says_nothing_when_the_downloads_directory_doesn_t_exist_yet() {
        let dir = downloads();
        assert!(sweep_installer_partials(&dir.path().join("absent"), None).await.is_empty());
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
        assert!(!installs_on_quit(UpdateInstallMode::Automatic, Some(LinuxPackageKind::Deb)));
        assert!(installs_on_quit(UpdateInstallMode::Automatic, Some(LinuxPackageKind::AppImage)));
        assert!(installs_on_quit(UpdateInstallMode::Automatic, None));
        assert!(!installs_on_quit(UpdateInstallMode::Manual, None));
    }

    #[test]
    fn asks_the_quit_prompt_before_a_linux_install_replaces_the_app() {
        assert!(asks_before_install(Some(LinuxPackageKind::Deb)));
        assert!(asks_before_install(Some(LinuxPackageKind::AppImage)));
        assert!(!asks_before_install(Some(LinuxPackageKind::Other)));
        assert!(!asks_before_install(None));
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
