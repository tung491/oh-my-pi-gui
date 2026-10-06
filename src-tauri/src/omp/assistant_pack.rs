//! The assistant pack every sidecar session loads, ported from
//! `src/main/assistant-pack.ts`: where it lives, the files it must hold, and
//! the spawn flags and env that load it.

use std::path::{Path, PathBuf};

use crate::product::PRODUCT_NAME;

/// Every file `scripts/build-assistant-pack.ts` writes, checked before each spawn.
pub(crate) const ASSISTANT_PACK_FILES: &[&str] = &[
    "package.json",
    "tools.js",
    "system-prompt.md",
    "config.yml",
    "skills/word-report/SKILL.md",
    "skills/spreadsheet-cleanup/SKILL.md",
    "skills/slides-from-report/SKILL.md",
    "skills/sai-os-helpdesk/SKILL.md",
];

const PACK_DIR_NAME: &str = "assistant-pack";
/// Ancestor levels searched above each search root, as the bundled-binary lookup does.
const SEARCH_DEPTH: usize = 8;

/// The pack's typed tools plus the file tools; no shell, no helper sessions.
const COMMON_TOOLS: &[&str] = &["read", "glob", "write", "ask"];
/// SAI OS helpdesk tools, shipped on Linux only.
const LINUX_OS_TOOLS: &[&str] = &["diagnose", "system_status", "open_item", "os_setting"];
const OFFICE_TOOLS: &[&str] = &["office_report", "office_slides", "office_clean"];

/// The pack directory for a sidecar binary: `assistant-pack/` beside it when
/// that exists (the binary is never resolved through a symlink, so a worktree
/// whose sidecar links into another checkout keeps its own pack). Otherwise
/// the first `resources/assistant-pack` found walking up from each search
/// root, which covers the e2e fixture sidecar in dev and e2e builds. When
/// nothing is found, the beside-binary path, so the missing-file message
/// names where the pack belongs.
pub(crate) fn resolve_pack_dir(binary: &Path, search_from: &[PathBuf]) -> PathBuf {
    let beside = binary.parent().unwrap_or(Path::new("")).join(PACK_DIR_NAME);
    if beside.is_dir() {
        return beside;
    }
    for start in search_from {
        for dir in start.ancestors().take(SEARCH_DEPTH) {
            let candidate = dir.join("resources").join(PACK_DIR_NAME);
            if candidate.is_dir() {
                return candidate;
            }
        }
    }
    beside
}

/// The spawn flags that load the pack. `os` is `std::env::consts::OS`: Linux
/// adds the SAI OS tools, every other platform gets the office set only.
pub(crate) fn pack_flags(pack_dir: &Path, os: &str) -> Vec<String> {
    let mut tools: Vec<&str> = COMMON_TOOLS.to_vec();
    if os == "linux" {
        tools.extend_from_slice(LINUX_OS_TOOLS);
    }
    tools.extend_from_slice(OFFICE_TOOLS);
    vec![
        "--no-extensions".to_string(),
        "--extension".to_string(),
        pack_dir.to_string_lossy().into_owned(),
        "--tools".to_string(),
        tools.join(","),
        "--system-prompt".to_string(),
        pack_dir.join("system-prompt.md").to_string_lossy().into_owned(),
        "--config".to_string(),
        pack_dir.join("config.yml").to_string_lossy().into_owned(),
        "--approval-mode".to_string(),
        "always-ask".to_string(),
    ]
}

/// The env keys the pack's tools read, set last at spawn.
pub(crate) fn pack_env(language: &str) -> Vec<(&'static str, String)> {
    vec![("SAI_ATLAS_LANG", language.to_string())]
}

/// The first listed pack file that is missing, or `None` when the pack is complete.
pub(crate) fn missing_pack_file(pack_dir: &Path) -> Option<&'static str> {
    ASSISTANT_PACK_FILES.iter().copied().find(|file| !pack_dir.join(file).exists())
}

/// The "pack incomplete" message, worded for the build that hit it: a dev tree
/// can rebuild the pack, a packaged app has to be reinstalled.
pub(crate) fn missing_pack_message(file: &str, packaged: bool) -> String {
    if !packaged {
        return format!("The assistant pack is missing {file}. Build it with `bun run build:pack`, then relaunch.");
    }
    format!("The assistant pack is missing {file} in this installation. Reinstall {PRODUCT_NAME}, then relaunch.")
}

#[cfg(test)]
mod tests {
    use super::*;

    const PACK_FILES: &[&str] = &[
        "package.json",
        "tools.js",
        "system-prompt.md",
        "config.yml",
        "skills/word-report/SKILL.md",
        "skills/spreadsheet-cleanup/SKILL.md",
        "skills/slides-from-report/SKILL.md",
        "skills/sai-os-helpdesk/SKILL.md",
    ];

