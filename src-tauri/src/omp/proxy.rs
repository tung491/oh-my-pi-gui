//! Proxy environment for every child, ported from `src/main/index.ts`
//! (`resolveProxyEnvForSpawn`). A desktop-launched app has no shell env, so
//! without this a proxy-only network hangs every provider request. Resolution
//! order per spawn: the GUI pref `proxyUrl` → inherited env (a terminal
//! launch) → the system proxy → none. Failure degrades to no proxy env, never
//! to a blocked spawn.

use std::collections::HashMap;
use std::sync::Arc;

use futures_util::future::BoxFuture;

use super::shell_env::Env;

/// Representative URL for system-proxy resolution.
#[cfg(target_os = "linux")]
const SYSTEM_PROXY_PROBE_URL: &str = "https://example.com";
/// A portal that never answers must not hold up a spawn.
#[cfg(target_os = "linux")]
const SYSTEM_PROXY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Looks up the system proxy for outbound HTTPS; `None` means direct.
pub(crate) type SystemProxyLookup = Arc<dyn Fn() -> BoxFuture<'static, Option<String>> + Send + Sync>;

/// Expand one proxy URL into the full env-var set the agent and Bun honor.
pub(crate) fn proxy_env_vars(proxy_url: &str) -> HashMap<String, String> {
    ["PI_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"].iter().map(|key| (key.to_string(), proxy_url.to_string())).collect()
}

/// Accept "127.0.0.1:7890" shorthand; keep explicit schemes as they are.
pub(crate) fn normalize_proxy_url(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    }
}

