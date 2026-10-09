//! Installing a downloaded package: the deb's privileged `apt-get` run and the
//! AppImage file swap. Every command is an
//! argv vector of absolute paths; nothing here goes through a shell.
//!
//! A deb installs with one command, `pkexec apt-get install -y --no-remove --
//! <package>`, never with `dpkg -i` and a later `apt-get install -f`. apt
//! resolves the dependencies before dpkg touches anything, so a package whose
//! dependencies cannot be installed fails with the installed version intact
//! instead of being left unconfigured, and `-f`'s resolver, which may remove
//! the very package it repairs, never runs. `--no-remove` turns "remove other
//! packages to make this fit" into a failure: an unattended `-y` run as root
//! must not decide that. One command also means one authentication prompt.

use std::path::{Path, PathBuf};

use futures_util::future::BoxFuture;

use super::state::sha512_file_base64;

/// The binary the .deb installs; the relaunch after a deb update starts it.
pub(crate) const DEB_BINARY: &str = "/usr/bin/sai-atlas";

const PKEXEC: &str = "/usr/bin/pkexec";
const APT_GET: &str = "/usr/bin/apt-get";

/// pkexec's own exit statuses: the user dismissed the authentication dialog,
/// or was not authorized. The command behind pkexec never ran.
const PKEXEC_DISMISSED: i32 = 126;
const PKEXEC_NOT_AUTHORIZED: i32 = 127;

/// What pkexec prints when it cannot gain privileges because the process
/// runs with `no_new_privs`; it exits with `PKEXEC_NOT_AUTHORIZED` then too.
const PKEXEC_NOT_SETUID: &str = "must be setuid root";

/// apt's words when it cannot install the package without breaking the system:
/// unmet or unsatisfiable dependencies (apt 2.x and the apt 3 solver), or a
/// resolution that would remove other packages, which `--no-remove` refuses.
/// Matched case-insensitively against apt's English output.
const APT_UNRESOLVABLE: &[&str] = &[
    "unmet dependencies",
    "unable to correct problems",
    "unable to satisfy dependencies",
    "packages need to be removed but remove is disabled",
];

/// The privileged deb install, `pkexec apt-get install -y --no-remove --
/// <package>`, as an argv vector with absolute paths. The path must be
/// absolute: apt reads an argument as a package file only when it contains a
/// slash. `--` ends apt's options, so the path is never read as one.
pub(crate) fn deb_install_command(package: &Path) -> Result<Vec<String>, String> {
    let package = deb_package_path(package)?;
    Ok([PKEXEC, APT_GET, "install", "-y", "--no-remove", "--", package].iter().map(|part| part.to_string()).collect())
}

fn deb_package_path(package: &Path) -> Result<&str, String> {
    if !package.is_absolute() {
        return Err(format!("the package path is not absolute: {}", package.display()));
    }
    package.to_str().ok_or_else(|| format!("the package path is not valid UTF-8: {}", package.display()))
}

/// The command a user can run in a terminal to install the package by hand:
/// interactive apt shows what it would install or remove and asks first. The
/// path is single-quoted for the shell when it holds anything but plain path
/// characters.
pub(crate) fn manual_deb_install_command(package: &str) -> String {
    let plain = !package.is_empty() && package.chars().all(|c| c.is_ascii_alphanumeric() || "/._-+@%=:,".contains(c));
    let quoted = if plain { package.to_string() } else { format!("'{}'", package.replace('\'', "'\\''")) };
    format!("sudo apt install {quoted}")
}

/// Whether apt's output says it could not resolve the package's dependencies.
fn apt_could_not_resolve(stderr: &str) -> bool {
    let stderr = stderr.to_lowercase();
    APT_UNRESOLVABLE.iter().any(|words| stderr.contains(words))
}

/// The last `STDERR_TAIL_CHARS` characters of a failure's output, for the banner.
fn tail(detail: &str) -> String {
    let skip = detail.chars().count().saturating_sub(STDERR_TAIL_CHARS);
    detail.chars().skip(skip).collect()
}

