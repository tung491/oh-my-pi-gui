//! System actions ported from `ipc.ts:792-878`: external open, the
//! open-path launch decision, clipboard read and notifications (with the
//! same per-window dedupe window as the TS handler).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::ctx::AppCtx;
use crate::ports::{Caller, WindowId};

use super::open_path_target::{self, OpenAction, OsFs};

/// The mailto header fields `system:open-external` passes on. Some mail
/// clients reached through xdg-open have honoured `attach`/`attachment`, so a
/// link in model output could pre-attach a local file; every other field is
/// dropped.
const MAILTO_FIELDS: [&str; 4] = ["subject", "body", "cc", "bcc"];
const MAILTO: &str = "mailto:";

/// The URL `system:open-external` opens, or `None` when it is refused
/// (`sanitizeExternalUrl` in `external-url.ts`). http and https pass
/// unchanged; a mailto link is rebuilt from its address and its `subject`,
/// `body`, `cc` and `bcc` fields (names matched case-insensitively, after
/// percent-decoding), without its fragment. A mailto address holding an
/// encoded `?` is refused, so a client that decodes it first finds no fields.
/// The host checks the URL again before opening it.
pub fn sanitize_external_url(url: &str) -> Option<String> {
    let starts_with = |prefix: &str| url.get(..prefix.len()).is_some_and(|head| head.eq_ignore_ascii_case(prefix));
    if starts_with("https://") || starts_with("http://") {
        return Some(url.to_string());
    }
    if !starts_with(MAILTO) {
        return None;
    }
    let without_fragment = url[MAILTO.len()..].split('#').next().unwrap_or("");
    let (address, query) = match without_fragment.split_once('?') {
        Some((address, query)) => (address, Some(query)),
        None => (without_fragment, None),
    };
    if address.to_ascii_lowercase().contains("%3f") {
        return None;
    }
    let fields: Vec<&str> = query.map(|query| query.split('&').filter(|field| is_kept_mailto_field(field)).collect()).unwrap_or_default();
    Some(if fields.is_empty() { format!("{MAILTO}{address}") } else { format!("{MAILTO}{address}?{}", fields.join("&")) })
}

fn is_kept_mailto_field(field: &str) -> bool {
    let raw_name = field.split_once('=').map_or(field, |(name, _)| name);
    // A malformed escape cannot name a kept field.
    percent_decode(raw_name).is_some_and(|name| MAILTO_FIELDS.iter().any(|kept| name.eq_ignore_ascii_case(kept.as_bytes())))
}

/// `%XX` escapes decoded to bytes; `None` on a malformed escape.
fn percent_decode(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = std::str::from_utf8(bytes.get(index + 1..index + 3)?).ok()?;
            decoded.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    Some(decoded)
}

