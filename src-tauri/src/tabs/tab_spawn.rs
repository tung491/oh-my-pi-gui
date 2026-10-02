//! Port of `src/main/tab-spawn.ts`: the `tab:spawn` decision (acquire a sidecar
//! for a new tab of the calling window, or refuse).
//!
//! Two refusal codes:
//! - `owned`: the session file is already attached to a tab (double attach);
//! - `kind-mismatch`: the payload's explicit kind disagrees with the kind stamped
//!   in the file (reject, never degrade). Without a payload kind the file wins.

use serde_json::{json, Value};

use crate::bridge::IpcError;
use crate::ctx::AppCtx;
use crate::ports::{AcquireOptions, IpcTabWorktree, SessionKind, WindowId};

use super::snowflake::next_snowflake;

/// Where a tab starts when the payload names no cwd, and the Work workspace.
pub(crate) struct SpawnTabDeps {
    /// The caller's cwd resolution, falling back to the app's initial cwd.
    pub fallback_cwd: Box<dyn FnOnce() -> String + Send>,
    /// The GUI-owned Work workspace, created on demand.
    pub default_workspace: Box<dyn FnOnce() -> std::io::Result<String> + Send>,
}

/// JavaScript truthiness, for the optional `defaultWorkspace` flag.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

fn non_empty_str<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    payload.get(key).and_then(Value::as_str).filter(|text| !text.is_empty())
}

