//! Handlers for the channels this module owns: the `ollama:*` commands from
//! `register-ipc.ts`. Pull and install progress stream to the
//! caller (or every main window) through `ctx.bridge`, the only reach into
//! the bridge this module makes.

use std::sync::Arc;

use serde_json::Value;

use super::context_fit_scheduler::MeasureReason;
use super::{string_field, Ollama, OLLAMA_DOWNLOAD_URL};
use crate::bridge::{self, IpcError, Reply};
use crate::ctx::AppCtx;
use crate::ports::Caller;

/// The real `Ollama` behind `ctx.ollama`, or an error reply when the port is some other stub.
fn ollama(ctx: &Arc<AppCtx>) -> Result<&Ollama, IpcError> {
    ctx.ollama.as_any().downcast_ref::<Ollama>().ok_or_else(|| IpcError::new("ollama port is not the production implementation"))
}

/// `ollama:status`
pub fn ollama_status(ctx: &Arc<AppCtx>, _caller: Caller, _args: Vec<Value>) -> Reply {
    let ctx = ctx.clone();
    Reply::Later(Box::pin(async move {
        let status = ollama(&ctx)?.status().await;
        Ok(serde_json::to_value(status)?)
    }))
}

/// `ollama:model-screen`
pub fn ollama_model_screen(ctx: &Arc<AppCtx>, _caller: Caller, _args: Vec<Value>) -> Reply {
    let ctx = ctx.clone();
    Reply::Later(Box::pin(async move {
        let screen = ollama(&ctx)?.model_screen().await;
        Ok(serde_json::to_value(screen)?)
    }))
}

/// `ollama:pull`
pub fn ollama_pull(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    // The puller answers an invalid tag with an error frame; pass whatever string
    // arrived (even empty) so the frame can echo it, matching the TS handler.
    let tag = string_field(&args, "tag").unwrap_or("").to_string();
    let ctx = ctx.clone();
    Reply::Later(Box::pin(async move {
        let frame = ollama(&ctx)?.pull(&tag, caller.win_id).await;
        Ok(serde_json::to_value(frame)?)
    }))
}

/// `ollama:pull-cancel`
pub fn ollama_pull_cancel(ctx: &Arc<AppCtx>, _caller: Caller, _args: Vec<Value>) -> Reply {
    match ollama(ctx) {
        Ok(ollama) => {
            ollama.pull_cancel();
            Reply::ok(Value::Null)
        }
        Err(error) => Reply::err(error),
    }
}

/// `ollama:warm`
pub fn ollama_warm(ctx: &Arc<AppCtx>, _caller: Caller, args: Vec<Value>) -> Reply {
    let Some(tag) = string_field(&args, "tag").filter(|tag| super::pull::is_valid_model_tag(tag)).map(str::to_string) else {
        return Reply::err(IpcError::new("Invalid model name"));
    };
    let ctx = ctx.clone();
    Reply::Later(Box::pin(async move {
        let _ = ollama(&ctx)?;
        // Fire and forget: loading can take minutes and `warm` logs its own failures.
        bridge::spawn_task(async move {
            if let Ok(ollama) = ollama(&ctx) {
                ollama.warm(tag).await;
            }
        });
        Ok(Value::Null)
    }))
}

/// `ollama:remedy`
pub fn ollama_remedy(ctx: &Arc<AppCtx>, _caller: Caller, args: Vec<Value>) -> Reply {
    let id_str = string_field(&args, "id");
    if !super::remedy::is_remedy_id(id_str) {
        return Reply::err(IpcError::new("Unknown Ollama remedy"));
    }
    let id = match id_str {
        Some("linux-start") => super::probe::OllamaRemedyId::LinuxStart,
        Some("linux-install") => super::probe::OllamaRemedyId::LinuxInstall,
        _ => return Reply::err(IpcError::new("Unknown Ollama remedy")),
    };
    let ctx = ctx.clone();
    Reply::Later(Box::pin(async move {
        let result = ollama(&ctx)?.run_remedy(id).await.map_err(IpcError::new)?;
        Ok(serde_json::to_value(result)?)
    }))
}

/// `ollama:open-download`
pub fn ollama_open_download(ctx: &Arc<AppCtx>, _caller: Caller, _args: Vec<Value>) -> Reply {
    match ctx.host.open_url(OLLAMA_DOWNLOAD_URL) {
        Ok(()) => Reply::ok(Value::Null),
        Err(error) => Reply::err(IpcError::new(error.to_string())),
    }
}

