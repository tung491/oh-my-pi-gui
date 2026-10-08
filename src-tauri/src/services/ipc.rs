//! Handlers for the channels this module owns. Every body starts as a
//! `not_ported` stub; the module's port replaces them and `check-module.sh`
//! fails while any stub remains.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};

use crate::bridge::{IpcError, Reply};
use crate::ctx::AppCtx;
use crate::ports::{Caller, SessionKind, SessionScope};

use super::fs as workspace_fs;

/// `~/` expands against the home directory; everything else passes through unchanged.
pub(super) fn expand_home(path: &str) -> String {
    expand_home_in(path, dirs::home_dir().as_deref())
}

pub(super) fn expand_home_in(path: &str, home: Option<&Path>) -> String {
    match (path.strip_prefix("~/"), home) {
        (Some(rest), Some(home)) => home.join(rest).to_string_lossy().into_owned(),
        _ => path.to_string(),
    }
}

/// `runtime:error-report`
pub fn runtime_error_report(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    // Normalized and bounded by the runtime log; the cwd comes from the caller's window.
    let report = args.into_iter().next().unwrap_or(Value::Null);
    let cwd = ctx.desktop.record(caller.win_id).map(|record| record.cwd);
    crate::runtime_log::write(&report, Some(caller.win_id.0), cwd.as_deref());
    Reply::ok(Value::Null)
}

/// `runtime:log-path`
pub fn runtime_log_path(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::ok(Value::String(crate::runtime_log::path().to_string_lossy().to_string()))
}

/// `log:snapshot`
pub fn log_snapshot(ctx: &Arc<AppCtx>, _caller: Caller, _args: Vec<Value>) -> Reply {
    let Some(services) = ctx.services.as_any().downcast_ref::<crate::services::Services>() else {
        return Reply::ok(json!({ "lines": Vec::<String>::new(), "nextSequence": 0 }));
    };
    let snapshot = services.log_watcher.snapshot();
    Reply::ok(json!({ "lines": snapshot.lines, "nextSequence": snapshot.next_sequence }))
}

fn requested_scope(payload: &Value) -> SessionScope {
    if payload.get("scope").and_then(Value::as_str) == Some("local") { SessionScope::Local } else { SessionScope::Global }
}

/// `sessions:list`
pub fn sessions_list(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let payload = args.into_iter().next().unwrap_or(Value::Null);
    let scope = requested_scope(&payload);
    let cwd = ctx.tabs.cwd_for(caller, None);
    let ctx = ctx.clone();
    Reply::Later(Box::pin(async move {
        let sessions = ctx.services.sessions_list(scope, cwd).await.map_err(|error| IpcError::new(error.to_string()))?;
        Ok(serde_json::to_value(sessions).unwrap_or(Value::Null))
    }))
}

fn rpc_response_ok(response: &Value) -> Result<(), IpcError> {
    if response.get("success").and_then(Value::as_bool) == Some(true) {
        return Ok(());
    }
    Err(IpcError::new(response.get("error").and_then(Value::as_str).unwrap_or("Sidecar request failed").to_string()))
}

/// `sessions:delete`, ported exactly from `ipc.ts:582-602`: refuse only while
/// the owning tab's sidecar is running; if the owner is live and idle, send
/// it `drop_session` and await the reply before deleting; if the owner has no
/// process, drop the claim first so a restored tab cannot wake into a path
/// that no longer exists, then delete.
pub fn sessions_delete(ctx: &Arc<AppCtx>, _caller: Caller, args: Vec<Value>) -> Reply {
    let payload = args.into_iter().next().unwrap_or(Value::Null);
    let session_path = match payload.get("sessionPath").and_then(Value::as_str) {
        Some(path) if path.ends_with(".jsonl") => path.to_string(),
        _ => return Reply::err(IpcError::new("Invalid session path")),
    };
    let owner = ctx.tabs.session_owner(&session_path);
    let is_live = owner.is_some() && ctx.tabs.session_owner_is_live(&session_path);
    if is_live {
        // The command is queued on the owner's stdin before `command_for_idle_session`
        // returns, so calling it synchronously here and awaiting only the reply is safe.
        let pending = ctx.tabs.command_for_idle_session(&session_path, json!({ "type": "drop_session" }));
        let ctx = ctx.clone();
        return Reply::Later(Box::pin(async move {
            let Some(response) = pending.await else { return Err(IpcError::new("Session is currently running")) };
            rpc_response_ok(&response)?;
            let cancelled = response.get("data").and_then(|data| data.get("cancelled")).and_then(Value::as_bool).unwrap_or(false);
            if cancelled {
                return Err(IpcError::new("Session deletion was cancelled"));
            }
            ctx.services.session_delete(&session_path).await.map(|_| Value::Null).map_err(|error| IpcError::new(error.to_string()))
        }));
    }
    // Either no tab claims the file, or the claiming tab has no process (a
    // restored tab that was never shown). Nothing is loaded anywhere, so the
    // file IS the session — drop the tab's claim first.
    if let Some(owner) = owner {
        ctx.tabs.note_session_file(&owner.tab_id, None);
    }
    let ctx = ctx.clone();
    Reply::Later(Box::pin(async move {
        ctx.services.session_delete(&session_path).await.map(|_| Value::Null).map_err(|error| IpcError::new(error.to_string()))
    }))
}

/// `sessions:rename`, same ownership rules as delete (`ipc.ts:603-632`); the
/// no-owner fallback uses the caller's own sidecar when it is ready and connected.
pub fn sessions_rename(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let payload = args.into_iter().next().unwrap_or(Value::Null);
    let session_path = match payload.get("sessionPath").and_then(Value::as_str) {
        Some(path) if path.ends_with(".jsonl") => path.to_string(),
        _ => return Reply::err(IpcError::new("Invalid session path")),
    };
    let name = payload.get("name").and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
    if name.is_empty() {
        return Reply::err(IpcError::new("Session name cannot be empty"));
    }
    let command = json!({ "type": "set_session_name", "name": name, "sessionPath": session_path });
    let live_owner = ctx.tabs.session_owner(&session_path).is_some() && ctx.tabs.session_owner_is_live(&session_path);
    if live_owner {
        let pending = ctx.tabs.command_for_idle_session(&session_path, command);
        return Reply::Later(Box::pin(async move {
            let Some(response) = pending.await else { return Err(IpcError::new("Session is currently running")) };
            rpc_response_ok(&response)?;
            Ok(Value::Null)
        }));
    }
    if let Some(sidecar) = ctx.tabs.sidecar_for_window(caller.win_id) {
        if sidecar.status() == crate::ports::SidecarStatus::Ready && sidecar.has_rpc_client() {
            let pending = sidecar.request(command, None);
            return Reply::Later(Box::pin(async move {
                let response = pending.await.map_err(|error| IpcError::new(error.to_string()))?;
                rpc_response_ok(&response)?;
                Ok(Value::Null)
            }));
        }
    }
    Reply::err(IpcError::new("Sidecar not connected"))
}

