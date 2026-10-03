//! Test-only bridge channels, compiled only with the `e2e-hooks` cargo feature.
//! Release bundles never enable it. The end-to-end suite reaches these through
//! `omp_invoke` on the `bridge::E2E_HOOK_GEN` page generation
//! (`e2e-tauri/test-hooks.ts`); the Electron specs did the same work through
//! `app.evaluate` in the main process (`e2e-tauri/reach-ins.json` maps each one).

use crate::bridge::Registry;

/// Register the `test:*` channels. Without the feature this registers nothing.
#[cfg(not(feature = "e2e-hooks"))]
pub fn register(_reg: &mut Registry) {}

#[cfg(feature = "e2e-hooks")]
pub fn register(reg: &mut Registry) {
    use crate::bridge::Scope;
    reg.register("test:release", Scope::Main, hooks::release);
    reg.register("test:barrier-waiters", Scope::Main, hooks::barrier_waiters);
    reg.register("test:calls", Scope::Main, hooks::calls);
    reg.register("test:emit", Scope::Main, hooks::emit);
    reg.register("test:quit", Scope::Main, hooks::quit);
    reg.register("test:windows", Scope::Main, hooks::windows);
    reg.register("test:second-instance", Scope::Main, hooks::second_instance);
    reg.register("test:navigation-probe", Scope::Main, hooks::navigation_probe);
    reg.register("test:fault", Scope::Main, hooks::fault);
    reg.register("test:runtime", Scope::Main, hooks::runtime);
}

#[cfg(feature = "e2e-hooks")]
mod hooks {
    use std::sync::Arc;

    use serde::Deserialize;
    use serde_json::{json, Value};

    use crate::bridge::{Fault, IpcError, Reply};
    use crate::ctx::AppCtx;
    use crate::ports::{Caller, WindowId};

    fn first<T: for<'de> Deserialize<'de>>(channel: &str, args: &[Value]) -> Result<T, IpcError> {
        let value = args.first().cloned().unwrap_or(Value::Null);
        serde_json::from_value(value).map_err(|error| IpcError::bad_payload(channel, error))
    }

    #[derive(Deserialize)]
    struct BarrierId {
        id: String,
    }

    /// `test:release { id }`: release the calls held at a barrier; true when it existed.
    pub fn release(ctx: &Arc<AppCtx>, _: Caller, args: Vec<Value>) -> Reply {
        match first::<BarrierId>("test:release", &args) {
            Ok(payload) => Reply::ok(json!(ctx.bridge.release_barrier(&payload.id))),
            Err(error) => Reply::err(error),
        }
    }

    /// `test:barrier-waiters { id }`: how many calls are held at the barrier right now.
    pub fn barrier_waiters(ctx: &Arc<AppCtx>, _: Caller, args: Vec<Value>) -> Reply {
        match first::<BarrierId>("test:barrier-waiters", &args) {
            Ok(payload) => Reply::ok(json!(ctx.bridge.barrier_waiters(&payload.id))),
            Err(error) => Reply::err(error),
        }
    }

    /// `test:calls { channel }`: calls that reached the channel since start, faulted ones included.
    pub fn calls(ctx: &Arc<AppCtx>, _: Caller, args: Vec<Value>) -> Reply {
        #[derive(Deserialize)]
        struct Payload {
            channel: String,
        }
        match first::<Payload>("test:calls", &args) {
            Ok(payload) => Reply::ok(json!(ctx.bridge.calls_to(&payload.channel))),
            Err(error) => Reply::err(error),
        }
    }

    /// `test:emit { winId, channel, payload }`: inject a main→renderer message.
    pub fn emit(ctx: &Arc<AppCtx>, _: Caller, args: Vec<Value>) -> Reply {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload {
            win_id: WindowId,
            channel: String,
            payload: Value,
        }
        match first::<Payload>("test:emit", &args) {
            Ok(payload) => {
                ctx.bridge.emit_to_window(payload.win_id, &payload.channel, payload.payload);
                Reply::ok(Value::Null)
            }
            Err(error) => Reply::err(error),
        }
    }

