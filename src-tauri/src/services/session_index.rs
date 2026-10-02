//! Watches `~/.omp/agent/sessions/` for `.jsonl` session files: list, search,
//! rename (via `tabs`/`SidecarHandle`, in `ipc.rs`), delete, and watch for
//! outside changes. Ported from `session-index.ts`.
//!
//! Change handling is per file: a watcher event drops that path's cache
//! entries and notifies, so a streaming agent appending to one session costs
//! one stat — never a re-fingerprint of the whole tree. Correctness does not
//! depend on the events, though: every read goes through [`SessionIndex::list`],
//! which scans and re-parses whatever its cache does not already hold, so a
//! missed event self-heals on the next refresh instead of needing a background poll.
//!
//! Per the wave rule that a module never resolves the agent directory itself
//! (`paths::agent_dir()` panics in a test build when it would resolve the
//! default profile), the sessions directory is a constructor parameter; the
//! `Services` port passes `paths::agent_dir().join("sessions")` in production
//! and a temp dir in tests.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::Value;

use crate::ports::{ServiceError, SessionInfo, SessionKind, SessionScope, SessionStatus};

use super::session_cache::StampedLru;

const TITLE_SLOT_BYTES: usize = 256;
const TAIL_BYTES: u64 = 32 * 1024;
const HEAD_BYTES: u64 = 32 * 1024;
const MAX_PARSE_CACHE_ENTRIES: usize = 4096;
/// Per-file cap for full-content search reads; larger sessions match on this prefix.
const SEARCH_READ_BYTES: u64 = 8 * 1024 * 1024;
/// Total bytes of cached search text. Counted, not entry-counted: one entry
/// can be the full read cap, so an entry-count ceiling alone would allow
/// ~8 MB x entries of resident strings.
const SEARCH_CACHE_BYTES: usize = 64 * 1024 * 1024;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Lexically resolve `path` against the process cwd (Node's `path.resolve`:
/// no symlink resolution, unlike `std::fs::canonicalize`).
fn resolve(path: &str) -> PathBuf {
    let candidate = Path::new(path);
    let base = if candidate.is_absolute() { PathBuf::new() } else { std::env::current_dir().unwrap_or_default() };
    let mut out = base;
    for component in candidate.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn signature(len: u64, modified_ms: i64) -> String {
    format!("{modified_ms}:{len}")
}

fn modified_ms(metadata: &std::fs::Metadata) -> i64 {
    metadata.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn created_ms(metadata: &std::fs::Metadata) -> i64 {
    metadata.created().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn millis_to_rfc3339(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let nanos = (ms.rem_euclid(1000) * 1_000_000) as u32;
    chrono::DateTime::from_timestamp(secs, nanos).map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)).unwrap_or_default()
}

fn read_at(file: &mut std::fs::File, offset: u64, len: u64) -> std::io::Result<Vec<u8>> {
    let mut buffer = vec![0u8; len as usize];
    file.seek(SeekFrom::Start(offset))?;
    let mut read_total = 0usize;
    loop {
        let read = file.read(&mut buffer[read_total..])?;
        if read == 0 {
            break;
        }
        read_total += read;
        if read_total == buffer.len() {
            break;
        }
    }
    buffer.truncate(read_total);
    Ok(buffer)
}

/// The agent's session header line (the file's second line).
#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionHeader {
    id: Option<String>,
    title: Option<String>,
    timestamp: Option<String>,
    cwd: Option<String>,
    parent_session: Option<String>,
    kind: Option<SessionKind>,
}

pub struct SessionIndex {
    sessions_dir: PathBuf,
    default_cwd: String,
    parse_cache: Mutex<StampedLru<SessionInfo>>,
    text_cache: Mutex<StampedLru<String>>,
    on_change: Mutex<Vec<Box<dyn Fn() + Send + Sync>>>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

impl SessionIndex {
    pub fn new(sessions_dir: PathBuf, default_cwd: String) -> Self {
        Self {
            sessions_dir,
            default_cwd,
            parse_cache: Mutex::new(StampedLru::new(MAX_PARSE_CACHE_ENTRIES)),
            text_cache: Mutex::new(StampedLru::with_size_of(SEARCH_CACHE_BYTES, |text: &String| text.len())),
            on_change: Mutex::new(Vec::new()),
            watcher: Mutex::new(None),
        }
    }

    /// Sessions root watched by this index (plan files live in per-session artifact dirs beneath it).
    pub fn sessions_dir(&self) -> &Path {
        &self.sessions_dir
    }

    pub fn on_change(&self, listener: Box<dyn Fn() + Send + Sync>) {
        lock(&self.on_change).push(listener);
    }

    fn notify_change(&self) {
        for listener in lock(&self.on_change).iter() {
            listener();
        }
    }

    /// Start the directory watcher. A changed, added or removed `.jsonl` file
    /// drops exactly that path's cached view and notifies; everything else is
    /// ignored (chokidar's `depth: 2` boundary has no direct notify
    /// equivalent, so this matches it by filtering on the extension instead).
    pub fn start(self: &std::sync::Arc<Self>) {
        let index = self.clone();
        let result = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            let Ok(event) = event else { return };
            for path in event.paths {
                if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
                    index.invalidate(&path);
                }
            }
        });
        let Ok(mut watcher) = result else { return };
        use notify::Watcher;
        if std::fs::create_dir_all(&self.sessions_dir).is_err() {
            return;
        }
        let _ = watcher.watch(&self.sessions_dir, notify::RecursiveMode::Recursive);
        *lock(&self.watcher) = Some(watcher);
    }

    pub fn stop(&self) {
        lock(&self.watcher).take();
        lock(&self.parse_cache).clear();
        lock(&self.text_cache).clear();
    }

    fn invalidate(&self, path: &Path) {
        let key = path.to_string_lossy().to_string();
        lock(&self.parse_cache).delete(&key);
        lock(&self.text_cache).delete(&key);
        self.notify_change();
    }

    /// `scope` "local" filters to sessions whose cwd matches `cwd` (defaulting
    /// to the index's own cwd for single-window behavior; multi-window
    /// callers pass their own so each window sees only its project's sessions).
    pub fn list(&self, scope: SessionScope, cwd: Option<&str>) -> Result<Vec<SessionInfo>, ServiceError> {
        let entries = self.scan_dir();
        let mut parsed: Vec<SessionInfo> = entries.iter().filter_map(|path| self.parse_session_file(path)).collect();
        let local_cwd = resolve(cwd.unwrap_or(&self.default_cwd));
        if scope == SessionScope::Local {
            parsed.retain(|info| !info.cwd.is_empty() && resolve(&info.cwd) == local_cwd);
        }
        // Sort by modified descending.
        parsed.sort_by(|a, b| b.modified.cmp(&a.modified));
        // Dedupe by session id: the agent migrates sessions between legacy and
        // current cwd-directory encodings, and during that window the same
        // session id can exist as a file in both directories. After the
        // modified-desc sort, the first occurrence of each id is the newest
        // copy — keep it and drop the stale duplicates.
        let mut seen = std::collections::HashSet::new();
        parsed.retain(|info| !info.id.is_empty() && seen.insert(info.id.clone()));
        Ok(parsed)
    }

    /// Session kind for one file: the cached parse when fresh, a cold parse
    /// otherwise. Unreadable files degrade to "agent".
    pub fn kind_for(&self, session_path: &str) -> SessionKind {
        self.parse_session_file(Path::new(session_path)).and_then(|info| info.kind).unwrap_or_default()
    }

    pub fn delete_session(&self, session_path: &str) -> Result<(), ServiceError> {
        let target = resolve(session_path);
        let root = format!("{}{}", resolve(&self.sessions_dir.to_string_lossy()).display(), std::path::MAIN_SEPARATOR);
        let target_str = target.to_string_lossy();
        if !target_str.starts_with(&root) || !target_str.ends_with(".jsonl") {
            return Err(ServiceError::Refused("Invalid session path".into()));
        }
        let _ = std::fs::remove_file(&target);
        let key = target.to_string_lossy().to_string();
        lock(&self.parse_cache).delete(&key);
        lock(&self.text_cache).delete(&key);
        self.notify_change();
        Ok(())
    }

    /// Full-content search: paths of the given session files whose raw JSONL
    /// text contains every query token (case-insensitive). Deliberately a raw
    /// grep — no JSON parsing — because tokens are matched individually, so
    /// JSON escaping rarely breaks them.
    pub fn search_content(&self, query: &str, candidate_paths: &[String]) -> Vec<String> {
        let tokens: Vec<String> = query.to_lowercase().split_whitespace().map(str::to_string).collect();
        if tokens.is_empty() || candidate_paths.is_empty() {
            return Vec::new();
        }
        candidate_paths
            .iter()
            .filter(|path| {
                let Some(text) = self.search_text(Path::new(path)) else { return false };
                tokens.iter().all(|token| text.contains(token.as_str()))
            })
            .cloned()
            .collect()
    }

    /// Lowercased session-file text (capped at `SEARCH_READ_BYTES`), cached by mtime:size.
    fn search_text(&self, path: &Path) -> Option<String> {
        let metadata = std::fs::metadata(path).ok()?;
        let sig = signature(metadata.len(), modified_ms(&metadata));
        let key = path.to_string_lossy().to_string();
        if let Some(cached) = lock(&self.text_cache).get(&key, &sig) {
            return Some(cached.clone());
        }
        let mut file = std::fs::File::open(path).ok()?;
        let length = metadata.len().min(SEARCH_READ_BYTES);
        let bytes = read_at(&mut file, 0, length).ok()?;
        let text = String::from_utf8_lossy(&bytes).to_lowercase();
        lock(&self.text_cache).set(&key, &sig, text.clone());
        Some(text)
    }

    fn scan_dir(&self) -> Vec<PathBuf> {
        let Ok(project_dirs) = std::fs::read_dir(&self.sessions_dir) else { return Vec::new() };
        let mut out = Vec::new();
        for project_dir in project_dirs.flatten() {
            let Ok(file_type) = project_dir.file_type() else { continue };
            if !file_type.is_dir() {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(project_dir.path()) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                if entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) && path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                    out.push(path);
                }
            }
        }
        out
    }

    /// One session file changed, appeared, or vanished: forget exactly that
    /// file's cached view and notify. Nothing else is stat'ed.
    fn parse_session_file(&self, path: &Path) -> Option<SessionInfo> {
        let metadata = std::fs::metadata(path).ok()?;
        let sig = signature(metadata.len(), modified_ms(&metadata));
        let key = path.to_string_lossy().to_string();
        if let Some(cached) = lock(&self.parse_cache).get(&key, &sig) {
            return Some(cached.clone());
        }
        let info = self.do_parse(path, &metadata)?;
        lock(&self.parse_cache).set(&key, &sig, info.clone());
        Some(info)
    }

    fn do_parse(&self, path: &Path, metadata: &std::fs::Metadata) -> Option<SessionInfo> {
        let size = metadata.len();
        if size == 0 {
            return None;
        }
        let mut file = std::fs::File::open(path).ok()?;
        // Read enough of the head to parse the title, header, and first user message.
        let head = read_at(&mut file, 0, HEAD_BYTES.min(size)).ok()?;
        let title_slot = &head[..TITLE_SLOT_BYTES.min(head.len())];
        let title_slot_value = parse_title_slot(title_slot);

        let header_start = head.iter().position(|b| *b == b'\n');
        let mut header = SessionHeader::default();
        if let Some(header_start) = header_start {
            let header_bytes = read_at(&mut file, (header_start + 1) as u64, 4096.min(size.saturating_sub(header_start as u64 + 1))).ok()?;
            let header_line = header_bytes.split(|b| *b == b'\n').next().unwrap_or(&[]);
            if let Ok(parsed) = serde_json::from_slice::<SessionHeader>(header_line) {
                header = parsed;
            }
        }

        let tail_start = size.saturating_sub(TAIL_BYTES);
        let tail = read_at(&mut file, tail_start, size - tail_start).ok()?;
        let (status, message_count) = parse_tail(&String::from_utf8_lossy(&tail));
        let first_message = parse_first_message(&String::from_utf8_lossy(&head));

        let id = header.id.clone().unwrap_or_else(|| {
            path.file_stem().map(|stem| stem.to_string_lossy().to_string()).unwrap_or_else(|| "unknown".to_string())
        });

        Some(SessionInfo {
            path: path.to_string_lossy().to_string(),
            id,
            // Not `.or()`: an empty title slot (auto-title never ran) is
            // missing data, so fall back to the header line's title.
            title: title_slot_value.filter(|t| !t.is_empty()).or(header.title.clone()),
            cwd: header.cwd.unwrap_or_default(),
            created: header.timestamp.unwrap_or_else(|| millis_to_rfc3339(created_ms(metadata))),
            modified: millis_to_rfc3339(modified_ms(metadata)),
            message_count,
            size,
            status,
            kind: header.kind,
            parent_session_path: header.parent_session,
            first_message,
        })
    }
}