/// `ollama:context-list`
pub fn ollama_context_list(ctx: &Arc<AppCtx>, _caller: Caller, _args: Vec<Value>) -> Reply {
    let ctx = ctx.clone();
    Reply::Later(Box::pin(async move {
        let scheduler = ollama(&ctx)?.context_fit().clone();
        Ok(serde_json::to_value(scheduler.list().await)?)
    }))
}

/// `ollama:context-measure`: `{ tag, reason?: "manual" | "pulled" }` → `{ queued: true }`.
pub fn ollama_context_measure(ctx: &Arc<AppCtx>, _caller: Caller, args: Vec<Value>) -> Reply {
    let Some(tag) = string_field(&args, "tag").map(str::to_string) else {
        return Reply::err(IpcError::new("Invalid model name"));
    };
    let reason = match args.first().and_then(|payload| payload.get("reason")) {
        None | Some(Value::Null) => MeasureReason::Manual,
        Some(Value::String(reason)) if reason == "manual" => MeasureReason::Manual,
        Some(Value::String(reason)) if reason == "pulled" => MeasureReason::Pulled,
        Some(_) => return Reply::err(IpcError::new("Invalid measurement reason")),
    };
    let ctx = ctx.clone();
    Reply::Later(Box::pin(async move {
        let scheduler = ollama(&ctx)?.context_fit().clone();
        scheduler.request_measure(&tag, reason).await.map_err(IpcError::new)?;
        Ok(serde_json::json!({ "queued": true }))
    }))
}

