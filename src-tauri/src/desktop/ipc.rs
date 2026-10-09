//! Handlers for the channels this module owns. Each reaches the module's
//! state through `Desktop::of(ctx)` and does its work synchronously; none of
//! them awaits anything.

use std::sync::Arc;

use serde_json::{json, Value};

use super::quick_entry_core::QuickEntryFailure;
use super::Desktop;
use crate::bridge::{IpcError, Reply};
use crate::ctx::AppCtx;
use crate::ports::{Caller, RunProgressState, WindowKind};

fn desktop<'a>(ctx: &'a Arc<AppCtx>, channel: &str) -> Result<&'a Desktop, IpcError> {
    Desktop::of(ctx).ok_or_else(|| IpcError::new(format!("{channel}: the desktop module is not installed")))
}

/// Bar channels answer only the bar's own page.
fn bar<'a>(ctx: &'a Arc<AppCtx>, caller: Caller, channel: &str) -> Result<&'a Desktop, IpcError> {
    if caller.kind != WindowKind::QuickEntry {
        return Err(IpcError::wrong_scope(channel));
    }
    desktop(ctx, channel)
}

/// Main-window channels answer only a live chat window, never the bar.
fn chat_window<'a>(ctx: &'a Arc<AppCtx>, caller: Caller, channel: &str) -> Result<&'a Desktop, IpcError> {
    let desktop = desktop(ctx, channel)?;
    if caller.kind != WindowKind::Main || !desktop.is_chat_window(caller.win_id) {
        return Err(IpcError::new(format!("{channel} is managed by the chat windows")));
    }
    Ok(desktop)
}

fn first<T: for<'de> serde::Deserialize<'de>>(channel: &str, args: &[Value]) -> Result<T, IpcError> {
    let value = args.first().cloned().unwrap_or(Value::Null);
    serde_json::from_value(value).map_err(|error| IpcError::bad_payload(channel, error))
}

/// `app:quit`: quit through the guard, as the menu would.
pub fn app_quit(ctx: &Arc<AppCtx>, caller: Caller, _args: Vec<Value>) -> Reply {
    let _ = caller;
    match desktop(ctx, "app:quit") {
        Ok(desktop) => {
            desktop.start_guarded_quit(ctx);
            Reply::ok(Value::Null)
        }
        Err(error) => Reply::err(error),
    }
}

/// `quick-entry:submit`
pub fn quick_entry_submit(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let desktop = match bar(ctx, caller, "quick-entry:submit") {
        Ok(desktop) => desktop,
        Err(error) => return Reply::err(error),
    };
    match desktop.quick_entry.submit(ctx, desktop, args.first()) {
        Ok(()) => Reply::ok(json!({ "ok": true })),
        Err(reason) => Reply::ok(json!({ "ok": false, "reason": reason })),
    }
}

/// `quick-entry:consume-restored`
pub fn quick_entry_consume_restored(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let desktop = match bar(ctx, caller, "quick-entry:consume-restored") {
        Ok(desktop) => desktop,
        Err(error) => return Reply::err(error),
    };
    if let Some(id) = args.first().and_then(Value::as_str) {
        desktop.quick_entry.consume_restored(id);
    }
    Reply::ok(Value::Null)
}

/// `quick-entry:dismiss`
pub fn quick_entry_dismiss(ctx: &Arc<AppCtx>, caller: Caller, _args: Vec<Value>) -> Reply {
    match bar(ctx, caller, "quick-entry:dismiss") {
        Ok(desktop) => {
            desktop.quick_entry.hide(desktop);
            Reply::ok(Value::Null)
        }
        Err(error) => Reply::err(error),
    }
}

/// `quick-entry:claim`: lease the window's pending prompts to its renderer.
pub fn quick_entry_claim(ctx: &Arc<AppCtx>, caller: Caller, _args: Vec<Value>) -> Reply {
    match chat_window(ctx, caller, "quick-entry:claim") {
        Ok(desktop) => match serde_json::to_value(desktop.quick_entry.claim(caller.win_id)) {
            Ok(value) => Reply::ok(value),
            Err(error) => Reply::err(IpcError::new(error.to_string())),
        },
        Err(error) => Reply::err(error),
    }
}

