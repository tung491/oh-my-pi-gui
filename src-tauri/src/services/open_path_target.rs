//! Whether opening a path would run a program, decided by its name against one deny list; such a path is revealed in the file manager instead.

use std::collections::HashSet;
use std::sync::LazyLock;

/// Extensions the OS default handler runs or launches instead of opening for
/// editing: scripts, Terminal/URL/location launchers,
/// Java Web Start, Python launchers, and binary programs and installers.
static PROGRAM_EXTENSIONS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    HashSet::from([
        ".appimage",
        ".bat",
        ".cmd",
        ".command",
        ".desktop",
        ".exe",
        ".fileloc",
        ".inetloc",
        ".jar",
        ".jnlp",
        ".mpkg",
        ".pkg",
        ".ps1",
        ".py",
        ".sh",
        ".terminal",
        ".tool",
        ".vbe",
        ".vbs",
        ".webloc",
        ".wsf",
        ".wsh",
    ])
});

/// The lowercased extension of the last path segment, never of a folder above it.
fn extension_of(path: &str) -> String {
    let name = path.rsplit(['\\', '/']).next().unwrap_or("").to_lowercase();
    match name.rfind('.') {
        Some(index) => name[index..].to_string(),
        None => String::new(),
    }
}

/// Whether opening this path with the OS default handler would run it, judged by its name.
fn opens_as_program(path: &str) -> bool {
    PROGRAM_EXTENSIONS.contains(extension_of(path).as_str())
}

/// The filesystem calls the decision needs; injected so tests can model symlinks.
pub trait OpenPathFs {
    fn realpath(&self, path: &str) -> Option<String>;
    fn exists(&self, path: &str) -> bool;
}

/// `std::fs`-backed filesystem for production use.
pub struct OsFs;

impl OpenPathFs for OsFs {
    fn realpath(&self, path: &str) -> Option<String> {
        std::fs::canonicalize(path).ok().map(|p| p.to_string_lossy().into_owned())
    }

    fn exists(&self, path: &str) -> bool {
        std::path::Path::new(path).exists()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenAction {
    Open,
    Reveal,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenPathTarget {
    pub action: OpenAction,
    /// The canonical path, which is what gets opened or revealed.
    pub path: String,
}

/// Decides how to hand an existing absolute path to the OS default handler,
/// or returns `None` when it does not exist. Both the requested name and the
/// canonical one are judged: a symlink can hide the launcher's real extension,
/// and a trailing separator or dot segment hides the last name of the requested path.
pub fn open_path_target(requested: &str, fs: &dyn OpenPathFs) -> Option<OpenPathTarget> {
    let canonical = fs.realpath(requested)?;
    if !fs.exists(&canonical) {
        return None;
    }
    let launches = opens_as_program(requested) || opens_as_program(&canonical);
    Some(OpenPathTarget { action: if launches { OpenAction::Reveal } else { OpenAction::Open }, path: canonical })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Clone)]
    struct Entry {
        real: Option<String>,
    }

    /// A fake filesystem: each key is a path as requested; `real` is where it
    /// resolves (symlinks, dot segments).
    struct FakeFs(HashMap<String, Entry>);

    impl FakeFs {
        fn new(entries: Vec<(&str, Entry)>) -> Self {
            Self(entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
        }
    }

    impl OpenPathFs for FakeFs {
        fn realpath(&self, path: &str) -> Option<String> {
            let entry = self.0.get(path)?;
            Some(entry.real.clone().unwrap_or_else(|| path.to_string()))
        }

        fn exists(&self, path: &str) -> bool {
            self.0.values().any(|entry| entry.real.as_deref() == Some(path)) || self.0.contains_key(path)
        }
    }

    fn text() -> Entry {
        Entry { real: None }
    }

    fn with_real(mut entry: Entry, real: &str) -> Entry {
        entry.real = Some(real.to_string());
        entry
    }

    fn decide(path: &str, entries: Vec<(&str, Entry)>) -> Option<OpenPathTarget> {
        open_path_target(path, &FakeFs::new(entries))
    }

    #[test]
    fn opens_an_ordinary_file_at_its_resolved_path() {
        assert_eq!(
            decide("/repo/src/App.tsx", vec![("/repo/src/App.tsx", text())]),
            Some(OpenPathTarget { action: OpenAction::Open, path: "/repo/src/App.tsx".into() })
        );
    }

    #[test]
    fn reports_a_missing_path_instead_of_deciding() {
        assert_eq!(decide("/repo/gone.txt", vec![]), None);
    }

    #[test]
    fn reveals_a_harmless_looking_symlink_whose_target_is_a_launcher() {
        let decision = decide("/repo/NOTES.md", vec![("/repo/NOTES.md", with_real(text(), "/repo/.x/run.terminal"))]);
        assert_eq!(decision.map(|d| d.action), Some(OpenAction::Reveal));
    }

    #[test]
    fn reveals_a_launcher_named_by_the_requested_path_even_when_it_resolves_elsewhere() {
        let decision = decide("/repo/deploy.sh", vec![("/repo/deploy.sh", with_real(text(), "/repo/.x/notes"))]);
        assert_eq!(decision.map(|d| d.action), Some(OpenAction::Reveal));
    }
}
