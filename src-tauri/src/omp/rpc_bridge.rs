//! NDJSON framing and protocol-v2 chunk reassembly for the sidecar's stdout
//! stream, ported from `src/main/rpc-bridge.ts`. One logical frame is at most
//! `RPC_MAX_FRAME_BYTES` on the wire, or `RPC_MAX_REASSEMBLED_BYTES` after a
//! contiguous `rpc_chunk` sequence is put back together.

use std::fmt;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

pub(crate) const RPC_MAX_FRAME_BYTES: usize = 1_048_576;
pub(crate) const RPC_MAX_REASSEMBLED_BYTES: usize = 67_108_864;
const CHUNK_PAYLOAD_BYTES: usize = 262_144;
const MAX_CHUNK_COUNT: u64 = RPC_MAX_REASSEMBLED_BYTES.div_ceil(CHUNK_PAYLOAD_BYTES) as u64;
const MAX_CHUNK_ID_CHARS: usize = 128;

/// Negotiate v2 only when both peers agree on the framing limits.
pub(crate) fn supports_rpc_protocol_v2(value: &Value) -> bool {
    let Some(ready) = value.as_object() else { return false };
    let versions = ready.get("supportedProtocolVersions").and_then(Value::as_array);
    let has_v2 = versions.map(|list| list.iter().any(|version| version.as_u64() == Some(2))).unwrap_or(false);
    has_v2
        && ready.get("maxFrameBytes").and_then(Value::as_u64) == Some(RPC_MAX_FRAME_BYTES as u64)
        && ready.get("maxReassembledFrameBytes").and_then(Value::as_u64) == Some(RPC_MAX_REASSEMBLED_BYTES as u64)
}

/// Why a chunk was refused; the message is the TS error text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ChunkError(pub(crate) &'static str);

impl fmt::Display for ChunkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for ChunkError {}

struct PendingChunks {
    chunk_id: String,
    count: u64,
    byte_length: usize,
    next_index: u64,
    received_bytes: usize,
    chunks: Vec<Vec<u8>>,
}

/// Strict base64: the canonical alphabet with canonical padding, nothing else.
fn decode_base64(data: Option<&Value>) -> Result<Vec<u8>, ChunkError> {
    let text = data.and_then(Value::as_str).filter(|text| !text.is_empty()).ok_or(ChunkError("Invalid RPC chunk data"))?;
    let bytes = BASE64.decode(text).map_err(|_| ChunkError("Invalid RPC chunk data"))?;
    if BASE64.encode(&bytes) != text {
        return Err(ChunkError("Invalid RPC chunk data"));
    }
    Ok(bytes)
}

/// Reassembles one v2 chunk sequence. The server writes a sequence
/// contiguously; rejecting interleaving keeps retained memory bounded to one
/// logical frame.
#[derive(Default)]
pub(crate) struct ChunkReassembler {
    pending: Option<PendingChunks>,
}

impl ChunkReassembler {
    pub(crate) fn feed(&mut self, frame: &Value) -> Result<Option<Vec<u8>>, ChunkError> {
        let result = self.feed_inner(frame);
        if result.is_err() {
            self.pending = None;
        }
        result
    }