    /// `test:fault { channel, when?, fault }` scripts one channel:
    /// `fault` is `null` (clear), `{ error }`, `{ value }` (answer with it),
    /// `{ delayMs }`, `{ barrier }`, `{ barrier, error }` (hold, then reject) or
    /// `{ barrier, value }` (hold, then answer with `value`). `when` limits the
    /// fault to calls whose first argument equals it; other calls run normally.
    pub fn fault(ctx: &Arc<AppCtx>, _: Caller, args: Vec<Value>) -> Reply {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload {
            channel: String,
            when: Option<Value>,
            fault: Option<FaultSpec>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FaultSpec {
            error: Option<String>,
            delay_ms: Option<u64>,
            barrier: Option<String>,
            value: Option<Value>,
        }
        let payload = match first::<Payload>("test:fault", &args) {
            Ok(payload) => payload,
            Err(error) => return Reply::err(error),
        };
        let Some(spec) = payload.fault else {
            ctx.bridge.clear_fault(&payload.channel);
            return Reply::ok(Value::Null);
        };
        let fault = match spec {
            FaultSpec { barrier: Some(id), error: Some(message), .. } => Fault::BarrierThenError(id, message),
            FaultSpec { barrier: Some(id), value: Some(value), .. } => Fault::BarrierThenValue(id, value),
            FaultSpec { barrier: Some(id), .. } => Fault::Barrier(id),
            FaultSpec { error: Some(message), .. } => Fault::Error(message),
            FaultSpec { value: Some(value), .. } => Fault::Value(value),
            FaultSpec { delay_ms: Some(ms), .. } => Fault::Delay(ms),
            FaultSpec { .. } => return Reply::err(IpcError::bad_payload("test:fault", "no fault kind given")),
        };
        match payload.when {
            Some(first_arg) => ctx.bridge.set_fault_when(&payload.channel, fault, first_arg),
            None => ctx.bridge.set_fault(&payload.channel, fault),
        }
        Reply::ok(Value::Null)
    }

    /// `test:quit`: approve and run the quit, as the Electron specs' `app.exit(0)` did.
    pub fn quit(ctx: &Arc<AppCtx>, _: Caller, _: Vec<Value>) -> Reply {
        ctx.desktop.request_quit();
        Reply::ok(Value::Null)
    }

    /// `test:windows`: the known windows, whether each page has attached, and
    /// whether the window is shown (`null` when the desktop cannot tell).
    pub fn windows(ctx: &Arc<AppCtx>, _: Caller, _: Vec<Value>) -> Reply {
        let desktop = ctx.desktop.as_any().downcast_ref::<crate::desktop::Desktop>();
        let windows: Vec<Value> = ctx
            .bridge
            .windows()
            .into_iter()
            .map(|caller| {
                let record = ctx.desktop.record(caller.win_id);
                json!({
                    "winId": caller.win_id,
                    "label": caller.label(),
                    "kind": caller.kind,
                    "attached": ctx.bridge.is_attached(caller.win_id),
                    "cwd": record.map(|r| r.cwd),
                    "visible": desktop.map(|desktop| desktop.is_window_visible(caller.win_id)),
                })
            })
            .collect();
        Reply::ok(Value::Array(windows))
    }

    /// `test:second-instance { argv, cwd? }`: what another launch would hand over.
    /// `argv` is the full command line, executable first.
    pub fn second_instance(ctx: &Arc<AppCtx>, _: Caller, args: Vec<Value>) -> Reply {
        #[derive(Deserialize)]
        struct Payload {
            argv: Vec<String>,
            cwd: Option<String>,
        }
        match first::<Payload>("test:second-instance", &args) {
            Ok(payload) => {
                ctx.desktop.on_second_instance(payload.argv, payload.cwd);
                Reply::ok(Value::Null)
            }
            Err(error) => Reply::err(error),
        }
    }

    /// `test:navigation-probe { url }`: what the navigation lock would decide for `url`.
    pub fn navigation_probe(_: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
        #[derive(Deserialize)]
        struct Payload {
            url: String,
        }
        let payload = match first::<Payload>("test:navigation-probe", &args) {
            Ok(payload) => payload,
            Err(error) => return Reply::err(error),
        };
        let Ok(url) = tauri::Url::parse(&payload.url) else {
            return Reply::err(IpcError::bad_payload("test:navigation-probe", "not a URL"));
        };
        let page = match caller.kind {
            crate::ports::WindowKind::Main => "index.html",
            crate::ports::WindowKind::QuickEntry => "quick-entry.html",
        };
        Reply::ok(json!({
            "navigation": crate::webview::navigation_allowed(&url, page, None, cfg!(debug_assertions)),
            "newWindow": format!("{:?}", crate::webview::new_window_action(&url)),
        }))
    }

    /// `test:runtime`: which process and binaries this run uses — the evidence
    /// the Electron specs read from `app.isPackaged`, `process.execPath` and
    /// the sidecar environment. Reads paths only; nothing is created.
    pub fn runtime(_: &Arc<AppCtx>, _: Caller, _: Vec<Value>) -> Reply {
        let argv: Vec<String> = std::env::args().collect();
        let executable = std::env::current_exe().map(|path| path.display().to_string()).unwrap_or_default();
        let (sidecar, sidecar_error) = match crate::paths::resolve_bundled_omp() {
            Ok(path) => (Some(path.display().to_string()), None),
            Err(error) => (None, Some(error.to_string())),
        };
        Reply::ok(json!({
            "pid": std::process::id(),
            "executable": executable,
            "debugBuild": cfg!(debug_assertions),
            "userDataDir": crate::paths::user_data_dir_switch(&argv),
            "sidecar": sidecar,
            "sidecarError": sidecar_error,
        }))
    }
}

#[cfg(all(test, not(feature = "e2e-hooks")))]
mod tests {
    use super::*;

