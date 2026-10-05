//! One-time import of the five mirrored renderer localStorage keys from an
//! Electron build's Chromium LevelDB, for an install that never ran the
//! Phase 1 write-through mirror release (user decision, 2026-10-02).
//!
//! Per the wave rule that a module never resolves the profile directory
//! itself (`paths::user_data_dir()` panics in a test build when it would
//! resolve the default profile), the profile directory is a parameter here;
//! `Services::import_legacy_renderer_storage` passes `paths::user_data_dir()`
//! in production.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rusty_leveldb::{LdbIterator, Options, DB};

use crate::prefs::{renderer_storage_pref_key, JsonStore, RENDERER_STORAGE_KEYS};

/// A unique scratch directory under the OS temp dir, removed on drop.
/// `tempfile` is a dev-only dependency, so this path (used in production,
/// outside `#[cfg(test)]`) rolls its own instead of pulling that crate in.
struct TempCopy(PathBuf);

impl TempCopy {
    fn new() -> std::io::Result<Self> {
        use std::hash::{BuildHasher, Hasher};
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
        let random = std::collections::hash_map::RandomState::new().build_hasher().finish();
        let path = std::env::temp_dir().join(format!("sai-atlas-legacy-storage-{}-{now}-{random:x}", std::process::id()));
        std::fs::create_dir_all(&path)?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempCopy {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Chromium's DOM Storage LevelDB backend prefixes every key of the app's
/// `file://` origin with this byte sequence (a meta-prefix byte, the origin
/// string, then the namespace separator `\x00\x01`).
const KEY_PREFIX: &[u8] = b"_file://\x00\x01";

/// Chromium's value encoding: a one-byte format tag, then the payload.
/// `0x01` is Latin-1 (each byte is already its Unicode code point), `0x00` is UTF-16LE.
// `slice::as_chunks` (clippy's suggested replacement) is nightly-only; this
// crate targets stable.
#[allow(clippy::chunks_exact_to_as_chunks)]
fn decode_value(raw: &[u8]) -> Option<String> {
    let (format_byte, payload) = raw.split_first()?;
    match *format_byte {
        0x01 => Some(payload.iter().map(|&byte| byte as char).collect()),
        0x00 => {
            if payload.len() % 2 != 0 {
                return None;
            }
            let units: Vec<u16> = payload.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
            String::from_utf16(&units).ok()
        }
        _ => None,
    }
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &dest)?;
        } else {
            std::fs::copy(entry.path(), &dest)?;
        }
    }
    Ok(())
}

/// Copy `leveldb_dir` to a temp directory first (a running Electron build may
/// hold its `LOCK`), open the copy read-only, and read only the five
/// `RENDERER_STORAGE_KEYS`. The temp copy is removed when this returns
/// (`TempDir`'s `Drop`). Any failure (missing, locked, corrupt, an unreadable
/// manifest) is one `Err`; the caller logs it and imports nothing.
fn read_renderer_storage(leveldb_dir: &Path) -> Result<BTreeMap<String, String>, String> {
    let temp = TempCopy::new().map_err(|error| error.to_string())?;
    let copy_path = temp.path().join("leveldb");
    copy_dir(leveldb_dir, &copy_path).map_err(|error| error.to_string())?;
    // The copy either holds a real database or it does not; never invent one.
    let options = Options { create_if_missing: false, ..Options::default() };
    let mut db = DB::open(&copy_path, options).map_err(|error| error.to_string())?;
    let mut iter = db.new_iter().map_err(|error| error.to_string())?;
    let mut found = BTreeMap::new();
    while let Some((key, value)) = iter.next() {
        let Some(suffix) = key.strip_prefix(KEY_PREFIX) else { continue };
        let Ok(name) = std::str::from_utf8(suffix) else { continue };
        if !RENDERER_STORAGE_KEYS.contains(&name) {
            continue;
        }
        if let Some(text) = decode_value(&value) {
            found.insert(name.to_string(), text);
        }
    }
    Ok(found)
}

