//! The assistant pack every sidecar session loads, mirrored by
//! `scripts/assistant-pack.ts` (the pack check's copy): where it lives, the
//! files it must hold, and the spawn flags and env that load it.

use std::path::{Path, PathBuf};

use crate::product::PRODUCT_NAME;

/// Every file `scripts/build-assistant-pack.ts` writes, checked before each spawn.
pub(crate) const ASSISTANT_PACK_FILES: &[&str] = &[
    "package.json",
    "tools.js",
    "system-prompt.md",
    "append-system-prompt.md",
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
/// root, which covers the e2e fixture sidecar in dev and e2e builds. An empty
/// binary path (the TS shell's source sidecar) has nothing beside it. When
/// nothing is found, the beside-binary path (or, for an empty binary path, the
/// first search root's `resources/assistant-pack`), so the missing-file
/// message names where the pack belongs. The result is always absolute: omp
/// resolves a relative flag path against the session cwd.
pub(crate) fn resolve_pack_dir(binary: &Path, search_from: &[PathBuf]) -> PathBuf {
    let beside = (!binary.as_os_str().is_empty()).then(|| absolute(binary.parent().unwrap_or(Path::new("")).join(PACK_DIR_NAME)));
    if let Some(beside) = beside.as_ref().filter(|beside| beside.is_dir()) {
        return beside.clone();
    }
    for root in search_from {
        let start = absolute(root.clone());
        for dir in start.ancestors().take(SEARCH_DEPTH) {
            let candidate = dir.join("resources").join(PACK_DIR_NAME);
            if candidate.is_dir() {
                return candidate;
            }
        }
    }
    beside.unwrap_or_else(|| absolute(search_from.first().cloned().unwrap_or_default().join("resources").join(PACK_DIR_NAME)))
}

/// `path` made absolute against the process cwd, without following symlinks
/// (a worktree's sidecar links into another checkout but keeps its own pack).
fn absolute(path: PathBuf) -> PathBuf {
    std::path::absolute(&path).unwrap_or(path)
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
        // The folder's instruction files (rules folders, AGENTS.md, CLAUDE.md
        // and the like) are written for coding agents, not for the assistant.
        "--no-rules".to_string(),
        "--no-context-files".to_string(),
        "--extension".to_string(),
        pack_dir.to_string_lossy().into_owned(),
        "--tools".to_string(),
        tools.join(","),
        "--system-prompt".to_string(),
        pack_dir.join("system-prompt.md").to_string_lossy().into_owned(),
        // An explicit append prompt (empty) stops omp from appending a
        // workspace's or the user's APPEND_SYSTEM.md to the pack's system prompt.
        "--append-system-prompt".to_string(),
        pack_dir.join("append-system-prompt.md").to_string_lossy().into_owned(),
        "--config".to_string(),
        pack_dir.join("config.yml").to_string_lossy().into_owned(),
        "--approval-mode".to_string(),
        "always-ask".to_string(),
    ]
}

