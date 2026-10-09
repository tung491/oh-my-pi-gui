//! Login-shell environment resolution for GUI-spawned processes.
//!
//! A desktop-launched app inherits the session's bare environment, so the
//! PATH entries, provider API keys and `$VISUAL`/`$EDITOR` the user's rc files
//! export never reach the GUI. The login shell's env is dumped once between
//! marker lines (rc files may print arbitrary text), cached, merged *under*
//! the process env (an explicitly exported launch env always wins), and
//! degraded to a static PATH augmentation on any failure: resolution must
//! never block a spawn.
//!
//! Every function takes the process environment as a map, so tests control
//! `SHELL`, `HOME` and `PATH` without touching the real process environment.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;
use tokio::sync::OnceCell;

const PROBE_TIMEOUT: Duration = Duration::from_millis(4_000);
const BEGIN: &str = "__OMP_ENV_BEGIN__";
const END: &str = "__OMP_ENV_END__";

/// Keys that must never be overlaid from the shell probe.
const OVERLAY_DENYLIST: &[&str] = &[
    // Process identity / launch context owned by the app or the session.
    "HOME", "LOGNAME", "OLDPWD", "PWD", "SHELL", "SHLVL", "TMPDIR", "USER", "_",
    // Proxy resolution has its own precedence chain (GUI pref → inherited
    // env → system proxy); rc-file proxy exports must not bypass it.
    "ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "PI_PROXY", "all_proxy", "http_proxy", "https_proxy", "no_proxy",
    // They redirect omp's config away from what the assistant pack pins.
    "PI_CONFIG_FILES", "PI_CONFIG_DIR", "PI_CODING_AGENT_DIR",
    // Startup files a shell would source inside the pack tools' system programs.
    "BASH_ENV", "ENV",
];

/// The process environment as the module sees it.
pub(crate) type Env = HashMap<String, String>;

pub(crate) fn process_env() -> Env {
    std::env::vars().collect()
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct LoginShellEnv {
    /// Full parsed env from the login shell; empty when the probe failed.
    pub(crate) env: HashMap<String, String>,
    /// PATH exactly as the login shell computes it; `None` when the probe failed.
    pub(crate) path: Option<String>,
    /// `$VISUAL` or `$EDITOR` from the login shell; `None` when unset or the probe failed.
    pub(crate) editor: Option<String>,
}

fn non_empty(value: Option<&String>) -> Option<String> {
    value.map(|value| value.trim()).filter(|value| !value.is_empty()).map(str::to_string)
}

/// The env dump between the markers; `None` when either marker is missing.
fn parse_probe_output(stdout: &str) -> Option<LoginShellEnv> {
    let begin = stdout.find(BEGIN)?;
    let end = stdout.rfind(END)?;
    if end < begin {
        return None;
    }
    let mut env = HashMap::new();
    for line in stdout[begin + BEGIN.len()..end].split('\n') {
        let Some(eq) = line.find('=') else { continue };
        if eq == 0 {
            continue;
        }
        env.insert(line[..eq].to_string(), line[eq + 1..].to_string());
    }
    let path = non_empty(env.get("PATH"));
    let editor = non_empty(env.get("VISUAL")).or_else(|| non_empty(env.get("EDITOR")));
    Some(LoginShellEnv { env, path, editor })
}

/// Run `$SHELL -ilc` once with marker-delimited `env`; failure yields the empty result.
async fn probe_login_shell(env: &Env) -> LoginShellEnv {
    // Windows has no login-shell probe. Keep the inherited environment and add
    // the well-known per-user tool directories through `fallback_bin_dirs`.
    if cfg!(windows) {
        return LoginShellEnv::default();
    }
    let shell = env.get("SHELL").filter(|shell| !shell.is_empty()).cloned().unwrap_or_else(|| "/bin/zsh".to_string());
    // `command` bypasses rc aliases; the markers isolate rc chatter.
    let script = format!("command printf '%s\\n' '{BEGIN}'; command env; command printf '%s\\n' '{END}'");
    let mut command = Command::new(&shell);
    command.args(["-ilc", &script]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    let output = tokio::time::timeout(PROBE_TIMEOUT, command.output()).await;
    match output {
        Ok(Ok(output)) if output.status.success() => parse_probe_output(&String::from_utf8_lossy(&output.stdout)).unwrap_or_default(),
        _ => LoginShellEnv::default(),
    }
}

/// Probe once per process and cache the result; every caller of `spawn_env` shares it.
#[derive(Default)]
pub(crate) struct ShellEnvCache {
    cell: OnceCell<LoginShellEnv>,
}

impl ShellEnvCache {
    pub(crate) async fn resolve(&self, env: &Env) -> &LoginShellEnv {
        self.cell.get_or_init(|| probe_login_shell(env)).await
    }
}

/// Compare two `vX.Y.Z` directory names numerically (nvm version dirs).
fn compare_version_dirs(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |name: &str| -> Vec<u64> { name.trim_start_matches('v').split('.').map(|part| part.parse().unwrap_or(0)).collect() };
    let (pa, pb) = (parse(a), parse(b));
    for index in 0..3 {
        let diff = pa.get(index).copied().unwrap_or(0).cmp(&pb.get(index).copied().unwrap_or(0));
        if diff != std::cmp::Ordering::Equal {
            return diff;
        }
    }
    std::cmp::Ordering::Equal
}

fn home_dir(env: &Env) -> PathBuf {
    env.get("HOME").filter(|home| !home.is_empty()).map(PathBuf::from).or_else(dirs::home_dir).unwrap_or_else(|| PathBuf::from("."))
}

/// Existing well-known user bin dirs, used when the shell probe fails.
fn fallback_bin_dirs(env: &Env) -> Vec<PathBuf> {
    let home = home_dir(env);
    let mut candidates: Vec<PathBuf> = if cfg!(windows) {
        let local = env.get("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData").join("Local"));
        let roaming = env.get("APPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData").join("Roaming"));
        vec![
            home.join(".bun").join("bin"),
            home.join(".cargo").join("bin"),
            home.join(".local").join("bin"),
            local.join("Programs").join("bun"),
            roaming.join("npm"),
            local.join("Microsoft").join("WindowsApps"),
        ]
    } else {
        vec![
            home.join(".local").join("bin"),
            home.join(".bun").join("bin"),
            home.join("bin"),
            home.join(".cargo").join("bin"),
            home.join(".volta").join("bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ]
    };
    if !cfg!(windows) {
        // nvm keeps no stable "current" symlink; take the newest installed node.
        let nvm_dir = home.join(".nvm").join("versions").join("node");
        if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
            let mut versions: Vec<String> = entries.flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).filter(|name| name.starts_with('v')).collect();
            versions.sort_by(|a, b| compare_version_dirs(a, b));
            if let Some(newest) = versions.last() {
                candidates.push(nvm_dir.join(newest).join("bin"));
            }
        }
    }
    candidates.into_iter().filter(|dir| dir.is_dir()).collect()
}