/// `sessions:search`: full-content search over the same candidate set the list view would show.
pub fn sessions_search(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let payload = args.into_iter().next().unwrap_or(Value::Null);
    let scope = requested_scope(&payload);
    let query = payload.get("query").and_then(Value::as_str).unwrap_or("").to_string();
    let cwd = ctx.tabs.cwd_for(caller, None);
    let ctx = ctx.clone();
    Reply::Later(Box::pin(async move {
        let candidates = ctx.services.sessions_list(scope, cwd).await.map_err(|error| IpcError::new(error.to_string()))?;
        let paths: Vec<String> = candidates.into_iter().map(|info| info.path).collect();
        let results = ctx.services.session_search(&query, paths).await;
        Ok(serde_json::to_value(results).unwrap_or(Value::Null))
    }))
}

/// `session:open-new-window`: open a session (or a fresh project window) in a
/// new parallel window with its own sidecar; focuses the owner window instead
/// of double-attaching when the session is already open, and refuses a
/// chat-stamped session with `{ "refusal": "kind-mismatch" }`, since an
/// assistant session cannot resume it. `session-new-window.ts`.
pub fn session_open_new_window(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let payload = args.into_iter().next().unwrap_or(Value::Null);
    let session_path = payload.get("sessionPath").and_then(Value::as_str).map(str::to_string);
    let payload_cwd = payload.get("cwd").and_then(Value::as_str).filter(|cwd| !cwd.is_empty()).map(str::to_string);
    let caller_cwd = ctx.tabs.cwd_for(caller, None);
    let ctx = ctx.clone();
    Reply::Later(Box::pin(async move {
        if let Some(session_path) = &session_path {
            if let Some(owner) = ctx.tabs.session_owner(session_path) {
                if ctx.desktop.focus(owner.win_id) {
                    return Ok(Value::Bool(true));
                }
            }
            if ctx.services.session_kind_for(session_path).await == SessionKind::Chat {
                return Ok(json!({ "refusal": "kind-mismatch" }));
            }
        }
        if ctx.tabs.at_cap() {
            return Ok(Value::Bool(false));
        }
        let cwd = payload_cwd.or(caller_cwd).or_else(|| {
            let home = dirs::home_dir();
            crate::paths::initial_cwd(&[home.as_deref().and_then(|path| path.to_str())])
        });
        // The new window always runs an assistant session, so no kind is passed on.
        Ok(Value::Bool(ctx.desktop.spawn_window(cwd, session_path, None).is_some()))
    }))
}

/// `session:consume-pending`: a fresh window pulls the session it was opened
/// to display (one-shot).
pub fn session_consume_pending(ctx: &Arc<AppCtx>, caller: Caller, _args: Vec<Value>) -> Reply {
    Reply::ok(ctx.desktop.consume_pending_session(caller.win_id).map(Value::String).unwrap_or(Value::Null))
}

/// `system:open-external`
pub fn system_open_external(ctx: &Arc<AppCtx>, _caller: Caller, args: Vec<Value>) -> Reply {
    if let Some(url) = args.into_iter().next().and_then(|value| value.as_str().map(str::to_string)) {
        if let Some(target) = super::system::sanitize_external_url(&url) {
            let _ = ctx.host.open_url(&target);
        }
    }
    Reply::ok(Value::Null)
}

/// `system:open-path`: `[path, { tabId }?]`. A non-empty `tabId` resolves a
/// relative path in that tab's workspace (an unknown tab fails); without one
/// the calling window's workspace is used, as before tabs could be named.
pub fn system_open_path(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let mut args = args.into_iter();
    let Some(target) = args.next().and_then(|value| value.as_str().map(str::to_string)) else {
        return Reply::ok(json!({ "ok": false, "error": "Empty path" }));
    };
    let tab_id = args
        .next()
        .and_then(|options| options.get("tabId").and_then(Value::as_str).map(str::to_string))
        .filter(|tab_id| !tab_id.is_empty());
    let ctx = ctx.clone();
    Reply::Later(Box::pin(async move {
        match super::system::open_path(&ctx, caller, &target, tab_id.as_deref()).await {
            Ok(outcome) => Ok(json!({ "ok": true, "resolvedPath": outcome.resolved_path })),
            Err(error) => Ok(json!({ "ok": false, "error": error.message() })),
        }
    }))
}

fn filters_from(value: Option<Value>) -> Option<Vec<crate::ports::FileFilter>> {
    let array = value?.as_array()?.clone();
    Some(
        array
            .iter()
            .filter_map(|item| {
                let name = item.get("name")?.as_str()?.to_string();
                let extensions =
                    item.get("extensions")?.as_array()?.iter().filter_map(|ext| ext.as_str().map(str::to_string)).collect();
                Some(crate::ports::FileFilter { name, extensions })
            })
            .collect(),
    )
}

/// `system:save-dialog(defaultPath, filters)`
pub fn system_save_dialog(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let mut iter = args.into_iter();
    let default_path = iter.next().and_then(|value| value.as_str().map(str::to_string)).filter(|path| !path.is_empty());
    let filters = filters_from(iter.next());
    let ctx = ctx.clone();
    Reply::Later(Box::pin(async move {
        let Some(services) = ctx.services.as_any().downcast_ref::<crate::services::Services>() else { return Ok(Value::Null) };
        let result = super::dialogs::save_dialog(&ctx, &services.dialog_memory, caller.win_id, default_path.as_deref(), filters).await;
        Ok(result.map(|path| Value::String(path.to_string_lossy().into_owned())).unwrap_or(Value::Null))
    }))
}

/// `system:open-dialog(filters, options)`
pub fn system_open_dialog(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let mut iter = args.into_iter();
    let filters = filters_from(iter.next());
    let directory = iter.next().and_then(|options| options.get("directory").and_then(Value::as_bool)).unwrap_or(false);
    let ctx = ctx.clone();
    Reply::Later(Box::pin(async move {
        let Some(services) = ctx.services.as_any().downcast_ref::<crate::services::Services>() else { return Ok(Value::Null) };
        let result = super::dialogs::open_dialog(&ctx, &services.dialog_memory, caller.win_id, filters, directory).await;
        let paths: Option<Vec<String>> = result.map(|paths| paths.into_iter().map(|path| path.to_string_lossy().into_owned()).collect());
        Ok(paths.map(|paths| serde_json::to_value(paths).unwrap_or(Value::Null)).unwrap_or(Value::Null))
    }))
}

/// `system:clipboard-read`
pub fn system_clipboard_read(ctx: &Arc<AppCtx>, _caller: Caller, _args: Vec<Value>) -> Reply {
    let ctx = ctx.clone();
    Reply::Later(Box::pin(async move { Ok(Value::String(ctx.host.clipboard_read_text().await.unwrap_or_default())) }))
}

/// `system:notify`, with the same per-window dedupe window as `ipc.ts:865`;
/// on failure it writes a runtime log entry instead of failing the call.
pub fn system_notify(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let payload = args.into_iter().next().unwrap_or(Value::Null);
    let Some(title) = payload.get("title").and_then(Value::as_str) else { return Reply::ok(Value::Null) };
    let body = payload.get("body").and_then(Value::as_str).unwrap_or("");
    let key = super::system::NotifyDedupe::dedupe_key(caller.win_id, title, body);
    let should_show =
        ctx.services.as_any().downcast_ref::<crate::services::Services>().map(|services| services.notify_dedupe.should_show(&key)).unwrap_or(true);
    if should_show {
        if let Err(error) = ctx.host.notify(title, Some(body).filter(|body| !body.is_empty())) {
            crate::runtime_log::write(
                &json!({ "source": "notification", "message": format!("Notification failed: {error}") }),
                Some(caller.win_id.0),
                None,
            );
        }
    }
    Reply::ok(Value::Null)
}

