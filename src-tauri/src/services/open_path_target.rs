//! Decides how to hand an existing path to the OS default handler.

use std::collections::HashSet;
use std::sync::LazyLock;

/// The platform whose default-open behavior decides what counts as a program.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaunchPlatform {
    Mac,
    Linux,
    Windows,
}

/// Maps a Node `process.platform` name; anything not macOS or Windows opens files the Linux way.
pub fn launch_platform_of(node_platform: &str) -> LaunchPlatform {
    match node_platform {
        "darwin" => LaunchPlatform::Mac,
        "win32" => LaunchPlatform::Windows,
        _ => LaunchPlatform::Linux,
    }
}

/// Extensions the OS default handler runs or launches instead of opening for
/// editing, on every platform: scripts, macOS Terminal/URL/location launchers,
/// Java Web Start, Python launchers, and binary programs and installers.
/// macOS application bundles are folders, so `launches_when_opened` checks `.app`.
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

/// Extra extensions the Windows shell runs or launches on open.
static WINDOWS_PROGRAM_EXTENSIONS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    HashSet::from([
        ".appref-ms",
        ".application",
        ".chm",
        ".com",
        ".cpl",
        ".hta",
        ".inf",
        ".js",
        ".jse",
        ".library-ms",
        ".lnk",
        ".msc",
        ".msi",
        ".msp",
        ".pif",
        ".pyc",
        ".pyo",
        ".pyw",
        ".pyz",
        ".pyzw",
        ".rdp",
        ".reg",
        ".scf",
        ".scr",
        ".sct",
        ".searchconnector-ms",
        ".url",
        ".website",
        ".wsc",
    ])
});

/// The lowercased extension of the last path segment, never of a folder above it.
fn extension_of(path: &str, platform: LaunchPlatform) -> String {
    let mut name = path.rsplit(['\\', '/']).next().unwrap_or("").to_lowercase();
    // Windows drops trailing dots and spaces, so "run.bat. " opens as "run.bat".
    if platform == LaunchPlatform::Windows {
        name = name.trim_end_matches(['.', ' ']).to_string();
    }
    match name.rfind('.') {
        Some(index) => name[index..].to_string(),
        None => String::new(),
    }
}

/// Whether opening this path with the OS default handler would run it, judged by its name.
fn opens_as_program(path: &str, platform: LaunchPlatform) -> bool {
    let extension = extension_of(path, platform);
    PROGRAM_EXTENSIONS.contains(extension.as_str())
        || (platform == LaunchPlatform::Windows && WINDOWS_PROGRAM_EXTENSIONS.contains(extension.as_str()))
}

/// A file's kind and POSIX permission bits, enough to judge launchability.
#[derive(Clone, Copy, Debug)]
pub struct FileKind {
    pub is_file: bool,
    pub mode: u32,
}

/// Whether handing this existing path to the OS default handler would launch
/// it rather than show it: a launcher by name, or, on macOS, an application
/// bundle (a folder named `.app`) or an executable regular file. Elsewhere the
/// executable bit is left out: the default handler picks by type, and
/// FAT/NTFS mounts mark every file executable. Pass a canonical path: a
/// trailing separator or dot segment hides the last name.
pub fn launches_when_opened(path: &str, file: FileKind, platform: LaunchPlatform) -> bool {
    if opens_as_program(path, platform) {
        return true;
    }
    if platform != LaunchPlatform::Mac {
        return false;
    }
    if !file.is_file {
        return extension_of(path, platform) == ".app";
    }
    (file.mode & 0o111) != 0
}

/// The filesystem calls the decision needs; injected so tests can model symlinks and short names.
pub trait OpenPathFs {
    fn realpath(&self, path: &str) -> Option<String>;
    fn stat(&self, path: &str) -> Option<FileKind>;
}

/// `std::fs`-backed filesystem for production use.
pub struct OsFs;

impl OpenPathFs for OsFs {
    fn realpath(&self, path: &str) -> Option<String> {
        std::fs::canonicalize(path).ok().map(|p| p.to_string_lossy().into_owned())
    }

