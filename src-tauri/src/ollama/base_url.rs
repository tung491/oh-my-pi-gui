//! The Ollama endpoint, resolved exactly as the agent resolves its implicit
//! Ollama provider (`packages/coding-agent/src/config/model-discovery.ts`,
//! `getImplicitOllamaBaseUrl` + `normalizeOllamaBaseUrl`), so the GUI probes
//! and pulls against the same daemon the agent will talk to.

use std::collections::HashMap;

const DEFAULT_OLLAMA_BASE_URL: &str = "http://127.0.0.1:11434";
const OLLAMA_HOST_DEFAULT_PORT: &str = "11434";

/// `host[:port]` with an explicit port, as `url::Url` serializes it (brackets kept for IPv6).
fn host_and_port(parsed: &reqwest::Url, with_default_http_port: bool) -> Option<String> {
    let host = parsed.host_str()?;
    if host.is_empty() {
        return None;
    }
    match (parsed.port(), parsed.scheme()) {
        (Some(port), _) => Some(format!("{host}:{port}")),
        (None, "http") if with_default_http_port => Some(format!("{host}:{OLLAMA_HOST_DEFAULT_PORT}")),
        (None, _) => Some(host.to_string()),
    }
}

/// `OLLAMA_HOST` accepts `host`, `host:port`, `:port`, `//host` or a full URL; anything else is ignored.
pub fn normalize_ollama_host_env(value: Option<&str>) -> Option<String> {
    let trimmed = value.map(str::trim).filter(|s| !s.is_empty())?;
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else if trimmed.starts_with("//") {
        format!("http:{trimmed}")
    } else if let Some(rest) = trimmed.strip_prefix(':') {
        format!("http://127.0.0.1:{rest}")
    } else {
        format!("http://{trimmed}")
    };
    let parsed = reqwest::Url::parse(&candidate).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    let host_port = host_and_port(&parsed, true)?;
    Some(format!("{}://{host_port}", parsed.scheme()))
}

/// Reduce a base URL to `protocol//host`, the root the native `/api/*` routes hang off.
fn endpoint_of(base_url: &str) -> String {
    match reqwest::Url::parse(base_url) {
        Ok(parsed) => match host_and_port(&parsed, false) {
            Some(host_port) => format!("{}://{host_port}", parsed.scheme()),
            None => DEFAULT_OLLAMA_BASE_URL.to_string(),
        },
        Err(_) => DEFAULT_OLLAMA_BASE_URL.to_string(),
    }
}

/// `OLLAMA_BASE_URL` -> normalised `OLLAMA_HOST` -> `http://127.0.0.1:11434`, reduced to its endpoint.
pub fn ollama_base_url(env: &HashMap<String, String>) -> String {
    let base_url = env.get("OLLAMA_BASE_URL").map(|s| s.trim()).filter(|s| !s.is_empty());
    let candidate = match base_url {
        Some(base_url) => base_url.to_string(),
        None => normalize_ollama_host_env(env.get("OLLAMA_HOST").map(String::as_str))
            .unwrap_or_else(|| DEFAULT_OLLAMA_BASE_URL.to_string()),
    };
    endpoint_of(&candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn normalises_j_to_j_cases() {
        let cases: [(&str, &str); 9] = [
            ("127.0.0.1", "http://127.0.0.1:11434"),
            ("0.0.0.0:11500", "http://0.0.0.0:11500"),
            (":8080", "http://127.0.0.1:8080"),
            ("//gpu-box", "http://gpu-box:11434"),
            ("http://gpu-box", "http://gpu-box:11434"),
            ("https://ollama.example.com", "https://ollama.example.com"),
            ("https://ollama.example.com:8443/", "https://ollama.example.com:8443"),
            ("  localhost:11434  ", "http://localhost:11434"),
            ("[::1]:11434", "http://[::1]:11434"),
        ];
        for (input, expected) in cases {
            assert_eq!(normalize_ollama_host_env(Some(input)).as_deref(), Some(expected), "input: {input:?}");
        }
    }

    #[test]
    fn ignores_j_cases() {
        for input in [None, Some(""), Some("   "), Some("ftp://host"), Some("http://")] {
            assert_eq!(normalize_ollama_host_env(input), None, "input: {input:?}");
        }
    }

    #[test]
    fn defaults_to_the_loopback_daemon() {
        assert_eq!(ollama_base_url(&env(&[])), "http://127.0.0.1:11434");
    }

    #[test]
    fn prefers_ollama_base_url_over_ollama_host() {
        assert_eq!(ollama_base_url(&env(&[("OLLAMA_BASE_URL", "http://a:1"), ("OLLAMA_HOST", "b:2")])), "http://a:1");
    }

    #[test]
    fn falls_back_to_a_normalised_ollama_host() {
        assert_eq!(ollama_base_url(&env(&[("OLLAMA_BASE_URL", "  "), ("OLLAMA_HOST", "b:2")])), "http://b:2");
    }

    #[test]
    fn drops_a_path_such_as_v1_from_the_base_url() {
        assert_eq!(ollama_base_url(&env(&[("OLLAMA_BASE_URL", "http://a:1/v1")])), "http://a:1");
    }

    #[test]
    fn uses_the_default_when_ollama_base_url_is_not_a_url() {
        assert_eq!(ollama_base_url(&env(&[("OLLAMA_BASE_URL", "not a url")])), "http://127.0.0.1:11434");
    }
}