/// `prefs:get`
pub fn prefs_get(ctx: &Arc<AppCtx>, _caller: Caller, args: Vec<Value>) -> Reply {
    let payload = args.into_iter().next().unwrap_or(Value::Null);
    match payload.get("key").and_then(Value::as_str) {
        Some(key) => Reply::ok(ctx.prefs.get(key).unwrap_or(Value::Null)),
        None => Reply::ok(ctx.prefs.all()),
    }
}

/// `prefs:set`: rejects a key the main process owns, and an unreadable store
/// (the file existed but could not be read at startup, so it is never
/// overwritten) with the store's own error message.
pub fn prefs_set(ctx: &Arc<AppCtx>, _caller: Caller, args: Vec<Value>) -> Reply {
    let payload = args.into_iter().next().unwrap_or(Value::Null);
    let Some(key) = payload.get("key").and_then(Value::as_str).map(str::to_string) else {
        return Reply::err(IpcError::new("Invalid preference key"));
    };
    if ctx.desktop.is_main_owned_pref_key(&key) {
        return Reply::err(IpcError::new("Preference is managed by the app"));
    }
    let value = payload.get("value").cloned().unwrap_or(Value::Null);
    if let Err(error) = ctx.prefs.set(&key, value.clone()) {
        return Reply::err(IpcError::new(error.to_string()));
    }
    if key == "language" && (value == json!("en") || value == json!("vi")) {
        ctx.desktop.rebuild_menu();
    }
    Reply::ok(Value::Null)
}

/// `models:providers-list`
pub fn models_providers_list(_ctx: &Arc<AppCtx>, _caller: Caller, _args: Vec<Value>) -> Reply {
    match super::models_config::list_models_providers(&crate::paths::agent_dir()) {
        Ok(providers) => Reply::ok(serde_json::to_value(providers).unwrap_or(Value::Array(Vec::new()))),
        Err(error) => Reply::err(IpcError::new(error.to_string())),
    }
}

/// `provider-cleanup:config`
pub fn provider_cleanup_config(_ctx: &Arc<AppCtx>, _caller: Caller, _args: Vec<Value>) -> Reply {
    match super::provider_cleanup::clean_config(&crate::paths::agent_dir(), chrono::Local::now().naive_local()) {
        Ok(result) => Reply::ok(json!({
            "backupPath": result.backup_path.map(|path| path.to_string_lossy().into_owned()),
            "removed": result.removed,
        })),
        Err(error) => Reply::err(IpcError::new(error.to_string())),
    }
}

/// `fs:list`: node:fs-equivalent workspace listing, rooted at the calling
/// tab's cwd. Never fails the call; a problem comes back as `ok: false`.
pub fn fs_list(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let payload = args.into_iter().next().unwrap_or(Value::Null);
    let tab_id = payload.get("tabId").and_then(Value::as_str);
    let Some(root) = ctx.tabs.cwd_for(caller, tab_id) else {
        return Reply::ok(json!({ "ok": false, "entries": [], "truncated": false, "error": "No workspace" }));
    };
    let root_abs = PathBuf::from(root);
    let prefix_raw = payload.get("path").and_then(Value::as_str).unwrap_or("");
    let prefix = prefix_raw.replace('\\', "/");
    let prefix = prefix.strip_prefix("./").unwrap_or(&prefix).trim_matches('/').to_string();
    let Some(dir_abs) = workspace_fs::resolve_within(&root_abs, &prefix) else {
        return Reply::ok(json!({ "ok": false, "entries": [], "truncated": false, "error": "Path escapes the workspace" }));
    };
    let max_depth = workspace_fs::clamp_int(
        payload.get("maxDepth").and_then(Value::as_i64),
        1,
        workspace_fs::FS_LIST_MAX_DEPTH,
        workspace_fs::FS_LIST_DEFAULT_DEPTH,
    );
    let max_files = workspace_fs::clamp_int(
        payload.get("maxEntries").and_then(Value::as_i64),
        1,
        workspace_fs::FS_LIST_MAX_FILES_CAP,
        workspace_fs::FS_LIST_DEFAULT_MAX_FILES,
    );
    let mut state =
        workspace_fs::WalkState { rules: workspace_fs::load_ignore_rules(&root_abs), max_depth, max_files, file_count: 0, truncated: false };
    match std::fs::metadata(&dir_abs) {
        Ok(metadata) if metadata.is_dir() => {
            let entries = workspace_fs::walk_workspace(&dir_abs, &prefix, 0, &mut state);
            Reply::ok(json!({ "ok": true, "entries": entries, "truncated": state.truncated }))
        }
        Ok(_) => Reply::ok(json!({ "ok": false, "entries": [], "truncated": false, "error": "Not a directory" })),
        Err(error) => Reply::ok(json!({ "ok": false, "entries": [], "truncated": state.truncated, "error": error.to_string() })),
    }
}

/// `fs:read`: workspace-confined for a relative path, read as given for an
/// absolute or `~/` one (see `fs.rs`'s trust-contract note).
pub fn fs_read(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let payload = args.into_iter().next().unwrap_or(Value::Null);
    let fail = |error: String| Reply::ok(json!({ "ok": false, "content": "", "truncated": false, "binary": false, "size": 0, "error": error }));
    let Some(path) = payload.get("path").and_then(Value::as_str).filter(|path| !path.is_empty()) else {
        return fail("Invalid path".into());
    };
    let raw = expand_home(path);
    let abs = if Path::new(&raw).is_absolute() {
        PathBuf::from(&raw)
    } else {
        let tab_id = payload.get("tabId").and_then(Value::as_str);
        let Some(cwd) = ctx.tabs.cwd_for(caller, tab_id) else { return fail("No workspace".into()) };
        match workspace_fs::resolve_within(Path::new(&cwd), &raw) {
            Some(within) => within,
            None => return fail("Path escapes the workspace".into()),
        }
    };
    let max_bytes = workspace_fs::clamp_int(
        payload.get("maxBytes").and_then(Value::as_i64),
        1,
        workspace_fs::FS_READ_MAX_BYTES_CAP,
        workspace_fs::FS_READ_DEFAULT_MAX_BYTES,
    ) as u64;
    match workspace_fs::read_file_capped(&abs, max_bytes) {
        Ok(result) => {
            Reply::ok(json!({ "ok": true, "content": result.content, "truncated": result.truncated, "binary": result.binary, "size": result.size }))
        }
        Err(error) => fail(error.to_string()),
    }
}

fn stat_file(abs: &Path) -> Option<PathBuf> {
    std::fs::metadata(abs).ok().filter(std::fs::Metadata::is_file).map(|_| abs.to_path_buf())
}

/// Newest top-level `*plan.md` (case-insensitive) in `dir_abs`, mirroring the
/// agent-side fallback (the agent names its own `local://<slug>-plan.md`, so
/// the configured path alone often misses it).
fn newest_plan_file(dir_abs: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir_abs).ok()?;
    let mut best: Option<(PathBuf, std::time::SystemTime)> = None;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else { continue };
        if !file_type.is_file() {
            continue;
        }
        if !entry.file_name().to_string_lossy().to_lowercase().ends_with("plan.md") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|metadata| metadata.modified()) else { continue };
        if best.as_ref().is_none_or(|(_, best_mtime)| modified > *best_mtime) {
            best = Some((entry.path(), modified));
        }
    }
    best.map(|(path, _)| path)
}

