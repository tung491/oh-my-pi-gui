//! Installing a downloaded package: the deb's privileged `dpkg` run, the
//! AppImage file swap and the Windows installer start. Every command is an
//! argv vector of absolute paths; nothing here goes through a shell.

use std::path::{Path, PathBuf};

use futures_util::future::BoxFuture;

use super::state::sha512_file_base64;

/// The binary the .deb installs; the relaunch after a deb update starts it.
pub(crate) const DEB_BINARY: &str = "/usr/bin/sai-atlas";

const PKEXEC: &str = "/usr/bin/pkexec";
const DPKG: &str = "/usr/bin/dpkg";
const APT_GET: &str = "/usr/bin/apt-get";

/// pkexec's own exit statuses: the user dismissed the authentication dialog,
/// or was not authorized. The command behind pkexec never ran.
const PKEXEC_DISMISSED: i32 = 126;
const PKEXEC_NOT_AUTHORIZED: i32 = 127;

/// What pkexec prints when it cannot gain privileges because the process
/// runs with `no_new_privs`; it exits with `PKEXEC_NOT_AUTHORIZED` then too.
const PKEXEC_NOT_SETUID: &str = "must be setuid root";

/// The two privileged commands a deb install may run, in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DebInstallPlan {
    /// `pkexec dpkg -i -- <package>`: install the downloaded package.
    pub install: Vec<String>,
    /// `pkexec apt-get install -f -y`: when dpkg left the package unconfigured
    /// over missing dependencies, install them and finish the configuration.
    pub fix_dependencies: Vec<String>,
}

/// electron-updater's `DebUpdater.installWithCommandRunner` (`dpkg -i`, then
/// `apt-get install -f -y` after a failure) as argv vectors with absolute
/// paths. `--` ends dpkg's options, so the package path is never read as one.
pub(crate) fn deb_install_plan(package: &Path) -> Result<DebInstallPlan, String> {
    if !package.is_absolute() {
        return Err(format!("the package path is not absolute: {}", package.display()));
    }
    let package = package.to_str().ok_or_else(|| format!("the package path is not valid UTF-8: {}", package.display()))?;
    Ok(DebInstallPlan {
        install: [PKEXEC, DPKG, "-i", "--", package].iter().map(|part| part.to_string()).collect(),
        fix_dependencies: [PKEXEC, APT_GET, "install", "-f", "-y"].iter().map(|part| part.to_string()).collect(),
    })
}

