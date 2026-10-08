//! GUI-registered host tools the agent can call mid-turn, ported from
//! `executeGuiHostTool` (`ipc.ts:1222-1244`).

use std::sync::Arc;

use serde_json::Value;

use crate::ctx::AppCtx;

/// `gui_open_url`, `gui_notify`, `gui_clipboard_read`; `None` for anything
/// else, so the caller forwards an unknown tool to the owning renderer.
pub fn execute(ctx: &Arc<AppCtx>, name: &str, args: &Value) -> Option<futures_util::future::BoxFuture<'static, Result<Value, String>>> {
    match name {
        "gui_open_url" => {
            let url = args.get("url").and_then(Value::as_str).unwrap_or("").to_string();
            let ctx = ctx.clone();
            Some(Box::pin(async move {
                if super::system::allowed_web_url(&url) {
                    let _ = ctx.host.open_url(&url);
                    Ok(Value::String("Opened in browser".into()))
                } else {
                    Ok(Value::String(format!("Invalid URL: {url}")))
                }
            }))
        }
        "gui_notify" => {
            let title = args.get("title").and_then(Value::as_str).unwrap_or("Notification").to_string();
            let body = args.get("body").and_then(Value::as_str).unwrap_or("").to_string();
            let ctx = ctx.clone();
            Some(Box::pin(async move {
                let _ = ctx.host.notify(&title, Some(body.as_str()).filter(|body| !body.is_empty()));
                Ok(Value::String("Notification shown".into()))
            }))
        }
        "gui_clipboard_read" => {
            let ctx = ctx.clone();
            Some(Box::pin(async move { ctx.host.clipboard_read_text().await.map(Value::String).map_err(|error| error.to_string()) }))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::Registry;
    use crate::testing::{self, Fakes};

    fn ctx(fakes: &Fakes) -> Arc<AppCtx> {
        testing::fake_ctx_cyclic(fakes, Registry::new(), |ctx, ports| {
            ports.services = Some(Arc::new(crate::services::Services::new(ctx.clone())));
        })
    }

    #[tokio::test]
    async fn opens_an_allowed_url_and_refuses_everything_else() {
        let fakes = Fakes::default();
        let ctx = ctx(&fakes);
        let result = execute(&ctx, "gui_open_url", &serde_json::json!({ "url": "https://example.com" })).unwrap().await.unwrap();
        assert_eq!(result, Value::String("Opened in browser".into()));
        let refused = execute(&ctx, "gui_open_url", &serde_json::json!({ "url": "file:///etc/passwd" })).unwrap().await.unwrap();
        assert_eq!(refused, Value::String("Invalid URL: file:///etc/passwd".into()));
    }

    #[tokio::test]
    async fn shows_a_notification_and_reads_the_clipboard() {
        let fakes = Fakes::default();
        *fakes.host.clipboard_text.lock().unwrap() = "clip".into();
        let ctx = ctx(&fakes);
        let notified = execute(&ctx, "gui_notify", &serde_json::json!({ "title": "Hi" })).unwrap().await.unwrap();
        assert_eq!(notified, Value::String("Notification shown".into()));
        let clipboard = execute(&ctx, "gui_clipboard_read", &Value::Null).unwrap().await.unwrap();
        assert_eq!(clipboard, Value::String("clip".into()));
    }

    #[tokio::test]
    async fn an_unknown_tool_is_not_handled_here() {
        let fakes = Fakes::default();
        let ctx = ctx(&fakes);
        assert!(execute(&ctx, "something_else", &Value::Null).is_none());
    }
}
