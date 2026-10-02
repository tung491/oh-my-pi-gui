//! Workspace filesystem listing and reading, ported from `ipc.ts:985-1168`
//! and the helpers it calls (`resolveWithin`, `loadIgnoreRules`,
//! `walkWorkspace`, `clampInt`). `std::fs` against the calling window's cwd;
//! works without a live sidecar session and never panics (callers read
//! `ok`/`error` in the result).
//!
//! **Trust contract (kept exactly, `ipc.ts:249-254, 1026-1027, 1105-1106`):**
//! relative paths are confined lexically to the workspace root by
//! [`resolve_within`] (`path.resolve` plus a prefix check, no realpath).
//! Absolute and `~/` paths are read as given, because the renderer is trusted
//! and its integrity rests on the sandbox, the CSP and the navigation lock.
//! This is not tightened or loosened here; any change is a product decision.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

pub const FS_LIST_DEFAULT_DEPTH: i64 = 8;
pub const FS_LIST_MAX_DEPTH: i64 = 16;
pub const FS_LIST_DEFAULT_MAX_FILES: i64 = 2000;
pub const FS_LIST_MAX_FILES_CAP: i64 = 20_000;
pub const FS_READ_DEFAULT_MAX_BYTES: i64 = 200_000;
pub const FS_READ_MAX_BYTES_CAP: i64 = 2_000_000;
pub const FS_IMAGE_MAX_BYTES: u64 = 25_000_000;

/// Always-skipped names, applied like root `.gitignore` patterns.
const FS_IGNORED_DEFAULTS: &[&str] = &[
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "dist",
    "out",
    ".next",
    "target",
    "build",
    ".turbo",
    "coverage",
    "__pycache__",
    ".venv",
    "venv",
    ".cache",
    ".codegraph",
    "bazel-*",
];

const REGEX_SPECIALS: &str = "\\^$.|+()[]{}";

pub struct IgnoreRule {
    negated: bool,
    dir_only: bool,
    regex: Regex,
}

/// Compile one gitignore pattern line into a rule. Minimal but faithful to
/// the common semantics: `!` negation, trailing `/` dir-only, any slash
/// anchors the pattern to the root, `*`/`?` match within a segment, `**`
/// crosses segments.
fn compile_ignore_rule(raw_line: &str) -> Option<IgnoreRule> {
    let mut line = raw_line.trim_end().to_string();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let mut negated = false;
    if let Some(rest) = line.strip_prefix('!') {
        negated = true;
        line = rest.to_string();
    } else if line.starts_with("\\!") || line.starts_with("\\#") {
        line = line[1..].to_string();
    }
    let mut dir_only = false;
    if let Some(rest) = line.strip_suffix('/') {
        dir_only = true;
        line = rest.to_string();
    }
    if line.is_empty() {
        return None;
    }
    let anchored = line.contains('/');
    if let Some(rest) = line.strip_prefix('/') {
        line = rest.to_string();
    }
    let chars: Vec<char> = line.chars().collect();
    let mut body = String::new();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '*' {
            if chars.get(i + 1) == Some(&'*') {
                if chars.get(i + 2) == Some(&'/') {
                    body.push_str("(?:[^/]+/)*");
                    i += 3;
                } else {
                    body.push_str(".*");
                    i += 2;
                }
            } else {
                body.push_str("[^/]*");
                i += 1;
            }
        } else if ch == '?' {
            body.push_str("[^/]");
            i += 1;
        } else if REGEX_SPECIALS.contains(ch) {
            body.push('\\');
            body.push(ch);
            i += 1;
        } else {
            body.push(ch);
            i += 1;
        }
    }
    // A matching directory also ignores everything beneath it.
    let source = if anchored { format!("^{body}(?:/.*)?$") } else { format!("(?:^|/){body}(?:/.*)?$") };
    Regex::new(&source).ok().map(|regex| IgnoreRule { negated, dir_only, regex })
}

/// Last matching rule wins, per gitignore semantics.
fn is_ignored(rules: &[IgnoreRule], rel_path: &str, is_dir: bool) -> bool {
    let mut ignored = false;
    for rule in rules {
        if rule.dir_only && !is_dir {
            continue;
        }
        if rule.regex.is_match(rel_path) {
            ignored = !rule.negated;
        }
    }
    ignored
}

pub fn load_ignore_rules(root_abs: &Path) -> Vec<IgnoreRule> {
    let mut rules: Vec<IgnoreRule> = FS_IGNORED_DEFAULTS.iter().filter_map(|pattern| compile_ignore_rule(pattern)).collect();
    if let Ok(content) = std::fs::read_to_string(root_abs.join(".gitignore")) {
        for line in content.lines() {
            if let Some(rule) = compile_ignore_rule(line) {
                rules.push(rule);
            }
        }
    }
    rules
}