/// Why a privileged command did not succeed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RunFailure {
    /// The exit status, when the command ran at all.
    pub code: Option<i32>,
    /// The command's whole standard error, trimmed, or what kept it from running.
    pub detail: String,
}

impl RunFailure {
    /// pkexec itself refused: the dialog was dismissed or the user is not authorized.
    fn pkexec_refused(&self) -> bool {
        matches!(self.code, Some(PKEXEC_DISMISSED | PKEXEC_NOT_AUTHORIZED))
    }

    /// pkexec could not gain privileges at all: this process runs with
    /// `no_new_privs`. Caught here too in case the up-front check missed it.
    fn pkexec_blocked(&self) -> bool {
        self.code == Some(PKEXEC_NOT_AUTHORIZED) && self.detail.contains(PKEXEC_NOT_SETUID)
    }
}

/// Why an install did not happen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum InstallError {
    /// This process runs with `no_new_privs` (Electron's relaunch helper started
    /// it), so pkexec cannot work until the app is quit and opened again. The
    /// downloaded package stays usable.
    ReopenRequired,
    /// apt could not install the package's dependencies, or only by removing
    /// other packages; nothing changed. `command` installs it by hand.
    UnresolvedDependencies { detail: String, command: String },
    Failed(String),
}

impl From<String> for InstallError {
    fn from(detail: String) -> Self {
        InstallError::Failed(detail)
    }
}

/// Runs one argv vector as root. Injected so tests never start pkexec.
pub(crate) trait PrivilegedRunner: Send + Sync {
    fn run(&self, argv: Vec<String>) -> BoxFuture<'_, Result<(), RunFailure>>;

    /// Whether this process can gain privileges at all; pkexec cannot under `no_new_privs`.
    fn can_elevate(&self) -> bool;
}

/// The production runner: spawns `argv[0]` (pkexec) with the rest as its
/// arguments through `tokio::process`, with no shell in between. pkexec passes
/// the locale variables on to the command, so they are pinned to `C`: apt's
/// failures are then the English words `APT_UNRESOLVABLE` matches, whatever
/// language the session uses. The authentication dialog comes from the
/// session's polkit agent and keeps the user's language.
pub(crate) struct PkexecRunner;

const STDERR_TAIL_CHARS: usize = 400;

impl PrivilegedRunner for PkexecRunner {
    fn run(&self, argv: Vec<String>) -> BoxFuture<'_, Result<(), RunFailure>> {
        Box::pin(async move {
            let Some((program, args)) = argv.split_first() else {
                return Err(RunFailure { code: None, detail: "empty command".into() });
            };
            let output = tokio::process::Command::new(program)
                .args(args)
                .env("LC_ALL", "C")
                .env_remove("LANGUAGE")
                .stdin(std::process::Stdio::null())
                .output()
                .await
                .map_err(|error| RunFailure { code: None, detail: format!("{program} could not start: {error}") })?;
            if output.status.success() {
                return Ok(());
            }
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stderr = stderr.trim();
            let detail = if stderr.is_empty() { format!("{program} exited with {}", output.status) } else { stderr.to_string() };
            Err(RunFailure { code: output.status.code(), detail })
        })
    }

    fn can_elevate(&self) -> bool {
        !crate::relaunch::no_new_privs()
    }
}

/// Verify the downloaded package against the feed's hash. Runs again right
/// before an install, so the bytes checked are the bytes installed, as far as
/// this process can tell.
pub(crate) async fn verify_package(package: &Path, expected_sha512: &str) -> Result<(), String> {
    let actual = sha512_file_base64(package).await.map_err(|error| format!("{} could not be hashed: {error}", package.display()))?;
    if actual != expected_sha512 {
        return Err(format!("{} no longer matches the release's SHA-512", package.display()));
    }
    Ok(())
}

