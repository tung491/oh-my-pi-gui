//! Test-only bridge channels, compiled only with the `e2e-hooks` cargo feature.
//! Release bundles never enable it. The end-to-end suite fills in further hooks
//! here, always behind the same feature.

use crate::bridge::Registry;

/// Register the `test:*` channels. Without the feature this registers nothing.
#[cfg(not(feature = "e2e-hooks"))]
pub fn register(_reg: &mut Registry) {}

#[cfg(feature = "e2e-hooks")]
pub fn register(reg: &mut Registry) {
    use crate::bridge::Scope;
    reg.register("test:release", Scope::Main, hooks::release);
    reg.register("test:emit", Scope::Main, hooks::emit);
    reg.register("test:quit", Scope::Main, hooks::quit);
    reg.register("test:windows", Scope::Main, hooks::windows);
    reg.register("test:second-instance", Scope::Main, hooks::second_instance);
    reg.register("test:navigation-probe", Scope::Main, hooks::navigation_probe);
    reg.register("test:fault", Scope::Main, hooks::fault);
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

    /// `test:release { id }`: release the calls held at a barrier.
    pub fn release(ctx: &Arc<AppCtx>, _: Caller, args: Vec<Value>) -> Reply {
        #[derive(Deserialize)]
        struct Payload {
            id: String,
        }
        match first::<Payload>("test:release", &args) {
            Ok(payload) => Reply::ok(json!(ctx.bridge.release_barrier(&payload.id))),
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

    /// `test:fault { channel, fault: { error } | { delayMs } | { barrier } | null }`.
    pub fn fault(ctx: &Arc<AppCtx>, _: Caller, args: Vec<Value>) -> Reply {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload {
            channel: String,
            fault: Option<FaultSpec>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FaultSpec {
            error: Option<String>,
            delay_ms: Option<u64>,
            barrier: Option<String>,
        }
        match first::<Payload>("test:fault", &args) {
            Ok(payload) => {
                match payload.fault {
                    None => ctx.bridge.clear_fault(&payload.channel),
                    Some(FaultSpec { error: Some(message), .. }) => ctx.bridge.set_fault(&payload.channel, Fault::Error(message)),
                    Some(FaultSpec { delay_ms: Some(ms), .. }) => ctx.bridge.set_fault(&payload.channel, Fault::Delay(ms)),
                    Some(FaultSpec { barrier: Some(id), .. }) => ctx.bridge.set_fault(&payload.channel, Fault::Barrier(id)),
                    Some(_) => return Reply::err(IpcError::bad_payload("test:fault", "no fault kind given")),
                }
                Reply::ok(Value::Null)
            }
            Err(error) => Reply::err(error),
        }
    }

    /// `test:quit`: quit through the desktop guard, as the menu would.
    pub fn quit(ctx: &Arc<AppCtx>, _: Caller, _: Vec<Value>) -> Reply {
        ctx.desktop.request_quit();
        Reply::ok(Value::Null)
    }

    /// `test:windows`: the known windows and whether each page has attached.
    pub fn windows(ctx: &Arc<AppCtx>, _: Caller, _: Vec<Value>) -> Reply {
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
                })
            })
            .collect();
        Reply::ok(Value::Array(windows))
    }

    /// `test:second-instance { argv, cwd? }`: what another launch would hand over.
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
}