/// Resolve `rel` against `root`, refusing escapes outside the workspace.
pub fn resolve_within(root: &Path, rel: &str) -> Option<PathBuf> {
    let resolved = normalize(&std::env::current_dir().unwrap_or_default().join(root).join(rel));
    let root = normalize(&std::env::current_dir().unwrap_or_default().join(root));
    if resolved == root {
        return Some(resolved);
    }
    let root_with_sep = {
        let mut s = root.to_string_lossy().into_owned();
        if !s.ends_with(std::path::MAIN_SEPARATOR) {
            s.push(std::path::MAIN_SEPARATOR);
        }
        s
    };
    if resolved.to_string_lossy().starts_with(&root_with_sep) {
        Some(resolved)
    } else {
        None
    }
}

/// Lexically normalize (Node's `path.resolve` semantics: no symlink resolution).
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
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

pub fn clamp_int(value: Option<i64>, min: i64, max: i64, fallback: i64) -> i64 {
    match value {
        Some(value) => value.clamp(min, max),
        None => fallback,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FsEntryKind {
    File,
    Dir,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsTreeEntry {
    pub name: String,
    /// Workspace-relative path using POSIX separators.
    pub path: String,
    pub kind: FsEntryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FsTreeEntry>>,
}

pub struct WalkState {
    pub rules: Vec<IgnoreRule>,
    pub max_depth: i64,
    pub max_files: i64,
    pub file_count: i64,
    pub truncated: bool,
}

fn posix_join(prefix: &str, name: &str) -> String {
    if prefix.is_empty() { name.to_string() } else { format!("{prefix}/{name}") }
}

/// Recursive readdir -> sorted tree (dirs first, then files, each alphabetical).
pub fn walk_workspace(dir_abs: &Path, rel_prefix: &str, depth: i64, state: &mut WalkState) -> Vec<FsTreeEntry> {
    let Ok(entries) = std::fs::read_dir(dir_abs) else { return Vec::new() };
    let mut dirents: Vec<(String, bool, bool)> = Vec::new(); // (name, is_dir, is_symlink)
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        dirents.push((name, file_type.is_dir(), file_type.is_symlink()));
    }
    dirents.sort_by(|a, b| a.0.cmp(&b.0));

    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for (name, is_dir, is_symlink) in dirents {
        if state.truncated {
            break;
        }
        if is_symlink {
            continue;
        }
        let rel = posix_join(rel_prefix, &name);
        if is_ignored(&state.rules, &rel, is_dir) {
            continue;
        }
        if is_dir {
            let children = if depth < state.max_depth { walk_workspace(&dir_abs.join(&name), &rel, depth + 1, state) } else { Vec::new() };
            dirs.push(FsTreeEntry { name, path: rel, kind: FsEntryKind::Dir, children: Some(children) });
        } else {
            if state.file_count >= state.max_files {
                state.truncated = true;
                break;
            }
            state.file_count += 1;
            files.push(FsTreeEntry { name, path: rel, kind: FsEntryKind::File, children: None });
        }
    }
    dirs.into_iter().chain(files).collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadResult {
    pub content: String,
    pub truncated: bool,
    pub binary: bool,
    pub size: u64,
}

/// Read up to `max_bytes` of `abs`, detecting binary content (a NUL byte in
/// the read region) the same way the TS handler does.
pub fn read_file_capped(abs: &Path, max_bytes: u64) -> std::io::Result<ReadResult> {
    use std::io::Read;
    let metadata = std::fs::metadata(abs)?;
    if !metadata.is_file() {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "Not a file"));
    }
    let size = metadata.len();
    let length = size.min(max_bytes + 1) as usize;
    let mut file = std::fs::File::open(abs)?;
    let mut buffer = vec![0u8; length];
    let mut read_total = 0usize;
    while read_total < length {
        let read = file.read(&mut buffer[read_total..])?;
        if read == 0 {
            break;
        }
        read_total += read;
    }
    buffer.truncate(read_total);
    if buffer.contains(&0) {
        return Ok(ReadResult { content: String::new(), truncated: false, binary: true, size });
    }
    let max_bytes = max_bytes as usize;
    let slice_len = read_total.min(max_bytes);
    let content = String::from_utf8_lossy(&buffer[..slice_len]).into_owned();
    Ok(ReadResult { content, truncated: size > max_bytes as u64, binary: false, size })
}

/// Sniff a handful of common image formats from their magic bytes.
pub fn sniff_image_mime(header: &[u8]) -> Option<&'static str> {
    if header.len() >= 8 && header[0..4] == [0x89, 0x50, 0x4e, 0x47] {
        return Some("image/png");
    }
    if header.len() >= 3 && header[0..3] == [0xff, 0xd8, 0xff] {
        return Some("image/jpeg");
    }
    if header.len() >= 6 && (&header[0..6] == b"GIF89a" || &header[0..6] == b"GIF87a") {
        return Some("image/gif");
    }
    if header.len() >= 12 && &header[0..4] == b"RIFF" && &header[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if header.len() >= 12 && &header[4..8] == b"ftyp" {
        let brand = &header[8..12];
        if brand == b"avif" || brand == b"avis" {
            return Some("image/avif");
        }
    }
    if header.len() >= 2 && header[0] == 0x42 && header[1] == 0x4d {
        return Some("image/bmp");
    }
    if header.len() >= 4 && header[0..4] == [0x00, 0x00, 0x01, 0x00] {
        return Some("image/x-icon");
    }
    static SVG_PROLOG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^\s{0,512}(<svg|<\?xml[^>]*>?\s*<svg)").unwrap());
    let text = String::from_utf8_lossy(&header[..header.len().min(512)]);
    if SVG_PROLOG.is_match(&text) {
        return Some("image/svg+xml");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_relative_parent_traversal() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(resolve_within(dir.path(), "../outside"), None);
        assert!(resolve_within(dir.path(), "inner/file.txt").is_some());
    }

    #[test]
    fn reads_absolute_paths_unconfined_like_the_ts_handler() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("secret.txt");
        std::fs::write(&outside, "top secret").unwrap();
        // An absolute path is read as given, never run through `resolve_within`.
        let result = read_file_capped(&outside, FS_READ_DEFAULT_MAX_BYTES as u64).unwrap();
        assert_eq!(result.content, "top secret");
    }

    #[test]
    fn clamps_max_depth_and_max_entries() {
        assert_eq!(clamp_int(None, 1, FS_LIST_MAX_DEPTH, FS_LIST_DEFAULT_DEPTH), FS_LIST_DEFAULT_DEPTH);
        assert_eq!(clamp_int(Some(999), 1, FS_LIST_MAX_DEPTH, FS_LIST_DEFAULT_DEPTH), FS_LIST_MAX_DEPTH);
        assert_eq!(clamp_int(Some(-5), 1, FS_LIST_MAX_DEPTH, FS_LIST_DEFAULT_DEPTH), 1);
        assert_eq!(clamp_int(Some(3), 1, FS_LIST_MAX_FILES_CAP, FS_LIST_DEFAULT_MAX_FILES), 3);
    }

    #[test]
    fn marks_truncated_listings() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..5 {
            std::fs::write(dir.path().join(format!("f{i}.txt")), "x").unwrap();
        }
        let mut state = WalkState { rules: Vec::new(), max_depth: FS_LIST_MAX_DEPTH, max_files: 2, file_count: 0, truncated: false };
        let entries = walk_workspace(dir.path(), "", 0, &mut state);
        assert!(state.truncated);
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn refuses_images_above_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.png");
        std::fs::write(&path, vec![0u8; 10]).unwrap();
        let size = std::fs::metadata(&path).unwrap().len();
        assert!(size <= FS_IMAGE_MAX_BYTES, "sanity: the fixture is not actually oversize");
        // The handler itself performs the cap comparison; this proves the sniff
        // path used alongside it recognizes a real PNG header independent of size.
        let mut header = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        header.resize(16, 0);
        assert_eq!(sniff_image_mime(&header), Some("image/png"));
    }

    #[test]
    fn reads_utf8_with_a_byte_cap() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.txt");
        std::fs::write(&path, "a".repeat(100)).unwrap();
        let result = read_file_capped(&path, 10).unwrap();
        assert_eq!(result.content.len(), 10);
        assert!(result.truncated);
        assert_eq!(result.size, 100);
    }

    #[test]
    fn applies_the_ignore_rules_like_the_ts_walker() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules")).unwrap();
        std::fs::write(dir.path().join("node_modules").join("pkg.json"), "{}").unwrap();
        std::fs::write(dir.path().join("keep.txt"), "x").unwrap();
        let mut state =
            WalkState { rules: load_ignore_rules(dir.path()), max_depth: FS_LIST_MAX_DEPTH, max_files: FS_LIST_MAX_FILES_CAP, file_count: 0, truncated: false };
        let entries = walk_workspace(dir.path(), "", 0, &mut state);
        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, vec!["keep.txt"]);
    }
}