    #[test]
    fn no_test_hook_is_registered_without_e2e_hooks() {
        let mut registry = Registry::new();
        register(&mut registry);
        assert!(registry.is_empty());
        assert!(registry.channels().iter().all(|channel| !channel.starts_with("test:")));
    }
}

#[cfg(all(test, feature = "e2e-hooks"))]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::{json, Value};

    use super::*;
    use crate::bridge::{dispatch_for_test, IpcError, Reply, Scope};
    use crate::ctx::AppCtx;
    use crate::ports::{Caller, WindowId};
    use crate::testing::{fake_ctx, fake_ctx_with, Fakes, RecordingSink};

    fn echo(_: &Arc<AppCtx>, _: Caller, args: Vec<Value>) -> Reply {
        Reply::ok(json!(args))
    }

    fn registry() -> Registry {
        let mut registry = Registry::new();
        register(&mut registry);
        registry.register("probe:echo", Scope::Main, echo);
        registry
    }

    fn caller() -> Caller {
        Caller::main(WindowId(1))
    }

    async fn hook(ctx: &Arc<AppCtx>, channel: &str, payload: Value) -> Result<Value, IpcError> {
        dispatch_for_test(ctx, caller(), channel, vec![payload]).await
    }

    #[test]
    fn every_hook_is_registered_for_the_main_window_only() {
        let registry = registry();
        let hooks: Vec<String> = registry.channels().into_iter().filter(|channel| channel.starts_with("test:")).collect();
        assert_eq!(hooks.len(), 10);
        assert!(hooks.iter().all(|channel| registry.scope_of(channel) == Some(Scope::Main)));
    }

    #[tokio::test]
    async fn fault_hook_holds_one_payload_then_rejects_and_reports_the_wait() {
        let ctx = fake_ctx(registry());
        let fault = json!({ "channel": "probe:echo", "when": {}, "fault": { "barrier": "hold", "error": "refused" } });
        assert_eq!(hook(&ctx, "test:fault", fault).await, Ok(Value::Null));
        // A call with another first argument passes the filter.
        assert_eq!(hook(&ctx, "probe:echo", json!({ "key": "k" })).await, Ok(json!([{ "key": "k" }])));
        let mut held = Box::pin(hook(&ctx, "probe:echo", json!({})));
        tokio::time::timeout(Duration::from_millis(20), &mut held).await.expect_err("held at the barrier");
        assert_eq!(hook(&ctx, "test:barrier-waiters", json!({ "id": "hold" })).await, Ok(json!(1)));
        assert_eq!(hook(&ctx, "test:release", json!({ "id": "hold" })).await, Ok(json!(true)));
        assert_eq!(held.await, Err(IpcError::new("refused")));
        assert_eq!(hook(&ctx, "test:barrier-waiters", json!({ "id": "hold" })).await, Ok(json!(0)));
        assert_eq!(hook(&ctx, "test:calls", json!({ "channel": "probe:echo" })).await, Ok(json!(2)));
        // `fault: null` clears the script.
        assert_eq!(hook(&ctx, "test:fault", json!({ "channel": "probe:echo", "fault": null })).await, Ok(Value::Null));
        assert_eq!(hook(&ctx, "probe:echo", json!({})).await, Ok(json!([{}])));
    }