/// Env keys removed from every pack session: shell startup files a shell would
/// source inside the pack tools' system programs, the omp profile selectors,
/// which redirect omp's agent dir (user config, APPEND_SYSTEM.md, models), the
/// role model overrides, and every credential omp reads from the environment to
/// reach an online model, search or auth-broker service (the provider catalog's
/// `envVars`, the Anthropic, Google, Bedrock and web-search key lookups, and the
/// auth broker). A pack session talks only to the local Ollama server; the
/// pinned model policy refuses those providers too.
pub(crate) const REMOVED_ENV: &[&str] = &[
    "BASH_ENV",
    "ENV",
    "OMP_PROFILE",
    "PI_PROFILE",
    "PI_SMOL_MODEL",
    "PI_SLOW_MODEL",
    "PI_PLAN_MODEL",
    "ABLITERATION_API_KEY",
    "ABLIT_KEY",
    "AIAND_API_KEY",
    "AI_GATEWAY_API_KEY",
    "AIMLAPI_API_KEY",
    "ALIBABA_CODING_PLAN_API_KEY",
    "ALIBABA_TOKEN_PLAN_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_OAUTH_TOKEN",
    "ANTHROPIC_SEARCH_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_PROFILE",
    "AWS_ROLE_ARN",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AZURE_OPENAI_API_KEY",
    "BAILIAN_TOKEN_PLAN_API_KEY",
    "BASETEN_API_KEY",
    "BRAVE_API_KEY",
    "CEREBRAS_API_KEY",
    "CHARM_HYPER_API_KEY",
    "CLAUDE_CODE_CLIENT_KEY",
    "CLINE_API_KEY",
    "CLOUDFLARE_AI_GATEWAY_API_KEY",
    "CLOUDSDK_AUTH_ACCESS_TOKEN",
    "COMMANDCODE_API_KEY",
    "COPILOT_GITHUB_TOKEN",
    "COREWEAVE_API_KEY",
    "CURSOR_ACCESS_TOKEN",
    "CURSOR_API_KEY",
    "DEEPINFRA_API_KEY",
    "DEEPSEEK_API_KEY",
    "DEVIN_API_KEY",
    "EXA_API_KEY",
    "FIRECRAWL_API_KEY",
    "FIREPASS_API_KEY",
    "FIREWORKS_API_KEY",
    "FUGU_API_KEY",
    "GEMINI_API_KEY",
    "GITLAB_TOKEN",
    "GMI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_ACCESS_TOKEN",
    "GOOGLE_CLOUD_API_KEY",
    "GROQ_API_KEY",
    "HELMCODE_API_KEY",
    "HF_TOKEN",
    "HUGGINGFACE_HUB_TOKEN",
    "HYPER_API_KEY",
    "JINA_API_KEY",
    "KAGI_API_KEY",
    "KILO_API_KEY",
    "KIMI_API_KEY",
    "KIMI_SEARCH_API_KEY",
    "LITELLM_API_KEY",
    "LLAMA_CPP_API_KEY",
    "LM_STUDIO_API_KEY",
    "META_API_KEY",
    "MINIMAX_API_KEY",
    "MINIMAX_CODE_API_KEY",
    "MINIMAX_CODE_CN_API_KEY",
    "MISTRAL_API_KEY",
    "MODEL_API_KEY",
    "MOONSHOT_API_KEY",
    "MOONSHOT_SEARCH_API_KEY",
    "NANO_GPT_API_KEY",
    "NOVITA_API_KEY",
    "NVIDIA_API_KEY",
    "OLLAMA_API_KEY",
    "OLLAMA_CLOUD_API_KEY",
    "OMP_AUTH_BROKER_TOKEN",
    "OMP_AUTH_BROKER_URL",
    "OPENAI_API_KEY",
    "OPENAI_CODEX_OAUTH_TOKEN",
    "OPENCODE_API_KEY",
    "OPENROUTER_API_KEY",
    "PARALLEL_API_KEY",
    "PERPLEXITY_API_KEY",
    "PERPLEXITY_COOKIES",
    "QIANFAN_API_KEY",
    "QWEN_OAUTH_TOKEN",
    "QWEN_PORTAL_API_KEY",
    "SAKANA_API_KEY",
    "SILICONFLOW_API_KEY",
    "SILICONFLOW_CN_API_KEY",
    "SINGULARITYAPI_DEV_API_KEY",
    "SINGULARITYAPI_TECH_API_KEY",
    "SMITHERY_API_KEY",
    "STENCIL_API_KEY",
    "STEPFUN_API_KEY",
    "SYNTHETIC_API_KEY",
    "TAVILY_API_KEY",
    "TINYFISH_API_KEY",
    "TOGETHER_API_KEY",
    "TYPESAFE_API_KEY",
    "UMANS_AI_CODING_PLAN_API_KEY",
    "VENICE_API_KEY",
    "VERCEL_AI_GATEWAY_API_KEY",
    "VLLM_API_KEY",
    "WAFER_SERVERLESS_API_KEY",
    "WANDB_API_KEY",
    "XAI_API_KEY",
    "XAI_OAUTH_TOKEN",
    "XIAOMI_API_KEY",
    "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
    "XIAOMI_TOKEN_PLAN_CN_API_KEY",
    "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
    "YOLO_AUTO_API_KEY",
    "ZAI_API_KEY",
    "ZENMUX_API_KEY",
    "ZHIPU_API_KEY",
];

/// The env keys the pack's tools read, set last at spawn.
pub(crate) fn pack_env(language: &str) -> Vec<(&'static str, String)> {
    vec![("SAI_ATLAS_LANG", language.to_string())]
}