/// Install a downloaded .deb as root.
///
/// The hash check and the privileged read are two separate opens of a file in
/// a location this user can write, so a process running as the same user could
/// swap the package between them. This process cannot close that window: the
/// check runs here, apt reads the file as root, and nothing hands apt an
/// already-verified descriptor. The remaining exposure is to code already
/// running as this user, which could also edit anything else the user owns;
/// users who want no window at all install the package by hand with `sudo apt
/// install ./<package>.deb`.
pub(crate) async fn install_deb(runner: &dyn PrivilegedRunner, package: &Path, expected_sha512: &str) -> Result<(), InstallError> {
    let command = deb_install_command(package)?;
    verify_package(package, expected_sha512).await?;
    if !runner.can_elevate() {
        return Err(InstallError::ReopenRequired);
    }
    let Err(failure) = runner.run(command).await else { return Ok(()) };
    if failure.pkexec_blocked() {
        return Err(InstallError::ReopenRequired);
    }
    // A refused prompt means apt never ran, so the output cannot be apt's.
    if !failure.pkexec_refused() && apt_could_not_resolve(&failure.detail) {
        let command = manual_deb_install_command(deb_package_path(package)?);
        return Err(InstallError::UnresolvedDependencies { detail: tail(&failure.detail), command });
    }
    Err(InstallError::Failed(tail(&failure.detail)))
}

/// Replace the AppImage at `target` with `downloaded`: copy next to it, make it
/// executable, then rename over the old file in one step, so the path never
/// points at a half-written image. `target` must be absolute, as electron-updater
/// requires of `$APPIMAGE`.
pub(crate) async fn replace_appimage(downloaded: &Path, target: &Path) -> Result<(), String> {
    if !target.is_absolute() {
        return Err(format!("APPIMAGE is not an absolute path: {}", target.display()));
    }
    let mut staging_name = target.file_name().ok_or_else(|| format!("APPIMAGE has no file name: {}", target.display()))?.to_os_string();
    staging_name.push(format!(".update-{}", std::process::id()));
    let staging = target.with_file_name(staging_name);
    let result = stage_appimage(downloaded, &staging, target).await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&staging).await;
    }
    result
}

async fn stage_appimage(downloaded: &Path, staging: &Path, target: &Path) -> Result<(), String> {
    tokio::fs::copy(downloaded, staging).await.map_err(|error| format!("{} could not be copied next to {}: {error}", downloaded.display(), target.display()))?;
    set_executable(staging).await?;
    tokio::fs::rename(staging, target).await.map_err(|error| format!("{} could not replace {}: {error}", staging.display(), target.display()))
}

#[cfg(unix)]
async fn set_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = tokio::fs::metadata(path).await.map_err(|error| format!("{} could not be inspected: {error}", path.display()))?;
    let mut permissions = metadata.permissions();
    permissions.set_mode(permissions.mode() | 0o755);
    tokio::fs::set_permissions(path, permissions).await.map_err(|error| format!("{} could not be made executable: {error}", path.display()))
}