    #[tokio::test]
    async fn fault_hook_can_answer_with_a_canned_value_after_the_hold() {
        let ctx = fake_ctx(registry());
        let fault = json!({ "channel": "probe:echo", "fault": { "barrier": "snapshot", "value": { "fontSize": 18 } } });
        assert_eq!(hook(&ctx, "test:fault", fault).await, Ok(Value::Null));
        let mut held = Box::pin(hook(&ctx, "probe:echo", json!({})));
        tokio::time::timeout(Duration::from_millis(20), &mut held).await.expect_err("held at the barrier");
        assert_eq!(hook(&ctx, "test:release", json!({ "id": "snapshot" })).await, Ok(json!(true)));
        assert_eq!(held.await, Ok(json!({ "fontSize": 18 })));
        // Re-scripted without a barrier, the same stale answer comes back at once.
        let fault = json!({ "channel": "probe:echo", "fault": { "value": { "fontSize": 18 } } });
        assert_eq!(hook(&ctx, "test:fault", fault).await, Ok(Value::Null));
        assert_eq!(hook(&ctx, "probe:echo", json!({})).await, Ok(json!({ "fontSize": 18 })));
    }

    #[tokio::test]
    async fn fault_hook_rejects_a_spec_without_a_kind() {
        let ctx = fake_ctx(registry());
        let result = hook(&ctx, "test:fault", json!({ "channel": "probe:echo", "fault": {} })).await;
        assert_eq!(result, Err(IpcError::bad_payload("test:fault", "no fault kind given")));
        assert_eq!(hook(&ctx, "probe:echo", json!(1)).await, Ok(json!([1])));
    }

    #[tokio::test]
    async fn emit_hook_delivers_a_wrapped_message_to_the_window() {
        let ctx = fake_ctx(registry());
        let sink = Arc::new(RecordingSink::default());
        ctx.bridge.attach(&ctx, caller(), "page".into(), sink.clone());
        let payload = json!({ "winId": 1, "channel": "config:update", "payload": { "tabId": "t1", "payload": {} } });
        assert_eq!(hook(&ctx, "test:emit", payload).await, Ok(Value::Null));
        let sent = sink.sent();
        let injected = sent.iter().find(|envelope| envelope.channel == "config:update").expect("injected message");
        assert_eq!(injected.payload, json!({ "tabId": "t1", "payload": {} }));
    }

    #[tokio::test]
    async fn windows_hook_lists_known_windows_and_leaves_visibility_unknown_on_a_fake_desktop() {
        let ctx = fake_ctx(registry());
        ctx.bridge.register_window(Caller::quick_entry());
        let windows = hook(&ctx, "test:windows", Value::Null).await.expect("window list");
        assert_eq!(
            windows,
            json!([
                { "winId": 0, "label": "quick-entry", "kind": "quick-entry", "attached": false, "cwd": null, "visible": null },
                { "winId": 1, "label": "main-1", "kind": "main", "attached": true, "cwd": null, "visible": null },
            ])
        );
    }

    #[tokio::test]
    async fn quit_and_second_instance_hooks_reach_the_desktop() {
        let fakes = Fakes::default();
        let ctx = fake_ctx_with(&fakes, registry());
        let argv = json!({ "argv": ["sai-atlas", "--quick-entry"], "cwd": "/tmp" });
        assert_eq!(hook(&ctx, "test:second-instance", argv).await, Ok(Value::Null));
        assert_eq!(hook(&ctx, "test:quit", Value::Null).await, Ok(Value::Null));
        let calls = fakes.desktop.log.calls();
        assert!(calls.contains(&"on_second_instance([\"sai-atlas\", \"--quick-entry\"], Some(\"/tmp\"))".to_string()), "{calls:?}");
        assert!(calls.contains(&"request_quit()".to_string()), "{calls:?}");
    }

    #[tokio::test]
    async fn runtime_hook_reports_this_process_without_touching_the_profile() {
        let ctx = fake_ctx(registry());
        let runtime = hook(&ctx, "test:runtime", Value::Null).await.expect("runtime facts");
        assert_eq!(runtime["pid"], json!(std::process::id()));
        assert_eq!(runtime["debugBuild"], json!(cfg!(debug_assertions)));
        assert!(runtime["executable"].as_str().is_some_and(|path| !path.is_empty()));
        // The test binary has no --user-data-dir; whether a sidecar resolves
        // depends on the checkout (the dev fallback is `../resources/omp`), so
        // exactly one of the two sidecar fields is a non-empty string.
        assert_eq!(runtime["userDataDir"], Value::Null);
        let resolved = runtime["sidecar"].as_str().is_some_and(|path| !path.is_empty());
        let failed = runtime["sidecarError"].as_str().is_some_and(|text| !text.is_empty());
        assert!(resolved != failed, "{runtime}");
    }
}