/// `ollama:context-set-cap`: `{ tag, cap: number | null }` → the stored entry.
pub fn ollama_context_set_cap(ctx: &Arc<AppCtx>, _caller: Caller, args: Vec<Value>) -> Reply {
    let payload = args.first();
    let (Some(tag), Some(cap)) = (string_field(&args, "tag").map(str::to_string), payload.and_then(|payload| payload.get("cap")).cloned()) else {
        return Reply::err(IpcError::new("Invalid context limit"));
    };
    let ctx = ctx.clone();
    Reply::Later(Box::pin(async move {
        let scheduler = ollama(&ctx)?.context_fit().clone();
        let entry = scheduler.set_cap(&tag, &cap).await.map_err(IpcError::new)?;
        Ok(serde_json::to_value(entry)?)
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::{dispatch_for_test, Registry};
    use crate::ports::{Caller, WindowId};
    use crate::testing::{fake_ctx_cyclic, Fakes};

    fn registry() -> Registry {
        let mut registry = Registry::new();
        super::super::register(&mut registry);
        registry
    }

    fn main_caller() -> Caller {
        Caller::main(WindowId(1))
    }

    #[tokio::test]
    async fn ollama_status_reports_the_daemon_state() {
        let fakes = Fakes::default();
        let ctx = fake_ctx_cyclic(&fakes, registry(), |ctx, ports| ports.ollama = Some(Arc::new(Ollama::new(ctx.clone()))));
        let result = dispatch_for_test(&ctx, main_caller(), "ollama:status", vec![]).await.expect("ollama:status replies");
        // Whether a daemon happens to be running on this host's loopback port is
        // out of scope here (`probe.rs` already covers every state); this only
        // checks the handler is wired and shaped correctly.
        assert!(matches!(result.get("state").and_then(Value::as_str), Some("ok" | "stopped" | "absent")));
    }

    #[tokio::test]
    async fn ollama_model_screen_sizes_the_catalog_against_this_machine() {
        let fakes = Fakes::default();
        let ctx = fake_ctx_cyclic(&fakes, registry(), |ctx, ports| ports.ollama = Some(Arc::new(Ollama::new(ctx.clone()))));
        let result = dispatch_for_test(&ctx, main_caller(), "ollama:model-screen", vec![]).await.expect("ollama:model-screen replies");
        assert!(result.get("machine").is_some());
        assert!(result.get("choices").and_then(Value::as_array).is_some());
    }

    #[tokio::test]
    async fn ollama_pull_rejects_an_invalid_tag_without_a_request() {
        let fakes = Fakes::default();
        let ctx = fake_ctx_cyclic(&fakes, registry(), |ctx, ports| ports.ollama = Some(Arc::new(Ollama::new(ctx.clone()))));
        let result = dispatch_for_test(&ctx, main_caller(), "ollama:pull", vec![serde_json::json!({ "tag": "; rm -rf /" })])
            .await
            .expect("ollama:pull replies even for an invalid tag");
        assert_eq!(result.get("error").and_then(Value::as_str), Some("Invalid model name"));
    }

    #[tokio::test]
    async fn ollama_pull_cancel_cancels_without_a_running_pull() {
        let fakes = Fakes::default();
        let ctx = fake_ctx_cyclic(&fakes, registry(), |ctx, ports| ports.ollama = Some(Arc::new(Ollama::new(ctx.clone()))));
        let result = dispatch_for_test(&ctx, main_caller(), "ollama:pull-cancel", vec![]).await;
        assert_eq!(result, Ok(Value::Null));
    }

    #[tokio::test]
    async fn ollama_warm_rejects_an_invalid_tag() {
        let fakes = Fakes::default();
        let ctx = fake_ctx_cyclic(&fakes, registry(), |ctx, ports| ports.ollama = Some(Arc::new(Ollama::new(ctx.clone()))));
        let result = dispatch_for_test(&ctx, main_caller(), "ollama:warm", vec![serde_json::json!({ "tag": "bad name" })]).await;
        assert_eq!(result, Err(IpcError::new("Invalid model name")));
    }

    #[tokio::test]
    async fn ollama_remedy_rejects_an_id_outside_the_closed_set() {
        let fakes = Fakes::default();
        let ctx = fake_ctx_cyclic(&fakes, registry(), |ctx, ports| ports.ollama = Some(Arc::new(Ollama::new(ctx.clone()))));
        let result = dispatch_for_test(&ctx, main_caller(), "ollama:remedy", vec![serde_json::json!({ "id": "rm -rf /" })]).await;
        assert_eq!(result, Err(IpcError::new("Unknown Ollama remedy")));
    }

    #[tokio::test]
    async fn ollama_open_download_opens_the_download_page() {
        let fakes = Fakes::default();
        let ctx = fake_ctx_cyclic(&fakes, registry(), |ctx, ports| ports.ollama = Some(Arc::new(Ollama::new(ctx.clone()))));
        let result = dispatch_for_test(&ctx, main_caller(), "ollama:open-download", vec![]).await;
        assert_eq!(result, Ok(Value::Null));
        assert!(fakes.host.log.calls().iter().any(|call| call.contains(OLLAMA_DOWNLOAD_URL)));
    }

    #[tokio::test]
    async fn ollama_context_measure_refuses_an_internal_or_unknown_reason_and_a_missing_tag() {
        let fakes = Fakes::default();
        let ctx = fake_ctx_cyclic(&fakes, registry(), |ctx, ports| ports.ollama = Some(Arc::new(Ollama::new(ctx.clone()))));
        for reason in ["stale", "later"] {
            let result = dispatch_for_test(&ctx, main_caller(), "ollama:context-measure", vec![serde_json::json!({ "tag": "qwen3:8b", "reason": reason })]).await;
            assert_eq!(result, Err(IpcError::new("Invalid measurement reason")), "{reason}");
        }
        let result = dispatch_for_test(&ctx, main_caller(), "ollama:context-measure", vec![serde_json::json!({ "tag": 7 })]).await;
        assert_eq!(result, Err(IpcError::new("Invalid model name")));
        let result = dispatch_for_test(&ctx, main_caller(), "ollama:context-measure", vec![serde_json::json!({ "tag": "bad name" })]).await;
        assert_eq!(result, Err(IpcError::new("Invalid model name")));
    }

    #[tokio::test]
    async fn ollama_context_set_cap_refuses_a_payload_without_a_cap() {
        let fakes = Fakes::default();
        let ctx = fake_ctx_cyclic(&fakes, registry(), |ctx, ports| ports.ollama = Some(Arc::new(Ollama::new(ctx.clone()))));
        for payload in [serde_json::json!({ "tag": "qwen3:8b" }), serde_json::json!({ "cap": 16384 }), Value::Null] {
            let result = dispatch_for_test(&ctx, main_caller(), "ollama:context-set-cap", vec![payload.clone()]).await;
            assert_eq!(result, Err(IpcError::new("Invalid context limit")), "{payload}");
        }
    }
}
