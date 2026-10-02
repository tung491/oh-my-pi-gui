//! External-editor round trip for the composer editor dialog, ported from
//! `editor.ts`: write the draft to a temp file, spawn `$VISUAL`/`$EDITOR`,
//! read the file back on a clean exit.

use std::path::{Path, PathBuf};

use tokio::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorRoundTripResult {
    /// Edited text (exit 0), `None` when the editor exits non-zero (draft unchanged).
    pub text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EditorError {
    #[error("Set $VISUAL or $EDITOR to use an external editor")]
    Unavailable,
    #[error("{0}")]
    Io(String),
}

fn temp_file_path() -> PathBuf {
    use std::hash::{BuildHasher, Hasher};
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
    let random = std::collections::hash_map::RandomState::new().build_hasher().finish();
    std::env::temp_dir().join(format!("omp-editor-{now}-{random:x}.md"))
}

/// Resolution order (same as the TS source, minus the shell probe, which
/// `ctx.omp.resolve_editor_command()` already performed before this is
/// called): process `$VISUAL`/`$EDITOR`, then `editor_cmd` as given.
pub async fn open_in_external_editor(content: &str, editor_cmd: &str, path_env: &str) -> Result<EditorRoundTripResult, EditorError> {
    let tmp_file = temp_file_path();
    let result = run_editor(editor_cmd, &tmp_file, content, path_env).await;
    let _ = tokio::fs::remove_file(&tmp_file).await;
    result
}

async fn run_editor(editor_cmd: &str, tmp_file: &Path, content: &str, path_env: &str) -> Result<EditorRoundTripResult, EditorError> {
    tokio::fs::write(tmp_file, content).await.map_err(|error| EditorError::Io(error.to_string()))?;
    let mut parts = editor_cmd.split_whitespace();
    let editor = parts.next().ok_or(EditorError::Unavailable)?;
    let editor_args: Vec<&str> = parts.collect();

    // Bare editor names (code, zed, subl) resolve via the login-shell PATH,
    // which is why the caller passes the overlay `spawn_env()` computed.
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("cmd");
        command.arg("/C").arg(editor).args(&editor_args);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new(editor);
        command.args(&editor_args);
        command
    };
    command.arg(tmp_file);
    command.env("PATH", path_env);
    command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    let status = command.status().await.map_err(|error| EditorError::Io(error.to_string()))?;
    if !status.success() {
        return Ok(EditorRoundTripResult { text: None });
    }
    // Read-back contract: strip exactly one trailing newline.
    let text = tokio::fs::read_to_string(tmp_file).await.map_err(|error| EditorError::Io(error.to_string()))?;
    let text = text.strip_suffix('\n').unwrap_or(&text).to_string();
    Ok(EditorRoundTripResult { text: Some(text) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_clean_exit_returns_the_file_with_one_trailing_newline_stripped() {
        // `/usr/bin/true` exits 0 without touching the file, so the round trip
        // returns the draft exactly as `fs.writeFile` + the read-back contract
        // would. The command runs with the PATH this test hands it (here
        // empty), so the absolute path is used rather than a bare name.
        let result = open_in_external_editor("draft content\n", "/usr/bin/true", "").await.unwrap();
        assert_eq!(result.text, Some("draft content".to_string()));
    }

    #[tokio::test]
    async fn a_non_zero_exit_leaves_the_draft_unread() {
        let result = open_in_external_editor("draft content", "/usr/bin/false", "").await.unwrap();
        assert_eq!(result.text, None);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn the_temp_file_is_removed_after_the_round_trip() {
        use std::os::unix::fs::PermissionsExt;
        // A tiny script captures the temp file path it was handed, so the test
        // can confirm the file existed during the round trip and is gone after.
        let dir = tempfile::tempdir().unwrap();
        let captured = dir.path().join("captured-path");
        let script_path = dir.path().join("editor.sh");
        std::fs::write(&script_path, format!("#!/bin/sh\nprintf '%s' \"$1\" > '{}'\n", captured.display())).unwrap();
        let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).unwrap();

        let result = open_in_external_editor("draft", script_path.to_str().unwrap(), "").await.unwrap();
        assert_eq!(result.text, Some("draft".to_string()));
        let tmp_file_path = std::fs::read_to_string(&captured).unwrap();
        assert!(!tmp_file_path.is_empty());
        assert!(!std::path::Path::new(&tmp_file_path).exists(), "the temp file is cleaned up after the round trip");
    }
}