/// `quick-entry:ack`
pub fn quick_entry_ack(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let desktop = match chat_window(ctx, caller, "quick-entry:ack") {
        Ok(desktop) => desktop,
        Err(error) => return Reply::err(error),
    };
    if let Some(id) = args.first().and_then(Value::as_str) {
        desktop.quick_entry.ack(caller.win_id, id);
    }
    Reply::ok(Value::Null)
}

/// `quick-entry:return`: `{ prompt: { id }, reason }`.
pub fn quick_entry_return(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let desktop = match chat_window(ctx, caller, "quick-entry:return") {
        Ok(desktop) => desktop,
        Err(error) => return Reply::err(error),
    };
    let payload = args.first();
    let id = payload.and_then(|p| p.get("prompt")).and_then(|p| p.get("id")).and_then(Value::as_str);
    let reason = payload.and_then(|p| p.get("reason")).cloned().and_then(|r| serde_json::from_value::<QuickEntryFailure>(r).ok());
    if let (Some(id), Some(reason)) = (id, reason) {
        desktop.quick_entry.return_prompt(ctx, desktop, caller.win_id, id, reason);
    }
    Reply::ok(Value::Null)
}

/// `quick-entry:shortcut-get`
pub fn quick_entry_shortcut_get(ctx: &Arc<AppCtx>, caller: Caller, _args: Vec<Value>) -> Reply {
    let desktop = match chat_window(ctx, caller, "quick-entry:shortcut-get") {
        Ok(desktop) => desktop,
        Err(error) => return Reply::err(error),
    };
    match desktop.shortcut_handle() {
        Some(shortcut) => Reply::Ready(serde_json::to_value(shortcut.state()).map_err(IpcError::from)),
        None => Reply::err(IpcError::new("the quick entry shortcut is not installed")),
    }
}

/// `quick-entry:shortcut-set`
pub fn quick_entry_shortcut_set(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let desktop = match chat_window(ctx, caller, "quick-entry:shortcut-set") {
        Ok(desktop) => desktop,
        Err(error) => return Reply::err(error),
    };
    let Some(shortcut) = desktop.shortcut_handle() else { return Reply::err(IpcError::new("the quick entry shortcut is not installed")) };
    let update = args.first().cloned().unwrap_or(Value::Null);
    Reply::ok(shortcut.update(caller.win_id, &update).to_json())
}

/// `quick-entry:shortcut-suspend`
pub fn quick_entry_shortcut_suspend(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let desktop = match chat_window(ctx, caller, "quick-entry:shortcut-suspend") {
        Ok(desktop) => desktop,
        Err(error) => return Reply::err(error),
    };
    if let (Some(shortcut), Some(suspended)) = (desktop.shortcut_handle(), args.first().and_then(Value::as_bool)) {
        shortcut.set_suspended(caller.win_id, suspended);
    }
    Reply::ok(Value::Null)
}

/// `quick-entry:shortcut-notice`
pub fn quick_entry_shortcut_notice(ctx: &Arc<AppCtx>, caller: Caller, _args: Vec<Value>) -> Reply {
    let desktop = match chat_window(ctx, caller, "quick-entry:shortcut-notice") {
        Ok(desktop) => desktop,
        Err(error) => return Reply::err(error),
    };
    let notice = desktop.shortcut_handle().and_then(|shortcut| shortcut.take_startup_notice());
    Reply::Ready(serde_json::to_value(notice).map_err(IpcError::from))
}

/// `tray:state-push`: the window's snapshot joins the tray aggregate.
pub fn tray_state_push(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let desktop = match chat_window(ctx, caller, "tray:state-push") {
        Ok(desktop) => desktop,
        Err(error) => return Reply::err(error),
    };
    let state = args.first().cloned().unwrap_or(Value::Null);
    match desktop.push_tray_state(ctx, caller.win_id, state) {
        Ok(()) => Reply::ok(Value::Null),
        Err(error) => Reply::err(IpcError::bad_payload("tray:state-push", error)),
    }
}