fn path_delimiter() -> char {
    if cfg!(windows) {
        ';'
    } else {
        ':'
    }
}

fn split_path(value: &str) -> impl Iterator<Item = &str> {
    value.split(path_delimiter()).filter(|entry| !entry.is_empty())
}

/// Merge inherited PATH entries (the explicit launch env wins order) with the
/// probed login-shell PATH, or the static fallback when probing failed.
pub(crate) fn spawn_path(env: &Env, probed: &LoginShellEnv) -> String {
    let mut seen = HashSet::new();
    let mut merged: Vec<String> = Vec::new();
    let inherited = env.get("PATH").map(String::as_str).unwrap_or("");
    let fallback: Vec<String> = match &probed.path {
        Some(_) => Vec::new(),
        None => fallback_bin_dirs(env).iter().map(|dir| dir.to_string_lossy().into_owned()).collect(),
    };
    let extra: Vec<&str> = match &probed.path {
        Some(path) => split_path(path).collect(),
        None => fallback.iter().map(String::as_str).collect(),
    };
    for entry in split_path(inherited).chain(extra) {
        if seen.insert(entry.to_string()) {
            merged.push(entry.to_string());
        }
    }
    merged.join(&path_delimiter().to_string())
}

/// Env overlay for sidecar spawns: every probed shell var the process lacks
/// (API keys, locale, tool config) plus the merged PATH. Keys the launch env
/// already defines win: an exported terminal env always beats rc files.
pub(crate) fn shell_spawn_env(env: &Env, probed: &LoginShellEnv) -> HashMap<String, String> {
    let mut overlay = HashMap::new();
    for (key, value) in &probed.env {
        if OVERLAY_DENYLIST.contains(&key.as_str()) || key == "PATH" || env.contains_key(key) {
            continue;
        }
        overlay.insert(key.clone(), value.clone());
    }
    overlay.insert("PATH".to_string(), spawn_path(env, probed));
    overlay
}

