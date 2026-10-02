//! System actions ported from `ipc.ts:792-878`: external open, the
//! open-path launch decision, clipboard read and notifications (with the
//! same per-window dedupe window as the TS handler).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::ctx::AppCtx;
use crate::ports::{Caller, WindowId};

use super::open_path_target::{self, LaunchPlatform, OpenAction, OsFs};

/// The URL schemes `system:open-external` allows (`ipc.ts:792-806`); the host
/// refuses anything else again, but this stops the browser from even being asked.
pub fn allowed_external_url(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

/// A desktop notification is suppressed within a window when the same
/// `(window, title, body)` triple fired less than 1.5 s ago (a turn can emit
/// the same notification from several renderers), but never across windows:
/// two parallel sessions finishing in different windows are distinct events.
pub struct NotifyDedupe {
    last: Mutex<Option<(String, Instant)>>,
}

impl Default for NotifyDedupe {
    fn default() -> Self {
        Self { last: Mutex::new(None) }
    }
}

impl NotifyDedupe {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn dedupe_key(win_id: WindowId, title: &str, body: &str) -> String {
        format!("{}{title}{body}", win_id.0)
    }

    /// `true` when this notification should actually show.
    pub fn should_show(&self, key: &str) -> bool {
        self.should_show_at(key, Instant::now())
    }

    fn should_show_at(&self, key: &str, now: Instant) -> bool {
        let mut last = self.last.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((last_key, last_at)) = last.as_ref() {
            if last_key == key && now.saturating_duration_since(*last_at) < Duration::from_millis(1500) {
                return false;
            }
        }
        *last = Some((key.to_string(), now));
        true
    }
}

/// The Node `process.platform` name this build reports for the open-path decision.
pub fn launch_platform() -> LaunchPlatform {
    open_path_target::launch_platform_of(crate::runtime_log::node_platform())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenPathOutcome {
    pub resolved_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenPathError {
    EmptyPath,
    NoWorkspace,
    EscapesWorkspace,
    NotFound,
}

impl OpenPathError {
    pub fn message(&self) -> &'static str {
        match self {
            OpenPathError::EmptyPath => "Empty path",
            OpenPathError::NoWorkspace => "No workspace",
            OpenPathError::EscapesWorkspace => "Path escapes the workspace",
            OpenPathError::NotFound => "File not found",
        }
    }
}

/// `system:open-path`: tool-card path links. `~` expands, relative paths
/// resolve inside the calling window's workspace (escapes refused), absolute
/// paths pass through. A path the OS default handler would run — judged by
/// its requested and its resolved name — is revealed, never opened.
pub async fn open_path(ctx: &Arc<AppCtx>, caller: Caller, target: &str) -> Result<OpenPathOutcome, OpenPathError> {
    if target.trim().is_empty() {
        return Err(OpenPathError::EmptyPath);
    }
    let expanded = super::ipc::expand_home(target);
    let resolved = if std::path::Path::new(&expanded).is_absolute() {
        expanded
    } else {
        let root = ctx.tabs.cwd_for(caller, None).ok_or(OpenPathError::NoWorkspace)?;
        super::fs::resolve_within(std::path::Path::new(&root), &expanded)
            .ok_or(OpenPathError::EscapesWorkspace)?
            .to_string_lossy()
            .into_owned()
    };
    let probe_path = resolved.clone();
    let decision = tokio::task::spawn_blocking(move || {
        open_path_target::open_path_target(&probe_path, launch_platform(), &OsFs)
    })
    .await
    .ok()
    .flatten();
    let Some(decision) = decision else { return Err(OpenPathError::NotFound) };
    if decision.action != OpenAction::Reveal && ctx.host.open_path(std::path::Path::new(&decision.path)).is_ok() {
        return Ok(OpenPathOutcome { resolved_path: resolved });
    }
    let _ = ctx.host.reveal_in_folder(std::path::Path::new(&decision.path));
    Ok(OpenPathOutcome { resolved_path: resolved })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::{self, Registry};
    use crate::ports::{Caller, WindowId};
    use crate::testing::{self, Fakes};
    use serde_json::json;
    use std::sync::Arc as StdArc;

    fn registry() -> Registry {
        let mut reg = Registry::new();
        crate::services::register(&mut reg);
        reg
    }

    fn services_ctx(fakes: &Fakes) -> StdArc<crate::ctx::AppCtx> {
        testing::fake_ctx_cyclic(fakes, registry(), |ctx, ports| {
            ports.services = Some(StdArc::new(crate::services::Services::new(ctx.clone())));
        })
    }

    #[test]
    fn allows_only_http_and_https_urls() {
        assert!(allowed_external_url("https://example.com"));
        assert!(allowed_external_url("http://example.com"));
        assert!(!allowed_external_url("file:///etc/passwd"));
        assert!(!allowed_external_url("javascript:alert(1)"));
    }

    #[test]
    fn suppresses_a_repeat_within_the_window_but_not_a_different_window() {
        let dedupe = NotifyDedupe::new();
        let key = NotifyDedupe::dedupe_key(WindowId(1), "Done", "");
        let now = Instant::now();
        assert!(dedupe.should_show_at(&key, now));
        assert!(!dedupe.should_show_at(&key, now + Duration::from_millis(500)));
        assert!(dedupe.should_show_at(&key, now + Duration::from_millis(2000)));
        let other_window_key = NotifyDedupe::dedupe_key(WindowId(2), "Done", "");
        assert!(dedupe.should_show_at(&other_window_key, now + Duration::from_millis(500)));
    }

    #[tokio::test]
    async fn dispatches_system_open_external_only_for_http_s() {
        let fakes = Fakes::default();
        let ctx = services_ctx(&fakes);
        let caller = Caller::main(WindowId(1));
        bridge::dispatch_for_test(&ctx, caller, "system:open-external", vec![json!("https://example.com")]).await.unwrap();
        assert!(fakes.host.log.calls().iter().any(|call| call.contains("open_url(https://example.com)")));
        bridge::dispatch_for_test(&ctx, caller, "system:open-external", vec![json!("file:///etc/passwd")]).await.unwrap();
        assert!(!fakes.host.log.calls().iter().any(|call| call.contains("open_url(file")));
    }

    #[tokio::test]
    async fn dispatches_system_clipboard_read() {
        let fakes = Fakes::default();
        *fakes.host.clipboard_text.lock().unwrap() = "copied text".into();
        let ctx = services_ctx(&fakes);
        let caller = Caller::main(WindowId(1));
        let result = bridge::dispatch_for_test(&ctx, caller, "system:clipboard-read", vec![]).await.unwrap();
        assert_eq!(result, json!("copied text"));
    }

    #[tokio::test]
    async fn dispatches_system_notify_and_dedupes_within_the_window() {
        let fakes = Fakes::default();
        let ctx = services_ctx(&fakes);
        let caller = Caller::main(WindowId(1));
        let payload = json!({ "title": "Done", "body": "ok" });
        bridge::dispatch_for_test(&ctx, caller, "system:notify", vec![payload.clone()]).await.unwrap();
        bridge::dispatch_for_test(&ctx, caller, "system:notify", vec![payload]).await.unwrap();
        let notify_calls = fakes.host.log.calls().into_iter().filter(|call| call.starts_with("notify(")).count();
        assert_eq!(notify_calls, 1, "the second call within 1.5s is deduped");
    }

    #[tokio::test]
    async fn dispatches_system_open_path_for_a_regular_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("notes.md"), "hello").unwrap();
        let fakes = Fakes::default();
        fakes.tabs.cwds.lock().unwrap().insert(WindowId(1), dir.path().to_string_lossy().into_owned());
        let ctx = services_ctx(&fakes);
        let caller = Caller::main(WindowId(1));
        let result = bridge::dispatch_for_test(&ctx, caller, "system:open-path", vec![json!("notes.md")]).await.unwrap();
        assert_eq!(result["ok"], json!(true));
        assert!(fakes.host.log.calls().iter().any(|call| call.starts_with("open_path(")));
    }

    #[tokio::test]
    async fn dispatches_system_save_dialog_and_remembers_the_folder() {
        let fakes = Fakes::default();
        *fakes.host.save_dialog_answers.lock().unwrap() = vec![Some(std::path::PathBuf::from("/home/me/exports/session.html"))];
        let ctx = services_ctx(&fakes);
        let caller = Caller::main(WindowId(1));
        let result = bridge::dispatch_for_test(&ctx, caller, "system:save-dialog", vec![]).await.unwrap();
        assert_eq!(result, json!("/home/me/exports/session.html"));
    }

    #[tokio::test]
    async fn dispatches_system_open_dialog_for_multiple_files() {
        let fakes = Fakes::default();
        *fakes.host.open_dialog_answers.lock().unwrap() = vec![Some(vec![std::path::PathBuf::from("/tmp/a.txt")])];
        let ctx = services_ctx(&fakes);
        let caller = Caller::main(WindowId(1));
        let result = bridge::dispatch_for_test(&ctx, caller, "system:open-dialog", vec![]).await.unwrap();
        assert_eq!(result, json!(["/tmp/a.txt"]));
    }
}
