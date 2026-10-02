//! Handlers for the channels this module owns, ported from `src/main/ipc.ts`.
//! "This window" is always `Caller.win_id`, never a payload field.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::bridge::{IpcError, Reply};
use crate::ctx::AppCtx;
use crate::i18n::MainTextKey;
use crate::paths;
use crate::ports::{Caller, IpcTabViewSplit, OpenDialogOptions, SidecarHandle, SidecarStatus};

use super::tab_spawn::{spawn_tab_for_window, SpawnTabDeps};

/// The payload: every channel of this module takes at most one argument.
fn payload(args: &[Value]) -> &Value {
    args.first().unwrap_or(&Value::Null)
}

fn str_field<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    payload.get(key).and_then(Value::as_str)
}

fn status_name(status: SidecarStatus) -> String {
    serde_json::to_value(status).ok().and_then(|value| value.as_str().map(str::to_string)).unwrap_or_default()
}

/// The GUI-owned Work workspace (`<agent dir>/../work`), created on demand.
#[cfg(not(test))]
fn ensure_default_workspace() -> std::io::Result<PathBuf> {
    paths::ensure_default_workspace()
}

/// Tests never touch the user's agent directory: the Work workspace lives in a temp dir.
#[cfg(test)]
fn ensure_default_workspace() -> std::io::Result<PathBuf> {
    let dir = std::env::temp_dir().join("sai-atlas-tests").join(format!("{}-tabs-work", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Where a caller with no cwd starts: never the volume root (a file-manager
/// launch has a process cwd of "/"), so the last project, the process cwd, then home.
fn initial_cwd(ctx: &AppCtx) -> String {
    let last_project = ctx.prefs.get_string("lastProject");
    let process_cwd = std::env::current_dir().ok().map(|cwd| path_string(&cwd));
    paths::initial_cwd(&[last_project.as_deref(), process_cwd.as_deref()])
        .or_else(|| dirs::home_dir().map(|home| path_string(&home)))
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// RPC passthrough
// ---------------------------------------------------------------------------

/// A failed `RpcResponse` for `id` (omitted when the command had none, as JSON drops `undefined`).
fn failed_response(id: Option<&Value>, fields: Value) -> Value {
    let mut response = Map::new();
    if let Some(id) = id {
        response.insert("id".into(), id.clone());
    }
    response.insert("type".into(), json!("response"));
    response.insert("success".into(), json!(false));
    if let Value::Object(fields) = fields {
        response.extend(fields);
    }
    Value::Object(response)
}

/// The shared `rpc:command` / `rpc:command-for-tab` path. It always answers with
/// a response, never an error, for anything the sidecar does: the renderer reads
/// `success` and `code` (`rpc_delivery_unknown` marks an uncertain delivery).
/// The command is queued on stdin before this returns, so stdin order is arrival order.
fn dispatch_rpc_command(
    ctx: &Arc<AppCtx>,
    caller: Caller,
    channel: &str,
    sidecar: Option<Arc<dyn SidecarHandle>>,
    issuer_tab_id: Option<String>,
    payload: &Value,
) -> Reply {
    let Some(command) = payload.get("command").filter(|command| command.is_object()) else {
        return Reply::err(IpcError::bad_payload(channel, "expected { command }"));
    };
    let id = command.get("id");
    let Some(sidecar) = sidecar.filter(|sidecar| sidecar.has_rpc_client()) else {
        return Reply::ok(failed_response(id, json!({ "error": "Sidecar not connected" })));
    };
    let status = sidecar.status();
    if status != SidecarStatus::Ready {
        return Reply::ok(failed_response(id, json!({ "error": format!("Sidecar not ready ({})", status_name(status)) })));
    }
    // Refuse a switch_session onto a file another tab owns BEFORE dispatch: the
    // sidecar would attach for real and silently diverge the owner's file. The
    // renderer pre-check routes to the owner; this catches the race.
    if str_field(command, "type") == Some("switch_session") {
        if let Some(session_path) = str_field(command, "sessionPath") {
            if let Some(blocker) = ctx.tabs.foreign_session_owner(issuer_tab_id.as_deref(), session_path) {
                return Reply::ok(failed_response(
                    id,
                    json!({
                        "command": "switch_session",
                        "error": "Session is already open in another tab",
                        "code": "session_owned_elsewhere",
                        "data": { "ownerTabId": blocker.tab_id, "ownerWinId": blocker.win_id },
                    }),
                ));
            }
        }
    }
    let timeout_ms = payload.get("timeoutMs").and_then(Value::as_f64).filter(|ms| ms.is_finite() && *ms > 0.0).map(|ms| ms as u64);
    let id = id.cloned();
    let command = command.clone();
    let response = sidecar.request(command.clone(), timeout_ms);
    let ctx = Arc::clone(ctx);
    Reply::Later(Box::pin(async move {
        match response.await {
            Ok(response) => {
                if let Some(issuer) = issuer_tab_id.as_deref() {
                    note_passthrough(&ctx, caller, issuer, &command, &response);
                }
                Ok(response)
            }
            Err(error) => Ok(failed_response(id.as_ref(), json!({ "code": "rpc_delivery_unknown", "error": error.to_string() }))),
        }
    }))
}

/// The session-ownership facts the passthrough carries: a successful
/// `switch_session` attaches the issuer to that file; `get_state` reports the
/// file and the live cwd (`switch_session` re-roots the agent with no event).
fn note_passthrough(ctx: &AppCtx, caller: Caller, issuer: &str, command: &Value, response: &Value) {
    if response.get("success").and_then(Value::as_bool) != Some(true) {
        return;
    }
    match str_field(command, "type") {
        Some("switch_session") => {
            let cancelled = response.pointer("/data/cancelled").and_then(Value::as_bool).unwrap_or(false);
            if !cancelled {
                ctx.tabs.note_session_file(issuer, str_field(command, "sessionPath"));
            }
        }
        Some("get_state") => {
            let state = response.get("data").unwrap_or(&Value::Null);
            ctx.tabs.note_session_file(issuer, str_field(state, "sessionFile"));
            // Keep the window record in sync too (the menu's New Window reads its cwd).
            if let Some(cwd) = str_field(state, "cwd").filter(|cwd| !cwd.is_empty()) {
                if ctx.tabs.adopt_session_cwd(issuer, cwd) {
                    ctx.desktop.set_cwd(caller.win_id, cwd);
                }
            }
        }
        _ => {}
    }
}

/// `rpc:command`: the window's focused tab.
pub fn rpc_command(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let issuer = ctx.tabs.active_tab_for_window(caller.win_id);
    let sidecar = ctx.tabs.sidecar_for_window(caller.win_id);
    dispatch_rpc_command(ctx, caller, "rpc:command", sidecar, issuer, payload(&args))
}

/// `rpc:command-for-tab`: one specific tab of the calling window (split panes use it for everything).
pub fn rpc_command_for_tab(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let payload = payload(&args);
    let tab_id = str_field(payload, "tabId").map(str::to_string);
    let sidecar = tab_id.as_deref().and_then(|tab_id| ctx.tabs.sidecar_for_tab(caller.win_id, tab_id));
    dispatch_rpc_command(ctx, caller, "rpc:command-for-tab", sidecar, tab_id, payload)
}

// ---------------------------------------------------------------------------
// Side-channel responses
// ---------------------------------------------------------------------------

/// Route `payload[key]` to the sidecar that raised its request id, else to the
/// window's focused sidecar (ids raised before tracking, or after a restart).
fn respond_side_channel(ctx: &Arc<AppCtx>, caller: Caller, channel: &str, args: &[Value], key: &str, is_final: bool) -> Reply {
    let Some(frame) = payload(args).get(key).filter(|frame| frame.is_object()) else {
        return Reply::err(IpcError::bad_payload(channel, format!("expected {{ {key} }}")));
    };
    if let Some(id) = str_field(frame, "id") {
        if ctx.tabs.route_side_channel(id, frame.clone(), is_final) {
            return Reply::ok(Value::Null);
        }
    }
    if let Some(sidecar) = ctx.tabs.sidecar_for_window(caller.win_id) {
        sidecar.send_side_channel(frame.clone());
    }
    Reply::ok(Value::Null)
}

/// `extension-ui:respond`
pub fn extension_ui_respond(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    respond_side_channel(ctx, caller, "extension-ui:respond", &args, "response", true)
}

/// `host-tool:result`
pub fn host_tool_result(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    respond_side_channel(ctx, caller, "host-tool:result", &args, "result", true)
}

/// `host-tool:update`: keeps the route, because the result follows.
pub fn host_tool_update(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    respond_side_channel(ctx, caller, "host-tool:update", &args, "update", false)
}

/// `host-uri:result`
pub fn host_uri_result(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    respond_side_channel(ctx, caller, "host-uri:result", &args, "result", true)
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/// `tab:spawn`: a background tab of the calling window; `null` at the pool cap.
/// The renderer decides whether to activate it.
pub fn tab_spawn(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let payload = payload(&args).clone();
    let ctx = Arc::clone(ctx);
    Reply::Later(Box::pin(async move {
        let fallback_ctx = Arc::clone(&ctx);
        let deps = SpawnTabDeps {
            fallback_cwd: Box::new(move || fallback_ctx.tabs.cwd_for(caller, None).unwrap_or_else(|| initial_cwd(&fallback_ctx))),
            default_workspace: Box::new(|| ensure_default_workspace().map(|dir| path_string(&dir))),
        };
        spawn_tab_for_window(&ctx, caller.win_id, &payload, deps).await
    }))
}

/// `tab:close`: false when the tab is unknown or belongs to another window.
pub fn tab_close(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let Some(tab_id) = str_field(payload(&args), "tabId") else { return Reply::ok(json!(false)) };
    if ctx.tabs.sidecar_for_tab(caller.win_id, tab_id).is_none() {
        return Reply::ok(json!(false));
    }
    Reply::ok(json!(ctx.tabs.release_tab(tab_id)))
}

/// `tab:set-active`
pub fn tab_set_active(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let Some(tab_id) = str_field(payload(&args), "tabId") else { return Reply::ok(json!(false)) };
    Reply::ok(json!(ctx.tabs.set_active_tab(caller.win_id, tab_id)))
}

/// `tab:set-view`: the focused tab plus the one or two tabs the window renders.
pub fn tab_set_view(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let payload = payload(&args);
    let (Some(focused), Some(visible)) = (str_field(payload, "focusedTabId"), payload.get("visibleTabIds").and_then(Value::as_array)) else {
        return Reply::ok(json!(false));
    };
    let Some(visible) = visible.iter().map(|id| id.as_str().map(str::to_string)).collect::<Option<Vec<String>>>() else {
        return Reply::ok(json!(false));
    };
    let split = match payload.get("split") {
        None | Some(Value::Null) => None,
        Some(split) => match serde_json::from_value::<IpcTabViewSplit>(split.clone()) {
            Ok(split) => Some(split),
            // An unknown axis or a non-numeric ratio is refused, as TS refused it.
            Err(_) => return Reply::ok(json!(false)),
        },
    };
    Reply::ok(json!(ctx.tabs.set_tab_view(caller.win_id, focused, &visible, split)))
}

/// `tab:get-all`: the window's tabs in acquisition order.
pub fn tab_get_all(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = args;
    Reply::Ready(serde_json::to_value(ctx.tabs.tabs_for_window(caller.win_id)).map_err(IpcError::from))
}

/// `tab:get-session-owner`: which tab and window hold a session file, if any.
pub fn tab_get_session_owner(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = caller;
    let Some(session_path) = str_field(payload(&args), "sessionPath") else { return Reply::ok(Value::Null) };
    Reply::Ready(serde_json::to_value(ctx.tabs.session_owner(session_path)).map_err(IpcError::from))
}

// ---------------------------------------------------------------------------
// Launch profiles
// ---------------------------------------------------------------------------

fn trimmed_string(record: &Map<String, Value>, key: &str) -> Option<String> {
    record.get(key).and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty()).map(str::to_string)
}

fn string_list(record: &Map<String, Value>, key: &str) -> Option<Value> {
    let items: Vec<Value> = record
        .get(key)?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(|item| Value::String(item.to_string()))
        .collect();
    (!items.is_empty()).then_some(Value::Array(items))
}

/// `parseLaunchProfile` from `src/shared/launch-profile.ts`: sanitize untrusted
/// prefs JSON into a launch profile. Unknown keys are dropped, and blank values
/// normalize away, so an empty result means "no profile". It must stay
/// identical to the `omp` module's port, which reads the profile at spawn.
fn parse_launch_profile(raw: Option<&Value>) -> Map<String, Value> {
    let mut profile = Map::new();
    let Some(record) = raw.and_then(Value::as_object) else { return profile };
    // The prompts keep their text untrimmed; only a blank one is dropped.
    for key in ["systemPrompt", "appendSystemPrompt"] {
        if let Some(text) = record.get(key).and_then(Value::as_str).filter(|text| !text.trim().is_empty()) {
            profile.insert(key.into(), Value::String(text.to_string()));
        }
    }
    if record.get("noRules") == Some(&Value::Bool(true)) {
        profile.insert("noRules".into(), Value::Bool(true));
    }
    for key in ["addDirs", "tools"] {
        if let Some(list) = string_list(record, key) {
            profile.insert(key.into(), list);
        }
    }
    for key in ["noLsp", "planYolo"] {
        if record.get(key) == Some(&Value::Bool(true)) {
            profile.insert(key.into(), Value::Bool(true));
        }
    }
    for key in ["profile", "sessionDir", "config"] {
        if let Some(text) = trimmed_string(record, key) {
            profile.insert(key.into(), Value::String(text));
        }
    }
    profile
}

/// `prefs:update-launch-profile`: merge a patch into `launchProfiles.<cwd>`.
/// The read-merge-write runs under the prefs lock, so concurrent windows editing
/// different fields or workspaces never replace each other.
pub fn prefs_update_launch_profile(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = caller;
    let payload = payload(&args);
    let cwd = str_field(payload, "cwd").filter(|cwd| Path::new(cwd).is_absolute());
    let (Some(cwd), Some(patch)) = (cwd, payload.get("patch").and_then(Value::as_object)) else {
        return Reply::err(IpcError::new("Invalid launch profile update"));
    };
    let mut profile = Map::new();
    let written = ctx.prefs.update("launchProfiles", |raw| {
        let mut profiles = raw.and_then(|raw| raw.as_object().cloned()).unwrap_or_default();
        let mut merged = parse_launch_profile(profiles.get(cwd));
        merged.extend(patch.clone());
        profile = parse_launch_profile(Some(&Value::Object(merged)));
        if profile.is_empty() {
            profiles.remove(cwd);
        } else {
            profiles.insert(cwd.to_string(), Value::Object(profile.clone()));
        }
        Some(Value::Object(profiles))
    });
    match written {
        Ok(()) => Reply::ok(Value::Object(profile)),
        Err(error) => Reply::err(IpcError::new(error.to_string())),
    }
}

// ---------------------------------------------------------------------------
// Sidecar control
// ---------------------------------------------------------------------------

/// `sidecar:restart`: a named tab of the window, else its focused tab.
pub fn sidecar_restart(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let payload = payload(&args);
    let sidecar = match str_field(payload, "tabId") {
        Some(tab_id) => ctx.tabs.sidecar_for_tab(caller.win_id, tab_id),
        None => ctx.tabs.sidecar_for_window(caller.win_id),
    };
    let Some(sidecar) = sidecar else { return Reply::err(IpcError::new("Unknown tab")) };
    sidecar.restart(None, str_field(payload, "sessionPath").filter(|path| !path.is_empty()));
    Reply::ok(Value::Null)
}

/// Point this window at `cwd`: remember it as the last project, keep the window
/// record in sync (the menu's New Window reads it) and restart only this window's sidecar.
fn switch_project(ctx: &AppCtx, caller: Caller, sidecar: &dyn SidecarHandle, cwd: &str) -> Result<(), IpcError> {
    ctx.prefs.set("lastProject", json!(cwd)).map_err(|error| IpcError::new(error.to_string()))?;
    ctx.desktop.set_cwd(caller.win_id, cwd);
    sidecar.restart(Some(cwd), None);
    Ok(())
}

/// `sidecar:select-project`: pick a folder, then switch this window to it; `null` on cancel.
pub fn sidecar_select_project(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = args;
    let Some(sidecar) = ctx.tabs.sidecar_for_window(caller.win_id) else { return Reply::ok(Value::Null) };
    let options = OpenDialogOptions {
        title: Some(ctx.i18n.t(MainTextKey::DialogOpenProject)),
        default_path: Some(sidecar.cwd().into()),
        directory: true,
        can_create_directories: true,
        parent: Some(caller.win_id),
        ..Default::default()
    };
    let ctx = Arc::clone(ctx);
    Reply::Later(Box::pin(async move {
        let picked = ctx.host.open_dialog(options).await;
        let Some(cwd) = picked.and_then(|paths| paths.into_iter().next()).map(|path| path_string(&path)).filter(|cwd| !cwd.is_empty()) else {
            return Ok(Value::Null);
        };
        switch_project(&ctx, caller, sidecar.as_ref(), &cwd)?;
        Ok(json!(cwd))
    }))
}

/// `sidecar:set-project`: switch to a known directory (no picker); false when it is not one.
pub fn sidecar_set_project(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let Some(cwd) = str_field(payload(&args), "cwd").filter(|cwd| !cwd.is_empty()) else { return Reply::ok(json!(false)) };
    let Some(sidecar) = ctx.tabs.sidecar_for_window(caller.win_id) else { return Reply::ok(json!(false)) };
    if !paths::is_existing_directory(cwd) {
        return Reply::ok(json!(false));
    }
    match switch_project(ctx, caller, sidecar.as_ref(), cwd) {
        Ok(()) => Reply::ok(json!(true)),
        Err(error) => Reply::err(error),
    }
}

/// `sidecar:default-workspace`: the Work workspace, created on demand.
pub fn sidecar_default_workspace(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    match ensure_default_workspace() {
        Ok(dir) => Reply::ok(json!(path_string(&dir))),
        Err(error) => Reply::err(IpcError::new(format!("could not create the Work workspace: {error}"))),
    }
}

/// `sidecar:status-get`: the focused sidecar's status (`starting` before one binds) and the window's cwd.
pub fn sidecar_status_get(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = args;
    let status = ctx.tabs.sidecar_for_window(caller.win_id).map_or(SidecarStatus::Starting, |sidecar| sidecar.status());
    let cwd = ctx.tabs.cwd_for(caller, None).unwrap_or_default();
    Reply::ok(json!({ "status": status_name(status), "cwd": cwd }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::{dispatch_for_test, Registry};
    use crate::ports::{AcquireOptions, SidecarError, SidecarEvent, WindowId, WindowRecord};
    use crate::tabs::Tabs;
    use crate::testing::{fake_ctx_cyclic, FakeSidecar, Fakes, RecordingSink};

    const WIN: WindowId = WindowId(1);

    struct Harness {
        fakes: Fakes,
        ctx: Arc<AppCtx>,
        sink: Arc<RecordingSink>,
    }

    /// The real `Tabs` behind the real channel table, over fakes; window 1 is attached.
    fn harness() -> Harness {
        let fakes = Fakes::default();
        let mut registry = Registry::new();
        crate::tabs::register(&mut registry);
        let ctx = fake_ctx_cyclic(&fakes, registry, |ctx, ports| ports.tabs = Some(Arc::new(Tabs::new(ctx.clone()))));
        fakes.desktop.add_record(WindowRecord { id: WIN, cwd: "/window-cwd".into(), pending_session_path: None });
        let sink = Arc::new(RecordingSink::default());
        ctx.bridge.attach(&ctx, Caller::main(WIN), "test-gen".into(), sink.clone());
        Harness { fakes, ctx, sink }
    }

    impl Harness {
        async fn call(&self, channel: &str, args: Vec<Value>) -> Result<Value, IpcError> {
            dispatch_for_test(&self.ctx, Caller::main(WIN), channel, args).await
        }

        async fn ok(&self, channel: &str, args: Vec<Value>) -> Value {
            self.call(channel, args).await.unwrap()
        }

        fn tab(&self, cwd: &str, tab_id: &str) -> Arc<FakeSidecar> {
            self.ctx.tabs.acquire(AcquireOptions { tab_id: Some(tab_id.into()), ..AcquireOptions::new(cwd, WIN) }).unwrap();
            self.fakes.omp.sidecars.lock().unwrap().last().cloned().unwrap()
        }

        fn ready_tab(&self, cwd: &str, tab_id: &str) -> Arc<FakeSidecar> {
            let sidecar = self.tab(cwd, tab_id);
            *sidecar.status.lock().unwrap() = SidecarStatus::Ready;
            sidecar
        }

        fn sent(&self, channel: &str) -> Vec<Value> {
            self.sink.sent().into_iter().filter(|envelope| envelope.channel == channel).map(|envelope| envelope.payload).collect()
        }
    }

    async fn settle() {
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
    }

    fn calls(sidecar: &FakeSidecar, prefix: &str) -> Vec<String> {
        sidecar.log.calls().into_iter().filter(|call| call.starts_with(prefix)).collect()
    }

    #[tokio::test]
    async fn rpc_command_sends_to_the_focused_tab_and_learns_its_session_from_get_state() {
        let h = harness();
        // No tab yet: a response, never a rejection.
        let command = json!({ "id": "1", "type": "get_state" });
        assert_eq!(
            h.ok("rpc:command", vec![json!({ "command": command })]).await,
            json!({ "id": "1", "type": "response", "success": false, "error": "Sidecar not connected" })
        );

        let sidecar = h.tab("/a", "tab-a");
        assert_eq!(
            h.ok("rpc:command", vec![json!({ "command": command })]).await,
            json!({ "id": "1", "type": "response", "success": false, "error": "Sidecar not ready (starting)" })
        );

        *sidecar.status.lock().unwrap() = SidecarStatus::Ready;
        let state = json!({ "id": "1", "type": "response", "command": "get_state", "success": true, "data": { "sessionFile": "/s/a.jsonl", "cwd": "/moved" } });
        sidecar.responses.lock().unwrap().push(Ok(state.clone()));
        assert_eq!(h.ok("rpc:command", vec![json!({ "command": command, "timeoutMs": 5000 })]).await, state);
        assert_eq!(calls(&sidecar, "request("), [format!("request({command}, Some(5000))")]);
        assert_eq!(h.ctx.tabs.session_owner("/s/a.jsonl").map(|owner| owner.tab_id).as_deref(), Some("tab-a"));
        assert_eq!(sidecar.cwd(), "/moved");
        assert!(h.fakes.desktop.log.calls().contains(&"set_cwd(1, /moved)".to_string()));

        // A delivery failure resolves as an uncertain-delivery response.
        sidecar.responses.lock().unwrap().push(Err(SidecarError::Timeout { timeout_ms: 30_000, command_type: "prompt".into() }));
        assert_eq!(
            h.ok("rpc:command", vec![json!({ "command": { "id": "2", "type": "prompt" } })]).await,
            json!({ "id": "2", "type": "response", "success": false, "code": "rpc_delivery_unknown", "error": "RPC timeout (30000ms): prompt" })
        );

        // A payload without a command is refused.
        assert!(h.call("rpc:command", vec![json!({})]).await.is_err());
    }

    #[tokio::test]
    async fn rpc_command_for_tab_targets_a_background_tab_and_guards_session_ownership() {
        let h = harness();
        h.ctx.tabs.acquire(AcquireOptions { tab_id: Some("tab-a".into()), session_path: Some("/s/a.jsonl".into()), ..AcquireOptions::new("/a", WIN) });
        let b = h.ready_tab("/b", "tab-b");

        // A switch onto a file another tab owns is refused before dispatch.
        let refused = h
            .ok("rpc:command-for-tab", vec![json!({ "tabId": "tab-b", "command": { "id": "7", "type": "switch_session", "sessionPath": "/s/a.jsonl" } })])
            .await;
        assert_eq!(
            refused,
            json!({
                "id": "7", "type": "response", "command": "switch_session", "success": false,
                "error": "Session is already open in another tab", "code": "session_owned_elsewhere",
                "data": { "ownerTabId": "tab-a", "ownerWinId": 1 },
            })
        );
        assert!(calls(&b, "request(").is_empty());

        // A free file is attached to the issuing tab once the switch succeeds.
        b.responses.lock().unwrap().push(Ok(json!({ "type": "response", "success": true, "data": { "cancelled": false } })));
        let switched = h
            .ok("rpc:command-for-tab", vec![json!({ "tabId": "tab-b", "command": { "id": "8", "type": "switch_session", "sessionPath": "/s/b.jsonl" } })])
            .await;
        assert_eq!(switched["success"], json!(true));
        assert_eq!(h.ctx.tabs.session_owner("/s/b.jsonl").map(|owner| owner.tab_id).as_deref(), Some("tab-b"));

        // An unknown tab has no sidecar.
        let unknown = h.ok("rpc:command-for-tab", vec![json!({ "tabId": "nope", "command": { "id": "9", "type": "get_state" } })]).await;
        assert_eq!(unknown["error"], json!("Sidecar not connected"));
    }

    #[tokio::test]
    async fn extension_ui_respond_routes_to_the_raising_tab_and_falls_back_to_the_focused_one() {
        let h = harness();
        let a = h.tab("/a", "tab-a");
        let b = h.tab("/b", "tab-b");
        a.emit(SidecarEvent::ExtensionUi(json!({ "type": "extension_ui_request", "id": "req-1", "method": "confirm" })));
        settle().await;
        assert_eq!(h.sent("extension-ui:request").len(), 1);
        h.ok("tab:set-active", vec![json!({ "tabId": "tab-b" })]).await;

        let response = json!({ "type": "extension_ui_response", "id": "req-1", "confirmed": true });
        assert_eq!(h.ok("extension-ui:respond", vec![json!({ "response": response })]).await, Value::Null);
        assert_eq!(*a.side_channel.lock().unwrap(), [response.clone()]);
        // The route is consumed: the same id now goes to the focused tab.
        h.ok("extension-ui:respond", vec![json!({ "response": response })]).await;
        assert_eq!(*b.side_channel.lock().unwrap(), [response]);
        assert!(h.call("extension-ui:respond", vec![json!({})]).await.is_err());
    }

    #[tokio::test]
    async fn host_tool_result_routes_to_the_tab_that_called_the_tool() {
        let h = harness();
        let a = h.tab("/a", "tab-a");
        let b = h.tab("/b", "tab-b");
        a.emit(SidecarEvent::HostToolCall(json!({ "type": "host_tool_call", "id": "tool-1", "toolCallId": "c1", "toolName": "renderer_tool", "arguments": {} })));
        settle().await;
        assert_eq!(h.sent("host-tool:call")[0]["request"]["toolName"], json!("renderer_tool"));
        h.ok("tab:set-active", vec![json!({ "tabId": "tab-b" })]).await;

        let result = json!({ "type": "host_tool_result", "id": "tool-1", "result": "done" });
        h.ok("host-tool:result", vec![json!({ "result": result })]).await;
        assert_eq!(*a.side_channel.lock().unwrap(), [result]);
        assert!(b.side_channel.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn host_tool_update_keeps_the_route_for_the_result() {
        let h = harness();
        let a = h.tab("/a", "tab-a");
        a.emit(SidecarEvent::HostToolCall(json!({ "type": "host_tool_call", "id": "tool-2", "toolCallId": "c2", "toolName": "renderer_tool", "arguments": {} })));
        settle().await;
        let b = h.tab("/b", "tab-b");
        h.ok("tab:set-active", vec![json!({ "tabId": "tab-b" })]).await;

        let update = json!({ "type": "host_tool_update", "id": "tool-2", "update": "working" });
        h.ok("host-tool:update", vec![json!({ "update": update })]).await;
        h.ok("host-tool:update", vec![json!({ "update": update })]).await;
        assert_eq!(*a.side_channel.lock().unwrap(), [update.clone(), update]);
        assert!(b.side_channel.lock().unwrap().is_empty());
        assert!(h.ctx.tabs.route_side_channel("tool-2", json!({ "type": "host_tool_result", "id": "tool-2" }), true));
    }

    #[tokio::test]
    async fn host_uri_result_routes_to_the_requesting_tab() {
        let h = harness();
        let a = h.tab("/a", "tab-a");
        let b = h.tab("/b", "tab-b");
        a.emit(SidecarEvent::HostUriRequest(json!({ "type": "host_uri_request", "id": "uri-1", "operation": "read", "url": "https://example.com" })));
        settle().await;
        h.ok("tab:set-active", vec![json!({ "tabId": "tab-b" })]).await;

        let result = json!({ "type": "host_uri_result", "id": "uri-1", "content": "data" });
        h.ok("host-uri:result", vec![json!({ "result": result })]).await;
        assert_eq!(*a.side_channel.lock().unwrap(), [result]);
        assert!(b.side_channel.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn tab_spawn_acquires_a_fresh_background_tab_in_the_calling_window() {
        let h = harness();
        h.tab("/a", "tab-a");
        let spawned = h.ok("tab:spawn", vec![json!({ "cwd": "/work" })]).await;
        let tab_id = spawned["tabId"].as_str().unwrap().to_string();
        assert_eq!(spawned, json!({ "tabId": tab_id }));
        let tabs = h.ctx.tabs.tabs_for_window(WIN);
        assert_eq!(tabs.iter().map(|tab| tab.tab_id.as_str()).collect::<Vec<_>>(), ["tab-a", tab_id.as_str()]);
        // Spawning never switches: the first tab stays focused.
        assert_eq!(h.ctx.tabs.active_tab_for_window(WIN).as_deref(), Some("tab-a"));
        let options = h.fakes.omp.sidecars.lock().unwrap()[1].options.clone();
        assert_eq!((options.cwd.as_str(), options.fresh), ("/work", true));

        // Without a cwd the tab starts in the caller's cwd.
        let spawned = h.ok("tab:spawn", vec![json!({})]).await;
        assert!(spawned["tabId"].is_string());
        assert_eq!(h.fakes.omp.sidecars.lock().unwrap()[2].options.cwd, "/a");

        // Work mode reports the workspace it created.
        let work = h.ok("tab:spawn", vec![json!({ "defaultWorkspace": true })]).await;
        let workspace = path_string(&ensure_default_workspace().unwrap());
        assert_eq!(work["cwd"], json!(workspace));

        // A session another tab owns is refused with its owner.
        h.ctx.tabs.note_session_file("tab-a", Some("/s/a.jsonl"));
        let refused = h.ok("tab:spawn", vec![json!({ "sessionPath": "/s/a.jsonl" })]).await;
        assert_eq!(refused, json!({ "tabId": null, "ownerTabId": "tab-a", "ownerWinId": 1, "refusal": "owned" }));
    }

    #[tokio::test]
    async fn tab_close_releases_only_the_calling_window_s_tabs() {
        let h = harness();
        let a = h.tab("/a", "tab-a");
        h.ctx.tabs.acquire(AcquireOptions { tab_id: Some("tab-other".into()), ..AcquireOptions::new("/o", WindowId(2)) });

        assert_eq!(h.ok("tab:close", vec![json!({ "tabId": "tab-other" })]).await, json!(false));
        assert_eq!(h.ok("tab:close", vec![json!({ "tabId": "nope" })]).await, json!(false));
        assert_eq!(h.ok("tab:close", vec![json!({})]).await, json!(false));
        assert_eq!(h.ok("tab:close", vec![json!({ "tabId": "tab-a" })]).await, json!(true));
        assert!(a.log.calls().contains(&"dispose()".to_string()));
        assert_eq!(h.ctx.tabs.size(), 1);
    }

    #[tokio::test]
    async fn tab_set_active_moves_the_focus_within_the_window() {
        let h = harness();
        h.tab("/a", "tab-a");
        h.tab("/b", "tab-b");
        assert_eq!(h.ok("tab:set-active", vec![json!({ "tabId": "tab-b" })]).await, json!(true));
        assert_eq!(h.ctx.tabs.active_tab_for_window(WIN).as_deref(), Some("tab-b"));
        assert_eq!(h.ok("tab:set-active", vec![json!({ "tabId": "nope" })]).await, json!(false));
        assert_eq!(h.ok("tab:set-active", vec![Value::Null]).await, json!(false));
    }

    #[tokio::test]
    async fn tab_set_view_shows_two_tabs_and_refuses_a_malformed_view() {
        let h = harness();
        h.tab("/a", "tab-a");
        h.tab("/b", "tab-b");
        let split = json!({ "axis": "rows", "firstTabId": "tab-a", "secondTabId": "tab-b", "ratio": 0.95 });
        assert_eq!(h.ok("tab:set-view", vec![json!({ "focusedTabId": "tab-b", "visibleTabIds": ["tab-a", "tab-b"], "split": split })]).await, json!(true));
        let tabs = serde_json::to_value(h.ctx.tabs.tabs_for_window(WIN)).unwrap();
        // The ratio is clamped to 0.2–0.8.
        assert_eq!(tabs[0]["split"], json!({ "axis": "rows", "index": 0, "ratio": 0.8 }));
        assert_eq!(tabs[1]["active"], json!(true));

        let bad_axis = json!({ "axis": "diagonal", "firstTabId": "tab-a", "secondTabId": "tab-b", "ratio": 0.5 });
        assert_eq!(h.ok("tab:set-view", vec![json!({ "focusedTabId": "tab-a", "visibleTabIds": ["tab-a", "tab-b"], "split": bad_axis })]).await, json!(false));
        assert_eq!(h.ok("tab:set-view", vec![json!({ "focusedTabId": "tab-a", "visibleTabIds": "tab-a" })]).await, json!(false));
        assert_eq!(h.ok("tab:set-view", vec![json!({ "focusedTabId": "tab-a", "visibleTabIds": [1] })]).await, json!(false));
        assert_eq!(h.ok("tab:set-view", vec![json!({ "focusedTabId": "tab-a", "visibleTabIds": ["tab-a"], "split": null })]).await, json!(true));
    }

    #[tokio::test]
    async fn tab_get_all_lists_the_window_s_tabs_in_order() {
        let h = harness();
        assert_eq!(h.ok("tab:get-all", vec![]).await, json!([]));
        h.tab("/a", "tab-a");
        h.tab("/b", "tab-b");
        assert_eq!(
            h.ok("tab:get-all", vec![]).await,
            json!([
                { "kind": "agent", "tabId": "tab-a", "cwd": "/a", "status": "starting", "active": true, "visible": true, "placeholder": false, "sessionPath": null },
                { "kind": "agent", "tabId": "tab-b", "cwd": "/b", "status": "starting", "placeholder": false, "sessionPath": null },
            ])
        );
    }

    #[tokio::test]
    async fn tab_get_session_owner_reports_the_owning_tab_and_window() {
        let h = harness();
        h.ctx.tabs.acquire(AcquireOptions { tab_id: Some("tab-a".into()), session_path: Some("/s/a.jsonl".into()), ..AcquireOptions::new("/a", WIN) });
        assert_eq!(h.ok("tab:get-session-owner", vec![json!({ "sessionPath": "/s/a.jsonl" })]).await, json!({ "tabId": "tab-a", "winId": 1 }));
        assert_eq!(h.ok("tab:get-session-owner", vec![json!({ "sessionPath": "/s/free.jsonl" })]).await, Value::Null);
        assert_eq!(h.ok("tab:get-session-owner", vec![json!({})]).await, Value::Null);
    }

    #[tokio::test]
    async fn prefs_update_launch_profile_merges_sanitizes_and_drops_empty_profiles() {
        let h = harness();
        h.ctx.prefs.set("launchProfiles", json!({ "/other": { "noLsp": true } })).unwrap();

        let profile = h
            .ok("prefs:update-launch-profile", vec![json!({ "cwd": "/repo", "patch": { "systemPrompt": "  Be terse ", "tools": [" read ", "", 3], "--session": "x" } })])
            .await;
        assert_eq!(profile, json!({ "systemPrompt": "  Be terse ", "tools": ["read"] }));
        let merged = h.ok("prefs:update-launch-profile", vec![json!({ "cwd": "/repo", "patch": { "profile": " fast ", "noRules": true } })]).await;
        assert_eq!(merged, json!({ "systemPrompt": "  Be terse ", "tools": ["read"], "noRules": true, "profile": "fast" }));
        assert_eq!(h.ctx.prefs.get("launchProfiles"), Some(json!({ "/other": { "noLsp": true }, "/repo": merged })));

        // Clearing every field removes the workspace's entry.
        let cleared = h
            .ok("prefs:update-launch-profile", vec![json!({ "cwd": "/repo", "patch": { "systemPrompt": "", "tools": [], "noRules": false, "profile": " " } })])
            .await;
        assert_eq!(cleared, json!({}));
        assert_eq!(h.ctx.prefs.get("launchProfiles"), Some(json!({ "/other": { "noLsp": true } })));

        for invalid in [json!({ "cwd": "relative", "patch": {} }), json!({ "cwd": "/repo", "patch": [] }), json!({ "cwd": "/repo" })] {
            let error = h.call("prefs:update-launch-profile", vec![invalid]).await.unwrap_err();
            assert_eq!(error.message, "Invalid launch profile update");
        }
    }

    #[tokio::test]
    async fn sidecar_restart_restarts_the_focused_or_named_tab() {
        let h = harness();
        let a = h.tab("/a", "tab-a");
        let b = h.tab("/b", "tab-b");
        assert_eq!(h.ok("sidecar:restart", vec![Value::Null]).await, Value::Null);
        assert_eq!(calls(&a, "restart("), ["restart(None, None)"]);
        h.ok("sidecar:restart", vec![json!({ "tabId": "tab-b", "sessionPath": "/s/b.jsonl" })]).await;
        assert_eq!(calls(&b, "restart("), [r#"restart(None, Some("/s/b.jsonl"))"#]);
        assert_eq!(h.call("sidecar:restart", vec![json!({ "tabId": "nope" })]).await.unwrap_err().message, "Unknown tab");
    }

    #[tokio::test]
    async fn sidecar_status_get_reports_the_focused_sidecar_or_starting() {
        let h = harness();
        // Before a sidecar binds: "starting" and the window record's cwd.
        assert_eq!(h.ok("sidecar:status-get", vec![]).await, json!({ "status": "starting", "cwd": "/window-cwd" }));
        h.ready_tab("/a", "tab-a");
        assert_eq!(h.ok("sidecar:status-get", vec![]).await, json!({ "status": "ready", "cwd": "/a" }));
    }

    #[tokio::test]
    async fn sidecar_select_project_switches_the_window_to_the_picked_folder() {
        let h = harness();
        // No sidecar: nothing to switch.
        assert_eq!(h.ok("sidecar:select-project", vec![]).await, Value::Null);
        assert!(h.fakes.host.log.calls().is_empty());

        let sidecar = h.tab("/a", "tab-a");
        h.fakes.host.open_dialog_answers.lock().unwrap().extend([Some(vec![PathBuf::from("/picked")]), None]);
        assert_eq!(h.ok("sidecar:select-project", vec![]).await, json!("/picked"));
        let dialog = h.fakes.host.log.calls()[0].clone();
        let expected = OpenDialogOptions {
            title: Some("Open project".into()),
            default_path: Some(PathBuf::from("/a")),
            directory: true,
            can_create_directories: true,
            parent: Some(WIN),
            ..Default::default()
        };
        assert_eq!(dialog, format!("open_dialog({expected:?})"));
        assert_eq!(h.ctx.prefs.get_string("lastProject").as_deref(), Some("/picked"));
        assert!(h.fakes.desktop.log.calls().contains(&"set_cwd(1, /picked)".to_string()));
        assert_eq!(calls(&sidecar, "restart("), [r#"restart(Some("/picked"), None)"#]);

        // Cancelled: nothing changes.
        assert_eq!(h.ok("sidecar:select-project", vec![]).await, Value::Null);
        assert_eq!(calls(&sidecar, "restart(").len(), 1);
    }

    #[tokio::test]
    async fn sidecar_set_project_switches_only_to_an_existing_directory() {
        let h = harness();
        let project = tempfile::tempdir().unwrap();
        let project_path = path_string(project.path());
        assert_eq!(h.ok("sidecar:set-project", vec![json!({ "cwd": project_path })]).await, json!(false));

        let sidecar = h.tab("/a", "tab-a");
        assert_eq!(h.ok("sidecar:set-project", vec![json!({ "cwd": project_path })]).await, json!(true));
        assert_eq!(h.ctx.prefs.get_string("lastProject"), Some(project_path.clone()));
        assert!(h.fakes.desktop.log.calls().contains(&format!("set_cwd(1, {project_path})")));
        assert_eq!(calls(&sidecar, "restart("), [format!("restart(Some({project_path:?}), None)")]);

        let missing = path_string(&project.path().join("missing"));
        assert_eq!(h.ok("sidecar:set-project", vec![json!({ "cwd": missing })]).await, json!(false));
        assert_eq!(h.ok("sidecar:set-project", vec![json!({ "cwd": "" })]).await, json!(false));
        assert_eq!(calls(&sidecar, "restart(").len(), 1);
    }

    #[tokio::test]
    async fn sidecar_default_workspace_creates_and_returns_the_work_workspace() {
        let h = harness();
        let workspace = h.ok("sidecar:default-workspace", vec![]).await;
        let path = PathBuf::from(workspace.as_str().unwrap());
        assert!(path.is_dir());
        assert!(path.ends_with(format!("{}-tabs-work", std::process::id())));
    }

    #[test]
    fn parse_launch_profile_keeps_only_known_non_blank_fields() {
        assert!(parse_launch_profile(Some(&json!(["--session"]))).is_empty());
        assert!(parse_launch_profile(None).is_empty());
        let parsed = parse_launch_profile(Some(&json!({
            "systemPrompt": " ", "appendSystemPrompt": " more ", "noRules": "yes", "addDirs": [" /x ", 1], "noLsp": true,
            "planYolo": false, "sessionDir": " /s ", "config": "", "extra": true,
        })));
        assert_eq!(Value::Object(parsed), json!({ "appendSystemPrompt": " more ", "addDirs": ["/x"], "noLsp": true, "sessionDir": "/s" }));
    }
}
