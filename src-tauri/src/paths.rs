//! Filesystem locations the shell depends on: the profile directory, the
//! webview data directory, the agent profile, the bundled sidecar and the
//! directory a window starts in. Ported from `user-data-directory.ts`,
//! `bundled-omp-path.ts`, `initial-cwd.ts`, `default-workspace.ts` and
//! `agent-paths.ts`.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use sha2::{Digest, Sha256};

use crate::product;

/// The profile directory every 0.9.x release used, relative to the OS config dir.
/// It is pinned, never derived from the product name, so a rename cannot orphan settings.
pub const PROFILE_DIR_SEGMENTS: [&str; 2] = ["@oh-my-pi", "omp-gui"];

/// `--user-data-dir=<path>` (or `--user-data-dir <path>`), the only switch the shell reads itself.
pub const USER_DATA_DIR_SWITCH: &str = "--user-data-dir";

#[derive(Debug, thiserror::Error)]
pub enum PathsError {
    #[error("the bundled omp binary is missing; searched {}", join_paths(.0))]
    BundledOmpMissing(Vec<PathBuf>),
    #[error("the current executable path is unknown: {0}")]
    CurrentExe(std::io::Error),
    #[error("no config directory is known for this user (set XDG_CONFIG_HOME or pass --user-data-dir=<path>)")]
    NoConfigDir,
}

fn join_paths(paths: &[PathBuf]) -> String {
    paths.iter().map(|path| path.display().to_string()).collect::<Vec<_>>().join(", ")
}

/// The profile directory: `override` (resolved against the cwd) when given,
/// otherwise `<app_data>/@oh-my-pi/omp-gui`.
pub fn user_data_directory(app_data: &Path, override_dir: &str) -> PathBuf {
    if override_dir.is_empty() {
        let mut path = app_data.to_path_buf();
        for segment in PROFILE_DIR_SEGMENTS {
            path.push(segment);
        }
        return path;
    }
    let candidate = PathBuf::from(override_dir);
    if candidate.is_absolute() {
        normalize(&candidate)
    } else {
        normalize(&std::env::current_dir().unwrap_or_default().join(candidate))
    }
}

/// Lexically remove `.` and `..` segments (Node's `path.resolve` does the same).
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The value of `--user-data-dir` in `argv`, if any (`=` form or a separate argument).
pub fn user_data_dir_switch(argv: &[String]) -> Option<String> {
    let mut iter = argv.iter();
    while let Some(arg) = iter.next() {
        if let Some(value) = arg.strip_prefix(&format!("{USER_DATA_DIR_SWITCH}=")) {
            return Some(value.to_string());
        }
        if arg == USER_DATA_DIR_SWITCH {
            return iter.next().cloned();
        }
    }
    None
}

/// The default profile directory (`<config dir>/@oh-my-pi/omp-gui`), or
/// `NoConfigDir` when the OS reports no config directory for this user.
pub fn default_user_data_dir() -> Result<PathBuf, PathsError> {
    dirs::config_dir().map(|app_data| user_data_directory(&app_data, "")).ok_or(PathsError::NoConfigDir)
}

/// Resolve the profile directory for this process once, from argv and the OS
/// config dir. `run()` calls this first and fails startup on an error; the
/// profile is never allowed to fall back to a relative path.
pub fn resolve_user_data_dir() -> Result<&'static Path, PathsError> {
    // `None` means the OS reported no config directory and no override was given.
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        let argv: Vec<String> = std::env::args().collect();
        let override_dir = user_data_dir_switch(&argv).unwrap_or_default();
        // Tests never touch the user's real profile: every store and log goes
        // through a temp dir (`testing::fake_ctx`), so resolving the default
        // profile inside a test is a bug, not a path.
        #[cfg(test)]
        if override_dir.is_empty() {
            panic!("a test resolved the default profile directory; route stores and logs through temp dirs instead");
        }
        if override_dir.is_empty() {
            return default_user_data_dir().ok();
        }
        Some(user_data_directory(Path::new(""), &override_dir))
    })
    .as_deref()
    .ok_or(PathsError::NoConfigDir)
}

