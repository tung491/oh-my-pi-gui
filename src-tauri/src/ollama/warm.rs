//! Loads a model into memory ahead of the first chat turn: `POST /api/generate`
//! with no prompt makes Ollama load it and keep it resident for `keep_alive`.

use std::time::Duration;

use super::pull::is_valid_model_tag;

pub const WARM_KEEP_ALIVE: &str = "10m";
/// Loading a large model from disk can take a while; past this the warm-up is abandoned.
const WARM_TIMEOUT_MS: u64 = 120_000;

/// Fire and forget: resolves when the load finishes or fails, never hangs past
/// `timeout`, logs failures through the caller.
pub async fn warm_model(base_url: &str, tag: &str, timeout_ms: u64) -> bool {
    if !is_valid_model_tag(tag) {
        crate::runtime_log::note("ollama", format!("warm-up skipped: invalid model name {tag:?}"), serde_json::json!({}));
        return false;
    }
    let client = reqwest::Client::new();
    let result = client
        .post(format!("{base_url}/api/generate"))
        .header("content-type", "application/json")
        .json(&serde_json::json!({ "model": tag, "keep_alive": WARM_KEEP_ALIVE, "stream": false }))
        .timeout(Duration::from_millis(timeout_ms))
        .send()
        .await;
    match result {
        Ok(response) if response.status().is_success() => true,
        Ok(response) => {
            let status = response.status().as_u16();
            let text = response.text().await.unwrap_or_default();
            crate::runtime_log::note(
                "ollama",
                format!("warm-up of {tag} failed: HTTP {status} {}", &text[..text.len().min(300)]),
                serde_json::json!({}),
            );
            false
        }
        Err(error) => {
            crate::runtime_log::note("ollama", format!("warm-up of {tag} failed: {error}"), serde_json::json!({}));
            false
        }
    }
}

/// `warm_model` with the default timeout.
pub async fn warm_model_default(base_url: &str, tag: &str) -> bool {
    warm_model(base_url, tag, WARM_TIMEOUT_MS).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ollama::test_fake_ollama::{closed_port_url, send_json, start_fake_ollama};
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn asks_ollama_to_load_the_model_with_no_prompt_and_a_10m_keep_alive() {
        let seen = Arc::new(Mutex::new(None));
        let seen2 = seen.clone();
        let fake = start_fake_ollama(move |path, body| {
            *seen2.lock().unwrap_or_else(std::sync::PoisonError::into_inner) =
                Some((path.to_string(), serde_json::from_str::<serde_json::Value>(body).ok()));
            send_json(serde_json::json!({ "model": "qwen3:4b", "done": true, "done_reason": "load" }), 200)
        })
        .await;
        assert!(warm_model_default(&fake.url, "qwen3:4b").await);
        let (path, body) = seen.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone().expect("the request was recorded");
        assert_eq!(path, "/api/generate");
        assert_eq!(body, Some(serde_json::json!({ "model": "qwen3:4b", "keep_alive": "10m", "stream": false })));
        fake.close().await;
    }

    #[tokio::test]
    async fn never_rejects_on_http_errors_refused_connections_or_invalid_names() {
        let fake = start_fake_ollama(|_path, _body| send_json(serde_json::json!({ "error": "model not found" }), 404)).await;
        assert!(!warm_model_default(&fake.url, "missing:1b").await);
        assert!(!warm_model_default(&closed_port_url().await, "qwen3:4b").await);
        assert!(!warm_model_default(&fake.url, "bad name").await);
        fake.close().await;
    }
}