/// `progress:set`: the window's run progress joins the taskbar aggregate.
pub fn progress_set(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let desktop = match chat_window(ctx, caller, "progress:set") {
        Ok(desktop) => desktop,
        Err(error) => return Reply::err(error),
    };
    match first::<RunProgressState>("progress:set", &args) {
        Ok(state) => {
            desktop.push_progress(caller.win_id, state);
            Reply::ok(Value::Null)
        }
        Err(error) => Reply::err(error),
    }
}

#[cfg(test)]
mod tests {
    use crate::bridge::dispatch_for_test;
    use crate::desktop::testing::{harness, Backend as _, DesktopPort as _, Harness};
    use crate::ports::{Caller, RunProgressState, WindowId};
    use serde_json::json;

    /// A harness with one chat window whose page is attached, and the bar shown.
    async fn with_bar() -> (Harness, WindowId) {
        let h = harness();
        let id = h.desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        h.desktop.quick_entry.mark_startup_windows(&h.ctx, &h.desktop, &[]);
        h.desktop.quick_entry.show(&h.ctx, &h.desktop);
        (h, id)
    }

    async fn submit(h: &Harness, text: &str) -> serde_json::Value {
        dispatch_for_test(&h.ctx, Caller::quick_entry(), "quick-entry:submit", vec![json!({ "text": text, "target": { "kind": "chat" } })]).await.unwrap()
    }

    #[tokio::test]
    async fn dispatches_quick_entry_submit() {
        let (h, id) = with_bar().await;
        assert_eq!(submit(&h, "hello").await, json!({ "ok": true }));
        assert_eq!(h.desktop.quick_entry.claim(id).len(), 1);
    }

    #[tokio::test]
    async fn dispatches_quick_entry_consume_restored() {
        let (h, id) = with_bar().await;
        submit(&h, "one").await;
        let prompt = h.desktop.quick_entry.claim(id).remove(0);
        h.desktop.quick_entry.return_prompt(&h.ctx, &h.desktop, id, &prompt.id, crate::desktop::quick_entry_core::QuickEntryFailure::TabFailed);
        assert_eq!(h.desktop.quick_entry.restored().len(), 1);
        dispatch_for_test(&h.ctx, Caller::quick_entry(), "quick-entry:consume-restored", vec![json!(prompt.id)]).await.unwrap();
        assert!(h.desktop.quick_entry.restored().is_empty());
    }

    #[tokio::test]
    async fn dispatches_quick_entry_dismiss() {
        let (h, _) = with_bar().await;
        assert!(h.backend.is_visible(WindowId::QUICK_ENTRY));
        dispatch_for_test(&h.ctx, Caller::quick_entry(), "quick-entry:dismiss", vec![]).await.unwrap();
        assert!(!h.backend.is_visible(WindowId::QUICK_ENTRY));
    }

    #[tokio::test]
    async fn dispatches_quick_entry_claim() {
        let (h, id) = with_bar().await;
        submit(&h, "one").await;
        let claimed = dispatch_for_test(&h.ctx, Caller::main(id), "quick-entry:claim", vec![]).await.unwrap();
        assert_eq!(claimed.as_array().map(Vec::len), Some(1));
        assert_eq!(claimed[0]["text"], "one");
        let again = dispatch_for_test(&h.ctx, Caller::main(id), "quick-entry:claim", vec![]).await.unwrap();
        assert_eq!(again, json!([]));
    }

    #[tokio::test]
    async fn dispatches_quick_entry_ack() {
        let (h, id) = with_bar().await;
        submit(&h, "one").await;
        let claimed = dispatch_for_test(&h.ctx, Caller::main(id), "quick-entry:claim", vec![]).await.unwrap();
        dispatch_for_test(&h.ctx, Caller::main(id), "quick-entry:ack", vec![claimed[0]["id"].clone()]).await.unwrap();
        assert!(h.desktop.quick_entry.queue().is_empty());
    }

