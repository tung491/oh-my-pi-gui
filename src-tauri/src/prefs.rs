//! `JsonStore`: the electron-store replacement for `prefs.json` and
//! `window-state.json`. Dotted keys nest (`welcome.completed` lives at
//! `{ welcome: { completed } }`), every read and write goes through one mutex
//! that also serializes the file write, and writes land through a unique temp
//! file plus `rename`, so a crash never leaves a half-written store.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};

/// The renderer localStorage keys mirrored under `rendererStorage.*`.
/// Must stay identical to `RENDERER_STORAGE_KEYS` in `src/shared/renderer-storage.ts`.
pub const RENDERER_STORAGE_KEYS: [&str; 5] = [
    "omp.lang",
    "omp.themeScheme",
    "omp.update.dismissed",
    "omp.dock.focusHeight",
    "omp.palette.recent",
];

/// The prefs key a renderer storage key mirrors to.
pub fn renderer_storage_pref_key(key: &str) -> String {
    format!("rendererStorage.{key}")
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("could not write {path}: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("could not serialize the store: {0}")]
    Serialize(#[from] serde_json::Error),
    #[error("the store lock was poisoned")]
    Poisoned,
    #[error("{path} could not be read ({source}); refusing to overwrite it")]
    Unreadable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

struct Inner {
    path: PathBuf,
    root: Value,
    /// Set when the file exists but could not be read (EACCES, EIO, a directory
    /// in its place): the store answers reads from an empty document and refuses
    /// every write, so the user's settings are never replaced with `{}`.
    unreadable: Option<std::io::Error>,
}

/// A JSON document on disk with dotted-path access. Cheap to clone; clones share the document.
#[derive(Clone)]
pub struct JsonStore {
    inner: Arc<Mutex<Inner>>,
    counter: Arc<AtomicU64>,
}

impl std::fmt::Debug for JsonStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JsonStore").field("path", &self.path()).finish()
    }
}

/// Split a dotted path on unescaped dots (`a\.b` keeps the dot), as dot-prop does.
pub fn split_dot_path(path: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut chars = path.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' if chars.peek() == Some(&'.') => {
                current.push('.');
                chars.next();
            }
            '.' => {
                parts.push(std::mem::take(&mut current));
            }
            other => current.push(other),
        }
    }
    parts.push(current);
    parts
}