/// Bytes read from the head of a session file to find the header line, as the session index does.
const SESSION_HEAD_BYTES: u64 = 32 * 1024;
/// Bytes read for the header line itself, as the session index does.
const SESSION_HEADER_BYTES: u64 = 4096;

/// Whether a session file is stamped `chat` (header `kind`, the second line;
/// the first is the title slot). omp resumes such a file restricted to its
/// stamped tools, without the pack's, so no pack session may start on it. A
/// file that cannot be read or parsed counts as not chat, as the session index
/// degrades.
pub(crate) fn is_chat_stamped_session(session_path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let read_stamp = || -> Option<bool> {
        let mut file = std::fs::File::open(session_path).ok()?;
        let mut head = Vec::new();
        (&mut file).take(SESSION_HEAD_BYTES).read_to_end(&mut head).ok()?;
        let newline = head.iter().position(|byte| *byte == b'\n')?;
        file.seek(SeekFrom::Start(newline as u64 + 1)).ok()?;
        let mut header = Vec::new();
        file.take(SESSION_HEADER_BYTES).read_to_end(&mut header).ok()?;
        let line = header.split(|byte| *byte == b'\n').next().unwrap_or(&[]);
        let parsed: serde_json::Value = serde_json::from_slice(line).ok()?;
        Some(parsed.get("kind").and_then(serde_json::Value::as_str) == Some("chat"))
    };
    read_stamp().unwrap_or(false)
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
        "append-system-prompt.md",
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
            "--no-rules",
            "--no-context-files",
            "--extension",
            "/opt/pack",
            "--tools",
            "read,glob,write,ask,diagnose,system_status,open_item,os_setting,office_report,office_slides,office_clean",
            "--system-prompt",
            "/opt/pack/system-prompt.md",
            "--append-system-prompt",
            "/opt/pack/append-system-prompt.md",
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
            "--no-rules",
            "--no-context-files",
            "--extension",
            "/opt/pack",
            "--tools",
            "read,glob,write,ask,office_report,office_slides,office_clean",
            "--system-prompt",
            "/opt/pack/system-prompt.md",
            "--append-system-prompt",
            "/opt/pack/append-system-prompt.md",
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
    fn resolves_the_pack_from_the_search_roots_when_the_sidecar_runs_from_source() {
        let root = tempfile::tempdir().unwrap();
        write_pack(&root.path().join("resources").join("assistant-pack"), PACK_FILES);
        let app_path = root.path().join("out").join("main");
        std::fs::create_dir_all(&app_path).unwrap();

        // A source sidecar has no binary path: nothing sits beside it, so the search roots decide.
        assert_eq!(resolve_pack_dir(Path::new(""), &[app_path]), root.path().join("resources").join("assistant-pack"));
        // The result is always absolute: omp would resolve a relative flag path against the session cwd.
        let cwd = std::env::current_dir().unwrap();
        let unfound = resolve_pack_dir(Path::new(""), &[PathBuf::from("nowhere")]);
        // (cargo runs tests from src-tauri, so the walk up may find the checkout's own pack.)
        assert!(unfound.is_absolute(), "{}", unfound.display());
        assert!(cwd.join("nowhere").starts_with(unfound.parent().unwrap().parent().unwrap()), "{}", unfound.display());
        assert!(unfound.ends_with(Path::new("resources").join("assistant-pack")), "{}", unfound.display());
        assert_eq!(resolve_pack_dir(&Path::new("bin").join("omp"), &[]), cwd.join("bin").join("assistant-pack"));
    }

    #[test]
    fn builds_the_pack_env_with_the_session_language() {
        assert_eq!(pack_env("vi"), vec![("SAI_ATLAS_LANG", "vi".to_string())]);
        assert_eq!(pack_env("en"), vec![("SAI_ATLAS_LANG", "en".to_string())]);
    }

    #[test]
    fn strips_every_online_provider_credential_from_the_pack_env() {
        // The startup files and profile selectors stay removed, and so does every
        // credential omp would use to reach an online model or search provider:
        // a pack session only ever talks to the local Ollama server.
        for key in [
            "BASH_ENV",
            "ENV",
            "OMP_PROFILE",
            "PI_PROFILE",
            "PI_SMOL_MODEL",
            "PI_SLOW_MODEL",
            "PI_PLAN_MODEL",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_OAUTH_TOKEN",
            "OPENAI_API_KEY",
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "OLLAMA_API_KEY",
            "OLLAMA_CLOUD_API_KEY",
            "OPENROUTER_API_KEY",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_BEARER_TOKEN_BEDROCK",
            "HF_TOKEN",
            "PERPLEXITY_COOKIES",
            "OMP_AUTH_BROKER_URL",
            "OMP_AUTH_BROKER_TOKEN",
        ] {
            assert!(REMOVED_ENV.contains(&key), "{key} must be removed");
        }
        let unique: std::collections::HashSet<_> = REMOVED_ENV.iter().collect();
        assert_eq!(unique.len(), REMOVED_ENV.len());
        // The local Ollama address and the pack's own language survive.
        assert!(!REMOVED_ENV.contains(&"OLLAMA_HOST"));
        assert!(!REMOVED_ENV.contains(&"SAI_ATLAS_LANG"));
        // The pack check strips the very same keys.
        let source = include_str!("../../../scripts/assistant-pack.ts");
        assert_eq!(REMOVED_ENV.to_vec(), ts_removed_env(source));
    }

    /// The quoted keys of `scripts/assistant-pack.ts`'s removed-env lists, in order: the
    /// provider credentials expand where the removed list spreads them.
    fn ts_removed_env(source: &str) -> Vec<&str> {
        let block = |name: &str| -> Vec<&str> {
            let start = source.find(&format!("export const {name}")).unwrap_or_else(|| panic!("{name} missing"));
            let body = &source[start..];
            let body = &body[body.find('[').unwrap() + 1..];
            let body = &body[body.find("= [").map_or(0, |at| at + 3)..];
            let body = &body[..body.find("];").unwrap()];
            body.split(',').map(str::trim).filter(|item| !item.is_empty()).collect()
        };
        let credentials: Vec<&str> =
            block("ASSISTANT_PACK_PROVIDER_CREDENTIAL_ENV").into_iter().map(|item| item.trim_matches('"')).collect();
        let mut keys = Vec::new();
        for item in block("ASSISTANT_PACK_REMOVED_ENV") {
            if item == "...ASSISTANT_PACK_PROVIDER_CREDENTIAL_ENV" {
                keys.extend(credentials.iter().copied());
            } else {
                keys.push(item.trim_matches('"'));
            }
        }
        keys
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
    fn reads_the_chat_stamp_from_the_session_header() {
        let dir = tempfile::tempdir().unwrap();
        let session = |name: &str, text: &str| {
            let path = dir.path().join(name);
            std::fs::write(&path, text).unwrap();
            path
        };
        // Line 1 is the title slot, line 2 the header.
        let title_slot = format!("{:<255}\n", r#"{"title":"Notes"}"#);
        let chat = session("chat.jsonl", &format!("{title_slot}{}\n{{}}\n", r#"{"type":"session","id":"c","kind":"chat"}"#));
        let agent = session("agent.jsonl", &format!("{title_slot}{}\n{{}}\n", r#"{"type":"session","id":"a"}"#));
        assert!(is_chat_stamped_session(&chat));
        assert!(!is_chat_stamped_session(&agent));
        // A file that cannot be read or parsed is not refused, as the session index degrades.
        assert!(!is_chat_stamped_session(&dir.path().join("missing.jsonl")));
        assert!(!is_chat_stamped_session(&session("empty.jsonl", "")));
        assert!(!is_chat_stamped_session(&session("one-line.jsonl", r#"{"kind":"chat"}"#)));
        assert!(!is_chat_stamped_session(&session("broken.jsonl", &format!("{title_slot}{}\n", r#"{"kind":"chat""#))));
        assert!(!is_chat_stamped_session(dir.path()));
    }

    #[test]
    fn ships_the_tool_list_the_pack_check_expects() {
        let script = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("scripts").join("check-assistant-pack.ts")).unwrap();
        // The import statement may span lines: take it from its `import` to its module path.
        let from = script.find("from \"./assistant-pack\"").expect("the pack check imports the shared pack module");
        let start = script[..from].rfind("import").expect("the module path belongs to an import");
        let import = &script[start..from];
        assert!(import.split(|c: char| !c.is_alphanumeric()).any(|name| name == "assistantPackFlags"), "{import}");
        assert!(!script.contains("office_report"));
    }
}