    fn write_file(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "x").unwrap();
    }

    fn write_pack(pack: &Path, files: &[&str]) {
        std::fs::create_dir_all(pack).unwrap();
        for file in files {
            write_file(&pack.join(file));
        }
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn builds_the_linux_pack_flags_in_order() {
        let pack = Path::new("/opt/pack");
        let expected = strings(&[
            "--no-extensions",
            "--extension",
            "/opt/pack",
            "--tools",
            "read,glob,write,ask,diagnose,system_status,open_item,os_setting,office_report,office_slides,office_clean",
            "--system-prompt",
            "/opt/pack/system-prompt.md",
            "--config",
            "/opt/pack/config.yml",
            "--approval-mode",
            "always-ask",
        ]);
        assert_eq!(pack_flags(pack, "linux"), expected);
    }

    #[test]
    fn builds_the_macos_pack_flags_without_the_os_tools() {
        let pack = Path::new("/opt/pack");
        let expected = strings(&[
            "--no-extensions",
            "--extension",
            "/opt/pack",
            "--tools",
            "read,glob,write,ask,office_report,office_slides,office_clean",
            "--system-prompt",
            "/opt/pack/system-prompt.md",
            "--config",
            "/opt/pack/config.yml",
            "--approval-mode",
            "always-ask",
        ]);
        assert_eq!(pack_flags(pack, "macos"), expected);
        // Every platform other than Linux gets the list without the OS tools.
        assert_eq!(pack_flags(pack, "windows"), expected);
    }

    #[test]
    fn resolves_the_pack_beside_the_sidecar_binary() {
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("bundle").join("omp");
        write_file(&binary);
        write_pack(&root.path().join("bundle").join("assistant-pack"), PACK_FILES);
        // A pack under a search root never wins over the one beside the binary.
        write_pack(&root.path().join("repo").join("resources").join("assistant-pack"), PACK_FILES);
        assert_eq!(resolve_pack_dir(&binary, &[root.path().join("repo")]), root.path().join("bundle").join("assistant-pack"));

        // The binary is not resolved through a symlink: a worktree links its
        // sidecar into the main checkout but keeps its own pack.
        #[cfg(unix)]
        {
            let linked = root.path().join("worktree").join("resources").join("omp.linux-x64");
            std::fs::create_dir_all(linked.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(&binary, &linked).unwrap();
            write_pack(&root.path().join("worktree").join("resources").join("assistant-pack"), PACK_FILES);
            assert_eq!(resolve_pack_dir(&linked, &[]), root.path().join("worktree").join("resources").join("assistant-pack"));
        }
    }

    #[test]
    fn resolves_the_pack_under_resources_for_a_fixture_sidecar_outside_the_tree() {
        let root = tempfile::tempdir().unwrap();
        let fixture = root.path().join("e2e").join("sidecar-fixture.ts");
        write_file(&fixture);
        write_pack(&root.path().join("resources").join("assistant-pack"), PACK_FILES);
        let manifest_dir = root.path().join("src-tauri");
        std::fs::create_dir_all(&manifest_dir).unwrap();

        // The search walks up from each root, as the bundled-binary lookup does.
        assert_eq!(resolve_pack_dir(&fixture, &[manifest_dir]), root.path().join("resources").join("assistant-pack"));
        // Without search roots, or when no root holds a pack, the beside-binary
        // path comes back so the missing-file message can name it.
        assert_eq!(resolve_pack_dir(&fixture, &[]), root.path().join("e2e").join("assistant-pack"));
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(resolve_pack_dir(&fixture, &[empty.path().to_path_buf()]), root.path().join("e2e").join("assistant-pack"));
    }

    #[test]
    fn builds_the_pack_env_with_the_session_language() {
        assert_eq!(pack_env("vi"), vec![("SAI_ATLAS_LANG", "vi".to_string())]);
        assert_eq!(pack_env("en"), vec![("SAI_ATLAS_LANG", "en".to_string())]);
    }

    #[test]
    fn refuses_to_spawn_when_a_pack_file_is_missing() {
        assert_eq!(ASSISTANT_PACK_FILES, PACK_FILES);
        let complete = tempfile::tempdir().unwrap();
        write_pack(complete.path(), ASSISTANT_PACK_FILES);
        assert_eq!(missing_pack_file(complete.path()), None);

        for left in ASSISTANT_PACK_FILES {
            let pack = tempfile::tempdir().unwrap();
            let kept: Vec<&str> = ASSISTANT_PACK_FILES.iter().copied().filter(|file| file != left).collect();
            write_pack(pack.path(), &kept);
            assert_eq!(missing_pack_file(pack.path()), Some(*left));

            let packaged = missing_pack_message(left, true);
            assert!(packaged.contains(left), "{packaged}");
            assert!(packaged.contains("Reinstall Sai ATLAS"), "{packaged}");
            let dev = missing_pack_message(left, false);
            assert!(dev.contains(left), "{dev}");
            assert!(dev.contains("bun run build:pack"), "{dev}");
        }
    }

    #[test]
    fn ships_the_tool_list_the_pack_check_expects() {
        let script = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("scripts").join("check-assistant-pack.ts")).unwrap();
        let import = script.lines().find(|line| line.starts_with("import") && line.contains("\"../src/main/assistant-pack\"")).expect("the pack check imports the shared pack module");
        assert!(import.contains("assistantPackFlags"), "{import}");
        assert!(!script.contains("office_report"));
    }
}
