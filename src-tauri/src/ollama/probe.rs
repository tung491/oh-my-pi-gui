//! Is the local Ollama daemon answering, and if not, is it installed? The
//! stopped/absent split follows sai-welcome (`welcome/backend/ollama.go`).

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::process::Command;

const SYSTEMCTL_TIMEOUT_MS: u64 = 1_000;
pub const PROBE_TIMEOUT_MS: u64 = 1_500;

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// The closed set of privileged fixes the renderer may ask for. Main owns the
/// command each id runs; the renderer can only name an id, never send a command.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OllamaRemedyId {
    LinuxStart,
    LinuxInstall,
}

/// `ok` answers on its HTTP API; `stopped` is installed but silent; `absent` is not installed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OllamaState {
    Ok,
    Stopped,
    Absent,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaStatus {
    pub state: OllamaState,
    /// The endpoint probed, resolved like the agent does (`OLLAMA_BASE_URL` / `OLLAMA_HOST`).
    pub base_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub model_count: u32,
    pub installed_tags: Vec<String>,
    pub platform: String,
    /// The remedy that fits this state and platform, or `None` when none applies.
    pub remedy: Option<OllamaRemedyId>,
    /// Last probe or remedy failure, for diagnostics.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fault: Option<String>,
}

/// The installation checks behind the stopped/absent decision; injectable for tests.
pub struct InstallChecks {
    /// `systemctl cat ollama.service` succeeds.
    pub systemd_unit: Arc<dyn Fn() -> BoxFuture<bool> + Send + Sync>,
    /// An executable named `name` is on the login-shell PATH (`which`).
    pub on_path: Arc<dyn Fn(String) -> BoxFuture<bool> + Send + Sync>,
    pub exists: Arc<dyn Fn(&Path) -> bool + Send + Sync>,
}

async fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match tokio::fs::metadata(path).await {
            Ok(meta) => meta.is_file() && meta.permissions().mode() & 0o111 != 0,
            Err(_) => false,
        }
    }
    #[cfg(not(unix))]
    {
        tokio::fs::metadata(path).await.map(|meta| meta.is_file()).unwrap_or(false)
    }
}

/// Default install checks: `systemctl`, PATH lookup through the given directories, and `Path::exists`.
pub fn default_install_checks(path_dirs: impl Fn() -> BoxFuture<String> + Send + Sync + 'static) -> InstallChecks {
    let path_dirs = Arc::new(path_dirs);
    InstallChecks {
        systemd_unit: Arc::new(|| {
            Box::pin(async {
                let output = tokio::time::timeout(
                    Duration::from_millis(SYSTEMCTL_TIMEOUT_MS),
                    Command::new("systemctl").args(["cat", "ollama.service"]).stdin(Stdio::null()).output(),
                )
                .await;
                matches!(output, Ok(Ok(out)) if out.status.success())
            })
        }),
        on_path: Arc::new(move |name| {
            let path_dirs = path_dirs.clone();
            Box::pin(async move {
                let path = (path_dirs)().await;
                for dir in path.split(if cfg!(windows) { ';' } else { ':' }).filter(|d| !d.is_empty()) {
                    if is_executable(&PathBuf::from(dir).join(&name)).await {
                        return true;
                    }
                }
                false
            })
        }),
        exists: Arc::new(|path| path.exists()),
    }
}

pub struct InstallFacts {
    pub installed: bool,
    /// Linux only: an `ollama.service` unit exists, so `systemctl start` can work.
    pub systemd_unit: bool,
}

/// Whether Ollama is installed though not answering, and how it was installed.
pub async fn detect_ollama_install(platform: &str, checks: &InstallChecks, local_app_data: Option<&str>) -> InstallFacts {
    match platform {
        "linux" => {
            let systemd_unit = (checks.systemd_unit)().await;
            let installed = systemd_unit || (checks.on_path)("ollama".to_string()).await;
            InstallFacts { installed, systemd_unit }
        }
        "darwin" => {
            let installed = (checks.exists)(Path::new("/Applications/Ollama.app")) || (checks.on_path)("ollama".to_string()).await;
            InstallFacts { installed, systemd_unit: false }
        }
        "win32" => {
            let installed = local_app_data
                .map(|dir| (checks.exists)(&PathBuf::from(dir).join("Programs").join("Ollama").join("ollama.exe")))
                .unwrap_or(false);
            InstallFacts { installed, systemd_unit: false }
        }
        _ => InstallFacts { installed: (checks.on_path)("ollama".to_string()).await, systemd_unit: false },
    }
}

/// Whether Ollama is installed though not answering.
#[cfg(test)]
pub async fn is_ollama_installed(platform: &str, checks: &InstallChecks, local_app_data: Option<&str>) -> bool {
    detect_ollama_install(platform, checks, local_app_data).await.installed
}