/// The file the AppImage install replaces: `$APPIMAGE` when set and non-empty.
pub(crate) fn appimage_target(appimage: Option<&Path>) -> Result<PathBuf, String> {
    appimage.filter(|path| !path.as_os_str().is_empty()).map(Path::to_path_buf).ok_or_else(|| "APPIMAGE is not defined".to_string())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Records every argv and answers from a script, newest answer first.
    #[derive(Default)]
    pub(crate) struct FakeRunner {
        pub calls: Mutex<Vec<Vec<String>>>,
        pub answers: Mutex<Vec<Result<(), RunFailure>>>,
        /// Plays a process running with `no_new_privs`.
        pub no_new_privs: std::sync::atomic::AtomicBool,
    }

    impl PrivilegedRunner for FakeRunner {
        fn run(&self, argv: Vec<String>) -> BoxFuture<'_, Result<(), RunFailure>> {
            self.calls.lock().unwrap().push(argv);
            let mut answers = self.answers.lock().unwrap();
            let answer = if answers.is_empty() { Ok(()) } else { answers.remove(0) };
            Box::pin(std::future::ready(answer))
        }

        fn can_elevate(&self) -> bool {
            !self.no_new_privs.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    fn failure(code: i32, detail: &str) -> RunFailure {
        RunFailure { code: Some(code), detail: detail.into() }
    }

    // deb command builder

    const PACKAGE: &str = "/home/u/.cache/updates/sai-atlas_0.9.16_amd64.deb";

    #[test]
    fn installs_with_one_absolute_apt_get_command_and_never_repairs_with_f() {
        let command = deb_install_command(Path::new(PACKAGE)).unwrap();
        assert_eq!(command, ["/usr/bin/pkexec", "/usr/bin/apt-get", "install", "-y", "--no-remove", "--", PACKAGE]);
        for part in command.iter().take(2) {
            assert!(Path::new(part).is_absolute(), "{part}");
        }
        assert!(!command.iter().any(|part| part == "-f" || part == "--fix-broken" || part.ends_with("/dpkg")), "{command:?}");
    }

    #[test]
    fn passes_the_package_after_double_dash() {
        let command = deb_install_command(Path::new(PACKAGE)).unwrap();
        assert_eq!(command[command.len() - 2..], ["--", PACKAGE]);
        assert!(deb_install_command(Path::new("sai-atlas_0.9.16_amd64.deb")).unwrap_err().contains("not absolute"));
    }

    #[test]
    fn never_builds_a_shell_string() {
        let hostile = Path::new("/tmp/odd dir/$(touch pwned); sai-atlas_0.9.16_amd64.deb");
        let command = deb_install_command(hostile).unwrap();
        // One argv element per word; the path stays one verbatim element.
        assert_eq!(command.len(), 7);
        assert_eq!(command[6], hostile.to_str().unwrap());
        for part in &command {
            assert!(!part.contains("bash") && !part.contains("sh -c") && part != "-c", "{part}");
            assert!(!part.starts_with('\'') && !part.starts_with('"'), "{part}");
        }
        assert!(!command.iter().any(|part| part.contains(' ') && part != hostile.to_str().unwrap()));
    }

    #[test]
    fn quotes_the_manual_command_s_path_only_when_the_shell_needs_it() {
        assert_eq!(manual_deb_install_command(PACKAGE), format!("sudo apt install {PACKAGE}"));
        assert_eq!(manual_deb_install_command("/home/my user/a.deb"), "sudo apt install '/home/my user/a.deb'");
        assert_eq!(manual_deb_install_command("/tmp/it's $(x).deb"), "sudo apt install '/tmp/it'\\''s $(x).deb'");
    }

    #[test]
    fn recognises_apt_s_unresolvable_dependency_failures() {
        // apt 2.x (Ubuntu 24.04).
        assert!(apt_could_not_resolve(" sai-atlas : Depends: libwebkit2gtk-4.1-0 but it is not installable\nE: Unable to correct problems, you have held broken packages."));
        assert!(apt_could_not_resolve("E: Unmet dependencies. Try 'apt --fix-broken install' with no packages (or specify a solution)."));
        // apt 3 (Ubuntu 26.04).
        assert!(apt_could_not_resolve("The following packages have unmet dependencies:\n sai-atlas : Depends: x but it is not installable"));
        assert!(apt_could_not_resolve("E: Unable to satisfy dependencies. Reached two conflicting assignments:\n   1. sai-atlas:amd64=0.9.17 is selected for install"));
        // --no-remove refusing a resolution that removes other packages.
        assert!(apt_could_not_resolve("E: Packages need to be removed but remove is disabled."));
        assert!(!apt_could_not_resolve("E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 4242 (unattended-upgr)"));
        assert!(!apt_could_not_resolve("debconf: unable to initialize frontend: Dialog"));
    }

    #[test]
    fn keeps_the_end_of_a_long_failure() {
        let long = format!("{}E: the reason", "x".repeat(1000));
        assert_eq!(tail(&long).chars().count(), STDERR_TAIL_CHARS);
        assert!(tail(&long).ends_with("E: the reason"));
        assert_eq!(tail("short"), "short");
    }

    // deb install

    async fn downloaded_package(dir: &tempfile::TempDir) -> (PathBuf, String) {
        let package = dir.path().join("sai-atlas_0.9.16_amd64.deb");
        tokio::fs::write(&package, b"deb bytes").await.unwrap();
        let sha = sha512_file_base64(&package).await.unwrap();
        (package, sha)
    }

    #[tokio::test]
    async fn runs_the_single_apt_get_command_once_and_reports_its_failure() {
        let dir = tempfile::tempdir().unwrap();
        let (package, sha) = downloaded_package(&dir).await;

        let runner = FakeRunner::default();
        install_deb(&runner, &package, &sha).await.unwrap();
        assert_eq!(runner.calls.lock().unwrap().clone(), [deb_install_command(&package).unwrap()]);

        let runner = FakeRunner::default();
        *runner.answers.lock().unwrap() = vec![Err(failure(100, "E: Could not get lock /var/lib/dpkg/lock-frontend"))];
        assert_eq!(install_deb(&runner, &package, &sha).await.unwrap_err(), InstallError::Failed("E: Could not get lock /var/lib/dpkg/lock-frontend".into()));
        assert_eq!(runner.calls.lock().unwrap().len(), 1, "no second command after a failure");
    }

    #[tokio::test]
    async fn maps_unresolvable_dependencies_to_the_manual_apt_command() {
        let dir = tempfile::tempdir().unwrap();
        let (package, sha) = downloaded_package(&dir).await;
        let stderr = format!("{}\nE: Unable to correct problems, you have held broken packages.", "debconf: noise ".repeat(60));
        let runner = FakeRunner::default();
        *runner.answers.lock().unwrap() = vec![Err(failure(100, &stderr))];

        let error = install_deb(&runner, &package, &sha).await.unwrap_err();

        let command = format!("sudo apt install {}", package.to_str().unwrap());
        assert_eq!(error, InstallError::UnresolvedDependencies { detail: tail(&stderr), command });
        assert_eq!(runner.calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn matches_apt_s_words_anywhere_in_the_output_not_only_in_the_banner_tail() {
        let dir = tempfile::tempdir().unwrap();
        let (package, sha) = downloaded_package(&dir).await;
        let stderr = format!("The following packages have unmet dependencies:\n{}", "      [no choices]\n".repeat(60));
        let runner = FakeRunner::default();
        *runner.answers.lock().unwrap() = vec![Err(failure(100, &stderr))];
        assert!(!tail(&stderr).contains("unmet"));
        assert!(matches!(install_deb(&runner, &package, &sha).await.unwrap_err(), InstallError::UnresolvedDependencies { .. }));
    }

    #[tokio::test]
    async fn reports_a_refused_pkexec_prompt_as_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let (package, sha) = downloaded_package(&dir).await;
        for code in [PKEXEC_DISMISSED, PKEXEC_NOT_AUTHORIZED] {
            let runner = FakeRunner::default();
            *runner.answers.lock().unwrap() = vec![Err(failure(code, "dismissed"))];
            assert_eq!(install_deb(&runner, &package, &sha).await.unwrap_err(), InstallError::Failed("dismissed".into()));
            assert_eq!(runner.calls.lock().unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn asks_for_a_reopen_instead_of_running_pkexec_under_no_new_privs() {
        let dir = tempfile::tempdir().unwrap();
        let package = dir.path().join("sai-atlas_0.9.16_amd64.deb");
        tokio::fs::write(&package, b"deb bytes").await.unwrap();
        let sha = sha512_file_base64(&package).await.unwrap();
        let runner = FakeRunner { no_new_privs: true.into(), ..FakeRunner::default() };
        assert_eq!(install_deb(&runner, &package, &sha).await.unwrap_err(), InstallError::ReopenRequired);
        assert!(runner.calls.lock().unwrap().is_empty(), "pkexec never runs");
        // The hash is still checked first: a changed package is reported as such.
        assert!(matches!(install_deb(&runner, &package, "not-the-hash").await.unwrap_err(), InstallError::Failed(detail) if detail.contains("SHA-512")));
    }

    #[tokio::test]
    async fn reads_pkexec_s_setuid_failure_as_a_reopen_not_a_refusal() {
        let dir = tempfile::tempdir().unwrap();
        let package = dir.path().join("sai-atlas_0.9.16_amd64.deb");
        tokio::fs::write(&package, b"deb bytes").await.unwrap();
        let sha = sha512_file_base64(&package).await.unwrap();
        let runner = FakeRunner::default();
        *runner.answers.lock().unwrap() = vec![Err(failure(PKEXEC_NOT_AUTHORIZED, "pkexec must be setuid root"))];
        assert_eq!(install_deb(&runner, &package, &sha).await.unwrap_err(), InstallError::ReopenRequired);
        assert_eq!(runner.calls.lock().unwrap().len(), 1, "nothing runs after a blocked pkexec");
        // The same words with another status are an ordinary failure.
        let runner = FakeRunner::default();
        *runner.answers.lock().unwrap() = vec![Err(failure(1, "must be setuid root"))];
        assert_eq!(install_deb(&runner, &package, &sha).await.unwrap_err(), InstallError::Failed("must be setuid root".into()));
    }

    #[tokio::test]
    async fn refuses_to_install_a_package_whose_hash_changed() {
        let dir = tempfile::tempdir().unwrap();
        let package = dir.path().join("sai-atlas_0.9.16_amd64.deb");
        tokio::fs::write(&package, b"deb bytes").await.unwrap();
        let runner = FakeRunner::default();
        let error = install_deb(&runner, &package, "not-the-hash").await.unwrap_err();
        assert!(matches!(&error, InstallError::Failed(detail) if detail.contains("SHA-512")), "{error:?}");
        assert!(runner.calls.lock().unwrap().is_empty());
    }

    // AppImage swap

    #[tokio::test]
    async fn replaces_the_appimage_in_place_and_keeps_it_executable() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("Sai-ATLAS.AppImage");
        let downloaded = dir.path().join("cache").join("Sai-ATLAS-0.9.16-x86_64.AppImage");
        tokio::fs::create_dir_all(downloaded.parent().unwrap()).await.unwrap();
        tokio::fs::write(&target, b"old image").await.unwrap();
        tokio::fs::write(&downloaded, b"new image").await.unwrap();

        replace_appimage(&downloaded, &target).await.unwrap();

        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"new image");
        assert!(downloaded.exists(), "the downloaded copy stays until the cache is cleared");
        let leftovers: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|entry| entry.unwrap().file_name()).collect();
        assert_eq!(leftovers.len(), 2, "{leftovers:?}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&target).unwrap().permissions().mode() & 0o111, 0o111);
        }
    }

    #[tokio::test]
    async fn leaves_no_staging_file_when_the_copy_fails() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("Sai-ATLAS.AppImage");
        tokio::fs::write(&target, b"old image").await.unwrap();
        let error = replace_appimage(&dir.path().join("missing"), &target).await.unwrap_err();
        assert!(error.contains("could not be copied"), "{error}");
        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"old image");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        assert!(replace_appimage(&target, Path::new("relative.AppImage")).await.unwrap_err().contains("absolute"));
    }

    #[test]
    fn requires_appimage_to_name_the_file_to_replace() {
        assert_eq!(appimage_target(Some(Path::new("/home/u/Sai.AppImage"))), Ok(PathBuf::from("/home/u/Sai.AppImage")));
        assert!(appimage_target(Some(Path::new(""))).is_err());
        assert!(appimage_target(None).is_err());
    }
}
