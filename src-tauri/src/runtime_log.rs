//! The GUI runtime crash log (`<profile>/logs/gui-runtime.jsonl`), ported from
//! `runtime-log-core.ts` and `runtime-log.ts`. Writes are synchronous and
//! bounded: a crash logger may be the last code that runs, and it must never
//! be the source of a second failure.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[cfg(not(test))]
use crate::paths;

const MAX_LOG_BYTES: u64 = 4 * 1024 * 1024;
const MAX_MESSAGE_LENGTH: usize = 8_192;
const MAX_STACK_LENGTH: usize = 32_768;
const MAX_URL_LENGTH: usize = 4_096;
const MAX_DETAIL_KEYS: usize = 24;
const MAX_DETAIL_VALUE_LENGTH: usize = 4_096;

/// Every `RuntimeErrorSource` the renderer and the shell may report (`src/shared/ipc-types.ts`).
pub const RUNTIME_ERROR_SOURCES: [&str; 18] = [
    "react-render",
    "react-uncaught",
    "react-recoverable",
    "window-error",
    "unhandled-rejection",
    "renderer-console",
    "renderer-load",
    "preload",
    "renderer-process",
    "renderer-unresponsive",
    "application-resources",
    "child-process",
    "main-uncaught",
    "main-unhandled-rejection",
    "global-shortcut",
    "notification",
    "quick-entry",
    "unknown",
];

/// The validated shape of a report (`RuntimeErrorReport` in `ipc-types.ts`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeErrorReport {
    pub source: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component_stack: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Map<String, Value>>,
}

/// Process context stamped on every line.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLogContext {
    pub app_version: String,
    pub platform: String,
    pub pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_id: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

fn bounded_string(value: Option<&Value>, max_length: usize) -> Option<String> {
    let text = value?.as_str()?;
    if text.chars().count() <= max_length {
        return Some(text.to_string());
    }
    let mut cut: String = text.chars().take(max_length).collect();
    cut.push('…');
    Some(cut)
}

fn finite_number(value: Option<&Value>) -> Option<f64> {
    value?.as_f64().filter(|number| number.is_finite())
}

fn source(value: Option<&Value>) -> String {
    match value.and_then(Value::as_str) {
        Some(text) if RUNTIME_ERROR_SOURCES.contains(&text) => text.to_string(),
        _ => "unknown".to_string(),
    }
}

fn details(value: Option<&Value>) -> Option<Map<String, Value>> {
    let input = value?.as_object()?;
    let mut output = Map::new();
    for (key, detail) in input.iter().take(MAX_DETAIL_KEYS) {
        match detail {
            Value::Null | Value::Number(_) | Value::Bool(_) => {
                output.insert(key.clone(), detail.clone());
            }
            Value::String(_) => {
                if let Some(text) = bounded_string(Some(detail), MAX_DETAIL_VALUE_LENGTH) {
                    output.insert(key.clone(), Value::String(text));
                }
            }
            _ => {}
        }
    }
    if output.is_empty() {
        None
    } else {
        Some(output)
    }
}

/// Validate and bound an IPC payload before it reaches disk.
pub fn normalize_runtime_error_report(value: &Value) -> RuntimeErrorReport {
    let input = value.as_object();
    let field = |name: &str| input.and_then(|map| map.get(name));
    RuntimeErrorReport {
        source: source(field("source")),
        message: bounded_string(field("message"), MAX_MESSAGE_LENGTH).unwrap_or_else(|| "Unknown runtime error".to_string()),
        stack: bounded_string(field("stack"), MAX_STACK_LENGTH),
        component_stack: bounded_string(field("componentStack"), MAX_STACK_LENGTH),
        url: bounded_string(field("url"), MAX_URL_LENGTH),
        line: finite_number(field("line")),
        column: finite_number(field("column")),
        details: details(field("details")),
    }
}