/// Why a privileged command did not succeed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RunFailure {
    /// The exit status, when the command ran at all.
    pub code: Option<i32>,
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
/// arguments through `tokio::process`, with no shell in between.
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
                .stdin(std::process::Stdio::null())
                .output()
                .await
                .map_err(|error| RunFailure { code: None, detail: format!("{program} could not start: {error}") })?;
            if output.status.success() {
                return Ok(());
            }
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stderr = stderr.trim();
            let tail: String = stderr.chars().rev().take(STDERR_TAIL_CHARS).collect::<Vec<_>>().into_iter().rev().collect();
            let detail = if tail.is_empty() { format!("{program} exited with {}", output.status) } else { tail };
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
/// check runs here, dpkg reads the file as root, and nothing hands dpkg an
/// already-verified descriptor. The remaining exposure is to code already
/// running as this user, which could also edit anything else the user owns;
/// users who want no window at all install the package by hand with `sudo apt
/// install ./<package>.deb`.
pub(crate) async fn install_deb(runner: &dyn PrivilegedRunner, package: &Path, expected_sha512: &str) -> Result<(), InstallError> {
    let plan = deb_install_plan(package)?;
    verify_package(package, expected_sha512).await?;
    if !runner.can_elevate() {
        return Err(InstallError::ReopenRequired);
    }
    let Err(install) = runner.run(plan.install).await else { return Ok(()) };
    if install.pkexec_blocked() {
        return Err(InstallError::ReopenRequired);
    }
    // pkexec refusing means the user said no; a second prompt would only ask again.
    if install.pkexec_refused() {
        return Err(install.detail.into());
    }
    match runner.run(plan.fix_dependencies).await {
        Ok(()) => Ok(()),
        Err(fix) => Err(format!("{}; {}", install.detail, fix.detail).into()),
    }
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

#[cfg(not(unix))]
async fn set_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Start the downloaded NSIS installer. `/S` is NSIS's silent switch, used for
/// the install at quit; an install the user asked for shows the installer's
/// own progress. The installer outlives this process, which exits right after.
#[cfg(windows)]
pub(crate) fn start_windows_installer(installer: &Path, silent: bool) -> Result<(), String> {
    let mut command = tokio::process::Command::new(installer);
    if silent {
        command.arg("/S");
    }
    command.spawn().map(|_child| ()).map_err(|error| format!("{} could not start: {error}", installer.display()))
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

    #[test]
    fn uses_absolute_dpkg_path() {
        let plan = deb_install_plan(Path::new("/var/cache/sai-atlas/sai-atlas_0.9.16_amd64.deb")).unwrap();
        assert_eq!(plan.install[0], "/usr/bin/pkexec");
        assert_eq!(plan.install[1], "/usr/bin/dpkg");
        assert_eq!(plan.fix_dependencies[0], "/usr/bin/pkexec");
        assert_eq!(plan.fix_dependencies[1], "/usr/bin/apt-get");
        for part in plan.install.iter().take(2).chain(plan.fix_dependencies.iter().take(2)) {
            assert!(Path::new(part).is_absolute(), "{part}");
        }
        assert_eq!(plan.fix_dependencies[2..], ["install", "-f", "-y"]);
    }

    #[test]
    fn passes_the_package_after_double_dash() {
        let plan = deb_install_plan(Path::new("/home/u/.cache/updates/sai-atlas_0.9.16_amd64.deb")).unwrap();
        assert_eq!(plan.install[2..], ["-i", "--", "/home/u/.cache/updates/sai-atlas_0.9.16_amd64.deb"]);
        assert!(deb_install_plan(Path::new("sai-atlas_0.9.16_amd64.deb")).unwrap_err().contains("not absolute"));
    }

    #[test]
    fn never_builds_a_shell_string() {
        let hostile = Path::new("/tmp/odd dir/$(touch pwned); sai-atlas_0.9.16_amd64.deb");
        let plan = deb_install_plan(hostile).unwrap();
        // One argv element per word; the path stays one verbatim element.
        assert_eq!(plan.install.len(), 5);
        assert_eq!(plan.install[4], hostile.to_str().unwrap());
        for part in plan.install.iter().chain(plan.fix_dependencies.iter()) {
            assert!(!part.contains("bash") && !part.contains("sh -c") && part != "-c", "{part}");
            assert!(!part.starts_with('\'') && !part.starts_with('"'), "{part}");
        }
        assert!(!plan.install.iter().any(|part| part.contains(' ') && part != hostile.to_str().unwrap()));
    }

    // deb install

    #[tokio::test]
    async fn runs_dpkg_then_the_dependency_fix_only_after_a_dpkg_failure() {
        let dir = tempfile::tempdir().unwrap();
        let package = dir.path().join("sai-atlas_0.9.16_amd64.deb");
        tokio::fs::write(&package, b"deb bytes").await.unwrap();
        let sha = sha512_file_base64(&package).await.unwrap();

        let runner = FakeRunner::default();
        install_deb(&runner, &package, &sha).await.unwrap();
        assert_eq!(runner.calls.lock().unwrap().len(), 1);

        let runner = FakeRunner::default();
        *runner.answers.lock().unwrap() = vec![Err(failure(1, "dependency problems")), Ok(())];
        install_deb(&runner, &package, &sha).await.unwrap();
        let calls = runner.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1][1..], ["/usr/bin/apt-get", "install", "-f", "-y"]);
    }

    #[tokio::test]
    async fn skips_the_dependency_fix_when_pkexec_itself_refused() {
        let dir = tempfile::tempdir().unwrap();
        let package = dir.path().join("sai-atlas_0.9.16_amd64.deb");
        tokio::fs::write(&package, b"deb bytes").await.unwrap();
        let sha = sha512_file_base64(&package).await.unwrap();
        for code in [PKEXEC_DISMISSED, PKEXEC_NOT_AUTHORIZED] {
            let runner = FakeRunner::default();
            *runner.answers.lock().unwrap() = vec![Err(failure(code, "dismissed"))];
            assert_eq!(install_deb(&runner, &package, &sha).await.unwrap_err(), InstallError::Failed("dismissed".into()));
            assert_eq!(runner.calls.lock().unwrap().len(), 1);
        }
        let runner = FakeRunner::default();
        *runner.answers.lock().unwrap() = vec![Err(failure(1, "first")), Err(failure(100, "second"))];
        assert_eq!(install_deb(&runner, &package, &sha).await.unwrap_err(), InstallError::Failed("first; second".into()));
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
        assert_eq!(runner.calls.lock().unwrap().len(), 1, "no dependency fix after a blocked pkexec");
        // The same words with another status are an ordinary failure.
        let runner = FakeRunner::default();
        *runner.answers.lock().unwrap() = vec![Err(failure(1, "must be setuid root")), Err(failure(1, "again"))];
        assert_eq!(install_deb(&runner, &package, &sha).await.unwrap_err(), InstallError::Failed("must be setuid root; again".into()));
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