fn parse_title_slot(buf: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(buf);
    let first_line = text.split('\n').next()?.trim_end();
    if first_line.is_empty() {
        return None;
    }
    let parsed: Value = serde_json::from_str(first_line).ok()?;
    if parsed.get("type").and_then(Value::as_str) == Some("title") {
        parsed.get("title").and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_string)
    } else {
        None
    }
}

fn parse_first_message(head: &str) -> String {
    for line in head.split('\n') {
        let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
        if entry.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(message) = entry.get("message") else { continue };
        if message.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let Some(content) = message.get("content") else { continue };
        if let Some(text) = content.as_str() {
            return text.chars().take(200).collect();
        }
        if let Some(parts) = content.as_array() {
            if let Some(text) = parts
                .iter()
                .find(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                .and_then(|part| part.get("text"))
                .and_then(Value::as_str)
            {
                return text.chars().take(200).collect();
            }
        }
    }
    String::new()
}

fn parse_tail(tail: &str) -> (SessionStatus, u64) {
    let mut message_count = 0u64;
    let mut status = SessionStatus::Unknown;
    let mut last_entry: Option<Value> = None;
    for line in tail.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
        if entry.get("type").and_then(Value::as_str) == Some("message") {
            message_count += 1;
        }
        last_entry = Some(entry);
    }
    if let Some(entry) = last_entry {
        status = match entry.get("type").and_then(Value::as_str) {
            Some("agent_end") | Some("turn_end") => SessionStatus::Complete,
            Some("error") => SessionStatus::Error,
            Some("aborted") => SessionStatus::Aborted,
            Some("interrupted") => SessionStatus::Interrupted,
            Some("message_start") | Some("tool_execution_start") => SessionStatus::Pending,
            Some("message") => {
                if entry.get("message").and_then(|m| m.get("role")).and_then(Value::as_str) == Some("assistant") {
                    SessionStatus::Complete
                } else {
                    SessionStatus::Pending
                }
            }
            _ => SessionStatus::Unknown,
        };
    }
    (status, message_count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn write_session(dir: &Path, id: &str, kind: Option<&str>) -> PathBuf {
        let project_dir = dir.join("project-x");
        std::fs::create_dir_all(&project_dir).unwrap();
        let file = project_dir.join(format!("{id}.jsonl"));
        let slot = format!("{}\n", serde_json::json!({ "updatedAt": chrono::Utc::now().to_rfc3339() }));
        let mut header = serde_json::json!({
            "type": "session",
            "version": 3,
            "id": id,
            "timestamp": chrono::Utc::now().to_rfc3339(),
            "cwd": dir.to_string_lossy(),
        });
        if let Some(kind) = kind {
            header["kind"] = serde_json::json!(kind);
        }
        std::fs::write(&file, format!("{slot}{}\n", header)).unwrap();
        file
    }

    fn make_index() -> (Arc<SessionIndex>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let index = Arc::new(SessionIndex::new(dir.path().to_path_buf(), dir.path().to_string_lossy().to_string()));
        (index, dir)
    }

    #[test]
    fn reads_kind_from_the_session_header_into_sessioninfo_absent_on_legacy_files() {
        let (index, dir) = make_index();
        write_session(dir.path(), "chat-one", Some("chat"));
        write_session(dir.path(), "agent-one", None);

        let infos = index.list(SessionScope::Global, None).unwrap();
        assert_eq!(infos.iter().find(|info| info.id == "chat-one").and_then(|info| info.kind), Some(SessionKind::Chat));
        assert_eq!(infos.iter().find(|info| info.id == "agent-one").and_then(|info| info.kind), None);
    }

    #[test]
    fn kindfor_cold_reads_a_single_file_and_degrades_unreadable_files_to_agent() {
        let (index, dir) = make_index();
        let chat_file = write_session(dir.path(), "chat-two", Some("chat"));
        let agent_file = write_session(dir.path(), "agent-two", None);

        assert_eq!(index.kind_for(chat_file.to_str().unwrap()), SessionKind::Chat);
        assert_eq!(index.kind_for(agent_file.to_str().unwrap()), SessionKind::Agent);
        assert_eq!(index.kind_for(dir.path().join("missing.jsonl").to_str().unwrap()), SessionKind::Agent);
    }

    #[test]
    fn re_reads_only_the_session_that_was_written_to() {
        let (index, dir) = make_index();
        let growing = write_session(dir.path(), "growing", None);
        write_session(dir.path(), "quiet", None);

        let first = index.list(SessionScope::Global, None).unwrap();
        let growing_before = first.iter().find(|info| info.id == "growing").cloned();
        assert_eq!(growing_before.map(|info| info.message_count), Some(0));

        // The cache keys on `mtime:size`, so the size change alone invalidates
        // the entry even when the filesystem's mtime resolution is coarse.
        let mut contents = std::fs::read_to_string(&growing).unwrap();
        contents.push_str(&format!("{}\n", serde_json::json!({ "type": "message", "message": { "role": "user", "content": "next turn" } })));
        std::fs::write(&growing, contents).unwrap();

        let second = index.list(SessionScope::Global, None).unwrap();
        assert_eq!(second.iter().find(|info| info.id == "growing").map(|info| info.message_count), Some(1));
        let quiet_second = second.iter().find(|info| info.id == "quiet");
        assert!(quiet_second.is_some());
    }
}