    fn feed_inner(&mut self, frame: &Value) -> Result<Option<Vec<u8>>, ChunkError> {
        let invalid = ChunkError("Invalid RPC chunk metadata");
        let chunk_id = frame.get("chunkId").and_then(Value::as_str).filter(|id| !id.is_empty() && id.len() <= MAX_CHUNK_ID_CHARS).ok_or(invalid.clone())?;
        let index = frame.get("index").and_then(Value::as_u64).ok_or(invalid.clone())?;
        let count = frame.get("count").and_then(Value::as_u64).ok_or(invalid.clone())?;
        let byte_length = frame.get("byteLength").and_then(Value::as_u64).ok_or(invalid.clone())?;
        if !(2..=MAX_CHUNK_COUNT).contains(&count) || byte_length < RPC_MAX_FRAME_BYTES as u64 || byte_length > RPC_MAX_REASSEMBLED_BYTES as u64 {
            return Err(invalid);
        }
        let byte_length = byte_length as usize;
        let bytes = decode_base64(frame.get("data"))?;
        if bytes.len() > CHUNK_PAYLOAD_BYTES {
            return Err(ChunkError("RPC chunk payload exceeds the transport limit"));
        }
        if self.pending.is_none() {
            if index != 0 {
                return Err(ChunkError("RPC chunk sequence must start at index 0"));
            }
            self.pending = Some(PendingChunks { chunk_id: chunk_id.to_string(), count, byte_length, next_index: 0, received_bytes: 0, chunks: Vec::new() });
        }
        let pending = self.pending.as_mut().ok_or(ChunkError("RPC chunk sequence mismatch"))?;
        if pending.chunk_id != chunk_id || pending.count != count || pending.byte_length != byte_length || pending.next_index != index {
            return Err(ChunkError("RPC chunk sequence mismatch"));
        }
        pending.received_bytes += bytes.len();
        pending.chunks.push(bytes);
        pending.next_index += 1;
        if pending.received_bytes > pending.byte_length {
            return Err(ChunkError("RPC chunk sequence exceeds declared length"));
        }
        if pending.next_index < pending.count {
            return Ok(None);
        }
        if pending.received_bytes != pending.byte_length {
            return Err(ChunkError("RPC chunk sequence length mismatch"));
        }
        let Some(done) = self.pending.take() else { return Ok(None) };
        Ok(Some(done.chunks.concat()))
    }

    pub(crate) fn pending(&self) -> bool {
        self.pending.is_some()
    }

    pub(crate) fn clear(&mut self) {
        self.pending = None;
    }
}

/// One NDJSON line, delivered as a parsed object, with v2 chunk sequences
/// reassembled transparently. Mirrors `handleLine` in the TS source.
fn handle_line(reassembler: &mut ChunkReassembler, line: &[u8], on_frame: &mut impl FnMut(Value)) {
    let Ok(text) = std::str::from_utf8(line) else {
        reassembler.clear();
        return;
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return;
    }
    let parsed: Value = match serde_json::from_str(trimmed) {
        Ok(value) => value,
        Err(_) => {
            reassembler.clear();
            return;
        }
    };
    if !parsed.is_object() {
        reassembler.clear();
        return;
    }
    if parsed.get("type").and_then(Value::as_str) == Some("rpc_chunk") {
        match reassembler.feed(&parsed) {
            Ok(Some(full)) => {
                let reassembled = String::from_utf8(full).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok());
                match reassembled {
                    Some(frame) if frame.is_object() => on_frame(frame),
                    _ => reassembler.clear(),
                }
            }
            Ok(None) => {}
            Err(_) => reassembler.clear(),
        }
        return;
    }
    // Protocol v2 sequences are contiguous. A normal frame interrupts and
    // invalidates an incomplete sequence, but remains independently usable.
    if reassembler.pending() {
        reassembler.clear();
    }
    on_frame(parsed);
}