fn get_path<'a>(root: &'a Value, segments: &[String]) -> Option<&'a Value> {
    let mut cursor = root;
    for segment in segments {
        cursor = match cursor {
            Value::Object(map) => map.get(segment)?,
            Value::Array(items) => items.get(segment.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(cursor)
}

fn set_path(root: &mut Value, segments: &[String], value: Value) {
    let Some((last, parents)) = segments.split_last() else {
        *root = value;
        return;
    };
    let mut cursor = root;
    for segment in parents {
        if !cursor.is_object() {
            *cursor = Value::Object(Map::new());
        }
        let map = cursor.as_object_mut().unwrap_or_else(|| unreachable!("just made an object"));
        cursor = map.entry(segment.clone()).or_insert_with(|| Value::Object(Map::new()));
    }
    if !cursor.is_object() {
        *cursor = Value::Object(Map::new());
    }
    if let Some(map) = cursor.as_object_mut() {
        map.insert(last.clone(), value);
    }
}

fn delete_path(root: &mut Value, segments: &[String]) -> bool {
    let Some((last, parents)) = segments.split_last() else {
        *root = Value::Object(Map::new());
        return true;
    };
    let mut cursor = root;
    for segment in parents {
        cursor = match cursor {
            Value::Object(map) => match map.get_mut(segment) {
                Some(next) => next,
                None => return false,
            },
            _ => return false,
        };
    }
    match cursor {
        Value::Object(map) => map.remove(last).is_some(),
        _ => false,
    }
}

impl JsonStore {
    /// Open (or lazily create) the store at `path`. Only a missing file reads as
    /// an empty object. A file that does not parse is moved aside to
    /// `<name>.corrupt` so the next write does not silently overwrite what the
    /// user had; a file that cannot be read at all makes the store read-only.
    pub fn open(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let (root, unreadable) = match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(value) if value.is_object() => (value, None),
                Ok(_) | Err(_) => {
                    let mut aside = path.clone().into_os_string();
                    aside.push(".corrupt");
                    // Best effort: if even the rename fails there is nothing more to do here.
                    let _ = std::fs::rename(&path, PathBuf::from(aside));
                    (Value::Object(Map::new()), None)
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (Value::Object(Map::new()), None),
            Err(error) => {
                crate::runtime_log::note(
                    "unknown",
                    format!("could not read {}: {error}; the store is read-only until the file can be read", path.display()),
                    serde_json::json!({ "path": path.display().to_string() }),
                );
                (Value::Object(Map::new()), Some(error))
            }
        };
        Self {
            inner: Arc::new(Mutex::new(Inner { path, root, unreadable })),
            counter: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn path(&self) -> PathBuf {
        self.inner.lock().map(|inner| inner.path.clone()).unwrap_or_default()
    }

    /// The whole document.
    pub fn all(&self) -> Value {
        self.inner.lock().map(|inner| inner.root.clone()).unwrap_or(Value::Null)
    }

    /// The value at `dot_path`, or `None` when absent.
    pub fn get(&self, dot_path: &str) -> Option<Value> {
        let inner = self.inner.lock().ok()?;
        get_path(&inner.root, &split_dot_path(dot_path)).cloned()
    }

    /// The string at `dot_path`, if it is one.
    pub fn get_string(&self, dot_path: &str) -> Option<String> {
        self.get(dot_path).and_then(|value| value.as_str().map(str::to_string))
    }

    pub fn set(&self, dot_path: &str, value: Value) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().map_err(|_| StoreError::Poisoned)?;
        set_path(&mut inner.root, &split_dot_path(dot_path), value);
        self.persist(&inner)
    }

    pub fn delete(&self, dot_path: &str) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().map_err(|_| StoreError::Poisoned)?;
        if delete_path(&mut inner.root, &split_dot_path(dot_path)) {
            self.persist(&inner)?;
        }
        Ok(())
    }

    /// Read-modify-write under the lock: `update` sees the current value and
    /// returns the new one, or `None` to delete the key.
    pub fn update(&self, dot_path: &str, update: impl FnOnce(Option<Value>) -> Option<Value>) -> Result<(), StoreError> {
        let mut inner = self.inner.lock().map_err(|_| StoreError::Poisoned)?;
        let segments = split_dot_path(dot_path);
        let current = get_path(&inner.root, &segments).cloned();
        match update(current) {
            Some(next) => set_path(&mut inner.root, &segments, next),
            None => {
                if !delete_path(&mut inner.root, &segments) {
                    return Ok(());
                }
            }
        }
        self.persist(&inner)
    }

    fn persist(&self, inner: &Inner) -> Result<(), StoreError> {
        let path = &inner.path;
        if let Some(error) = &inner.unreadable {
            return Err(StoreError::Unreadable { path: path.clone(), source: std::io::Error::new(error.kind(), error.to_string()) });
        }
        let write_error = |source: std::io::Error| StoreError::Write { path: path.clone(), source };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(write_error)?;
        }
        // electron-store wrote `JSON.stringify(value, null, "\t")`; keep the file diff-friendly.
        let mut bytes = Vec::new();
        let formatter = serde_json::ser::PrettyFormatter::with_indent(b"\t");
        let mut serializer = serde_json::Serializer::with_formatter(&mut bytes, formatter);
        serde::Serialize::serialize(&inner.root, &mut serializer)?;
        let counter = self.counter.fetch_add(1, Ordering::Relaxed);
        let file_name = path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
        let temp = path.with_file_name(format!("{file_name}.{}.{counter}.tmp", std::process::id()));
        std::fs::write(&temp, &bytes).map_err(write_error)?;
        if let Err(source) = std::fs::rename(&temp, path) {
            let _ = std::fs::remove_file(&temp);
            return Err(write_error(source));
        }
        Ok(())
    }
}

/// Convenience for callers that only need `exists()`-style checks on the file.
pub fn store_file_exists(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const RENDERER_STORAGE_TS: &str = include_str!("../../src/shared/renderer-storage.ts");

    fn store_in(dir: &tempfile::TempDir) -> JsonStore {
        JsonStore::open(dir.path().join("prefs.json"))
    }

    #[test]
    fn an_unreadable_store_refuses_to_overwrite_the_file() {
        let dir = tempfile::tempdir().unwrap();
        // A directory where the file should be reads with an error that is not NotFound.
        let path = dir.path().join("prefs.json");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("keep"), b"user data").unwrap();
        let store = JsonStore::open(&path);
        assert_eq!(store.get("welcome.completed"), None);
        let refused = store.set("welcome.completed", json!(true)).unwrap_err();
        assert!(matches!(refused, StoreError::Unreadable { .. }), "{refused}");
        assert!(store.update("x", |_| Some(json!(1))).is_err());
        assert!(std::fs::read(path.join("keep")).is_ok(), "nothing was replaced");
        assert!(!dir.path().join("prefs.json.corrupt").exists(), "an unreadable file is not treated as corrupt");
    }

    #[test]
    fn nests_dotted_keys() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        store.set("welcome.completed", json!("2026-01-01")).unwrap();
        store.set("sidebar.workspaceLastUsed", json!({ "/a": 1 })).unwrap();
        assert_eq!(store.all(), json!({ "welcome": { "completed": "2026-01-01" }, "sidebar": { "workspaceLastUsed": { "/a": 1 } } }));
        assert_eq!(store.get("welcome.completed"), Some(json!("2026-01-01")));
        assert_eq!(store.get("welcome"), Some(json!({ "completed": "2026-01-01" })));
        assert_eq!(store.get("welcome.missing"), None);
        let on_disk: Value = serde_json::from_slice(&std::fs::read(store.path()).unwrap()).unwrap();
        assert_eq!(on_disk, store.all());
        store.delete("welcome.completed").unwrap();
        assert_eq!(store.get("welcome"), Some(json!({})));
    }

    #[test]
    fn reads_electron_store_files_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prefs.json");
        let text = "{\n\t\"language\": \"vi\",\n\t\"tabLayouts\": [\n\t\t{\n\t\t\t\"tabs\": [\n\t\t\t\t{\n\t\t\t\t\t\"cwd\": \"/home/me/work\"\n\t\t\t\t}\n\t\t\t]\n\t\t}\n\t]\n}";
        std::fs::write(&path, text).unwrap();
        let store = JsonStore::open(&path);
        assert_eq!(store.get("language"), Some(json!("vi")));
        assert_eq!(store.get("tabLayouts.0.tabs.0.cwd"), Some(json!("/home/me/work")));
        assert_eq!(store.get("missing"), None);
        // Reads never touch the file.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
    }

    #[test]
    fn update_is_atomic_under_concurrent_callers() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        store.set("counter", json!(0)).unwrap();
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let store = store.clone();
                std::thread::spawn(move || {
                    for _ in 0..25 {
                        store
                            .update("counter", |current| Some(json!(current.and_then(|v| v.as_i64()).unwrap_or(0) + 1)))
                            .unwrap();
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(store.get("counter"), Some(json!(200)));
        let on_disk: Value = serde_json::from_slice(&std::fs::read(store.path()).unwrap()).unwrap();
        assert_eq!(on_disk["counter"], json!(200));
    }

    #[test]
    fn unique_temp_names_leave_no_residue() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        for i in 0..20 {
            store.set("n", json!(i)).unwrap();
        }
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["prefs.json".to_string()]);
    }

    #[test]
    fn missing_file_reads_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        assert_eq!(store.all(), json!({}));
        assert_eq!(store.get("anything"), None);
        assert!(!store.path().exists());
    }

    #[test]
    fn renderer_storage_reads_the_five_nested_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prefs.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({
                "rendererStorage": {
                    "omp": {
                        "lang": "vi",
                        "themeScheme": "dark",
                        "update": { "dismissed": "0.9.14" },
                        "dock": { "focusHeight": "320" },
                        "palette": { "recent": "[\"a\"]" }
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let store = JsonStore::open(&path);
        let values: Vec<Option<String>> =
            RENDERER_STORAGE_KEYS.iter().map(|key| store.get_string(&renderer_storage_pref_key(key))).collect();
        assert_eq!(
            values,
            vec![Some("vi".into()), Some("dark".into()), Some("0.9.14".into()), Some("320".into()), Some("[\"a\"]".into())]
        );
    }

    #[test]
    fn renderer_storage_keys_mirror_the_shared_list() {
        let pattern = regex::Regex::new(r#"^\s*"(omp\.[A-Za-z.]+)",\s*$"#).unwrap();
        let ts_keys: Vec<String> = RENDERER_STORAGE_TS
            .lines()
            .filter_map(|line| pattern.captures(line).map(|c| c[1].to_string()))
            .collect();
        assert_eq!(ts_keys, RENDERER_STORAGE_KEYS.iter().map(|k| k.to_string()).collect::<Vec<_>>());
    }

    #[test]
    fn a_corrupt_file_is_moved_aside_instead_of_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prefs.json");
        std::fs::write(&path, b"{not json").unwrap();
        let store = JsonStore::open(&path);
        assert_eq!(store.all(), json!({}));
        assert_eq!(std::fs::read(dir.path().join("prefs.json.corrupt")).unwrap(), b"{not json");
    }

    #[test]
    fn escaped_dots_stay_in_one_segment() {
        assert_eq!(split_dot_path("a\\.b.c"), vec!["a.b".to_string(), "c".to_string()]);
        assert_eq!(split_dot_path("plain"), vec!["plain".to_string()]);
    }
}