    #[tokio::test]
    async fn dispatches_quick_entry_return() {
        let (h, id) = with_bar().await;
        submit(&h, "one").await;
        let claimed = dispatch_for_test(&h.ctx, Caller::main(id), "quick-entry:claim", vec![]).await.unwrap();
        let payload = json!({ "prompt": { "id": claimed[0]["id"], "text": "rewritten" }, "reason": "tab-failed" });
        dispatch_for_test(&h.ctx, Caller::main(id), "quick-entry:return", vec![payload]).await.unwrap();
        let restored = h.desktop.quick_entry.restored();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].prompt.text, "one", "the shell's own copy comes back, not the renderer's");
        // An unknown reason is ignored rather than failing the call.
        dispatch_for_test(&h.ctx, Caller::main(id), "quick-entry:return", vec![json!({ "prompt": { "id": "x" }, "reason": "nope" })]).await.unwrap();
        assert_eq!(h.desktop.quick_entry.restored().len(), 1);
    }

    #[tokio::test]
    async fn dispatches_quick_entry_shortcut_get() {
        let (h, id) = with_bar().await;
        let state = dispatch_for_test(&h.ctx, Caller::main(id), "quick-entry:shortcut-get", vec![]).await.unwrap();
        assert_eq!(state["chord"], "⇧⌃␣");
        assert_eq!(state["status"], "registered");
        assert_eq!(state["mode"], "native");
    }

    #[tokio::test]
    async fn dispatches_quick_entry_shortcut_set() {
        let (h, id) = with_bar().await;
        let rejected = dispatch_for_test(&h.ctx, Caller::main(id), "quick-entry:shortcut-set", vec![json!({ "chord": "⌘C" })]).await.unwrap();
        assert_eq!(rejected["ok"], false);
        assert_eq!(rejected["reason"], "system");
        let accepted = dispatch_for_test(&h.ctx, Caller::main(id), "quick-entry:shortcut-set", vec![json!({ "enabled": false })]).await.unwrap();
        assert_eq!(accepted["ok"], true);
        assert_eq!(accepted["state"]["status"], "off");
        assert_eq!(h.ctx.prefs.get("quickEntryShortcut"), Some(json!({ "chord": "⇧⌃␣", "enabled": false })));
    }

    #[tokio::test]
    async fn dispatches_quick_entry_shortcut_suspend() {
        let (h, id) = with_bar().await;
        dispatch_for_test(&h.ctx, Caller::main(id), "quick-entry:shortcut-suspend", vec![json!(true)]).await.unwrap();
        dispatch_for_test(&h.ctx, Caller::main(id), "quick-entry:shortcut-suspend", vec![json!(false)]).await.unwrap();
        // Only chat windows may suspend handling.
        assert!(dispatch_for_test(&h.ctx, Caller::quick_entry(), "quick-entry:shortcut-suspend", vec![json!(true)]).await.is_err());
    }

    #[tokio::test]
    async fn dispatches_quick_entry_shortcut_notice() {
        let (h, id) = with_bar().await;
        let notice = dispatch_for_test(&h.ctx, Caller::main(id), "quick-entry:shortcut-notice", vec![]).await.unwrap();
        assert_eq!(notice, serde_json::Value::Null, "the registry accepted the chord, so there is no startup refusal");
    }

    #[tokio::test]
    async fn progress_pushes_aggregate_across_windows() {
        let Harness { ctx, desktop, backend, .. } = harness();
        let first = desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        let second = desktop.spawn_window(Some("/w/beta".into()), None, None).unwrap();
        dispatch_for_test(&ctx, Caller::main(first), "progress:set", vec![json!("working")]).await.unwrap();
        dispatch_for_test(&ctx, Caller::main(second), "progress:set", vec![json!("idle")]).await.unwrap();
        assert_eq!(backend.progress.lock().unwrap().get(&second), Some(&Some(50)), "any working window keeps the aggregate working");
        dispatch_for_test(&ctx, Caller::main(first), "progress:set", vec![json!("waiting")]).await.unwrap();
        assert_eq!(backend.progress.lock().unwrap().get(&first), Some(&Some(75)));
        assert!(dispatch_for_test(&ctx, Caller::main(first), "progress:set", vec![json!("bogus")]).await.is_err());
        // A closed window's snapshot leaves the aggregate.
        desktop.push_progress(second, RunProgressState::Working);
        backend.destroy(first);
        desktop.on_window_event(&ctx, first, crate::desktop::windows::WinEvent::Destroyed);
        assert_eq!(backend.progress.lock().unwrap().get(&second), Some(&Some(50)));
        assert!(dispatch_for_test(&ctx, Caller::main(WindowId(77)), "progress:set", vec![json!("idle")]).await.is_err());
    }
}
