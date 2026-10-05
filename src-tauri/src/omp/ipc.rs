//! Handlers for the channels this module owns: the stats dashboard reads and
//! the benchmark runs, ported from the matching `ipcMain.handle` blocks of
//! `src/main/ipc.ts`.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value};

use super::bench::IpcBenchmarkRunOptions;
use super::stats_restart_policy::Revive;
use super::Omp;
use crate::bridge::{IpcError, Reply};
use crate::ctx::AppCtx;
use crate::ports::Caller;

fn module(ctx: &AppCtx) -> Result<&Omp, IpcError> {
    ctx.omp.as_any().downcast_ref::<Omp>().ok_or_else(|| IpcError::new("the omp module is not installed"))
}

/// `stats:fetch`
pub fn stats_fetch(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = caller;
    let payload = args.into_iter().next().unwrap_or(Value::Null);
    let Some(path) = payload.get("path").and_then(Value::as_str).map(str::to_string) else {
        return Reply::err(IpcError::new("Invalid stats path"));
    };
    let params: Option<HashMap<String, String>> = payload.get("params").filter(|params| !params.is_null()).and_then(|params| serde_json::from_value(params.clone()).ok());
    let omp = match module(ctx) {
        Ok(omp) => omp,
        Err(error) => return Reply::err(error),
    };
    let client = omp.stats_client();
    if client.port() == 0 {
        // Nothing is listening: ask for it and let the caller keep waiting, but
        // only while a revive is actually possible, so a permanently dead stats
        // server ends in an error instead of an endless "loading".
        let revive = omp.stats_server().map(|server| server.ensure_running()).unwrap_or(Revive::Exhausted);
        let error = if revive == Revive::Exhausted { "The bundled stats server is not running." } else { "The bundled stats server is not ready. Please retry shortly." };
        return Reply::ok(json!({ "error": error, "unavailable": revive != Revive::Exhausted }));
    }
    Reply::Later(Box::pin(async move {
        match client.fetch(&path, params.as_ref()).await {
            Ok(value) => Ok(value),
            // A request that reached the server and failed is a failure, not a
            // booting server: the dashboard must show it, not retry for a budget.
            Err(message) => Ok(json!({ "error": message, "unavailable": false })),
        }
    }))
}

/// `bench:run`
pub fn bench_run(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let options: IpcBenchmarkRunOptions = match args.into_iter().next().map(serde_json::from_value) {
        Some(Ok(options)) => options,
        Some(Err(error)) => return Reply::err(IpcError::bad_payload("bench:run", error)),
        None => return Reply::err(IpcError::bad_payload("bench:run", "missing options")),
    };
    let omp = match module(ctx) {
        Ok(omp) => omp,
        Err(error) => return Reply::err(error),
    };
    let Ok(binary) = omp.omp_binary() else {
        return Reply::ok(json!({ "success": false, "error": "Bundled omp is unavailable" }));
    };
    let Some(cwd) = ctx.tabs.cwd_for(caller, None) else {
        return Reply::ok(json!({ "success": false, "error": "No active workspace" }));
    };
    let runner = omp.bench_runner(caller.win_id);
    let env = (omp.spawn_env_provider())();
    let weak = Arc::downgrade(ctx);
    Reply::Later(Box::pin(async move {
        let env: Vec<(String, String)> = env.await.into_iter().collect();
        let result = runner.run(binary, cwd, options, env).await;
        if let Some(ctx) = weak.upgrade() {
            if let Ok(omp) = module(&ctx) {
                omp.release_bench_runner(caller.win_id, &runner);
            }
        }
        Ok(result.to_value())
    }))
}

