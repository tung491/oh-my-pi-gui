//! One-time removal of non-Ollama providers from the agent's `models.yml`,
//! ported from `provider-cleanup.ts`.
//!
//! The file is copied to `<name>.bak-<YYYYMMDD-HHmmss>` next to itself before
//! anything is deleted, and the copy's size is checked against the source, so
//! a user (or support) can always restore the previous config by copying the
//! backup back. Running again once only allowed providers remain is a no-op
//! that writes no backup.
//!
//! The handler this backs runs synchronously on its calling window's drain
//! loop (the bridge's per-window ordering, not Electron's single-threaded
//! event loop), so a second call already sees the cleaned file instead of
//! racing the first.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use chrono::{Datelike, NaiveDateTime, Timelike};
use regex::Regex;
use serde_yml::Value;

use super::models_config::{list_models_providers, models_path, ModelsConfigError};

/// Provider ids the GUI still offers. Mirrors `ALLOWED_PROVIDER_IDS` in
/// `src/shared/provider-policy.ts`; kept in sync by hand (one line to
/// re-enable a provider there and here).
const ALLOWED_PROVIDER_IDS: &[&str] = &["ollama"];

fn is_allowed_provider(id: &str) -> bool {
    ALLOWED_PROVIDER_IDS.contains(&id)
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProviderConfigCleanupResult {
    /// Where the previous `models.yml` was copied, or `None` when nothing needed removing.
    pub backup_path: Option<PathBuf>,
    /// Provider ids removed from `models.yml`.
    pub removed: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderCleanupError {
    #[error("{0}")]
    Config(#[from] ModelsConfigError),
    #[error("{0}")]
    Io(String),
    #[error("{0}")]
    Edit(String),
}

fn pad(value: u32) -> String {
    format!("{value:02}")
}

/// Local-time `YYYYMMDD-HHmmss`, the suffix of a backup file name.
pub fn backup_stamp(now: NaiveDateTime) -> String {
    format!(
        "{}{}{}-{}{}{}",
        now.year(),
        pad(now.month()),
        pad(now.day()),
        pad(now.hour()),
        pad(now.minute()),
        pad(now.second())
    )
}

/// Copy `file` next to itself, refusing to overwrite an existing backup, and
/// confirm the copy holds exactly the bytes the edit was computed from before
/// the caller destroys anything.
fn back_up(file: &Path, expected_bytes: u64, now: NaiveDateTime) -> Result<PathBuf, ProviderCleanupError> {
    let file_name = file.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let backup_path = file.with_file_name(format!("{file_name}.bak-{}", backup_stamp(now)));
    if backup_path.exists() {
        return Err(ProviderCleanupError::Io(format!("{} already exists", backup_path.display())));
    }
    std::fs::copy(file, &backup_path).map_err(|error| ProviderCleanupError::Io(error.to_string()))?;
    let backup_bytes = std::fs::metadata(&backup_path).map_err(|error| ProviderCleanupError::Io(error.to_string()))?.len();
    if backup_bytes != expected_bytes {
        let _ = std::fs::remove_file(&backup_path);
        return Err(ProviderCleanupError::Io(format!(
            "Backup of {} is incomplete ({backup_bytes} of {expected_bytes} bytes); nothing was removed.",
            file.display()
        )));
    }
    Ok(backup_path)
}

/// Whether the raw source's top-level `providers:` key is itself an alias
/// reference (`providers: *anchor`). The `yaml` package's CST cannot delete a
/// key through an alias node, and neither can a structural edit after the
/// alias is resolved away by parsing, so this is refused up front rather than
/// silently producing a document that does not match the source anymore.
fn top_level_providers_is_alias(source: &str) -> bool {
    static PATTERN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^providers:[ \t]*(\*\S+)[ \t]*$").unwrap());
    PATTERN.is_match(source)
}

/// The leading contiguous run of blank and `#` comment lines, kept verbatim
/// ahead of the re-serialized document (round-tripping through a generic YAML
/// value loses standalone comments elsewhere, but the file's header survives).
fn leading_comment_header(source: &str) -> String {
    let mut header = String::new();
    for line in source.lines() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            header.push_str(line);
            header.push('\n');
        } else {
            break;
        }
    }
    header
}

/// Render `source` with `ids` removed from its `providers` map, or fail when
/// the document cannot be edited in place (invalid YAML, `providers` written
/// as an alias, an entry the edit did not find).
fn render_without(file: &Path, source: &str, ids: &[String]) -> Result<String, ProviderCleanupError> {
    if let Some(first_id) = ids.first() {
        if top_level_providers_is_alias(source) {
            return Err(ProviderCleanupError::Edit(format!(
                "{}: cannot remove provider \"{first_id}\": providers is an alias; edit the file by hand.",
                file.display()
            )));
        }
    }
    let mut doc: Value =
        serde_yml::from_str(source).map_err(|error| ProviderCleanupError::Edit(format!("{}: {error}", file.display())))?;
    let providers = doc
        .as_mapping_mut()
        .and_then(|mapping| mapping.get_mut("providers"))
        .and_then(Value::as_mapping_mut)
        .ok_or_else(|| ProviderCleanupError::Edit(format!("{}: no providers map", file.display())))?;
    for id in ids {
        if providers.shift_remove(id.as_str()).is_none() {
            return Err(ProviderCleanupError::Edit(format!(
                "{}: cannot remove provider \"{id}\"; edit the file by hand.",
                file.display()
            )));
        }
    }
    let body = serde_yml::to_string(&doc).map_err(|error| ProviderCleanupError::Edit(error.to_string()))?;
    Ok(format!("{}{body}", leading_comment_header(source)))
}

/// Replace `file` in one atomic write (temp file + rename), so the agent's
/// live-reload watcher never sees a half-written config.
fn write_atomic(file: &Path, text: &str) -> Result<(), ProviderCleanupError> {
    let file_name = file.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = file.with_file_name(format!("{file_name}.tmp-cleanup-{}", std::process::id()));
    if let Err(error) = std::fs::write(&tmp, text) {
        let _ = std::fs::remove_file(&tmp);
        return Err(ProviderCleanupError::Io(error.to_string()));
    }
    if let Err(error) = std::fs::rename(&tmp, file) {
        let _ = std::fs::remove_file(&tmp);
        return Err(ProviderCleanupError::Io(error.to_string()));
    }
    Ok(())
}

/// Back up `models.yml` and delete every provider outside the allow-list (an
/// `ollama` entry stays). Everything that can fail on the content — parse,
/// edit, render — runs before the backup, so a file this migration cannot
/// clean is neither backed up nor rewritten.
pub fn clean_config(agent_dir: &Path, now: NaiveDateTime) -> Result<ProviderConfigCleanupResult, ProviderCleanupError> {
    // Propagates on invalid YAML, so a broken file is never backed up and rewritten.
    let removed: Vec<String> =
        list_models_providers(agent_dir)?.into_iter().map(|provider| provider.id).filter(|id| !is_allowed_provider(id)).collect();
    if removed.is_empty() {
        return Ok(ProviderConfigCleanupResult { backup_path: None, removed: Vec::new() });
    }

    let file = models_path(agent_dir);
    let source = std::fs::read_to_string(&file).map_err(|error| ProviderCleanupError::Io(error.to_string()))?;
    let cleaned = render_without(&file, &source, &removed)?;
    let backup_path = back_up(&file, source.len() as u64, now)?;
    write_atomic(&file, &cleaned)?;
    Ok(ProviderConfigCleanupResult { backup_path: Some(backup_path), removed })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MODELS_YML: &str = "# hand-written config\nproviders:\n  anthropic:\n    baseUrl: https://proxy.example.com\n  my-proxy:\n    api: openai-completions\n    baseUrl: https://my-proxy.example.com/v1\n    apiKey: sk-secret\n    models:\n      - id: proxy-model\n  ollama:\n    baseUrl: http://127.0.0.1:11434\n";

    fn now(year: i32, month: u32, day: u32, hour: u32, minute: u32, second: u32) -> NaiveDateTime {
        chrono::NaiveDate::from_ymd_opt(year, month, day).unwrap().and_hms_opt(hour, minute, second).unwrap()
    }

    fn backups(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("models.yml.bak-"))
            .collect();
        names.sort();
        names
    }

    #[test]
    fn backs_up_byte_identically_keeps_only_ollama_and_a_second_run_is_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("models.yml");
        std::fs::write(&file, MODELS_YML).unwrap();
        let stamp_time = now(2026, 10, 2, 9, 5, 7);

        let mut result = clean_config(dir.path(), stamp_time).unwrap();
        result.removed.sort();
        assert_eq!(result.removed, vec!["anthropic".to_string(), "my-proxy".to_string()]);
        assert_eq!(result.backup_path, Some(dir.path().join("models.yml.bak-20261002-090507")));
        assert_eq!(std::fs::read_to_string(result.backup_path.unwrap()).unwrap(), MODELS_YML);
        let cleaned: Value = serde_yml::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        let provider_keys: Vec<String> =
            cleaned.get("providers").and_then(Value::as_mapping).unwrap().iter().filter_map(|(k, _)| k.as_str().map(str::to_string)).collect();
        assert_eq!(provider_keys, vec!["ollama".to_string()]);
        assert!(std::fs::read_to_string(&file).unwrap().contains("# hand-written config"));

        let again = clean_config(dir.path(), now(2026, 10, 2, 9, 6, 0)).unwrap();
        assert_eq!(again, ProviderConfigCleanupResult { backup_path: None, removed: Vec::new() });
        assert_eq!(backups(dir.path()), vec!["models.yml.bak-20261002-090507".to_string()]);
    }

    #[test]
    fn does_nothing_without_a_models_file() {
        let dir = tempfile::tempdir().unwrap();
        let result = clean_config(dir.path(), now(2026, 10, 2, 9, 5, 7)).unwrap();
        assert_eq!(result, ProviderConfigCleanupResult { backup_path: None, removed: Vec::new() });
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn refuses_to_overwrite_an_existing_backup_and_leaves_the_config_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("models.yml");
        std::fs::write(&file, MODELS_YML).unwrap();
        let stamp_time = now(2026, 10, 2, 9, 5, 7);
        std::fs::write(dir.path().join(format!("models.yml.bak-{}", backup_stamp(stamp_time))), "older backup").unwrap();

        assert!(clean_config(dir.path(), stamp_time).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), MODELS_YML);
        assert_eq!(
            std::fs::read_to_string(dir.path().join(format!("models.yml.bak-{}", backup_stamp(stamp_time)))).unwrap(),
            "older backup"
        );
    }

    #[test]
    fn never_backs_up_or_rewrites_a_file_that_does_not_parse() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("models.yml");
        let broken = "providers:\n  anthropic: [unclosed\n";
        std::fs::write(&file, broken).unwrap();

        assert!(clean_config(dir.path(), now(2026, 10, 2, 9, 5, 7)).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), broken);
        assert!(backups(dir.path()).is_empty());
    }

    #[test]
    fn throws_without_writing_a_backup_when_providers_is_an_alias_it_cannot_edit() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("models.yml");
        let aliased = "base: &p\n  anthropic:\n    baseUrl: https://proxy.example.com\nproviders: *p\n";
        std::fs::write(&file, aliased).unwrap();

        let error = clean_config(dir.path(), now(2026, 10, 2, 9, 5, 7)).unwrap_err();
        assert!(error.to_string().contains("cannot remove provider \"anthropic\""), "{error}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), aliased);
        let names: Vec<String> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["models.yml".to_string()]);
    }

    #[test]
    fn registers_the_cleanup_handler_on_the_cleanup_channel() {
        let mut registry = crate::bridge::Registry::new();
        crate::services::register(&mut registry);
        assert_eq!(registry.scope_of("provider-cleanup:config"), Some(crate::bridge::Scope::Main));
    }
}