/// Editor command from the process env, falling back to the login shell's `$VISUAL`/`$EDITOR`.
pub(crate) fn resolve_editor_command(env: &Env, probed: &LoginShellEnv) -> Option<String> {
    if let Some(configured) = non_empty(env.get("VISUAL")).or_else(|| non_empty(env.get("EDITOR"))) {
        return Some(configured);
    }
    if cfg!(windows) {
        return Some("notepad".to_string());
    }
    probed.editor.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::omp::manager::SidecarManager;
    use crate::ports::{SessionKind, SidecarEvent, SidecarHandle, SidecarOptions, SidecarStatus};
    use std::path::Path;
    use std::sync::{Arc, Weak};

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs.iter().map(|(key, value)| (key.to_string(), value.to_string())).collect()
    }

    /// Fake login shell: optional rc noise around a marker-wrapped `env` dump.
    fn write_fake_shell(dir: &Path, entries: &[(&str, &str)], noisy: bool) -> String {
        let mut body = String::from("#!/bin/sh\n");
        if noisy {
            body.push_str("printf 'rc-banner-noise\\n'\n");
        }
        body.push_str("printf '%s\\n' '__OMP_ENV_BEGIN__'\n");
        for (key, value) in entries {
            body.push_str(&format!("printf '%s=%s\\n' '{key}' '{value}'\n"));
        }
        body.push_str("printf '%s\\n' '__OMP_ENV_END__'\n");
        if noisy {
            body.push_str("printf 'trailing-noise\\n'\n");
        }
        let path = dir.join("fake-shell");
        crate::omp::test_support::write_executable(&path, &body);
        path.to_string_lossy().into_owned()
    }

    fn no_such_shell() -> String {
        std::env::temp_dir().join("omp-no-such-shell").to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn extracts_the_env_dump_between_markers_even_when_the_rc_file_prints_noise() {
        let dir = tempfile::tempdir().unwrap();
        let shell = write_fake_shell(dir.path(), &[("PATH", "/probed/bin:/usr/bin"), ("VISUAL", "probed-editor"), ("PROBED_ONLY_KEY", "k1")], true);
        let cache = ShellEnvCache::default();
        let result = cache.resolve(&env(&[("SHELL", &shell)])).await;
        assert_eq!(result.path.as_deref(), Some("/probed/bin:/usr/bin"));
        assert_eq!(result.editor.as_deref(), Some("probed-editor"));
        assert_eq!(result.env.get("PROBED_ONLY_KEY").map(String::as_str), Some("k1"));
    }

    #[tokio::test]
    async fn degrades_to_empty_fields_when_the_shell_probe_fails() {
        let cache = ShellEnvCache::default();
        let result = cache.resolve(&env(&[("SHELL", &no_such_shell())])).await;
        assert_eq!(*result, LoginShellEnv { env: HashMap::new(), path: None, editor: None });
    }

    #[tokio::test]
    async fn puts_inherited_path_entries_first_and_appends_the_probed_shell_path() {
        let dir = tempfile::tempdir().unwrap();
        let shell = write_fake_shell(dir.path(), &[("PATH", "/probed/bin")], false);
        let env = env(&[("SHELL", &shell), ("PATH", "/inherited/bin:/usr/bin")]);
        let probed = ShellEnvCache::default().resolve(&env).await.clone();
        let result = spawn_path(&env, &probed);
        assert!(result.starts_with("/inherited/bin:/usr/bin"));
        assert!(result.split(':').any(|entry| entry == "/probed/bin"));
    }

    #[tokio::test]
    async fn falls_back_to_existing_well_known_user_bin_dirs_when_the_probe_fails() {
        let home = tempfile::tempdir().unwrap();
        let home_bin = home.path().join(".local").join("bin");
        std::fs::create_dir_all(&home_bin).unwrap();
        assert!(home_bin.is_dir());
        let env = env(&[("SHELL", &no_such_shell()), ("HOME", &home.path().to_string_lossy()), ("PATH", "/usr/bin")]);
        let probed = ShellEnvCache::default().resolve(&env).await.clone();
        let result = spawn_path(&env, &probed);
        let entries: Vec<&str> = result.split(':').collect();
        assert_eq!(entries[0], "/usr/bin");
        assert!(entries.contains(&home_bin.to_string_lossy().as_ref()));
        assert!(!entries.contains(&home.path().join("bin").to_string_lossy().as_ref()));
    }

    #[tokio::test]
    async fn overlays_shell_only_keys_rc_exported_api_keys_but_never_keys_the_launch_env_defines() {
        let dir = tempfile::tempdir().unwrap();
        let shell = write_fake_shell(
            dir.path(),
            &[
                ("PATH", "/probed/bin"),
                ("SHELL_ONLY_API_KEY", "from-rc"),
                ("LAUNCH_WINS_KEY", "from-rc"),
                ("HTTPS_PROXY", "rc-proxy-must-not-leak"),
                ("PWD", "/rc/pwd/must/not/leak"),
            ],
            false,
        );
        let env = env(&[("SHELL", &shell), ("LAUNCH_WINS_KEY", "from-launch"), ("PATH", "/usr/bin")]);
        let probed = ShellEnvCache::default().resolve(&env).await.clone();
        let overlay = shell_spawn_env(&env, &probed);
        assert_eq!(overlay.get("SHELL_ONLY_API_KEY").map(String::as_str), Some("from-rc"));
        assert_eq!(overlay.get("LAUNCH_WINS_KEY"), None);
        assert_eq!(overlay.get("HTTPS_PROXY"), None);
        assert_eq!(overlay.get("PWD"), None);
        assert!(overlay["PATH"].split(':').any(|entry| entry == "/probed/bin"));
    }

    #[tokio::test]
    async fn drops_pi_config_files_pi_config_dir_pi_coding_agent_dir_bash_env_and_env_from_the_login_shell_overlay() {
        let dir = tempfile::tempdir().unwrap();
        let redirects = ["PI_CONFIG_FILES", "PI_CONFIG_DIR", "PI_CODING_AGENT_DIR", "BASH_ENV", "ENV"];
        let values: Vec<String> = redirects.iter().map(|key| format!("/rc/{key}")).collect();
        let mut entries: Vec<(&str, &str)> = vec![("PATH", "/probed/bin"), ("SHELL_ONLY_API_KEY", "from-rc")];
        entries.extend(redirects.iter().copied().zip(values.iter().map(String::as_str)));
        let shell = write_fake_shell(dir.path(), &entries, false);
        let env = env(&[("SHELL", &shell), ("PATH", "/usr/bin")]);
        let probed = ShellEnvCache::default().resolve(&env).await.clone();
        let overlay = shell_spawn_env(&env, &probed);
        assert_eq!(overlay.get("SHELL_ONLY_API_KEY").map(String::as_str), Some("from-rc"));
        for key in redirects {
            assert_eq!(overlay.get(key), None, "{key}");
        }
    }

    #[tokio::test]
    async fn prefers_process_env_visual_over_the_login_shell_editor() {
        let probed = LoginShellEnv { editor: Some("probed-editor".into()), ..Default::default() };
        assert_eq!(resolve_editor_command(&env(&[("VISUAL", "explicit-editor")]), &probed).as_deref(), Some("explicit-editor"));
        assert_eq!(resolve_editor_command(&env(&[("EDITOR", " vim ")]), &probed).as_deref(), Some("vim"));
        assert_eq!(resolve_editor_command(&env(&[]), &probed).as_deref(), Some("probed-editor"));
        assert_eq!(resolve_editor_command(&env(&[]), &LoginShellEnv::default()), None);
    }

    /// The real sidecar fixture, which runs under the supervisor exactly like omp.
    fn fixture_path() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("e2e").join("sidecar-fixture.ts").canonicalize().unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn injects_the_shellenv_overlay_into_the_spawned_process() {
        let dir = tempfile::tempdir().unwrap();
        let inherited_path = std::env::var("PATH").unwrap_or_default();
        let overlay: HashMap<String, String> = [("PATH".to_string(), format!("/shell-probed:{inherited_path}")), ("PROBED_SHELL_KEY".to_string(), "present".to_string())].into_iter().collect();
        let options = SidecarOptions {
            binary_path: fixture_path(),
            cwd: dir.path().to_string_lossy().into_owned(),
            extra_flags: Vec::new(),
            packaged: false,
            fresh: false,
            kind: SessionKind::Agent,
            resume_session_path: None,
        };
        let (sidecar, mut events) = SidecarManager::new(Weak::new(), options, Arc::new(move || Box::pin(std::future::ready(overlay.clone()))));
        sidecar.start();
        let ready = tokio::time::timeout(Duration::from_secs(20), async {
            while let Some(event) = events.recv().await {
                if matches!(event, SidecarEvent::Status(ref payload) if payload.status == SidecarStatus::Ready) {
                    return true;
                }
            }
            false
        })
        .await;
        let pid = sidecar.omp_pid();
        let environ = pid.map(|pid| std::fs::read(format!("/proc/{pid}/environ")).unwrap_or_default()).unwrap_or_default();
        sidecar.dispose().await;
        assert_eq!(ready, Ok(true));
        let child_env: HashMap<String, String> = environ
            .split(|byte| *byte == 0)
            .filter_map(|entry| {
                let text = String::from_utf8_lossy(entry);
                let (key, value) = text.split_once('=')?;
                Some((key.to_string(), value.to_string()))
            })
            .collect();
        assert!(child_env.get("PATH").map(|path| path.starts_with("/shell-probed:")).unwrap_or(false), "PATH was {:?}", child_env.get("PATH"));
        assert_eq!(child_env.get("PROBED_SHELL_KEY").map(String::as_str), Some("present"));
    }
}