/// `fs:read-plan`: deliberately off the RPC bus (reading a plan via the
/// agent's bash RPC injected it into the model context on every poll). Reads
/// the configured path, else the newest `*plan.md` in the session-local root.
/// Confined to the workspace and the sessions dir (plan artifacts live there).
pub fn fs_read_plan(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let payload = args.into_iter().next().unwrap_or(Value::Null);
    let fail = |error: &str| Reply::ok(json!({ "ok": false, "path": Value::Null, "content": Value::Null, "error": error }));
    let Some(fs_path) = payload.get("fsPath").and_then(Value::as_str).filter(|path| !path.is_empty()) else {
        return fail("Invalid path");
    };
    let tab_id = payload.get("tabId").and_then(Value::as_str);
    let Some(cwd) = ctx.tabs.cwd_for(caller, tab_id) else { return fail("No workspace") };
    let sessions_dir = ctx.services.sessions_dir();
    let within_allowed_roots =
        |value: &str| workspace_fs::resolve_within(Path::new(&cwd), value).or_else(|| workspace_fs::resolve_within(&sessions_dir, value));
    let Some(target) = within_allowed_roots(fs_path) else { return fail("Path escapes allowed roots") };
    let local_root = match payload.get("localRoot").and_then(Value::as_str).filter(|value| !value.is_empty()) {
        Some(value) => match within_allowed_roots(value) {
            Some(path) => Some(path),
            None => return fail("Path escapes allowed roots"),
        },
        None => None,
    };
    let picked = stat_file(&target).or_else(|| local_root.as_deref().and_then(newest_plan_file));
    match picked {
        None => Reply::ok(json!({ "ok": true, "path": Value::Null, "content": Value::Null })),
        Some(path) => match std::fs::read_to_string(&path) {
            Ok(content) => Reply::ok(json!({ "ok": true, "path": path.to_string_lossy(), "content": content })),
            Err(error) => fail(&error.to_string()),
        },
    }
}

/// `fs:read-image`: markdown-image read. Relative paths stay
/// workspace-confined; absolute and `~` paths are readable because the bytes
/// never leave the local `<img>`, but the file must sniff as a real image
/// type and fit under the size cap.
pub fn fs_read_image(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let payload = args.into_iter().next().unwrap_or(Value::Null);
    let fail = |error: String| Reply::ok(json!({ "ok": false, "dataUrl": Value::Null, "mime": Value::Null, "size": 0, "error": error }));
    let Some(path) = payload.get("path").and_then(Value::as_str).filter(|path| !path.is_empty()) else {
        return fail("Invalid path".into());
    };
    let raw = expand_home(path);
    let abs = if Path::new(&raw).is_absolute() {
        PathBuf::from(&raw)
    } else {
        let tab_id = payload.get("tabId").and_then(Value::as_str);
        let Some(cwd) = ctx.tabs.cwd_for(caller, tab_id) else { return fail("No workspace".into()) };
        match workspace_fs::resolve_within(Path::new(&cwd), &raw) {
            Some(within) => within,
            None => return fail("Path escapes the workspace".into()),
        }
    };
    let metadata = match std::fs::metadata(&abs) {
        Ok(metadata) => metadata,
        Err(error) => return fail(error.to_string()),
    };
    if !metadata.is_file() {
        return fail("Not a file".into());
    }
    if metadata.len() > workspace_fs::FS_IMAGE_MAX_BYTES {
        return fail("Image too large".into());
    }
    let bytes = match std::fs::read(&abs) {
        Ok(bytes) => bytes,
        Err(error) => return fail(error.to_string()),
    };
    let header_len = bytes.len().min(512);
    let Some(mime) = workspace_fs::sniff_image_mime(&bytes[..header_len]) else { return fail("Not a supported image".into()) };
    let data_url = format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes));
    Reply::ok(json!({ "ok": true, "dataUrl": data_url, "mime": mime, "size": metadata.len() }))
}

/// Size cap for `fs:read-pdf`, matching the Electron handler.
const FS_PDF_MAX_BYTES: u64 = 32 * 1024 * 1024;

const PDF_SIGNATURE: &[u8] = b"%PDF-";

/// `fs:read-pdf`: a user-attached PDF, base64-encoded for a local page-1
/// thumbnail. Not workspace-confined: like a markdown image, the bytes never
/// leave a local render. Absolute or `~/` paths only; the file must start
/// with `%PDF-` and fit under the size cap. Failures come back as `ok: false`.
/// The read and encode run on a blocking thread so a large file never holds
/// up the window's other calls (sending or aborting a prompt).
pub fn fs_read_pdf(_ctx: &Arc<AppCtx>, _caller: Caller, args: Vec<Value>) -> Reply {
    let payload = args.into_iter().next().unwrap_or(Value::Null);
    let path = payload.get("path").and_then(Value::as_str).unwrap_or("").to_string();
    Reply::Later(Box::pin(async move {
        let result =
            tokio::task::spawn_blocking(move || read_pdf_file(&path, dirs::home_dir().as_deref(), FS_PDF_MAX_BYTES))
                .await;
        Ok(result.unwrap_or_else(|error| pdf_failure(&error.to_string(), 0)))
    }))
}

fn pdf_failure(error: &str, size: u64) -> Value {
    json!({ "ok": false, "size": size, "error": error })
}

/// Opens without blocking so a named pipe at the path cannot stall the
/// thread before `fstat` rejects it; reads from a regular file ignore the flag.
fn open_for_sniff(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    options.open(path)
}

fn read_pdf_file(path: &str, home: Option<&Path>, max_bytes: u64) -> Value {
    if path.is_empty() {
        return pdf_failure("Invalid path", 0);
    }
    let raw = expand_home_in(path, home);
    let abs = Path::new(&raw);
    if !abs.is_absolute() {
        return pdf_failure("Path must be absolute", 0);
    }
    // One handle for every check and the read: the type and size come from
    // `fstat` on it, so the path cannot be swapped between check and read.
    let mut file = match open_for_sniff(abs) {
        Ok(file) => file,
        Err(error) => return pdf_failure(&error.to_string(), 0),
    };
    let metadata = match file.metadata() {
        Ok(metadata) => metadata,
        Err(error) => return pdf_failure(&error.to_string(), 0),
    };
    if !metadata.is_file() {
        return pdf_failure("Not a file", 0);
    }
    if metadata.len() > max_bytes {
        return pdf_failure("PDF too large", metadata.len());
    }
    match read_pdf_bytes(&mut file, metadata.len(), max_bytes) {
        Ok(bytes) => {
            json!({ "ok": true, "data": base64::engine::general_purpose::STANDARD.encode(&bytes), "size": bytes.len() })
        }
        Err(failure) => failure,
    }
}

