//! Test-only: a real HTTP server on an ephemeral loopback port standing in for
//! the Ollama daemon. Each connection is read, handed to a handler, then
//! closed (`Connection: close`), so a streaming handler can write chunks with
//! its own timing and the client reads until EOF.

#![cfg(test)]

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

pub struct FakeRequest {
    pub path: String,
    pub body: String,
}

pub struct FakeOllama {
    pub url: String,
    shutdown: Option<oneshot::Sender<()>>,
    join: Option<tokio::task::JoinHandle<()>>,
}

impl FakeOllama {
    pub async fn close(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.join.take() {
            let _ = handle.await;
        }
    }
}

async fn read_request(stream: &mut TcpStream) -> Option<FakeRequest> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        if let Some(pos) = find_subslice(&buffer, b"\r\n\r\n") {
            break pos;
        }
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..n]);
    };
    let header_text = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next()?;
    let path = request_line.split_whitespace().nth(1)?.to_string();
    let content_length: usize = lines
        .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().to_string()))
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut body = buffer[header_end + 4..].to_vec();
    while body.len() < content_length {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(content_length.max(body.len().min(content_length)));
    Some(FakeRequest { path, body: String::from_utf8_lossy(&body).into_owned() })
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

type ConnHandler = Arc<dyn Fn(FakeRequest, TcpStream) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// Serve `handler` once per accepted connection; the returned stream is the
/// handler's to write and close as it likes.
async fn serve(handler: ConnHandler) -> FakeOllama {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind an ephemeral loopback port");
    let addr = listener.local_addr().expect("the bound listener has a local address");
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel();
    let join = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = &mut shutdown_rx => break,
                accepted = listener.accept() => {
                    let Ok((mut stream, _)) = accepted else { continue };
                    let handler = handler.clone();
                    tokio::spawn(async move {
                        if let Some(request) = read_request(&mut stream).await {
                            handler(request, stream).await;
                        }
                    });
                }
            }
        }
    });
    FakeOllama { url: format!("http://{addr}"), shutdown: Some(shutdown_tx), join: Some(join) }
}

/// A `FakeRequest` plus the raw connection, for a handler that streams chunks by hand.
pub async fn start_raw_fake_ollama<F, Fut>(handler: F) -> FakeOllama
where
    F: Fn(FakeRequest, TcpStream) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    serve(Arc::new(move |request, stream| Box::pin(handler(request, stream)))).await
}

/// `send_json`-style convenience: the handler answers with one JSON body, or
/// `None` to never respond at all (the connection stays open until the
/// client's own timeout fires).
pub async fn start_fake_ollama<F>(handler: F) -> FakeOllama
where
    F: Fn(&str, &str) -> Option<(u16, Value)> + Send + Sync + 'static,
{
    start_raw_fake_ollama(move |request, mut stream| {
        let answer = handler(&request.path, &request.body);
        async move {
            if let Some((status, body)) = answer {
                write_json(&mut stream, status, &body).await;
            }
        }
    })
    .await
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Error",
    }
}

pub async fn write_json(stream: &mut TcpStream, status: u16, body: &Value) {
    let text = body.to_string();
    let head = format!(
        "HTTP/1.1 {status} {}\r\ncontent-type: application/json\r\nconnection: close\r\ncontent-length: {}\r\n\r\n",
        reason_phrase(status),
        text.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(text.as_bytes()).await;
    let _ = stream.shutdown().await;
}

pub async fn write_head_streaming(stream: &mut TcpStream, status: u16, content_type: &str) {
    let head =
        format!("HTTP/1.1 {status} {}\r\ncontent-type: {content_type}\r\nconnection: close\r\n\r\n", reason_phrase(status));
    let _ = stream.write_all(head.as_bytes()).await;
}

/// `sendJson(res, body, status)`: a one-shot JSON answer for the simple handler form.
pub fn send_json(body: Value, status: u16) -> Option<(u16, Value)> {
    Some((status, body))
}

/// A loopback URL nothing listens on: bind an ephemeral port, then release it.
pub async fn closed_port_url() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind an ephemeral loopback port");
    let addr = listener.local_addr().expect("the bound listener has a local address");
    drop(listener);
    format!("http://{addr}")
}