/// The profile directory for this process. `run()` validates it through
/// `resolve_user_data_dir` before anything else, so after startup this cannot
/// fail; before that validation there is no profile to use, and this panics
/// rather than inventing a relative one.
pub fn user_data_dir() -> &'static Path {
    match resolve_user_data_dir() {
        Ok(dir) => dir,
        Err(error) => panic!("{error}"),
    }
}

/// Whether this process runs on the default profile: no `--user-data-dir`, or
/// one that resolves to the same directory (an empty value, or the default path itself).
pub fn is_default_profile() -> bool {
    match (resolve_user_data_dir(), default_user_data_dir()) {
        (Ok(dir), Ok(default)) => dir == default,
        _ => false,
    }
}

/// Shared WebKit data directory for every window, the quick-entry bar included.
pub fn webview_data_dir() -> PathBuf {
    user_data_dir().join("webview")
}

/// Where the runtime crash log lives, as `runtime-log.ts` computed it.
pub fn runtime_log_path() -> PathBuf {
    user_data_dir().join("logs").join("gui-runtime.jsonl")
}

/// The agent profile directory, shared with the CLI (`PI_CODING_AGENT_DIR` or `~/.omp/agent`).
pub fn agent_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("PI_CODING_AGENT_DIR").filter(|value| !value.is_empty()) {
        return PathBuf::from(dir);
    }
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".omp").join("agent")
}

/// Filename of the bundled omp sidecar on this platform.
pub fn bundled_omp_filename() -> &'static str {
    if cfg!(windows) {
        "omp.exe"
    } else {
        "omp"
    }
}

/// Resolve a bundled sidecar path, accepting a Windows `.exe` suffix when needed.
pub fn resolve_omp_candidate(parts: &[&Path]) -> Option<PathBuf> {
    let mut candidate = PathBuf::new();
    for part in parts {
        candidate.push(part);
    }
    if candidate.exists() {
        return Some(candidate);
    }
    if cfg!(windows) {
        let lower = candidate.to_string_lossy().to_lowercase();
        if !lower.ends_with(".exe") {
            let mut with_exe = candidate.into_os_string();
            with_exe.push(".exe");
            let with_exe = PathBuf::from(with_exe);
            if with_exe.exists() {
                return Some(with_exe);
            }
        }
    }
    None
}

/// Sidecar filename under `resources/` for a cross-target build.
pub fn sidecar_out_name(os_name: &str, arch: &str) -> String {
    if os_name == "win32" || os_name == "windows" {
        return "omp.exe".to_string();
    }
    if os_name == "linux" {
        return format!("omp.linux-{arch}");
    }
    if arch == "x64" {
        "omp.x64".to_string()
    } else {
        "omp".to_string()
    }
}

/// Directories a packaged build may hold the sidecar in, most specific first,
/// as Tauri's `resource_dir` computes them (`tauri-utils/src/platform.rs`) but
/// without a runtime: Linux bundles ship resources in `lib/<product name>`
/// beside `bin/` (the .deb's `/usr/lib/Sai ATLAS`, the AppImage's
/// `$APPDIR/usr/lib/Sai ATLAS`), macOS in `Contents/Resources`, Windows beside
/// the executable. The executable's own directory is always the last candidate.
/// `os_name` uses Node's names (`linux`, `darwin`, `win32`).
pub fn bundled_omp_candidates(os_name: &str, exe_dir: &Path, appdir: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if os_name == "linux" {
        dirs.push(normalize(&exe_dir.join("..").join("lib").join(product::PRODUCT_NAME)));
        if let Some(appdir) = appdir {
            dirs.push(appdir.join("usr").join("lib").join(product::PRODUCT_NAME));
        }
        dirs.push(Path::new("/usr/lib").join(product::PRODUCT_NAME));
    }
    if os_name == "darwin" {
        dirs.push(normalize(&exe_dir.join("..").join("Resources")));
    }
    dirs.push(exe_dir.to_path_buf());
    dirs
}

/// The packaged lookup over explicit directories, so tests can lay a bundle out in a temp dir.
pub fn resolve_bundled_omp_in(os_name: &str, exe_dir: &Path, appdir: Option<&Path>) -> Result<PathBuf, PathsError> {
    let filename = Path::new(bundled_omp_filename());
    let candidates = bundled_omp_candidates(os_name, exe_dir, appdir);
    for dir in &candidates {
        if let Some(found) = resolve_omp_candidate(&[dir, filename]) {
            return Ok(found);
        }
    }
    Err(PathsError::BundledOmpMissing(candidates.into_iter().map(|dir| dir.join(filename)).collect()))
}