/// Reads the signature first and stops on a non-PDF, then reads at most one
/// byte past the cap, so a file that grew after `fstat` is refused rather
/// than read whole. `size` is the `fstat` size, reported on a non-PDF.
fn read_pdf_bytes(reader: &mut impl std::io::Read, size: u64, max_bytes: u64) -> Result<Vec<u8>, Value> {
    use std::io::Read;
    let mut bytes = vec![0u8; PDF_SIGNATURE.len()];
    match reader.read_exact(&mut bytes) {
        Ok(()) if bytes == PDF_SIGNATURE => {}
        Ok(()) => return Err(pdf_failure("Not a PDF", size)),
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Err(pdf_failure("Not a PDF", size)),
        Err(error) => return Err(pdf_failure(&error.to_string(), 0)),
    }
    let remaining = (max_bytes + 1).saturating_sub(PDF_SIGNATURE.len() as u64);
    if let Err(error) = reader.take(remaining).read_to_end(&mut bytes) {
        return Err(pdf_failure(&error.to_string(), 0));
    }
    let read = bytes.len() as u64;
    if read > max_bytes {
        return Err(pdf_failure("PDF too large", read));
    }
    Ok(bytes)
}

/// Size cap for `fs:read-document`, matching the Electron handler.
const FS_DOCUMENT_MAX_BYTES: u64 = 32 * 1024 * 1024;

/// How long `fs:read-document` waits for a blocking read (a hung network
/// mount) before answering `timed-out`; the blocking thread may stay stuck,
/// but the window's call queue moves on.
const DOCUMENT_READ_TIMEOUT: Duration = Duration::from_secs(30);

/// `fs:read-document`: a document's bytes (PDF, ZIP, OLE or HTML-table
/// signature, bounded by a size cap) for the in-app preview, or `unchanged`
/// without bytes when `ifChanged` still matches its size and mtime. Relative
/// paths stay workspace-confined; absolute and `~/` paths are read as given
/// (see `fs.rs`'s trust-contract note). The read runs on a blocking thread
/// with a timeout so a slow mount never holds up the window's other calls.
pub fn fs_read_document(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let payload = args.into_iter().next().unwrap_or(Value::Null);
    let Some(path) = payload.get("path").and_then(Value::as_str).filter(|path| !path.is_empty()) else {
        return Reply::ok(document_failure("invalid-path"));
    };
    let raw = expand_home(path);
    let cwd = if Path::new(&raw).is_absolute() {
        None
    } else {
        let tab_id = payload.get("tabId").and_then(Value::as_str);
        match ctx.tabs.cwd_for(caller, tab_id) {
            Some(cwd) => Some(cwd),
            None => return Reply::ok(document_failure("no-workspace")),
        }
    };
    let if_changed = payload.get("ifChanged").and_then(|stamp| {
        Some((stamp.get("size").and_then(Value::as_u64)?, stamp.get("mtimeMs").and_then(Value::as_u64)?))
    });
    Reply::Later(Box::pin(async move {
        let read = tokio::task::spawn_blocking(move || {
            let abs = match cwd {
                None => PathBuf::from(&raw),
                Some(cwd) => match workspace_fs::resolve_within(Path::new(&cwd), &raw) {
                    Some(within) => within,
                    None => return document_failure("outside-workspace"),
                },
            };
            read_document_file(&abs, FS_DOCUMENT_MAX_BYTES, if_changed)
        });
        Ok(settle_document_read(read, DOCUMENT_READ_TIMEOUT).await)
    }))
}

/// The blocking read's result, or `timed-out` once `timeout` passes first.
async fn settle_document_read(read: tokio::task::JoinHandle<Value>, timeout: Duration) -> Value {
    match tokio::time::timeout(timeout, read).await {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => document_failure(&error.to_string()),
        Err(_) => document_failure("timed-out"),
    }
}

/// A failure before the path resolved to a file: no stamp, no `resolvedPath`.
fn document_failure(error: &str) -> Value {
    json!({ "ok": false, "size": 0, "mtimeMs": 0, "error": error })
}

/// The document kind a file's leading bytes declare; images return `None`
/// (they are read through `fs:read-image`).
fn document_signature(header: &[u8]) -> Option<&'static str> {
    if header.starts_with(PDF_SIGNATURE) {
        return Some("pdf");
    }
    if header.starts_with(&[0x50, 0x4b, 0x03, 0x04]) {
        return Some("zip");
    }
    if header.starts_with(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) {
        return Some("ole");
    }
    let text = header.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(header);
    let start = text.iter().position(|byte| !byte.is_ascii_whitespace()).unwrap_or(text.len());
    let text = &text[start..];
    let starts_with_tag = |tag: &[u8]| text.len() >= tag.len() && text[..tag.len()].eq_ignore_ascii_case(tag);
    if starts_with_tag(b"<!doctype html") || starts_with_tag(b"<html") || starts_with_tag(b"<table") {
        return Some("html");
    }
    None
}

/// Reads `abs` after lexically normalizing it (`.` and `..` segments, as
/// Node's `path.normalize` does), so `resolvedPath` matches the Electron shell.
fn read_document_file(abs: &Path, max_bytes: u64, if_changed: Option<(u64, u64)>) -> Value {
    read_document_with(&workspace_fs::normalize(abs), max_bytes, if_changed, || {})
}

/// One handle for the stamp, the cap and the read, reading at most one byte
/// past the cap so a file that grows after `fstat` is refused rather than
/// read whole. `after_open` runs between `fstat` and the read (tests use it
/// to grow the file).
fn read_document_with(abs: &Path, max_bytes: u64, if_changed: Option<(u64, u64)>, after_open: impl FnOnce()) -> Value {
    use std::io::Read;
    let resolved = abs.to_string_lossy();
    let failure = |size: u64, mtime_ms: u64, error: &str| {
        json!({ "ok": false, "size": size, "mtimeMs": mtime_ms, "resolvedPath": resolved, "error": error })
    };
    let file = match open_for_sniff(abs) {
        Ok(file) => file,
        Err(error) => return document_failure(&error.to_string()),
    };
    let metadata = match file.metadata() {
        Ok(metadata) => metadata,
        Err(error) => return document_failure(&error.to_string()),
    };
    if !metadata.is_file() {
        return failure(0, 0, "not-a-file");
    }
    let size = metadata.len();
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |since| u64::try_from(since.as_millis()).unwrap_or(u64::MAX));
    if if_changed == Some((size, mtime_ms)) {
        return json!({ "ok": true, "unchanged": true, "size": size, "mtimeMs": mtime_ms, "resolvedPath": resolved });
    }
    if size > max_bytes {
        return failure(size, mtime_ms, "too-large");
    }
    after_open();
    let mut bytes = Vec::with_capacity(usize::try_from(size).unwrap_or(0));
    if let Err(error) = file.take(max_bytes + 1).read_to_end(&mut bytes) {
        return document_failure(&error.to_string());
    }
    let read = bytes.len() as u64;
    if read > max_bytes {
        return failure(read, mtime_ms, "too-large");
    }
    let Some(signature) = document_signature(&bytes[..bytes.len().min(512)]) else {
        return failure(size, mtime_ms, "unsupported");
    };
    json!({
        "ok": true,
        "data": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "size": read,
        "mtimeMs": mtime_ms,
        "resolvedPath": resolved,
        "signature": signature,
    })
}