    fn stat(&self, path: &str) -> Option<FileKind> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let meta = std::fs::metadata(path).ok()?;
            Some(FileKind { is_file: meta.is_file(), mode: meta.mode() })
        }
        #[cfg(not(unix))]
        {
            let meta = std::fs::metadata(path).ok()?;
            Some(FileKind { is_file: meta.is_file(), mode: if meta.is_file() { 0o100644 } else { 0o40755 } })
        }
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
/// canonical one are judged: a symlink or a Windows short name can hide the
/// launcher's real extension, and a trailing separator or dot segment hides
/// the last name of the requested path.
pub fn open_path_target(requested: &str, platform: LaunchPlatform, fs: &dyn OpenPathFs) -> Option<OpenPathTarget> {
    let canonical = fs.realpath(requested)?;
    let stats = fs.stat(&canonical)?;
    let launches = launches_when_opened(requested, stats, platform) || launches_when_opened(&canonical, stats, platform);
    Some(OpenPathTarget { action: if launches { OpenAction::Reveal } else { OpenAction::Open }, path: canonical })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Clone)]
    struct Entry {
        real: Option<String>,
        is_file: bool,
        mode: u32,
    }

    /// A fake filesystem: each key is a path as requested; `real` is where it
    /// resolves (symlinks, dot segments, short names).
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

        fn stat(&self, path: &str) -> Option<FileKind> {
            let by_real = self.0.values().find(|entry| entry.real.as_deref().unwrap_or("") == path);
            let entry = by_real.or_else(|| self.0.get(path))?;
            Some(FileKind { is_file: entry.is_file, mode: entry.mode })
        }
    }

    const TEXT_MODE: u32 = 0o100644;
    const BUNDLE_MODE: u32 = 0o40755;

    fn text() -> Entry {
        Entry { real: None, is_file: true, mode: TEXT_MODE }
    }

    fn bundle() -> Entry {
        Entry { real: None, is_file: false, mode: BUNDLE_MODE }
    }

    fn with_real(mut entry: Entry, real: &str) -> Entry {
        entry.real = Some(real.to_string());
        entry
    }

    fn decide(path: &str, entries: Vec<(&str, Entry)>, platform: LaunchPlatform) -> Option<OpenPathTarget> {
        open_path_target(path, platform, &FakeFs::new(entries))
    }

    #[test]
    fn opens_an_ordinary_file_at_its_resolved_path() {
        assert_eq!(
            decide("/repo/src/App.tsx", vec![("/repo/src/App.tsx", text())], LaunchPlatform::Mac),
            Some(OpenPathTarget { action: OpenAction::Open, path: "/repo/src/App.tsx".into() })
        );
    }

    #[test]
    fn reports_a_missing_path_instead_of_deciding() {
        assert_eq!(decide("/repo/gone.txt", vec![], LaunchPlatform::Mac), None);
    }

    #[test]
    fn reveals_the_bundle_s_even_when_a_separator_or_dot_segment_hides_its_name_cases() {
        for requested in ["/repo/Evil.app/", "/repo/Evil.app/.", "/repo/Evil.app/Contents/.."] {
            let decision = decide(requested, vec![(requested, with_real(bundle(), "/repo/Evil.app"))], LaunchPlatform::Mac);
            assert_eq!(decision, Some(OpenPathTarget { action: OpenAction::Reveal, path: "/repo/Evil.app".into() }), "{requested}");
        }
    }

    #[test]
    fn reveals_a_harmless_looking_symlink_whose_target_is_a_launcher() {
        let decision = decide(
            "/repo/NOTES.md",
            vec![("/repo/NOTES.md", with_real(text(), "/repo/.x/run.terminal"))],
            LaunchPlatform::Mac,
        );
        assert_eq!(decision.map(|d| d.action), Some(OpenAction::Reveal));
    }

    #[test]
    fn reveals_a_symlink_to_an_application_bundle() {
        let decision =
            decide("/repo/docs", vec![("/repo/docs", with_real(bundle(), "/repo/.x/Evil.app"))], LaunchPlatform::Mac);
        assert_eq!(decision.map(|d| d.action), Some(OpenAction::Reveal));
    }

    #[test]
    fn reveals_a_launcher_named_by_the_requested_path_even_when_it_resolves_elsewhere() {
        let decision = decide(
            "/repo/deploy.sh",
            vec![("/repo/deploy.sh", with_real(text(), "/repo/.x/notes"))],
            LaunchPlatform::Linux,
        );
        assert_eq!(decision.map(|d| d.action), Some(OpenAction::Reveal));
    }

    #[test]
    fn reveals_a_windows_short_name_that_resolves_to_a_launcher() {
        let decision = decide(
            "C:\\repo\\X~1.LIB",
            vec![("C:\\repo\\X~1.LIB", with_real(text(), "C:\\repo\\x.library-ms"))],
            LaunchPlatform::Windows,
        );
        assert_eq!(decision.map(|d| d.action), Some(OpenAction::Reveal));
    }

    #[test]
    fn reveals_an_executable_file_on_macos() {
        let decision =
            decide("/repo/tool", vec![("/repo/tool", Entry { real: None, is_file: true, mode: 0o100755 })], LaunchPlatform::Mac);
        assert_eq!(decision.map(|d| d.action), Some(OpenAction::Reveal));
    }
}