/// http and https only: the rule the agent's `gui_open_url` tool keeps.
pub fn allowed_web_url(url: &str) -> bool {
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

/// Where `system:open-path` points before the OS sees it (`resolveOpenPath`
/// in `open-path-resolve.ts`): `~/` expands against `home`, an absolute path
/// passes through, a relative one resolves inside `cwd_for(tab_id)` — the
/// named tab's workspace, or the calling window's when `tab_id` is `None`.
/// A named tab without a workspace fails rather than borrowing another's.
pub fn resolve_open_path(
    target: &str,
    home: Option<&std::path::Path>,
    tab_id: Option<&str>,
    cwd_for: impl FnOnce(Option<&str>) -> Option<String>,
) -> Result<String, OpenPathError> {
    if target.trim().is_empty() {
        return Err(OpenPathError::EmptyPath);
    }
    let expanded = super::ipc::expand_home_in(target, home);
    if std::path::Path::new(&expanded).is_absolute() {
        return Ok(expanded);
    }
    let root = cwd_for(tab_id).ok_or(OpenPathError::NoWorkspace)?;
    Ok(super::fs::resolve_within(std::path::Path::new(&root), &expanded)
        .ok_or(OpenPathError::EscapesWorkspace)?
        .to_string_lossy()
        .into_owned())
}

/// `system:open-path`: tool-card path links and the preview's Open
/// externally. The path resolves through [`resolve_open_path`]; a path the OS
/// default handler would run — judged by its requested and its resolved name
/// — is revealed, never opened.
pub async fn open_path(
    ctx: &Arc<AppCtx>,
    caller: Caller,
    target: &str,
    tab_id: Option<&str>,
) -> Result<OpenPathOutcome, OpenPathError> {
    let resolved =
        resolve_open_path(target, dirs::home_dir().as_deref(), tab_id, |tab_id| ctx.tabs.cwd_for(caller, tab_id))?;
    let probe_path = resolved.clone();
    let decision = tokio::task::spawn_blocking(move || {
        open_path_target::open_path_target(&probe_path, &OsFs)
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
    fn allows_http_https_and_mailto_urls() {
        assert_eq!(sanitize_external_url("https://a.b/x?attach=1#y").as_deref(), Some("https://a.b/x?attach=1#y"));
        assert_eq!(sanitize_external_url("http://a.b").as_deref(), Some("http://a.b"));
        assert_eq!(sanitize_external_url("mailto:a@b.c").as_deref(), Some("mailto:a@b.c"));
    }

    #[test]
    fn refuses_file_javascript_and_data_urls() {
        for url in ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", ""] {
            assert_eq!(sanitize_external_url(url), None, "{url} must be refused");
        }
    }

    #[test]
    fn keeps_only_subject_body_cc_and_bcc_in_mailto_links() {
        assert_eq!(
            sanitize_external_url(
                "mailto:a@b.c?subject=Hi%20there&to=x@y.z&body=Line&cc=c@d.e&bcc=f@g.h&in-reply-to=1#frag"
            )
            .as_deref(),
            Some("mailto:a@b.c?subject=Hi%20there&body=Line&cc=c@d.e&bcc=f@g.h")
        );
        assert_eq!(sanitize_external_url("mailto:a@b.c?to=x@y.z&&").as_deref(), Some("mailto:a@b.c"));
    }

    #[test]
    fn drops_attach_parameters_from_mailto_links() {
        assert_eq!(
            sanitize_external_url("mailto:a@b.c?attach=/etc/passwd&subject=x").as_deref(),
            Some("mailto:a@b.c?subject=x")
        );
        assert_eq!(sanitize_external_url("mailto:a@b.c?Attachment=%2Fetc%2Fpasswd").as_deref(), Some("mailto:a@b.c"));
        assert_eq!(
            sanitize_external_url("mailto:a@b.c?%61ttach=/etc/passwd&body").as_deref(),
            Some("mailto:a@b.c?body")
        );
    }

    #[test]
    fn matches_mailto_parameter_names_case_insensitively() {
        assert_eq!(
            sanitize_external_url("MAILTO:a@b.c?SUBJECT=x&Body=y&%63c=z&ATTACH=w").as_deref(),
            Some("mailto:a@b.c?SUBJECT=x&Body=y&%63c=z")
        );
        assert_eq!(sanitize_external_url("mailto:a@b.c?%zzsubject=x").as_deref(), Some("mailto:a@b.c"));
    }

    #[test]
    fn refuses_mailto_links_that_hide_a_query_in_the_address() {
        assert_eq!(sanitize_external_url("mailto:a@b.c%3Fattach=/etc/passwd"), None);
        assert_eq!(sanitize_external_url("mailto:a@b.c%3fsubject=x"), None);
    }

    #[test]
    fn the_host_tool_still_refuses_mailto_urls() {
        assert!(allowed_web_url("https://a.b"));
        assert!(!allowed_web_url("mailto:a@b.c"));
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
        bridge::dispatch_for_test(&ctx, caller, "system:open-external", vec![json!("mailto:a@b.c?attach=/etc/passwd&subject=x")])
            .await
            .unwrap();
        assert!(fakes.host.log.calls().iter().any(|call| call == "open_url(mailto:a@b.c?subject=x)"));
        assert!(!fakes.host.log.calls().iter().any(|call| call.contains("attach")));
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

    /// Window `/win` with tabs `t1` → `/ws/one` and `t2` → `/ws/two`; records which tab was asked for.
    fn tab_cwd(asked: &std::cell::RefCell<Vec<Option<String>>>, tab_id: Option<&str>) -> Option<String> {
        asked.borrow_mut().push(tab_id.map(str::to_string));
        match tab_id {
            None => Some("/win".into()),
            Some("t1") => Some("/ws/one".into()),
            Some("t2") => Some("/ws/two".into()),
            Some(_) => None,
        }
    }

    fn home() -> Option<&'static std::path::Path> {
        Some(std::path::Path::new("/home/me"))
    }

    #[test]
    fn open_path_resolves_a_relative_path_against_the_given_tab() {
        let asked = std::cell::RefCell::new(Vec::new());
        let resolved = resolve_open_path("docs/a.pdf", home(), Some("t2"), |tab| tab_cwd(&asked, tab));
        assert_eq!(resolved, Ok("/ws/two/docs/a.pdf".to_string()));
        assert_eq!(*asked.borrow(), [Some("t2".to_string())]);
    }

    #[test]
    fn open_path_refuses_an_unknown_tab() {
        let asked = std::cell::RefCell::new(Vec::new());
        let resolved = resolve_open_path("docs/a.pdf", home(), Some("gone"), |tab| tab_cwd(&asked, tab));
        assert_eq!(resolved, Err(OpenPathError::NoWorkspace));
    }

    #[test]
    fn open_path_resolves_against_the_window_workspace_without_a_tab() {
        let asked = std::cell::RefCell::new(Vec::new());
        let resolved = resolve_open_path("notes.md", home(), None, |tab| tab_cwd(&asked, tab));
        assert_eq!(resolved, Ok("/win/notes.md".to_string()));
        assert_eq!(*asked.borrow(), [None]);
    }

    #[test]
    fn open_path_keeps_absolute_and_home_paths_without_asking_for_a_workspace() {
        let asked = std::cell::RefCell::new(Vec::new());
        assert_eq!(
            resolve_open_path("/abs/a.txt", home(), Some("gone"), |tab| tab_cwd(&asked, tab)),
            Ok("/abs/a.txt".to_string())
        );
        assert_eq!(
            resolve_open_path("~/a.txt", home(), Some("gone"), |tab| tab_cwd(&asked, tab)),
            Ok("/home/me/a.txt".to_string())
        );
        assert!(asked.borrow().is_empty());
    }

    #[test]
    fn open_path_refuses_a_path_that_escapes_the_tab_workspace() {
        let asked = std::cell::RefCell::new(Vec::new());
        let resolved = resolve_open_path("../one/a.txt", home(), Some("t2"), |tab| tab_cwd(&asked, tab));
        assert_eq!(resolved, Err(OpenPathError::EscapesWorkspace));
    }

    #[test]
    fn open_path_refuses_an_empty_path() {
        let asked = std::cell::RefCell::new(Vec::new());
        assert_eq!(resolve_open_path("  ", home(), Some("t1"), |tab| tab_cwd(&asked, tab)), Err(OpenPathError::EmptyPath));
        assert!(asked.borrow().is_empty());
    }

    #[tokio::test]
    async fn open_path_reads_the_tab_id_only_from_a_non_empty_string() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("notes.md"), "hello").unwrap();
        let fakes = Fakes::default();
        fakes.tabs.cwds.lock().unwrap().insert(WindowId(1), dir.path().to_string_lossy().into_owned());
        let ctx = services_ctx(&fakes);
        let caller = Caller::main(WindowId(1));
        for options in [json!({ "tabId": "t1" }), json!({ "tabId": "" }), json!({ "tabId": 7 }), json!("t1")] {
            let result =
                bridge::dispatch_for_test(&ctx, caller, "system:open-path", vec![json!("notes.md"), options]).await.unwrap();
            assert_eq!(result["ok"], json!(true));
        }
        let asked: Vec<String> =
            fakes.tabs.log.calls().into_iter().filter(|call| call.starts_with("cwd_for(")).collect();
        assert_eq!(asked, ["cwd_for(1, Some(\"t1\"))", "cwd_for(1, None)", "cwd_for(1, None)", "cwd_for(1, None)"]);
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