/// `editor:open-external`
pub fn editor_open_external(ctx: &Arc<AppCtx>, _caller: Caller, args: Vec<Value>) -> Reply {
    let payload = args.into_iter().next().unwrap_or(Value::Null);
    let content = payload.get("content").and_then(Value::as_str).unwrap_or("").to_string();
    let ctx = ctx.clone();
    Reply::Later(Box::pin(async move {
        let Some(editor_cmd) = ctx.omp.resolve_editor_command().await else {
            return Ok(json!({
                "ok": false,
                "unavailable": true,
                "text": Value::Null,
                "error": "Set $VISUAL or $EDITOR to use an external editor",
            }));
        };
        let path_env = ctx.omp.spawn_env().await.get("PATH").cloned().unwrap_or_default();
        match super::editor::open_in_external_editor(&content, &editor_cmd, &path_env).await {
            Ok(result) => Ok(json!({ "ok": true, "unavailable": false, "text": result.text })),
            Err(error) => Ok(json!({ "ok": false, "unavailable": false, "text": Value::Null, "error": error.to_string() })),
        }
    }))
}

#[cfg(test)]
mod tests {
    use crate::bridge::{self, Registry};
    use crate::ports::{Caller, IpcSessionOwner, SessionKind, WindowId, WindowRecord};
    use crate::testing::{self, Fakes};
    use serde_json::json;

    fn registry() -> Registry {
        let mut reg = Registry::new();
        crate::services::register(&mut reg);
        reg
    }

    fn ctx(fakes: &Fakes) -> std::sync::Arc<crate::ctx::AppCtx> {
        testing::fake_ctx_cyclic(fakes, registry(), |ctx, ports| {
            ports.services = Some(std::sync::Arc::new(crate::services::Services::new(ctx.clone())));
        })
    }

    #[tokio::test]
    async fn dispatches_prefs_get_and_prefs_set() {
        let fakes = Fakes::default();
        let ctx = ctx(&fakes);
        let caller = Caller::main(WindowId(1));
        bridge::dispatch_for_test(&ctx, caller, "prefs:set", vec![json!({ "key": "welcome.completed", "value": true })])
            .await
            .unwrap();
        let value = bridge::dispatch_for_test(&ctx, caller, "prefs:get", vec![json!({ "key": "welcome.completed" })]).await.unwrap();
        assert_eq!(value, json!(true));
        let all = bridge::dispatch_for_test(&ctx, caller, "prefs:get", vec![json!({})]).await.unwrap();
        assert_eq!(all["welcome"]["completed"], json!(true));
    }

    #[tokio::test]
    async fn prefs_set_refuses_a_main_owned_key_and_rebuilds_the_menu_on_language_change() {
        let fakes = Fakes::default();
        fakes.desktop.main_owned_keys.lock().unwrap().push("windowBounds".into());
        let ctx = ctx(&fakes);
        let caller = Caller::main(WindowId(1));
        let refused = bridge::dispatch_for_test(&ctx, caller, "prefs:set", vec![json!({ "key": "windowBounds", "value": {} })]).await;
        assert!(refused.is_err());

        bridge::dispatch_for_test(&ctx, caller, "prefs:set", vec![json!({ "key": "language", "value": "vi" })]).await.unwrap();
        assert!(fakes.desktop.log.calls().iter().any(|call| call == "rebuild_menu()"));
    }

    #[tokio::test]
    async fn prefs_set_rejects_when_the_store_could_not_be_read_at_startup() {
        let fakes = Fakes::default();
        // A directory in the file's place makes `JsonStore::open` mark the
        // store unreadable (matches `prefs.rs`'s own unreadable-store test).
        std::fs::create_dir(fakes.dir.path().join("prefs.json")).unwrap();
        let ctx = ctx(&fakes);
        let caller = Caller::main(WindowId(1));
        let result = bridge::dispatch_for_test(&ctx, caller, "prefs:set", vec![json!({ "key": "a", "value": 1 })]).await;
        assert!(result.is_err(), "an unreadable store must reject the write instead of silently dropping it");
    }

    #[tokio::test]
    async fn dispatches_runtime_error_report_and_log_path() {
        let fakes = Fakes::default();
        let ctx = ctx(&fakes);
        let caller = Caller::main(WindowId(1));
        bridge::dispatch_for_test(&ctx, caller, "runtime:error-report", vec![json!({ "source": "unknown", "message": "boom" })])
            .await
            .unwrap();
        let path = bridge::dispatch_for_test(&ctx, caller, "runtime:log-path", vec![]).await.unwrap();
        assert!(path.as_str().is_some_and(|path| !path.is_empty()));
    }

    /// `session:open-new-window` over the fakes: `owner` holds the file, the file has `kind`.
    fn new_window_fakes(kind: SessionKind, owner: Option<WindowId>, at_cap: bool) -> Fakes {
        let fakes = Fakes::default();
        fakes.services.kinds.lock().unwrap().insert("/s/session.jsonl".into(), kind);
        if let Some(win_id) = owner {
            fakes.desktop.add_record(WindowRecord { id: win_id, cwd: "/owner".into(), pending_session_path: None });
            fakes.tabs.owners.lock().unwrap().insert("/s/session.jsonl".into(), IpcSessionOwner { tab_id: "t1".into(), win_id });
        }
        *fakes.tabs.at_cap.lock().unwrap() = at_cap;
        fakes.tabs.cwds.lock().unwrap().insert(WindowId(1), "/caller".into());
        fakes
    }

    async fn open_new_window(fakes: &Fakes, payload: serde_json::Value) -> serde_json::Value {
        let ctx = testing::fake_ctx_with(fakes, registry());
        bridge::dispatch_for_test(&ctx, Caller::main(WindowId(1)), "session:open-new-window", vec![payload]).await.unwrap()
    }

    fn spawned_windows(fakes: &Fakes) -> Vec<String> {
        fakes.desktop.log.calls().into_iter().filter(|call| call.starts_with("spawn_window(")).collect()
    }

    #[tokio::test]
    async fn focuses_the_live_owner_before_the_kind_check() {
        let fakes = new_window_fakes(SessionKind::Chat, Some(WindowId(7)), false);
        assert_eq!(open_new_window(&fakes, json!({ "sessionPath": "/s/session.jsonl" })).await, json!(true));
        assert_eq!(*fakes.desktop.focused.lock().unwrap(), Some(WindowId(7)));
        assert!(!fakes.services.log.calls().iter().any(|call| call.starts_with("session_kind_for(")));
        assert!(spawned_windows(&fakes).is_empty());
    }

    #[tokio::test]
    async fn refuses_a_chat_stamped_session_with_kind_mismatch_and_opens_no_window() {
        let fakes = new_window_fakes(SessionKind::Chat, None, false);
        let payload = json!({ "sessionPath": "/s/session.jsonl", "cwd": "/work" });
        assert_eq!(open_new_window(&fakes, payload).await, json!({ "refusal": "kind-mismatch" }));
        assert!(spawned_windows(&fakes).is_empty());
        // The refusal wins over the cap: the user learns why, not that the app is full.
        let capped = new_window_fakes(SessionKind::Chat, None, true);
        assert_eq!(open_new_window(&capped, json!({ "sessionPath": "/s/session.jsonl" })).await, json!({ "refusal": "kind-mismatch" }));
    }