/// Run the one-time import for `profile_dir` into `prefs`, unless `prefs`
/// already has a `rendererStorage` subtree. Never blocks startup: any error
/// logs one runtime entry and imports nothing.
pub fn import(prefs: &JsonStore, profile_dir: &Path) {
    if prefs.get("rendererStorage").is_some() {
        return;
    }
    let leveldb_dir = profile_dir.join("Local Storage").join("leveldb");
    if !leveldb_dir.is_dir() {
        return;
    }
    match read_renderer_storage(&leveldb_dir) {
        Ok(values) => {
            let mut imported = Vec::new();
            for key in RENDERER_STORAGE_KEYS {
                let Some(value) = values.get(key) else { continue };
                match prefs.set(&renderer_storage_pref_key(key), serde_json::Value::String(value.clone())) {
                    Ok(()) => imported.push(key),
                    Err(error) => crate::runtime_log::note("unknown", format!("could not write imported {key}: {error}"), serde_json::json!({})),
                }
            }
            // Key names only, never values: a support report must tell an import from a skip.
            crate::runtime_log::note(
                "unknown",
                format!("imported {} legacy renderer storage keys", imported.len()),
                serde_json::json!({ "keys": imported.join(","), "path": leveldb_dir.display().to_string() }),
            );
        }
        Err(error) => {
            crate::runtime_log::note(
                "unknown",
                format!("legacy renderer storage import failed: {error}"),
                serde_json::json!({ "path": leveldb_dir.display().to_string() }),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chromium_key(suffix: &str) -> Vec<u8> {
        let mut key = KEY_PREFIX.to_vec();
        key.extend_from_slice(suffix.as_bytes());
        key
    }

    fn latin1_value(text: &str) -> Vec<u8> {
        let mut out = vec![0x01];
        out.extend(text.chars().map(|ch| ch as u8));
        out
    }

    fn utf16_value(text: &str) -> Vec<u8> {
        let mut out = vec![0x00];
        for unit in text.encode_utf16() {
            out.extend_from_slice(&unit.to_le_bytes());
        }
        out
    }

    /// A profile directory with a real LevelDB fixture at `Local Storage/leveldb`.
    fn profile_with_leveldb(entries: &[(Vec<u8>, Vec<u8>)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let leveldb_path = dir.path().join("Local Storage").join("leveldb");
        std::fs::create_dir_all(leveldb_path.parent().unwrap()).unwrap();
        let options = Options { create_if_missing: true, ..Options::default() };
        let mut db = DB::open(&leveldb_path, options).unwrap();
        for (key, value) in entries {
            db.put(key, value).unwrap();
        }
        drop(db);
        dir
    }

    #[test]
    fn imports_latin1_and_utf16_values() {
        let profile = profile_with_leveldb(&[
            (chromium_key("omp.lang"), latin1_value("vi")),
            (chromium_key("omp.themeScheme"), utf16_value("dark")),
        ]);
        let prefs = JsonStore::open(profile.path().join("prefs.json"));
        import(&prefs, profile.path());
        assert_eq!(prefs.get_string(&renderer_storage_pref_key("omp.lang")), Some("vi".to_string()));
        assert_eq!(prefs.get_string(&renderer_storage_pref_key("omp.themeScheme")), Some("dark".to_string()));
        let log = std::fs::read_to_string(crate::runtime_log::path()).unwrap_or_default();
        let leveldb = profile.path().join("Local Storage").join("leveldb").display().to_string();
        let line = log.lines().find(|line| line.contains("imported 2 legacy renderer storage keys") && line.contains(&leveldb)).expect("the import is in the runtime log");
        assert!(line.contains("omp.lang") && line.contains("omp.themeScheme"));
        assert!(!line.contains("\"vi\"") && !line.contains("\"dark\""), "values never reach the log: {line}");
    }

    #[test]
    fn ignores_other_origins_and_keys() {
        let mut other_origin_key = b"_https://example.com\x00\x01".to_vec();
        other_origin_key.extend_from_slice(b"omp.lang");
        let profile = profile_with_leveldb(&[
            (other_origin_key, latin1_value("vi")),
            (chromium_key("not.a.tracked.key"), latin1_value("x")),
        ]);
        let prefs = JsonStore::open(profile.path().join("prefs.json"));
        import(&prefs, profile.path());
        assert_eq!(prefs.get("rendererStorage"), None);
    }

    #[test]
    fn skips_when_prefs_already_has_renderer_storage() {
        let profile = profile_with_leveldb(&[(chromium_key("omp.lang"), latin1_value("vi"))]);
        let prefs = JsonStore::open(profile.path().join("prefs.json"));
        prefs.set(&renderer_storage_pref_key("omp.lang"), serde_json::json!("en")).unwrap();
        import(&prefs, profile.path());
        // The existing value is untouched: the import never ran at all.
        assert_eq!(prefs.get_string(&renderer_storage_pref_key("omp.lang")), Some("en".to_string()));
    }

    #[test]
    fn a_corrupt_store_imports_nothing_and_does_not_fail_startup() {
        let dir = tempfile::tempdir().unwrap();
        let leveldb_path = dir.path().join("Local Storage").join("leveldb");
        std::fs::create_dir_all(&leveldb_path).unwrap();
        std::fs::write(leveldb_path.join("CURRENT"), b"not a real manifest pointer\n").unwrap();
        let prefs = JsonStore::open(dir.path().join("prefs.json"));
        import(&prefs, dir.path());
        assert_eq!(prefs.get("rendererStorage"), None);
    }
}