/// The bundled sidecar: in the bundle's resource directory (or beside the
/// executable) in a packaged build, under `resources/` in development. A
/// packaged GUI never consults a system `omp`; a missing binary is an error.
pub fn resolve_bundled_omp() -> Result<PathBuf, PathsError> {
    #[cfg(feature = "e2e-hooks")]
    {
        if let Some(fixture) = e2e_sidecar_override(std::env::var_os("OMP_BUNDLED_OMP")) {
            return Ok(fixture);
        }
    }
    let filename = Path::new(bundled_omp_filename());
    if tauri::is_dev() {
        let dev_resources = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("resources");
        return resolve_omp_candidate(&[&dev_resources, filename])
            .ok_or_else(|| PathsError::BundledOmpMissing(vec![dev_resources.join(filename)]));
    }
    let exe = std::env::current_exe().map_err(PathsError::CurrentExe)?;
    let exe_dir = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    let appdir = std::env::var_os("APPDIR").filter(|value| !value.is_empty()).map(PathBuf::from);
    resolve_bundled_omp_in(crate::runtime_log::node_platform(), &exe_dir, appdir.as_deref())
}

/// `OMP_BUNDLED_OMP` names the e2e fixture sidecar, as it does for the Electron
/// specs. Only an `e2e-hooks` build reads it, so a shipped build always runs its
/// own bundled binary.
#[cfg(feature = "e2e-hooks")]
fn e2e_sidecar_override(value: Option<std::ffi::OsString>) -> Option<PathBuf> {
    value.filter(|value| !value.is_empty()).map(PathBuf::from).filter(|path| path.is_file())
}

/// GUI-owned workspace for Work mode (`<agent dir>/../work`). It runs the full agent, never `--chat`.
pub fn ensure_default_workspace() -> std::io::Result<PathBuf> {
    let cwd = normalize(&agent_dir().join("..").join("work"));
    std::fs::create_dir_all(&cwd)?;
    Ok(cwd)
}

/// Whether `path` names an existing directory.
pub fn is_existing_directory(path: &str) -> bool {
    std::fs::metadata(path).map(|meta| meta.is_dir()).unwrap_or(false)
}

/// The first candidate that is a real directory. The volume root is never an
/// answer: launched from a file manager a process cwd *is* "/", and a session
/// started there runs outside every project.
pub fn first_usable_cwd(candidates: &[Option<&str>], directory_exists: impl Fn(&str) -> bool) -> Option<String> {
    for candidate in candidates.iter().flatten() {
        if candidate.is_empty() || *candidate == "/" {
            continue;
        }
        if directory_exists(candidate) {
            return Some((*candidate).to_string());
        }
    }
    None
}

/// `first_usable_cwd` with the real filesystem.
pub fn initial_cwd(candidates: &[Option<&str>]) -> Option<String> {
    first_usable_cwd(candidates, is_existing_directory)
}

/// The single-instance id for a profile: the app id for the default profile
/// (`None`), otherwise the app id plus a hash of the resolved profile path, so
/// throwaway profiles never hand off to the user's running app.
pub fn single_instance_id_for(profile: Option<&Path>) -> String {
    match profile {
        None => product::APP_ID.to_string(),
        Some(path) => {
            let digest = Sha256::digest(path.to_string_lossy().as_bytes());
            format!("{}.p{}", product::APP_ID, &hex::encode(digest)[..16])
        }
    }
}