/// Append one bounded JSON line, rotating the file to `<path>.1` at 4 MiB.
/// Every failure is swallowed on purpose: a crash logger must not fail twice.
pub fn append_runtime_log_at_path(file_path: &Path, report: &Value, context: &RuntimeLogContext) {
    let _ = try_append(file_path, report, context);
}

fn try_append(file_path: &Path, report: &Value, context: &RuntimeLogContext) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(parent) = file_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::metadata(file_path) {
        Ok(meta) if meta.len() >= MAX_LOG_BYTES => {
            let mut archive = file_path.as_os_str().to_owned();
            archive.push(".1");
            let archive = PathBuf::from(archive);
            let _ = std::fs::remove_file(&archive);
            std::fs::rename(file_path, &archive)?;
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let mut entry = Map::new();
    entry.insert("timestamp".into(), Value::String(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)));
    if let Value::Object(context_map) = serde_json::to_value(context)? {
        entry.extend(context_map);
    }
    if let Value::Object(report_map) = serde_json::to_value(normalize_runtime_error_report(report))? {
        entry.extend(report_map);
    }
    let mut line = serde_json::to_vec(&Value::Object(entry))?;
    line.push(b'\n');
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(file_path)?;
    file.write_all(&line)
}

/// Node's platform name for this build (`process.platform` in Electron).
pub fn node_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win32"
    } else {
        "linux"
    }
}

/// A handle bound to one log file and the app version.
#[derive(Clone, Debug)]
pub struct RuntimeLog {
    path: PathBuf,
    app_version: String,
}

impl RuntimeLog {
    pub fn new(path: PathBuf, app_version: impl Into<String>) -> Self {
        Self { path, app_version: app_version.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Write `report` (any JSON; it is normalized) with process context.
    pub fn write(&self, report: &Value, window_id: Option<u32>, cwd: Option<&str>) {
        let context = RuntimeLogContext {
            app_version: self.app_version.clone(),
            platform: node_platform().to_string(),
            pid: std::process::id(),
            window_id,
            cwd: cwd.map(str::to_string),
        };
        append_runtime_log_at_path(&self.path, report, &context);
    }

    /// A shell-originated entry: `source`, `message` and flat `details`.
    pub fn note(&self, source: &str, message: impl Into<String>, details: Value) {
        let mut report = Map::new();
        report.insert("source".into(), Value::String(source.into()));
        report.insert("message".into(), Value::String(message.into()));
        if details.is_object() {
            report.insert("details".into(), details);
        }
        self.write(&Value::Object(report), None, None);
    }
}

static GLOBAL: OnceLock<RuntimeLog> = OnceLock::new();

/// Install the process-wide log. Later calls keep the first installation.
pub fn install(log: RuntimeLog) -> &'static RuntimeLog {
    GLOBAL.get_or_init(|| log)
}

/// The process-wide log, installed lazily at the profile's default path when
/// nothing installed one first (so a failure before setup still gets written).
/// That fallback carries the crate version, which may lag the bundle version
/// `run()` installs; only the Electron relaunch helper, which never reaches
/// `run()`, logs through it.
pub fn global() -> &'static RuntimeLog {
    GLOBAL.get_or_init(|| RuntimeLog::new(default_path(), env!("CARGO_PKG_VERSION")))
}

#[cfg(not(test))]
fn default_path() -> PathBuf {
    paths::runtime_log_path()
}

/// Tests never write into the user's real crash log: the process-wide log of a
/// test binary lands in a per-process file under the system temp directory.
#[cfg(test)]
fn default_path() -> PathBuf {
    std::env::temp_dir().join("sai-atlas-tests").join(format!("{}-gui-runtime.jsonl", std::process::id()))
}

/// Write a report through the process-wide log.
pub fn write(report: &Value, window_id: Option<u32>, cwd: Option<&str>) {
    global().write(report, window_id, cwd);
}

/// Write a shell-originated note through the process-wide log.
pub fn note(source: &str, message: impl Into<String>, details: Value) {
    global().note(source, message, details);
}

