//! Handlers for the channels this module owns. Every body starts as a
//! `not_ported` stub; the module's port replaces them and `check-module.sh`
//! fails while any stub remains.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine;
use serde_json::{json, Value};

use crate::bridge::{IpcError, Reply};
use crate::ctx::AppCtx;
use crate::ports::{Caller, SessionScope};

use super::fs as workspace_fs;

/// `~/` expands against the home directory; everything else passes through unchanged.
fn expand_home(path: &str) -> String {
    match path.strip_prefix("~/") {
        Some(rest) => dirs::home_dir().map(|home| home.join(rest).to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string()),
        None => path.to_string(),
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
pub fn log_snapshot(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("log:snapshot"))
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
/// of double-attaching when the session is already open. `ipc.ts:633-647`.
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
        }
        if ctx.tabs.at_cap() {
            return Ok(Value::Bool(false));
        }
        let cwd = payload_cwd.or(caller_cwd).or_else(|| {
            let home = dirs::home_dir();
            crate::paths::initial_cwd(&[home.as_deref().and_then(|path| path.to_str())])
        });
        let kind = match &session_path {
            Some(path) => Some(ctx.services.session_kind_for(path).await),
            None => None,
        };
        Ok(Value::Bool(ctx.desktop.spawn_window(cwd, session_path, kind).is_some()))
    }))
}

/// `session:consume-pending`: a fresh window pulls the session it was opened
/// to display (one-shot).
pub fn session_consume_pending(ctx: &Arc<AppCtx>, caller: Caller, _args: Vec<Value>) -> Reply {
    Reply::ok(ctx.desktop.consume_pending_session(caller.win_id).map(Value::String).unwrap_or(Value::Null))
}

/// `system:open-external`
pub fn system_open_external(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("system:open-external"))
}

/// `system:open-path`
pub fn system_open_path(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("system:open-path"))
}

/// `system:save-dialog`
pub fn system_save_dialog(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("system:save-dialog"))
}

/// `system:open-dialog`
pub fn system_open_dialog(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("system:open-dialog"))
}

/// `system:clipboard-read`
pub fn system_clipboard_read(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("system:clipboard-read"))
}

/// `system:notify`
pub fn system_notify(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("system:notify"))
}

/// `prefs:get`
pub fn prefs_get(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("prefs:get"))
}

/// `prefs:set`
pub fn prefs_set(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("prefs:set"))
}

/// `models:providers-list`
pub fn models_providers_list(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("models:providers-list"))
}

/// `provider-cleanup:config`
pub fn provider_cleanup_config(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("provider-cleanup:config"))
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

/// `editor:open-external`
pub fn editor_open_external(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = (ctx, caller, args);
    Reply::err(IpcError::not_ported("editor:open-external"))
}
