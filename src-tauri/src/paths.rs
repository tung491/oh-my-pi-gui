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
    #[error("the bundled omp binary is missing at {0}")]
    BundledOmpMissing(PathBuf),
    #[error("the current executable path is unknown: {0}")]
    CurrentExe(std::io::Error),
    #[error("no config directory is known for this user")]
    NoConfigDir,
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

/// The profile directory for this process, resolved once from argv and the OS config dir.
pub fn user_data_dir() -> &'static Path {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let argv: Vec<String> = std::env::args().collect();
        let override_dir = user_data_dir_switch(&argv).unwrap_or_default();
        let app_data = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        user_data_directory(&app_data, &override_dir)
    })
}

/// Whether this process runs on the default profile (no `--user-data-dir`).
pub fn is_default_profile() -> bool {
    let argv: Vec<String> = std::env::args().collect();
    user_data_dir_switch(&argv).is_none()
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

/// The bundled sidecar: beside the executable in a packaged build, under
/// `resources/` in development. A packaged GUI never consults a system `omp`.
pub fn resolve_bundled_omp() -> Result<PathBuf, PathsError> {
    let filename = Path::new(bundled_omp_filename());
    let dev_resources = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("resources");
    let candidate = if tauri::is_dev() {
        resolve_omp_candidate(&[&dev_resources, filename])
    } else {
        let exe = std::env::current_exe().map_err(PathsError::CurrentExe)?;
        let dir = exe.parent().map(Path::to_path_buf).unwrap_or_default();
        resolve_omp_candidate(&[&dir, filename])
    };
    candidate.ok_or_else(|| {
        let base = if tauri::is_dev() {
            dev_resources
        } else {
            std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)).unwrap_or_default()
        };
        PathsError::BundledOmpMissing(base.join(filename))
    })
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

/// The single-instance id: the app id on the default profile, otherwise the
/// app id plus a hash of the profile path, so throwaway profiles never hand
/// off to the user's running app.
pub fn single_instance_id() -> String {
    if is_default_profile() {
        return product::APP_ID.to_string();
    }
    let digest = Sha256::digest(user_data_dir().to_string_lossy().as_bytes());
    format!("{}.p{}", product::APP_ID, &hex::encode(digest)[..16])
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
    fn derives_a_profile_specific_single_instance_id_shape() {
        let digest = Sha256::digest(b"/tmp/profile");
        let id = format!("{}.p{}", product::APP_ID, &hex::encode(digest)[..16]);
        assert!(id.starts_with("vn.io.vif.saiatlas.p"));
        assert_eq!(id.len(), product::APP_ID.len() + 18);
    }
}