/// Read NDJSON frames from `stream` until EOF or a read error, calling
/// `on_frame` for every parsed object. A line longer than `RPC_MAX_FRAME_BYTES`
/// is discarded without being buffered or parsed, so a runaway writer cannot
/// grow memory past the frame cap.
pub(crate) async fn attach_ndjson_parser<R>(stream: R, mut on_frame: impl FnMut(Value))
where
    R: AsyncRead + Unpin,
{
    let mut reader = BufReader::with_capacity(64 * 1024, stream);
    let mut reassembler = ChunkReassembler::default();
    let mut line: Vec<u8> = Vec::new();
    let mut oversize = false;
    loop {
        let buffer = match reader.fill_buf().await {
            Ok(buffer) if buffer.is_empty() => break,
            Ok(buffer) => buffer,
            Err(_) => break,
        };
        let (consumed, complete) = match buffer.iter().position(|byte| *byte == b'\n') {
            Some(newline) => (newline + 1, true),
            None => (buffer.len(), false),
        };
        let segment = &buffer[..consumed - usize::from(complete)];
        if !oversize {
            if line.len() + segment.len() > RPC_MAX_FRAME_BYTES {
                oversize = true;
                line.clear();
            } else {
                line.extend_from_slice(segment);
            }
        }
        reader.consume(consumed);
        if complete {
            if oversize {
                reassembler.clear();
            } else {
                handle_line(&mut reassembler, &line, &mut on_frame);
            }
            line.clear();
            oversize = false;
        }
    }
    if !line.is_empty() && !oversize {
        handle_line(&mut reassembler, &line, &mut on_frame);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CHUNK_BYTES: usize = 262_144;

    fn chunk_frames(payload: &[u8], chunk_id: &str) -> Vec<Value> {
        let count = payload.len().div_ceil(CHUNK_BYTES);
        (0..count)
            .map(|index| {
                let end = ((index + 1) * CHUNK_BYTES).min(payload.len());
                json!({
                    "type": "rpc_chunk",
                    "chunkId": chunk_id,
                    "index": index,
                    "count": count,
                    "byteLength": payload.len(),
                    "data": BASE64.encode(&payload[index * CHUNK_BYTES..end]),
                })
            })
            .collect()
    }

    fn with(frame: &Value, key: &str, value: Value) -> Value {
        let mut copy = frame.clone();
        copy[key] = value;
        copy
    }

    #[test]
    fn requires_protocol_2_and_the_exact_framing_limits() {
        assert!(supports_rpc_protocol_v2(&json!({
            "supportedProtocolVersions": [1, 2],
            "maxFrameBytes": RPC_MAX_FRAME_BYTES,
            "maxReassembledFrameBytes": 67_108_864u64,
        })));
        assert!(!supports_rpc_protocol_v2(&json!({ "supportedProtocolVersions": [2] })));
        assert!(!supports_rpc_protocol_v2(&json!({
            "supportedProtocolVersions": [1, 2],
            "maxFrameBytes": RPC_MAX_FRAME_BYTES,
            "maxReassembledFrameBytes": 1,
        })));
        assert!(!supports_rpc_protocol_v2(&json!([2])));
    }

    #[test]
    fn reassembles_one_bounded_contiguous_protocol_v2_frame() {
        let payload = vec![0x61u8; RPC_MAX_FRAME_BYTES];
        let mut decoder = ChunkReassembler::default();
        let mut result = None;
        for frame in chunk_frames(&payload, "frame-1") {
            result = decoder.feed(&frame).unwrap();
        }
        assert_eq!(result.as_deref(), Some(payload.as_slice()));
        assert!(!decoder.pending());
    }

    #[test]
    fn rejects_malformed_or_interleaved_chunks_and_releases_pending_state() {
        let payload = vec![0x62u8; RPC_MAX_FRAME_BYTES];
        let frames = chunk_frames(&payload, "frame-1");
        let mut decoder = ChunkReassembler::default();

        assert_eq!(decoder.feed(&with(&frames[0], "data", json!("not-base64"))), Err(ChunkError("Invalid RPC chunk data")));
        assert!(!decoder.pending());

        assert_eq!(decoder.feed(&frames[0]), Ok(None));
        assert_eq!(decoder.feed(&with(&frames[1], "chunkId", json!("other-frame"))), Err(ChunkError("RPC chunk sequence mismatch")));
        assert!(!decoder.pending());

        assert_eq!(decoder.feed(&with(&frames[0], "count", json!(257))), Err(ChunkError("Invalid RPC chunk metadata")));
        assert!(!decoder.pending());
    }

    #[tokio::test]
    async fn the_parser_skips_blank_and_oversize_lines_and_reassembles_chunks() {
        let payload = serde_json::to_vec(&json!({ "type": "big", "fill": "x".repeat(RPC_MAX_FRAME_BYTES) })).unwrap();
        let mut input = Vec::new();
        input.extend_from_slice(b"\n{\"type\":\"a\"}\nrunning 1 test\n");
        input.extend_from_slice(&vec![b'y'; RPC_MAX_FRAME_BYTES + 10]);
        input.push(b'\n');
        for frame in chunk_frames(&payload, "c") {
            input.extend_from_slice(serde_json::to_string(&frame).unwrap().as_bytes());
            input.push(b'\n');
        }
        input.extend_from_slice(b"{\"type\":\"b\"}");
        let mut frames = Vec::new();
        attach_ndjson_parser(std::io::Cursor::new(input), |frame| frames.push(frame["type"].as_str().unwrap_or("").to_string())).await;
        assert_eq!(frames, vec!["a", "big", "b"]);
    }
}