/// The process-wide log's path.
pub fn path() -> PathBuf {
    global().path().to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn context() -> RuntimeLogContext {
        RuntimeLogContext {
            app_version: "0.6.0".into(),
            platform: "darwin".into(),
            pid: 42,
            window_id: Some(7),
            cwd: Some("/project".into()),
        }
    }

    #[test]
    fn persists_a_renderer_failure_as_one_parseable_jsonl_record_with_process_context() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("nested").join("gui-runtime.jsonl");
        append_runtime_log_at_path(
            &file_path,
            &json!({
                "source": "react-render",
                "message": "render exploded",
                "stack": "Error: render exploded\n at Broken",
                "details": { "phase": "commit", "retryable": true }
            }),
            &context(),
        );
        let text = std::fs::read_to_string(&file_path).unwrap();
        let lines: Vec<&str> = text.trim().split('\n').collect();
        assert_eq!(lines.len(), 1);
        let entry: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(entry["appVersion"], "0.6.0");
        assert_eq!(entry["platform"], "darwin");
        assert_eq!(entry["pid"], 42);
        assert_eq!(entry["windowId"], 7);
        assert_eq!(entry["cwd"], "/project");
        assert_eq!(entry["source"], "react-render");
        assert_eq!(entry["message"], "render exploded");
        assert_eq!(entry["details"], json!({ "phase": "commit", "retryable": true }));
        assert!(entry["timestamp"].is_string());
    }

    #[test]
    fn bounds_untrusted_ipc_fields_and_discards_unsupported_detail_values() {
        let report = normalize_runtime_error_report(&json!({
            "source": "invented-source",
            "message": "x".repeat(20_000),
            "details": { "kept": 3, "nested": { "secret": true }, "list": [1] }
        }));
        assert_eq!(report.source, "unknown");
        assert!(report.message.chars().count() < 8_200);
        assert_eq!(report.details, Some(json!({ "kept": 3 }).as_object().unwrap().clone()));
    }

    #[test]
    fn preserves_packaged_resource_replacement_reports() {
        let report = normalize_runtime_error_report(&json!({
            "source": "application-resources",
            "message": "resource archive changed",
            "details": { "launchInode": 100, "currentInode": 101 }
        }));
        assert_eq!(report.source, "application-resources");
        assert_eq!(report.message, "resource archive changed");
        assert_eq!(report.details, Some(json!({ "launchInode": 100, "currentInode": 101 }).as_object().unwrap().clone()));
    }

    #[test]
    fn keeps_a_refused_global_shortcut_report_under_its_own_source() {
        assert_eq!(
            normalize_runtime_error_report(&json!({ "source": "global-shortcut", "message": "refused" })).source,
            "global-shortcut"
        );
    }

    #[test]
    fn keeps_notification_and_quick_entry_failures_under_their_own_sources() {
        assert_eq!(normalize_runtime_error_report(&json!({ "source": "notification", "message": "failed" })).source, "notification");
        assert_eq!(normalize_runtime_error_report(&json!({ "source": "quick-entry", "message": "failed" })).source, "quick-entry");
    }

    #[test]
    fn rotates_the_file_once_it_reaches_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("gui-runtime.jsonl");
        std::fs::write(&file_path, vec![b'x'; MAX_LOG_BYTES as usize]).unwrap();
        append_runtime_log_at_path(&file_path, &json!({ "source": "preload", "message": "after rotation" }), &context());
        assert_eq!(std::fs::metadata(dir.path().join("gui-runtime.jsonl.1")).unwrap().len(), MAX_LOG_BYTES);
        let text = std::fs::read_to_string(&file_path).unwrap();
        assert_eq!(text.lines().count(), 1);
        assert!(text.contains("after rotation"));
    }

    #[test]
    fn a_missing_message_becomes_the_unknown_placeholder() {
        let report = normalize_runtime_error_report(&json!("not an object"));
        assert_eq!(report.message, "Unknown runtime error");
        assert_eq!(report.source, "unknown");
        assert_eq!(report.details, None);
    }
}