/// The one-click fix for a state, Linux only. Starting needs the systemd unit:
/// a binary or tarball install on PATH has none, and `systemctl start` could
/// only fail after asking for the root password, so it gets no button.
pub fn remedy_for(state: OllamaState, platform: &str, systemd_unit: bool) -> Option<OllamaRemedyId> {
    if platform != "linux" {
        return None;
    }
    match state {
        OllamaState::Stopped => systemd_unit.then_some(OllamaRemedyId::LinuxStart),
        OllamaState::Absent => Some(OllamaRemedyId::LinuxInstall),
        OllamaState::Ok => None,
    }
}

/// Tag names from `/api/tags` (`{ models: [{ name }] }`); rows without a string name are skipped.
pub fn parse_tags(body: &Value) -> Result<Vec<String>, String> {
    let models = body.get("models").and_then(Value::as_array).ok_or("/api/tags returned an unexpected shape")?;
    Ok(models
        .iter()
        .filter_map(|row| row.get("name").and_then(Value::as_str))
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect())
}

pub fn fault_text(error: &(dyn std::error::Error + 'static)) -> String {
    match error.source() {
        Some(cause) => format!("{error}: {cause}"),
        None => error.to_string(),
    }
}

async fn get_json(client: &reqwest::Client, url: &str, timeout: Duration) -> Result<Value, String> {
    let response = client.get(url).timeout(timeout).send().await.map_err(|error| fault_text(&error))?;
    if !response.status().is_success() {
        return Err(format!("{url} answered HTTP {}", response.status().as_u16()));
    }
    response.json::<Value>().await.map_err(|error| fault_text(&error))
}

/// Probe `/api/version` and `/api/tags`; never hangs the caller past `timeout_ms`.
pub async fn probe_ollama(
    base_url: &str,
    platform: &str,
    checks: &InstallChecks,
    timeout_ms: u64,
    local_app_data: Option<&str>,
) -> OllamaStatus {
    let timeout = Duration::from_millis(timeout_ms);
    let client = reqwest::Client::new();
    let version_url = format!("{base_url}/api/version");
    let tags_url = format!("{base_url}/api/tags");
    let result: Result<(Value, Value), String> = async {
        let (version, tags) =
            tokio::join!(get_json(&client, &version_url, timeout), get_json(&client, &tags_url, timeout));
        Ok((version?, tags?))
    }
    .await;

    match result {
        Ok((version, tags)) => match parse_tags(&tags) {
            Ok(installed_tags) => OllamaStatus {
                state: OllamaState::Ok,
                base_url: base_url.to_string(),
                version: version.get("version").and_then(Value::as_str).map(str::to_string),
                model_count: installed_tags.len() as u32,
                installed_tags,
                platform: platform.to_string(),
                remedy: None,
                fault: None,
            },
            Err(fault) => absent_or_stopped(base_url, platform, checks, local_app_data, fault).await,
        },
        Err(fault) => absent_or_stopped(base_url, platform, checks, local_app_data, fault).await,
    }
}

async fn absent_or_stopped(
    base_url: &str,
    platform: &str,
    checks: &InstallChecks,
    local_app_data: Option<&str>,
    fault: String,
) -> OllamaStatus {
    let facts = detect_ollama_install(platform, checks, local_app_data).await;
    let state = if facts.installed { OllamaState::Stopped } else { OllamaState::Absent };
    OllamaStatus {
        state,
        base_url: base_url.to_string(),
        version: None,
        model_count: 0,
        installed_tags: Vec::new(),
        platform: platform.to_string(),
        remedy: remedy_for(state, platform, facts.systemd_unit),
        fault: Some(fault),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ollama::test_fake_ollama::{closed_port_url, send_json, start_fake_ollama};

    fn checks(unit: bool, path: bool, files: Vec<&'static str>) -> InstallChecks {
        InstallChecks {
            systemd_unit: Arc::new(move || Box::pin(async move { unit })),
            on_path: Arc::new(move |_name| Box::pin(async move { path })),
            exists: Arc::new(move |p| files.iter().any(|f| Path::new(f) == p)),
        }
    }

    #[tokio::test]
    async fn reports_ok_with_the_version_and_installed_tags() {
        let fake = start_fake_ollama(|req, body| {
            if req == "/api/version" {
                return send_json(serde_json::json!({ "version": "0.12.3" }), 200);
            }
            if req == "/api/tags" {
                return send_json(serde_json::json!({ "models": [{ "name": "qwen3:4b" }, { "name": "gpt-oss:20b" }, {}] }), 200);
            }
            let _ = body;
            send_json(serde_json::json!({ "error": "not found" }), 404)
        })
        .await;
        let status = probe_ollama(&fake.url, "linux", &checks(false, false, vec![]), PROBE_TIMEOUT_MS, None).await;
        assert_eq!(
            status,
            OllamaStatus {
                state: OllamaState::Ok,
                base_url: fake.url.clone(),
                version: Some("0.12.3".to_string()),
                model_count: 2,
                installed_tags: vec!["qwen3:4b".to_string(), "gpt-oss:20b".to_string()],
                platform: "linux".to_string(),
                remedy: None,
                fault: None,
            }
        );
    }

    #[tokio::test]
    async fn reports_stopped_with_the_start_remedy_when_the_systemd_unit_exists_but_nothing_answers() {
        let url = closed_port_url().await;
        let status = probe_ollama(&url, "linux", &checks(true, false, vec![]), PROBE_TIMEOUT_MS, None).await;
        assert_eq!(status.state, OllamaState::Stopped);
        assert_eq!(status.remedy, Some(OllamaRemedyId::LinuxStart));
        assert!(status.fault.is_some());
        assert!(status.installed_tags.is_empty());
    }

    #[tokio::test]
    async fn reports_stopped_with_no_start_remedy_when_only_the_binary_is_on_path() {
        let url = closed_port_url().await;
        let status = probe_ollama(&url, "linux", &checks(false, true, vec![]), PROBE_TIMEOUT_MS, None).await;
        assert_eq!(status.state, OllamaState::Stopped);
        assert_eq!(status.remedy, None);
    }

    #[tokio::test]
    async fn reports_absent_with_the_install_remedy_when_nothing_is_installed() {
        let url = closed_port_url().await;
        let status = probe_ollama(&url, "linux", &checks(false, false, vec![]), PROBE_TIMEOUT_MS, None).await;
        assert_eq!(status.state, OllamaState::Absent);
        assert_eq!(status.remedy, Some(OllamaRemedyId::LinuxInstall));
    }

    #[tokio::test]
    async fn offers_no_remedy_off_linux() {
        let url = closed_port_url().await;
        let status = probe_ollama(&url, "darwin", &checks(false, false, vec![]), PROBE_TIMEOUT_MS, None).await;
        assert_eq!(status.state, OllamaState::Absent);
        assert_eq!(status.remedy, None);
        assert_eq!(status.platform, "darwin");
    }

    #[tokio::test]
    async fn treats_a_daemon_that_never_answers_as_down_within_the_timeout() {
        let fake = start_fake_ollama(|_req, _body| None).await;
        let started = std::time::Instant::now();
        let status = probe_ollama(&fake.url, "linux", &checks(true, false, vec![]), 100, None).await;
        assert_eq!(status.state, OllamaState::Stopped);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn treats_a_malformed_tags_body_as_down() {
        let fake = start_fake_ollama(|req, _body| {
            if req == "/api/version" {
                return send_json(serde_json::json!({ "version": "1" }), 200);
            }
            send_json(serde_json::json!({ "nope": true }), 200)
        })
        .await;
        let status = probe_ollama(&fake.url, "linux", &checks(false, false, vec![]), PROBE_TIMEOUT_MS, None).await;
        assert_eq!(status.state, OllamaState::Absent);
    }

    #[tokio::test]
    async fn tells_a_systemd_install_from_a_binary_on_path_on_linux() {
        let facts = detect_ollama_install("linux", &checks(true, false, vec![]), None).await;
        assert!(facts.installed);
        assert!(facts.systemd_unit);
        let facts = detect_ollama_install("linux", &checks(false, true, vec![]), None).await;
        assert!(facts.installed);
        assert!(!facts.systemd_unit);
        assert!(!is_ollama_installed("linux", &checks(false, false, vec![]), None).await);
    }

    #[tokio::test]
    async fn checks_the_macos_app_bundle() {
        assert!(is_ollama_installed("darwin", &checks(false, false, vec!["/Applications/Ollama.app"]), None).await);
        assert!(!is_ollama_installed("darwin", &checks(false, false, vec![]), None).await);
    }

    #[tokio::test]
    async fn checks_the_windows_per_user_install() {
        let exe = "C:\\Users\\u\\AppData\\Local/Programs/Ollama/ollama.exe";
        let files = [exe];
        assert!(is_ollama_installed("win32", &checks(false, false, files.to_vec()), Some("C:\\Users\\u\\AppData\\Local")).await);
        assert!(!is_ollama_installed("win32", &checks(false, false, vec![]), None).await);
    }

    #[test]
    fn maps_linux_states_to_remedies() {
        assert_eq!(remedy_for(OllamaState::Ok, "linux", true), None);
        assert_eq!(remedy_for(OllamaState::Stopped, "linux", true), Some(OllamaRemedyId::LinuxStart));
        assert_eq!(remedy_for(OllamaState::Stopped, "linux", false), None);
        assert_eq!(remedy_for(OllamaState::Absent, "linux", false), Some(OllamaRemedyId::LinuxInstall));
        assert_eq!(remedy_for(OllamaState::Absent, "win32", false), None);
    }

    #[test]
    fn rejects_a_body_without_a_models_array() {
        assert!(parse_tags(&Value::Null).is_err());
        assert!(parse_tags(&serde_json::json!({ "models": "x" })).is_err());
    }
}
