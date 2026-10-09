//! Request correlation for the RPC sidecar:
//! every command gets a `gui-<n>` id, its frame is written before the call
//! returns (so stdin order equals arrival order), and the response is awaited
//! by id with a per-command timeout.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use serde_json::Value;
use tokio::sync::oneshot;

use crate::ports::SidecarError;

const DEFAULT_TIMEOUT_MS: u64 = 8_000;

/// Writes one frame to the child's stdin (queued, in call order).
pub(crate) type FrameSender = Arc<dyn Fn(Value) + Send + Sync>;

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, SidecarError>>>>>;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) struct RpcClient {
    pending: Pending,
    next_id: AtomicU64,
    send: FrameSender,
    timeout: Duration,
}

impl RpcClient {
    pub(crate) fn new(send: FrameSender) -> Self {
        Self { pending: Arc::default(), next_id: AtomicU64::new(0), send, timeout: Duration::from_millis(DEFAULT_TIMEOUT_MS) }
    }

    fn mint_id(&self) -> String {
        format!("gui-{}", self.next_id.fetch_add(1, Ordering::SeqCst) + 1)
    }

    fn frame_with_id(command: &Value, id: &str) -> Value {
        let mut frame = command.clone();
        if let Some(object) = frame.as_object_mut() {
            object.insert("id".into(), Value::String(id.to_string()));
        }
        frame
    }

    /// Send a command and await its correlated response. The frame is handed
    /// to the sender synchronously; only the response is awaited.
    pub(crate) fn command(&self, command: Value, timeout_ms: Option<u64>) -> BoxFuture<'static, Result<Value, SidecarError>> {
        let id = self.mint_id();
        let timeout_ms = timeout_ms.unwrap_or(self.timeout.as_millis() as u64);
        let command_type = command.get("type").and_then(Value::as_str).unwrap_or("").to_string();
        let (tx, rx) = oneshot::channel();
        lock(&self.pending).insert(id.clone(), tx);
        (self.send)(Self::frame_with_id(&command, &id));
        let pending = self.pending.clone();
        Box::pin(async move {
            match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
                Ok(Ok(result)) => result,
                // The sender was dropped without an answer: the client went away.
                Ok(Err(_)) => Err(SidecarError::Closed),
                Err(_) => {
                    lock(&pending).remove(&id);
                    Err(SidecarError::Timeout { timeout_ms, command_type })
                }
            }
        })
    }

    /// Route an inbound response frame to its waiting request; false when nothing waits for it.
    pub(crate) fn on_response(&self, frame: &Value) -> bool {
        let Some(id) = frame.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()) else { return false };
        let Some(entry) = lock(&self.pending).remove(id) else { return false };
        let _ = entry.send(Ok(frame.clone()));
        true
    }

    /// Reject every pending request (the sidecar died).
    pub(crate) fn reject_all(&self, reason: &str) {
        let entries: Vec<_> = lock(&self.pending).drain().collect();
        for (_, entry) in entries {
            let _ = entry.send(Err(SidecarError::Other(reason.to_string())));
        }
    }

    #[cfg(test)]
    pub(crate) fn pending_count(&self) -> usize {
        lock(&self.pending).len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn client() -> (RpcClient, Arc<Mutex<Vec<Value>>>) {
        let sent: Arc<Mutex<Vec<Value>>> = Arc::default();
        let log = sent.clone();
        let client = RpcClient::new(Arc::new(move |frame| lock(&log).push(frame)));
        (client, sent)
    }

    #[tokio::test(start_paused = true)]
    async fn responds_by_id() {
        let (client, sent) = client();
        let first = client.command(json!({ "type": "get_state" }), None);
        let second = client.command(json!({ "type": "get_messages" }), None);
        let frames = lock(&sent).clone();
        assert_eq!(frames[0]["id"], "gui-1");
        assert_eq!(frames[1]["id"], "gui-2");
        assert_eq!(client.pending_count(), 2);
        assert!(client.on_response(&json!({ "type": "response", "id": "gui-2", "success": true, "data": 2 })));
        assert!(client.on_response(&json!({ "type": "response", "id": "gui-1", "success": true, "data": 1 })));
        assert!(!client.on_response(&json!({ "type": "response", "id": "gui-9" })));
        assert!(!client.on_response(&json!({ "type": "response" })));
        assert_eq!(first.await.unwrap()["data"], 1);
        assert_eq!(second.await.unwrap()["data"], 2);
        assert_eq!(client.pending_count(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn times_out_with_the_same_error_message_as_ts() {
        let (client, _sent) = client();
        let default = client.command(json!({ "type": "get_state" }), None);
        let custom = client.command(json!({ "type": "prompt" }), Some(30_000));
        let error = default.await.unwrap_err();
        assert_eq!(error.to_string(), "RPC timeout (8000ms): get_state");
        assert_eq!(client.pending_count(), 1);
        let error = custom.await.unwrap_err();
        assert_eq!(error.to_string(), "RPC timeout (30000ms): prompt");
        assert_eq!(client.pending_count(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn reject_all_fails_every_pending_request_with_the_reason() {
        let (client, sent) = client();
        let waiting = client.command(json!({ "type": "get_state" }), None);
        let second = client.command(json!({ "type": "bash", "command": "ls" }), None);
        assert_eq!(lock(&sent)[1]["id"], "gui-2");
        assert_eq!(lock(&sent).len(), 2);
        client.reject_all("Sidecar disconnected");
        assert_eq!(waiting.await, Err(SidecarError::Other("Sidecar disconnected".into())));
        assert_eq!(second.await, Err(SidecarError::Other("Sidecar disconnected".into())));
        assert_eq!(client.pending_count(), 0);
    }
}