    #[tokio::test]
    async fn opens_an_agent_session_in_a_new_window_without_a_session_kind() {
        let fakes = new_window_fakes(SessionKind::Agent, None, false);
        let payload = json!({ "sessionPath": "/s/session.jsonl", "cwd": "/work" });
        assert_eq!(open_new_window(&fakes, payload).await, json!(true));
        // No cwd in the payload: the caller's.
        assert_eq!(open_new_window(&fakes, json!({})).await, json!(true));
        assert_eq!(
            spawned_windows(&fakes),
            [r#"spawn_window(Some("/work"), Some("/s/session.jsonl"), None)"#, r#"spawn_window(Some("/caller"), None, None)"#]
        );
    }

    #[tokio::test]
    async fn returns_false_at_the_pool_cap() {
        let fakes = new_window_fakes(SessionKind::Agent, None, true);
        assert_eq!(open_new_window(&fakes, json!({ "sessionPath": "/s/session.jsonl" })).await, json!(false));
        assert!(spawned_windows(&fakes).is_empty());
    }

    const PDF: &[u8] = b"%PDF-1.7\n%\xe2\xe3\n1 0 obj\n<<>>\nendobj\n";

    fn pdf_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn read_pdf(path: &str, home: Option<&std::path::Path>, max_bytes: u64) -> serde_json::Value {
        super::read_pdf_file(path, home, max_bytes)
    }

    fn base64(bytes: &[u8]) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn returns_a_pdf_as_base64_with_its_size() {
        let dir = pdf_dir();
        let file = dir.path().join("report.pdf");
        std::fs::write(&file, PDF).unwrap();
        let result = read_pdf(file.to_str().unwrap(), None, super::FS_PDF_MAX_BYTES);
        assert_eq!(result, json!({ "ok": true, "data": base64(PDF), "size": PDF.len() }));
    }

    #[test]
    fn expands_a_home_relative_path() {
        let dir = pdf_dir();
        std::fs::create_dir(dir.path().join("Documents")).unwrap();
        std::fs::write(dir.path().join("Documents").join("a b.pdf"), PDF).unwrap();
        let result = read_pdf("~/Documents/a b.pdf", Some(dir.path()), super::FS_PDF_MAX_BYTES);
        assert_eq!(result["ok"], json!(true));
        assert_eq!(result["size"], json!(PDF.len()));
    }

    #[test]
    fn rejects_a_relative_path() {
        let result = read_pdf("report.pdf", None, super::FS_PDF_MAX_BYTES);
        assert_eq!(result, json!({ "ok": false, "size": 0, "error": "Path must be absolute" }));
    }

    #[test]
    fn rejects_a_missing_or_empty_path() {
        assert_eq!(read_pdf("", None, super::FS_PDF_MAX_BYTES), json!({ "ok": false, "size": 0, "error": "Invalid path" }));
    }

    #[test]
    fn rejects_a_file_that_does_not_start_with_the_pdf_signature() {
        let dir = pdf_dir();
        let file = dir.path().join("fake.pdf");
        std::fs::write(&file, b"PK\x03\x04 not a pdf").unwrap();
        let result = read_pdf(file.to_str().unwrap(), None, super::FS_PDF_MAX_BYTES);
        assert_eq!(result["ok"], json!(false));
        assert_eq!(result["error"], json!("Not a PDF"));
        assert!(result.get("data").is_none());
    }

    #[test]
    fn rejects_a_pdf_over_the_size_cap() {
        let dir = pdf_dir();
        let file = dir.path().join("big.pdf");
        std::fs::write(&file, PDF).unwrap();
        let result = read_pdf(file.to_str().unwrap(), None, PDF.len() as u64 - 1);
        assert_eq!(result, json!({ "ok": false, "size": PDF.len(), "error": "PDF too large" }));
    }

    #[test]
    fn rejects_a_directory_and_a_missing_file() {
        let dir = pdf_dir();
        let as_dir = read_pdf(dir.path().to_str().unwrap(), None, super::FS_PDF_MAX_BYTES);
        assert_eq!(as_dir, json!({ "ok": false, "size": 0, "error": "Not a file" }));
        let missing = read_pdf(dir.path().join("missing.pdf").to_str().unwrap(), None, super::FS_PDF_MAX_BYTES);
        assert_eq!(missing["ok"], json!(false));
        assert!(missing["error"].as_str().is_some_and(|error| !error.is_empty()));
    }

    #[test]
    fn stops_reading_once_a_file_grows_past_the_size_cap() {
        // The reader yields more than the `fstat` size allowed: the file grew
        // after it was checked.
        let mut grown = std::io::Cursor::new([PDF, b"appended after the size check".as_slice()].concat());
        let result = super::read_pdf_bytes(&mut grown, PDF.len() as u64, PDF.len() as u64);
        let failure = result.unwrap_err();
        assert_eq!(failure["ok"], json!(false));
        assert_eq!(failure["error"], json!("PDF too large"));
        assert_eq!(failure["size"], json!(PDF.len() + 1));
        assert!(failure.get("data").is_none());
    }

    #[test]
    fn reads_a_file_that_grew_but_still_fits_under_the_cap() {
        let whole = [PDF, b"more".as_slice()].concat();
        let mut grown = std::io::Cursor::new(whole.clone());
        let result = super::read_pdf_bytes(&mut grown, PDF.len() as u64, PDF.len() as u64 + 100);
        assert_eq!(result.unwrap(), whole);
    }

    #[test]
    fn rejects_a_non_pdf_after_reading_only_its_signature() {
        let mut reader = std::io::Cursor::new(b"PK\x03\x04 not a pdf, and much more after it".to_vec());
        let result = super::read_pdf_bytes(&mut reader, 40, super::FS_PDF_MAX_BYTES);
        assert_eq!(result.unwrap_err(), json!({ "ok": false, "size": 40, "error": "Not a PDF" }));
        assert_eq!(reader.position(), super::PDF_SIGNATURE.len() as u64);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_named_pipe_without_blocking() {
        let dir = pdf_dir();
        let fifo = dir.path().join("pipe.pdf");
        nix::unistd::mkfifo(&fifo, nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR).unwrap();
        let result = read_pdf(fifo.to_str().unwrap(), None, super::FS_PDF_MAX_BYTES);
        assert_eq!(result, json!({ "ok": false, "size": 0, "error": "Not a file" }));
    }

    #[tokio::test]
    async fn dispatches_fs_read_pdf_without_throwing() {
        let fakes = Fakes::default();
        let ctx = ctx(&fakes);
        let reply = bridge::dispatch_for_test(&ctx, Caller::main(WindowId(1)), "fs:read-pdf", vec![json!({ "path": "relative.pdf" })])
            .await
            .unwrap();
        assert_eq!(reply, json!({ "ok": false, "size": 0, "error": "Path must be absolute" }));
    }

    const DOC_ZIP: &[u8] = &[0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0];
    const DOC_OLE: &[u8] = &[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0];
    const DOC_HTML: &str = "\u{feff}  <html><body><table><tr><td>a</td></tr></table></body></html>";
    const DOC_PDF: &[u8] = b"%PDF-1.7\n%\xe2\xe3\n";
    const DOC_PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52];

    /// `(size, mtimeMs)` as both shells report them: whole milliseconds, floored.
    fn doc_stamp(path: &std::path::Path) -> (u64, u64) {
        let metadata = std::fs::metadata(path).unwrap();
        let mtime_ms = metadata.modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
        (metadata.len(), mtime_ms)
    }

    fn write_doc(dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let file = dir.path().join(name);
        std::fs::write(&file, bytes).unwrap();
        file
    }

    fn read_doc(path: &std::path::Path) -> serde_json::Value {
        super::read_document_file(path, super::FS_DOCUMENT_MAX_BYTES, None)
    }

    fn full_read(path: &std::path::Path, bytes: &[u8], signature: &str) -> serde_json::Value {
        let (size, mtime_ms) = doc_stamp(path);
        json!({
            "ok": true,
            "data": base64(bytes),
            "size": size,
            "mtimeMs": mtime_ms,
            "resolvedPath": path.to_str().unwrap(),
            "signature": signature,
        })
    }

    #[test]
    fn document_read_returns_a_docx_as_base64_with_the_zip_signature() {
        let dir = tempfile::tempdir().unwrap();
        let file = write_doc(&dir, "a.docx", DOC_ZIP);
        assert_eq!(read_doc(&file), full_read(&file, DOC_ZIP, "zip"));
    }

    #[test]
    fn document_read_returns_a_legacy_xls_with_the_ole_signature() {
        let dir = tempfile::tempdir().unwrap();
        let file = write_doc(&dir, "a.xls", DOC_OLE);
        assert_eq!(read_doc(&file), full_read(&file, DOC_OLE, "ole"));
    }

    #[test]
    fn document_read_returns_an_html_spreadsheet_export_with_the_html_signature() {
        let dir = tempfile::tempdir().unwrap();
        let file = write_doc(&dir, "a.xls", DOC_HTML.as_bytes());
        assert_eq!(read_doc(&file), full_read(&file, DOC_HTML.as_bytes(), "html"));
    }

    #[test]
    fn document_read_returns_a_pdf_with_the_pdf_signature() {
        let dir = tempfile::tempdir().unwrap();
        let file = write_doc(&dir, "a.pdf", DOC_PDF);
        assert_eq!(read_doc(&file), full_read(&file, DOC_PDF, "pdf"));
    }

    #[test]
    fn document_read_rejects_bytes_with_no_known_signature_as_unsupported() {
        let dir = tempfile::tempdir().unwrap();
        for file in [write_doc(&dir, "a.png", DOC_PNG), write_doc(&dir, "a.docx", b"hello")] {
            let (size, mtime_ms) = doc_stamp(&file);
            assert_eq!(
                read_doc(&file),
                json!({ "ok": false, "size": size, "mtimeMs": mtime_ms, "resolvedPath": file.to_str().unwrap(), "error": "unsupported" })
            );
        }
    }

    #[test]
    fn document_read_rejects_a_file_over_the_size_cap_as_too_large() {
        assert_eq!(super::FS_DOCUMENT_MAX_BYTES, 32 * 1024 * 1024);
        let dir = tempfile::tempdir().unwrap();
        let file = write_doc(&dir, "big.docx", &[DOC_ZIP, &[0, 0]].concat());
        let (_, mtime_ms) = doc_stamp(&file);
        assert_eq!(
            super::read_document_file(&file, 4, None),
            json!({ "ok": false, "size": 10, "mtimeMs": mtime_ms, "resolvedPath": file.to_str().unwrap(), "error": "too-large" })
        );
    }

    #[test]
    fn document_read_refuses_a_file_that_grows_past_the_cap_after_it_was_opened() {
        let dir = tempfile::tempdir().unwrap();
        let file = write_doc(&dir, "growing.docx", &DOC_ZIP[..4]);
        let appended = file.clone();
        let result = super::read_document_with(&file, 8, None, move || {
            use std::io::Write;
            let mut handle = std::fs::OpenOptions::new().append(true).open(&appended).unwrap();
            handle.write_all(&[0u8; 16]).unwrap();
        });
        assert_eq!(result["ok"], json!(false));
        assert_eq!(result["error"], json!("too-large"));
        assert!(result.get("data").is_none());
    }

    #[test]
    fn document_read_returns_unchanged_without_data_when_the_stamp_matches() {
        let dir = tempfile::tempdir().unwrap();
        let file = write_doc(&dir, "a.docx", DOC_ZIP);
        let (size, mtime_ms) = doc_stamp(&file);
        let result = super::read_document_file(&file, super::FS_DOCUMENT_MAX_BYTES, Some((size, mtime_ms)));
        assert_eq!(
            result,
            json!({ "ok": true, "unchanged": true, "size": size, "mtimeMs": mtime_ms, "resolvedPath": file.to_str().unwrap() })
        );
        assert!(result.get("data").is_none());
    }

    #[test]
    fn document_read_returns_the_bytes_when_the_stamp_is_stale() {
        let dir = tempfile::tempdir().unwrap();
        let file = write_doc(&dir, "a.docx", DOC_ZIP);
        let (size, mtime_ms) = doc_stamp(&file);
        let result = super::read_document_file(&file, super::FS_DOCUMENT_MAX_BYTES, Some((size + 1, mtime_ms)));
        assert_eq!(result, full_read(&file, DOC_ZIP, "zip"));
    }

    #[test]
    fn document_read_rejects_a_directory_as_not_a_file() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            read_doc(dir.path()),
            json!({ "ok": false, "size": 0, "mtimeMs": 0, "resolvedPath": dir.path().to_str().unwrap(), "error": "not-a-file" })
        );
    }

    #[test]
    fn document_read_normalizes_an_absolute_path_with_dot_segments() {
        let dir = tempfile::tempdir().unwrap();
        let file = write_doc(&dir, "a.pdf", DOC_PDF);
        let dotted = dir.path().join(".").join("sub").join("..").join("a.pdf");
        assert_eq!(read_doc(&dotted), full_read(&file, DOC_PDF, "pdf"));
    }

    #[test]
    fn document_read_reports_a_missing_file_as_not_ok() {
        let dir = tempfile::tempdir().unwrap();
        let result = read_doc(&dir.path().join("missing.docx"));
        assert_eq!(result["ok"], json!(false));
        assert_eq!(result["size"], json!(0));
        assert!(result["error"].as_str().is_some_and(|error| !error.is_empty()));
    }

    #[tokio::test]
    async fn document_read_answers_timed_out_when_the_read_outlasts_the_timeout() {
        assert_eq!(super::DOCUMENT_READ_TIMEOUT, std::time::Duration::from_secs(30));
        let (release, stalled) = std::sync::mpsc::channel::<()>();
        let read = tokio::task::spawn_blocking(move || {
            let _ = stalled.recv();
            json!({ "ok": true })
        });
        let result = super::settle_document_read(read, std::time::Duration::from_millis(10)).await;
        assert_eq!(result, json!({ "ok": false, "size": 0, "mtimeMs": 0, "error": "timed-out" }));
        release.send(()).unwrap();
    }

    #[tokio::test]
    async fn dispatches_fs_read_document_as_a_deferred_reply() {
        let fakes = Fakes::default();
        let ctx = ctx(&fakes);
        let reply = super::fs_read_document(&ctx, Caller::main(WindowId(1)), vec![json!({ "path": "/nonexistent/a.docx" })]);
        assert!(matches!(reply, crate::bridge::Reply::Later(_)));
    }

    #[tokio::test]
    async fn dispatches_log_snapshot() {
        let fakes = Fakes::default();
        let ctx = ctx(&fakes);
        let caller = Caller::main(WindowId(1));
        let snapshot = bridge::dispatch_for_test(&ctx, caller, "log:snapshot", vec![]).await.unwrap();
        assert_eq!(snapshot, json!({ "lines": [], "nextSequence": 0 }));
    }
}