/// The single-instance id for this process's profile.
pub fn single_instance_id() -> String {
    let profile = if is_default_profile() { None } else { Some(user_data_dir()) };
    single_instance_id_for(profile)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PACKAGE_JSON: &str = include_str!("../../package.json");

    fn package() -> serde_json::Value {
        serde_json::from_str(PACKAGE_JSON).unwrap()
    }

    #[test]
    fn keeps_the_directory_every_0_9_x_release_derived_from_package_json_name() {
        let app_data = Path::new("/profiles/appData");
        let name = package()["name"].as_str().unwrap().to_string();
        assert_eq!(user_data_directory(app_data, ""), app_data.join(&name));
        assert_eq!(user_data_directory(app_data, ""), app_data.join("@oh-my-pi").join("omp-gui"));
    }

    #[test]
    fn lets_an_explicit_user_data_dir_win() {
        let app_data = Path::new("/profiles/appData");
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(user_data_directory(app_data, "relative/profile"), cwd.join("relative/profile"));
        assert_eq!(user_data_directory(app_data, "/tmp/p"), PathBuf::from("/tmp/p"));
        assert_eq!(user_data_directory(app_data, "/tmp/a/../p"), PathBuf::from("/tmp/p"));
    }

    #[test]
    fn reads_the_switch_in_both_forms() {
        let argv = |items: &[&str]| items.iter().map(|item| item.to_string()).collect::<Vec<_>>();
        assert_eq!(user_data_dir_switch(&argv(&["app", "--user-data-dir=/tmp/x"])), Some("/tmp/x".into()));
        assert_eq!(user_data_dir_switch(&argv(&["app", "--user-data-dir", "/tmp/y"])), Some("/tmp/y".into()));
        assert_eq!(user_data_dir_switch(&argv(&["app", "omp://new"])), None);
    }

    #[test]
    fn resolving_the_default_profile_inside_a_test_is_refused() {
        // The guard that keeps `cargo test` out of the user's real profile: every
        // entry point that would resolve it fails the test instead.
        assert!(std::panic::catch_unwind(user_data_dir).is_err());
        assert!(std::panic::catch_unwind(runtime_log_path).is_err());
        assert!(std::panic::catch_unwind(is_default_profile).is_err());
        assert!(std::panic::catch_unwind(single_instance_id).is_err());
    }

    #[test]
    fn uses_the_host_sidecar_filename() {
        assert_eq!(bundled_omp_filename(), if cfg!(windows) { "omp.exe" } else { "omp" });
    }

    #[test]
    fn gives_every_packaged_platform_its_own_sidecar_file() {
        assert_eq!(sidecar_out_name("darwin", "arm64"), "omp");
        assert_eq!(sidecar_out_name("darwin", "x64"), "omp.x64");
        assert_eq!(sidecar_out_name("win32", "x64"), "omp.exe");
        assert_eq!(sidecar_out_name("windows", "x64"), "omp.exe");
        assert_eq!(sidecar_out_name("linux", "x64"), "omp.linux-x64");
    }

    #[test]
    fn builds_the_linux_sidecar_through_its_own_script() {
        let scripts = package()["scripts"].clone();
        assert_eq!(
            scripts["build:omp:linux"].as_str().unwrap(),
            "bun scripts/build-bundled-omp.ts --target bun-linux-x64-baseline"
        );
    }

    #[test]
    fn finds_the_sidecar_in_the_deb_resource_dir() {
        let root = tempfile::tempdir().unwrap();
        let exe_dir = root.path().join("usr").join("bin");
        let lib = root.path().join("usr").join("lib").join(product::PRODUCT_NAME);
        std::fs::create_dir_all(&exe_dir).unwrap();
        std::fs::create_dir_all(&lib).unwrap();
        std::fs::write(lib.join(bundled_omp_filename()), b"").unwrap();
        // A system `omp` beside the executable never shadows the bundled one.
        std::fs::write(exe_dir.join(bundled_omp_filename()), b"").unwrap();
        assert_eq!(resolve_bundled_omp_in("linux", &exe_dir, None).unwrap(), lib.join(bundled_omp_filename()));
    }

    #[test]
    fn finds_the_sidecar_in_the_appimage_resource_dir() {
        let root = tempfile::tempdir().unwrap();
        let appdir = root.path().join("squashfs-root");
        // The executable runs from a location whose `../lib` holds nothing, so only `APPDIR` leads to the bundle.
        let exe_dir = root.path().join("elsewhere");
        let lib = appdir.join("usr").join("lib").join(product::PRODUCT_NAME);
        std::fs::create_dir_all(&exe_dir).unwrap();
        std::fs::create_dir_all(&lib).unwrap();
        std::fs::write(lib.join(bundled_omp_filename()), b"").unwrap();
        assert_eq!(resolve_bundled_omp_in("linux", &exe_dir, Some(&appdir)).unwrap(), lib.join(bundled_omp_filename()));
        let candidates = bundled_omp_candidates("linux", &exe_dir, Some(&appdir));
        assert_eq!(candidates[1], lib);
        assert_eq!(candidates.last(), Some(&exe_dir));
    }

    #[test]
    #[cfg(feature = "e2e-hooks")]
    fn an_e2e_build_runs_the_fixture_sidecar_it_is_given() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = dir.path().join("sidecar-fixture.ts");
        std::fs::write(&fixture, "").unwrap();
        assert_eq!(e2e_sidecar_override(Some(fixture.clone().into_os_string())), Some(fixture));
        assert_eq!(e2e_sidecar_override(Some(dir.path().join("missing").into_os_string())), None);
        assert_eq!(e2e_sidecar_override(Some(dir.path().to_path_buf().into_os_string())), None);
        assert_eq!(e2e_sidecar_override(Some(std::ffi::OsString::new())), None);
        assert_eq!(e2e_sidecar_override(None), None);
    }

    #[test]
    fn falls_back_to_the_executable_dir_and_errors_when_nothing_is_bundled() {
        let root = tempfile::tempdir().unwrap();
        let exe_dir = root.path().join("bin");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let missing = resolve_bundled_omp_in("linux", &exe_dir, None).unwrap_err();
        assert!(matches!(missing, PathsError::BundledOmpMissing(_)));
        let message = missing.to_string();
        assert!(message.contains(product::PRODUCT_NAME) && message.contains(&exe_dir.display().to_string()), "{message}");
        std::fs::write(exe_dir.join(bundled_omp_filename()), b"").unwrap();
        assert_eq!(resolve_bundled_omp_in("linux", &exe_dir, None).unwrap(), exe_dir.join(bundled_omp_filename()));
        assert_eq!(bundled_omp_candidates("darwin", Path::new("/Apps/X.app/Contents/MacOS"), None), vec![
            PathBuf::from("/Apps/X.app/Contents/Resources"),
            PathBuf::from("/Apps/X.app/Contents/MacOS"),
        ]);
        assert_eq!(bundled_omp_candidates("win32", Path::new("C:/Apps/X"), None), vec![PathBuf::from("C:/Apps/X")]);
    }

    #[test]
    fn skips_the_volume_root_which_is_what_a_finder_launch_reports_as_cwd() {
        let exists = |_: &str| true;
        assert_eq!(first_usable_cwd(&[Some("/"), Some("/Users/me/work")], exists), Some("/Users/me/work".into()));
        assert_eq!(first_usable_cwd(&[Some("/")], exists), None);
    }

    #[test]
    fn drops_a_remembered_project_that_no_longer_exists() {
        let exists = |candidate: &str| candidate != "/gone/project";
        assert_eq!(first_usable_cwd(&[Some("/gone/project"), Some("/tmp/fallback")], exists), Some("/tmp/fallback".into()));
    }

    #[test]
    fn keeps_the_caller_s_priority_order_for_the_directories_it_is_given() {
        let dir = tempfile::tempdir().unwrap();
        let recent = dir.path().join("recent");
        std::fs::create_dir(&recent).unwrap();
        let gone = dir.path().join("gone");
        let recent_str = recent.to_string_lossy().to_string();
        let gone_str = gone.to_string_lossy().to_string();
        // The real predicate is the default, so an existing directory is taken and a missing one is not.
        assert_eq!(initial_cwd(&[None, Some(&recent_str), Some(&gone_str)]), Some(recent_str.clone()));
    }

    #[test]
    fn derives_a_profile_specific_single_instance_id() {
        assert_eq!(single_instance_id_for(None), product::APP_ID);
        let id = single_instance_id_for(Some(Path::new("/tmp/profile")));
        assert!(id.starts_with("vn.io.vif.saiatlas.p"));
        assert_eq!(id.len(), product::APP_ID.len() + 18);
        assert_eq!(id, single_instance_id_for(Some(Path::new("/tmp/profile"))), "deterministic");
        assert_ne!(id, single_instance_id_for(Some(Path::new("/tmp/other"))));
        let digest = Sha256::digest(b"/tmp/profile");
        assert_eq!(id, format!("{}.p{}", product::APP_ID, &hex::encode(digest)[..16]));
    }
}