/// The `IpcSpawnTabResult` (or `null` at the pool cap) for `payload` in window `win_id`.
pub(crate) async fn spawn_tab_for_window(ctx: &AppCtx, win_id: WindowId, payload: &Value, deps: SpawnTabDeps) -> Result<Value, IpcError> {
    if !payload.is_object() {
        return Err(IpcError::bad_payload("tab:spawn", "expected an object"));
    }
    let session_path = non_empty_str(payload, "sessionPath").map(str::to_string);
    // `kind !== undefined` in TS: an explicit value, even an unknown one, counts as a request.
    let requested_kind = payload.get("kind");
    let mut kind = if requested_kind.and_then(Value::as_str) == Some("chat") { SessionKind::Chat } else { SessionKind::Agent };
    if let Some(session_path) = &session_path {
        // A live owner wins over every other consideration.
        if let Some(owner) = ctx.tabs.session_owner(session_path) {
            return Ok(json!({ "tabId": null, "ownerTabId": owner.tab_id, "ownerWinId": owner.win_id, "refusal": "owned" }));
        }
        // The kind stamped in the file is authoritative.
        let file_kind = ctx.services.session_kind_for(session_path).await;
        if requested_kind.is_some() && file_kind != kind {
            return Ok(json!({ "tabId": null, "refusal": "kind-mismatch" }));
        }
        kind = file_kind;
    }
    if ctx.tabs.at_cap() {
        return Ok(Value::Null);
    }
    let default_workspace = truthy(payload.get("defaultWorkspace"));
    let cwd = if default_workspace {
        (deps.default_workspace)().map_err(|error| IpcError::new(format!("could not create the Work workspace: {error}")))?
    } else {
        match non_empty_str(payload, "cwd") {
            Some(cwd) => cwd.to_string(),
            None => (deps.fallback_cwd)(),
        }
    };
    let worktree = payload.get("worktree").cloned().and_then(|worktree| serde_json::from_value::<IpcTabWorktree>(worktree).ok());
    let tab_id = next_snowflake();
    // A tab without a session path is an explicit New Tab: it starts empty even
    // when the CLI's persistent auto-resume is on for the project.
    let fresh = session_path.is_none();
    let options = AcquireOptions {
        cwd: cwd.clone(),
        win_id,
        tab_id: Some(tab_id.clone()),
        session_path,
        kind,
        worktree,
        fresh,
        placeholder: false,
        defer_start: false,
        title: None,
    };
    Ok(match ctx.tabs.acquire(options) {
        None => Value::Null,
        Some(_) if default_workspace => json!({ "tabId": tab_id, "cwd": cwd }),
        Some(_) => json!({ "tabId": tab_id }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::Registry;
    use crate::ports::IpcSessionOwner;
    use crate::testing::{fake_ctx_with, Fakes};
    use std::sync::Arc;

    const WIN: WindowId = WindowId(1);

    fn harness() -> (Fakes, Arc<AppCtx>) {
        let fakes = Fakes::default();
        let ctx = fake_ctx_with(&fakes, Registry::new());
        (fakes, ctx)
    }

    fn deps() -> SpawnTabDeps {
        SpawnTabDeps { fallback_cwd: Box::new(|| "/fallback".to_string()), default_workspace: Box::new(|| Ok("/default-workspace".to_string())) }
    }

    async fn spawn(ctx: &AppCtx, payload: Value) -> Value {
        spawn_tab_for_window(ctx, WIN, &payload, deps()).await.unwrap()
    }

    fn acquires(fakes: &Fakes) -> Vec<String> {
        fakes.tabs.log.calls().into_iter().filter(|call| call.starts_with("acquire(")).collect()
    }

    fn kind_lookups(fakes: &Fakes) -> Vec<String> {
        fakes.services.log.calls().into_iter().filter(|call| call.starts_with("session_kind_for(")).collect()
    }

    /// The acquire call TS asserted with `toHaveBeenCalledWith(cwd, win, tabId, sessionPath, kind, worktree, fresh)`.
    fn expected_acquire(result: &Value, cwd: &str, session_path: Option<&str>, kind: SessionKind, worktree: Option<IpcTabWorktree>, fresh: bool) -> String {
        let tab_id = result["tabId"].as_str().expect("a minted tab id").to_string();
        assert_eq!(tab_id.len(), 16);
        let options = AcquireOptions {
            cwd: cwd.into(),
            win_id: WIN,
            tab_id: Some(tab_id),
            session_path: session_path.map(str::to_string),
            kind,
            worktree,
            fresh,
            placeholder: false,
            defer_start: false,
            title: None,
        };
        format!("acquire({options:?})")
    }

    #[tokio::test]
    async fn refuses_an_explicit_chat_payload_against_an_agent_file_i3_reject_never_degrade() {
        let (fakes, ctx) = harness();
        let result = spawn(&ctx, json!({ "sessionPath": "/s/agent.jsonl", "kind": "chat" })).await;

        assert_eq!(result, json!({ "tabId": null, "refusal": "kind-mismatch" }));
        assert!(acquires(&fakes).is_empty());
        assert_eq!(kind_lookups(&fakes), ["session_kind_for(/s/agent.jsonl)"]);
    }

    #[tokio::test]
    async fn refuses_an_explicit_agent_payload_against_a_chat_file() {
        let (fakes, ctx) = harness();
        fakes.services.kinds.lock().unwrap().insert("/s/chat.jsonl".into(), SessionKind::Chat);
        let result = spawn(&ctx, json!({ "sessionPath": "/s/chat.jsonl", "kind": "agent" })).await;

        assert_eq!(result, json!({ "tabId": null, "refusal": "kind-mismatch" }));
        assert!(acquires(&fakes).is_empty());
    }

    #[tokio::test]
    async fn spawns_with_the_file_s_kind_when_the_payload_omits_it_file_is_authoritative() {
        let (fakes, ctx) = harness();
        fakes.services.kinds.lock().unwrap().insert("/s/chat.jsonl".into(), SessionKind::Chat);
        let result = spawn(&ctx, json!({ "sessionPath": "/s/chat.jsonl" })).await;

        assert_eq!(acquires(&fakes), [expected_acquire(&result, "/fallback", Some("/s/chat.jsonl"), SessionKind::Chat, None, false)]);
    }

    #[tokio::test]
    async fn acquires_with_the_requested_kind_when_it_matches_the_file() {
        let (fakes, ctx) = harness();
        fakes.services.kinds.lock().unwrap().insert("/s/chat.jsonl".into(), SessionKind::Chat);
        let result = spawn(&ctx, json!({ "sessionPath": "/s/chat.jsonl", "kind": "chat" })).await;

        assert_eq!(acquires(&fakes), [expected_acquire(&result, "/fallback", Some("/s/chat.jsonl"), SessionKind::Chat, None, false)]);
    }

    #[tokio::test]
    async fn owner_wins_over_kind_resolution_f_own_checked_first_kindfor_not_consulted() {
        let (fakes, ctx) = harness();
        fakes.tabs.owners.lock().unwrap().insert("/s/owned.jsonl".into(), IpcSessionOwner { tab_id: "t-owner".into(), win_id: WindowId(7) });
        let result = spawn(&ctx, json!({ "sessionPath": "/s/owned.jsonl", "kind": "chat" })).await;

        assert_eq!(result, json!({ "tabId": null, "ownerTabId": "t-owner", "ownerWinId": 7, "refusal": "owned" }));
        assert!(kind_lookups(&fakes).is_empty());
        assert!(acquires(&fakes).is_empty());
    }

    #[tokio::test]
    async fn returns_null_at_the_pool_cap() {
        let (fakes, ctx) = harness();
        *fakes.tabs.at_cap.lock().unwrap() = true;
        let result = spawn(&ctx, json!({})).await;

        assert_eq!(result, Value::Null);
        assert!(acquires(&fakes).is_empty());
    }

    #[tokio::test]
    async fn fresh_tabs_bypass_auto_resume_spawn_agent_by_default_and_never_consult_kindfor() {
        let (fakes, ctx) = harness();
        let result = spawn(&ctx, json!({ "cwd": "/work" })).await;

        assert_eq!(result, json!({ "tabId": result["tabId"] }));
        assert_eq!(acquires(&fakes), [expected_acquire(&result, "/work", None, SessionKind::Agent, None, true)]);
        assert!(kind_lookups(&fakes).is_empty());
    }

    #[tokio::test]
    async fn spawns_work_as_a_full_agent_in_the_gui_default_workspace() {
        let (fakes, ctx) = harness();
        let result = spawn(&ctx, json!({ "defaultWorkspace": true })).await;

        assert_eq!(result, json!({ "tabId": result["tabId"], "cwd": "/default-workspace" }));
        assert_eq!(acquires(&fakes), [expected_acquire(&result, "/default-workspace", None, SessionKind::Agent, None, true)]);
        assert!(kind_lookups(&fakes).is_empty());
    }

    #[tokio::test]
    async fn passes_a_worktree_binding_through_to_acquire_plan_20() {
        let (fakes, ctx) = harness();
        let worktree = json!({ "name": "fix-login", "branch": "omp/gui/fix-login", "baseCwd": "/repo" });
        let result = spawn(&ctx, json!({ "cwd": "/wt/gui-fix-login-deadbeef", "worktree": worktree })).await;

        let binding: IpcTabWorktree = serde_json::from_value(worktree).unwrap();
        assert_eq!(acquires(&fakes), [expected_acquire(&result, "/wt/gui-fix-login-deadbeef", None, SessionKind::Agent, Some(binding), true)]);
    }

    #[tokio::test]
    async fn rejects_a_payload_that_is_not_an_object() {
        let (fakes, ctx) = harness();
        let error = spawn_tab_for_window(&ctx, WIN, &Value::Null, deps()).await.unwrap_err();
        assert!(error.message.contains("tab:spawn"), "{}", error.message);
        assert!(acquires(&fakes).is_empty());
    }

    #[tokio::test]
    async fn reports_a_work_workspace_that_cannot_be_created() {
        let (fakes, ctx) = harness();
        let failing = SpawnTabDeps {
            fallback_cwd: Box::new(|| "/fallback".to_string()),
            default_workspace: Box::new(|| Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied"))),
        };
        let error = spawn_tab_for_window(&ctx, WIN, &json!({ "defaultWorkspace": true }), failing).await.unwrap_err();
        assert!(error.message.contains("denied"), "{}", error.message);
        assert!(acquires(&fakes).is_empty());
    }
}
