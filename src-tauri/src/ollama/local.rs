//! Which Ollama models and endpoints count as "on this computer". The rules
//! match the sidecar's `modelPolicy.localOnly`, so the GUI never measures or
//! limits a model the agent would refuse to run. Keeps step with
//! `src/shared/ollama-local.ts`; change both together.

use std::net::Ipv4Addr;

use serde::{Deserialize, Serialize};

/// One `/api/tags` row, as far as the local rules need it. Field names are
/// Ollama's own.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct OllamaTagRow {
    pub name: String,
    #[serde(default)]
    pub model: Option<String>,
    /// Model file size in bytes.
    #[serde(default)]
    pub size: Option<u64>,
    /// Set by Ollama on its cloud models and on local copies of them.
    #[serde(default)]
    pub remote_host: Option<String>,
    #[serde(default)]
    pub remote_model: Option<String>,
}

/// An Ollama cloud model: its name or `:tag` part is `cloud` or ends in `-cloud`.
pub fn is_ollama_cloud_tag(tag: &str) -> bool {
    tag.to_lowercase().split(':').any(|part| part == "cloud" || part.ends_with("-cloud"))
}

fn is_set(value: Option<&String>) -> bool {
    value.is_some_and(|v| !v.is_empty())
}

/// A model that runs on this computer: not a cloud tag, and not a copy Ollama serves from a remote host.
pub fn is_local_ollama_row(row: &OllamaTagRow) -> bool {
    if is_ollama_cloud_tag(&row.name) || row.model.as_deref().is_some_and(is_ollama_cloud_tag) {
        return false;
    }
    !is_set(row.remote_host.as_ref()) && !is_set(row.remote_model.as_ref())
}

/// Whether a base URL points at this computer: `localhost`, an IPv4 literal in
/// 127.0.0.0/8, `[::1]`, or `0.0.0.0` (which connects to this host). Any DNS
/// name other than `localhost` is remote, whatever it starts with. The host is
/// read after WHATWG parsing, so `127.1` and `0x7f.1` count as IPv4 literals.
pub fn is_loopback_base_url(base_url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(base_url) else { return false };
    let Some(host) = url.host_str() else { return false };
    let host = host.to_lowercase();
    if host == "localhost" || host == "[::1]" || host == "0.0.0.0" {
        return true;
    }
    host.parse::<Ipv4Addr>().is_ok_and(|addr| addr.octets()[0] == 127)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(name: &str) -> OllamaTagRow {
        OllamaTagRow { name: name.to_string(), ..OllamaTagRow::default() }
    }

    #[test]
    fn treats_a_cloud_name_or_tag_part_as_a_cloud_tag() {
        assert!(is_ollama_cloud_tag("gpt-oss:120b-cloud"));
        assert!(is_ollama_cloud_tag("qwen3-coder:cloud"));
        assert!(is_ollama_cloud_tag("kimi-k2-cloud"));
        assert!(is_ollama_cloud_tag("Deepseek:671B-CLOUD"));
        assert!(!is_ollama_cloud_tag("qwen3:4b"));
        assert!(!is_ollama_cloud_tag("cloudy:latest"));
        assert!(!is_ollama_cloud_tag("hf.co/google/gemma-4-E2B-it-qat-q4_0-gguf:latest"));
    }

    #[test]
    fn accepts_a_plain_local_row() {
        let plain = OllamaTagRow { model: Some("qwen3:4b".into()), size: Some(2_500_000_000), ..row("qwen3:4b") };
        assert!(is_local_ollama_row(&plain));
        assert!(is_local_ollama_row(&OllamaTagRow { remote_host: Some(String::new()), ..row("qwen3:4b") }));
    }

    #[test]
    fn rejects_a_cloud_tag_in_the_name_or_the_model_field() {
        assert!(!is_local_ollama_row(&row("gpt-oss:120b-cloud")));
        assert!(!is_local_ollama_row(&OllamaTagRow { model: Some("gpt-oss:120b-cloud".into()), ..row("mine:latest") }));
    }

    #[test]
    fn rejects_a_copy_served_from_a_remote_host() {
        assert!(!is_local_ollama_row(&OllamaTagRow { remote_host: Some("https://ollama.com:443".into()), ..row("mine:latest") }));
        assert!(!is_local_ollama_row(&OllamaTagRow { remote_model: Some("gpt-oss:120b".into()), ..row("mine:latest") }));
    }

    #[test]
    fn accepts_localhost_127_0_0_0_8_1_and_0_0_0_0() {
        for url in [
            "http://localhost:11434",
            "http://LOCALHOST:11434",
            "http://127.0.0.1:11434",
            "http://127.1.2.3",
            "http://127.1:11434",
            "http://[::1]:11434",
            "http://0.0.0.0:11434",
        ] {
            assert!(is_loopback_base_url(url), "{url}");
        }
    }

    #[test]
    fn rejects_other_hosts_look_alike_names_and_unparseable_urls() {
        for url in [
            "http://192.168.1.5:11434",
            "http://10.0.0.1:11434",
            "http://127.0.0.1.example.com:11434",
            "http://localhost.example.com",
            "http://[::2]:11434",
            "https://ollama.com",
            "not a url",
            "",
        ] {
            assert!(!is_loopback_base_url(url), "{url}");
        }
    }

    #[test]
    fn reads_a_tags_row_with_ollama_field_names() {
        let parsed: OllamaTagRow = serde_json::from_value(serde_json::json!({
            "name": "mine:latest", "model": "mine:latest", "size": 42, "remote_host": "https://ollama.com:443", "digest": "abc"
        }))
        .unwrap_or_default();
        assert_eq!(parsed.remote_host.as_deref(), Some("https://ollama.com:443"));
        assert_eq!(parsed.size, Some(42));
    }
}