fn inherits_proxy(env: &Env) -> bool {
    ["PI_PROXY", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"].iter().any(|key| env.get(*key).map(|value| !value.is_empty()).unwrap_or(false))
}

/// The proxy variables to overlay on a child's environment.
pub(crate) async fn resolve(pref: Option<String>, env: &Env, system: &SystemProxyLookup) -> HashMap<String, String> {
    if let Some(pref) = pref.filter(|pref| !pref.trim().is_empty()) {
        return proxy_env_vars(&normalize_proxy_url(&pref));
    }
    if inherits_proxy(env) {
        return HashMap::new();
    }
    match system().await {
        Some(proxy) => proxy_env_vars(&proxy),
        None => HashMap::new(),
    }
}

/// The platform's system proxy lookup.
pub(crate) fn system_proxy_lookup() -> SystemProxyLookup {
    Arc::new(|| Box::pin(lookup_system_proxy()))
}

/// GNOME/KDE proxy settings through the `org.freedesktop.portal.ProxyResolver`
/// portal, the heir of Electron's `session.resolveProxy`.
#[cfg(target_os = "linux")]
async fn lookup_system_proxy() -> Option<String> {
    let probe = reqwest::Url::parse(SYSTEM_PROXY_PROBE_URL).ok()?;
    let lookup = async {
        let resolver = ashpd::desktop::proxy_resolver::ProxyResolver::new().await.ok()?;
        resolver.lookup(&probe).await.ok()
    };
    let answers = tokio::time::timeout(SYSTEM_PROXY_TIMEOUT, lookup).await.ok().flatten()?;
    answers.first().and_then(portal_proxy_to_url)
}

/// `protocol://[user[:password]@]host:port` from the portal, or `None` for `direct://`.
#[cfg(target_os = "linux")]
fn portal_proxy_to_url(answer: &reqwest::Url) -> Option<String> {
    let scheme = match answer.scheme() {
        "direct" => return None,
        // GIO names SOCKS proxies `socks://`; the agent and Bun take `socks5://`.
        "socks" | "socks5" => "socks5",
        "https" => "https",
        _ => "http",
    };
    let host = answer.host_str()?;
    let port = answer.port_or_known_default()?;
    let mut credentials = String::new();
    if !answer.username().is_empty() {
        credentials.push_str(answer.username());
        if let Some(password) = answer.password() {
            credentials.push(':');
            credentials.push_str(password);
        }
        credentials.push('@');
    }
    Some(format!("{scheme}://{credentials}{host}:{port}"))
}

/// Windows (WinHTTP) and macOS (`scutil --proxy`, PAC) lookups arrive when those
/// OSes switch shells; until then the chain ends without a system proxy.
#[cfg(not(target_os = "linux"))]
async fn lookup_system_proxy() -> Option<String> {
    crate::runtime_log::note("unknown", "system proxy lookup is not implemented on this OS", serde_json::json!({}));
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::Registry;
    use crate::omp::Omp;
    use crate::testing::{fake_ctx_cyclic, Fakes};
    use serde_json::json;
    use std::sync::Mutex;

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs.iter().map(|(key, value)| (key.to_string(), value.to_string())).collect()
    }

    fn fake_system(answer: Option<&'static str>) -> (SystemProxyLookup, Arc<Mutex<usize>>) {
        let calls = Arc::new(Mutex::new(0usize));
        let counter = calls.clone();
        let lookup: SystemProxyLookup = Arc::new(move || {
            *counter.lock().unwrap() += 1;
            Box::pin(std::future::ready(answer.map(str::to_string)))
        });
        (lookup, calls)
    }

    #[test]
    fn normalizes_shorthand_and_keeps_explicit_schemes() {
        assert_eq!(normalize_proxy_url(" 127.0.0.1:7890 "), "http://127.0.0.1:7890");
        assert_eq!(normalize_proxy_url("socks5://proxy:1080"), "socks5://proxy:1080");
        let vars = proxy_env_vars("http://p:1");
        assert_eq!(vars.len(), 7);
        assert_eq!(vars["PI_PROXY"], "http://p:1");
        assert_eq!(vars["all_proxy"], "http://p:1");
    }

    #[tokio::test]
    async fn the_pref_wins_over_the_inherited_env_and_the_system_proxy() {
        let (system, calls) = fake_system(Some("http://system:3128"));
        let vars = resolve(Some("127.0.0.1:7890".into()), &env(&[("HTTPS_PROXY", "http://inherited:1")]), &system).await;
        assert_eq!(vars["HTTPS_PROXY"], "http://127.0.0.1:7890");
        assert_eq!(vars["PI_PROXY"], "http://127.0.0.1:7890");
        assert_eq!(*calls.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn an_inherited_proxy_env_skips_the_system_lookup_and_adds_nothing() {
        let (system, calls) = fake_system(Some("http://system:3128"));
        assert!(resolve(None, &env(&[("all_proxy", "socks5://inherited:1")]), &system).await.is_empty());
        assert!(resolve(Some("   ".into()), &env(&[("PI_PROXY", "http://inherited:1")]), &system).await.is_empty());
        assert_eq!(*calls.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn the_system_proxy_is_used_when_nothing_else_is_set_and_direct_means_none() {
        let (system, calls) = fake_system(Some("http://system:3128"));
        let vars = resolve(None, &env(&[("PATH", "/usr/bin")]), &system).await;
        assert_eq!(vars["HTTPS_PROXY"], "http://system:3128");
        assert_eq!(*calls.lock().unwrap(), 1);
        let (direct, _) = fake_system(None);
        assert!(resolve(None, &env(&[]), &direct).await.is_empty());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn portal_answers_map_to_agent_proxy_urls() {
        let url = |text: &str| reqwest::Url::parse(text).unwrap();
        assert_eq!(portal_proxy_to_url(&url("direct://")), None);
        assert_eq!(portal_proxy_to_url(&url("http://proxy.example:8080/")).as_deref(), Some("http://proxy.example:8080"));
        assert_eq!(portal_proxy_to_url(&url("socks://user:pw@proxy.example:1080")).as_deref(), Some("socks5://user:pw@proxy.example:1080"));
        assert_eq!(portal_proxy_to_url(&url("https://proxy.example")).as_deref(), Some("https://proxy.example:443"));
    }

    #[tokio::test]
    async fn the_pref_is_read_from_the_context_the_port_received() {
        let fakes = Fakes::default();
        let ctx = fake_ctx_cyclic(&fakes, Registry::new(), |ctx, ports| ports.omp = Some(Arc::new(Omp::new(ctx.clone()))));
        let omp = ctx.omp.as_any().downcast_ref::<Omp>().unwrap();
        let (system, calls) = fake_system(Some("http://system:3128"));
        omp.set_system_proxy_for_test(system);
        ctx.prefs.set("proxyUrl", json!("10.0.0.1:8888")).unwrap();
        let env = env(&[("PATH", "/usr/bin")]);
        let vars = omp.proxy_env(&env).await;
        assert_eq!(vars["PI_PROXY"], "http://10.0.0.1:8888");
        assert_eq!(*calls.lock().unwrap(), 0);
        ctx.prefs.delete("proxyUrl").unwrap();
        let vars = omp.proxy_env(&env).await;
        assert_eq!(vars["PI_PROXY"], "http://system:3128");
        assert_eq!(*calls.lock().unwrap(), 1);
    }
}