/// `bench:abort`
pub fn bench_abort(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply {
    let _ = args;
    match module(ctx) {
        Ok(omp) => Reply::ok(Value::Bool(omp.abort_bench(caller.win_id))),
        Err(error) => Reply::err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::{dispatch_for_test, Registry};
    use crate::ports::{WindowId, WindowRecord};
    use crate::testing::{fake_ctx_cyclic, Fakes};
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    fn registry() -> Registry {
        let mut registry = Registry::new();
        super::super::register(&mut registry);
        registry
    }

    fn ctx_with_omp(fakes: &Fakes) -> Arc<AppCtx> {
        let ctx = fake_ctx_cyclic(fakes, registry(), |ctx, ports| ports.omp = Some(Arc::new(Omp::new(ctx.clone()))));
        let omp = module(&ctx).unwrap();
        omp.set_spawn_env_for_test(Arc::new(|| Box::pin(std::future::ready(HashMap::new()))));
        ctx
    }

    fn fixture_path() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("e2e").join("sidecar-fixture.ts").canonicalize().unwrap()
    }

    fn caller() -> Caller {
        Caller::main(WindowId(1))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stats_fetch_returns_the_fixture_json() {
        let fakes = Fakes::default();
        let ctx = ctx_with_omp(&fakes);
        module(&ctx).unwrap().set_binary_for_test(Some(fixture_path()));
        let payload = json!({ "path": "/api/stats/folders" });
        let first = dispatch_for_test(&ctx, caller(), "stats:fetch", vec![payload.clone()]).await.unwrap();
        assert_eq!(first, json!({ "error": "The bundled stats server is not ready. Please retry shortly.", "unavailable": true }));
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        let mut result = first;
        while !result.is_array() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
            result = dispatch_for_test(&ctx, caller(), "stats:fetch", vec![payload.clone()]).await.unwrap();
        }
        let server = module(&ctx).unwrap().stats_server().unwrap();
        let port = module(&ctx).unwrap().stats_client().port();
        let pid = server.child_pid_for_test().expect("a running stats server");
        // On Unix that is the supervisor; the server itself runs below it.
        let below: Vec<u32> = std::fs::read_dir(format!("/proc/{pid}/task"))
            .into_iter()
            .flatten()
            .flatten()
            .flat_map(|task| std::fs::read_to_string(task.path().join("children")).unwrap_or_default().split_whitespace().filter_map(|child| child.parse().ok()).collect::<Vec<u32>>())
            .collect();
        assert!(!below.is_empty(), "the supervisor {pid} runs no stats server");
        ctx.omp.shutdown().await;
        assert_eq!(result[0]["folder"], "/home/dev/projects/workspace-alpha");
        assert_eq!(result.as_array().map(Vec::len), Some(2));
        assert_ne!(port, 0);
        // Shutdown kills the server; the exit-wait task reaps it, so the process vanishes.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let gone = || std::fs::read_to_string(format!("/proc/{pid}/stat")).map(|stat| stat.contains(") Z ")).unwrap_or(true);
        while !gone() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(gone(), "stats server {pid} survived shutdown");
        let process_gone = |child: u32| std::fs::read_to_string(format!("/proc/{child}/stat")).map(|stat| stat.contains(") Z ")).unwrap_or(true);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !below.iter().all(|child| process_gone(*child)) && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(below.iter().all(|child| process_gone(*child)), "stats server children {below:?} survived shutdown");
    }

    #[tokio::test]
    async fn stats_fetch_rejects_a_non_string_path() {
        let fakes = Fakes::default();
        let ctx = ctx_with_omp(&fakes);
        let error = dispatch_for_test(&ctx, caller(), "stats:fetch", vec![json!({ "path": 5 })]).await.unwrap_err();
        assert_eq!(error, IpcError::new("Invalid stats path"));
    }

    #[tokio::test]
    async fn stats_fetch_reports_a_missing_binary_as_not_running() {
        let fakes = Fakes::default();
        let ctx = ctx_with_omp(&fakes);
        module(&ctx).unwrap().set_binary_for_test(None);
        let result = dispatch_for_test(&ctx, caller(), "stats:fetch", vec![json!({ "path": "/api/stats" })]).await.unwrap();
        assert_eq!(result, json!({ "error": "The bundled stats server is not running.", "unavailable": false }));
    }

    #[tokio::test]
    async fn bench_run_refuses_without_a_binary_or_a_workspace() {
        let fakes = Fakes::default();
        let ctx = ctx_with_omp(&fakes);
        let options = json!({ "models": ["m"], "profile": "chat", "runs": 1, "parallel": 1 });
        module(&ctx).unwrap().set_binary_for_test(None);
        let result = dispatch_for_test(&ctx, caller(), "bench:run", vec![options.clone()]).await.unwrap();
        assert_eq!(result, json!({ "success": false, "error": "Bundled omp is unavailable" }));
        module(&ctx).unwrap().set_binary_for_test(Some(PathBuf::from("/bin/true")));
        let result = dispatch_for_test(&ctx, caller(), "bench:run", vec![options]).await.unwrap();
        assert_eq!(result, json!({ "success": false, "error": "No active workspace" }));
        let error = dispatch_for_test(&ctx, caller(), "bench:run", vec![json!({ "models": "m" })]).await.unwrap_err();
        assert!(error.message.starts_with("invalid payload for bench:run"));
        assert_eq!(dispatch_for_test(&ctx, caller(), "bench:abort", vec![]).await.unwrap(), json!(false));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn closing_a_window_aborts_its_bench_run() {
        let fakes = Fakes::default();
        let ctx = ctx_with_omp(&fakes);
        Omp::register_listeners(&ctx);
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake-bench.sh");
        crate::omp::test_support::write_executable(&script, "#!/bin/sh\nexec /usr/bin/sleep 600\n");
        module(&ctx).unwrap().set_binary_for_test(Some(script));
        fakes.tabs.cwds.lock().unwrap().insert(WindowId(1), dir.path().to_string_lossy().into_owned());
        fakes.desktop.add_record(WindowRecord { id: WindowId(1), cwd: dir.path().to_string_lossy().into_owned(), pending_session_path: None });
        let run_ctx = ctx.clone();
        let run = tokio::spawn(async move {
            dispatch_for_test(&run_ctx, caller(), "bench:run", vec![json!({ "models": ["m"], "profile": "chat", "runs": 1, "parallel": 1 })]).await
        });
        let runner = module(&ctx).unwrap().bench_runner(WindowId(1));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !runner.running() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(runner.running());
        fakes.desktop.close(WindowId(1));
        let result = tokio::time::timeout(Duration::from_secs(5), run).await.unwrap().unwrap().unwrap();
        assert_eq!(result, json!({ "success": false, "error": "Benchmark cancelled" }));
        assert!(!runner.running());
        assert_eq!(dispatch_for_test(&ctx, caller(), "bench:abort", vec![]).await.unwrap(), json!(false));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bench_run_returns_the_summary_and_frees_the_slot() {
        let fakes = Fakes::default();
        let ctx = ctx_with_omp(&fakes);
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake-bench.sh");
        crate::omp::test_support::write_executable(&script, "#!/bin/sh\nprintf '%s' '{\"runs\":1,\"models\":[],\"failures\":0}'\n");
        module(&ctx).unwrap().set_binary_for_test(Some(script));
        fakes.tabs.cwds.lock().unwrap().insert(WindowId(1), dir.path().to_string_lossy().into_owned());
        let result = dispatch_for_test(&ctx, caller(), "bench:run", vec![json!({ "models": ["m"], "profile": "chat", "runs": 1, "parallel": 1 })]).await.unwrap();
        assert_eq!(result, json!({ "success": true, "summary": { "runs": 1, "models": [], "failures": 0 }, "exitCode": 0 }));
        assert!(module(&ctx).unwrap().bench_runs.lock().unwrap().is_empty());
    }
}
