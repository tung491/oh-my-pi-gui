//! Read the agent's `models.yml` for provider configuration, ported from
//! `models-config.ts`.
//!
//! The file lives in the agent dir (`models.yml` preferred, `models.yaml`
//! fallback) and is parsed as generic YAML. The GUI no longer writes provider
//! entries; the one-time Ollama-only cleanup in `provider_cleanup.rs` edits
//! the document itself after a backup.
//!
//! Per the wave rule that a module never resolves the agent directory itself
//! (`paths::agent_dir()` panics in a test build when it would resolve the
//! default profile), every function here takes the agent directory as a
//! parameter; the `Services` port passes `paths::agent_dir()` in production
//! and a temp dir in tests.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_yml::Value;

const MASK_PREVIEW_LEN: usize = 4;

/// Mirror of `CUSTOM_PROVIDER_APIS` in `src/shared/ipc-types.ts`.
const CUSTOM_PROVIDER_APIS: &[&str] = &[
    "openai-completions",
    "openai-responses",
    "openai-codex-responses",
    "azure-openai-responses",
    "anthropic-messages",
    "bedrock-converse-stream",
    "google-generative-ai",
    "google-gemini-cli",
    "google-vertex",
];

/// Mirror of `CUSTOM_MODEL_EFFORTS` in `src/shared/ipc-types.ts`.
const CUSTOM_MODEL_EFFORTS: &[&str] = &["minimal", "low", "medium", "high", "xhigh", "max"];

const DISCOVERY_TYPES: &[&str] = &["ollama", "llama.cpp", "lm-studio", "openai-models-list", "proxy", "litellm"];
const AUTH_MODES: &[&str] = &["apiKey", "none", "oauth"];
const THINKING_MODES: &[&str] =
    &["effort", "budget", "google-level", "anthropic-adaptive", "anthropic-budget-effort"];

/// Provider ids the agent already knows — a `models.yml` entry under one of
/// these is an *override* of the built-in, not a custom provider. Mirrors the
/// checked-in `BUILTIN_PROVIDERS` set in `models-config.ts` (kept in sync by
/// hand with the catalog's generated list; see that file's comment).
const BUILTIN_PROVIDERS: &[&str] = &[
    "abliteration",
    "aiand",
    "aimlapi",
    "alibaba-coding-plan",
    "alibaba-token-plan",
    "amazon-bedrock",
    "anthropic",
    "azure",
    "baseten",
    "bedrock-mantle",
    "cerebras",
    "charm-hyper",
    "cline-pass",
    "cloudflare-ai-gateway",
    "commandcode",
    "coreweave",
    "cursor",
    "deepinfra",
    "deepseek",
    "devin",
    "exa",
    "firepass",
    "fireworks",
    "github-copilot",
    "gitlab-duo",
    "gitlab-duo-agent",
    "gmi-cloud",
    "google",
    "google-antigravity",
    "google-gemini-cli",
    "google-vertex",
    "groq",
    "huggingface",
    "kagi",
    "kilo",
    "kimi-code",
    "litellm",
    "llama.cpp",
    "lm-studio",
    "local",
    "meta",
    "minimax",
    "minimax-code",
    "minimax-code-cn",
    "mistral",
    "moonshot",
    "muse-code",
    "nanogpt",
    "novita",
    "nvidia",
    "ollama",
    "ollama-cloud",
    "openai",
    "openai-codex",
    "openai-codex-device",
    "opencode-go",
    "opencode-zen",
    "openrouter",
    "parallel",
    "perplexity",
    "qianfan",
    "qwen-portal",
    "sakana",
    "siliconflow",
    "siliconflow-cn",
    "singularityapi",
    "stencil",
    "synthetic",
    "tavily",
    "together",
    "typesafe",
    "umans",
    "venice",
    "vercel-ai-gateway",
    "vllm",
    "wafer-serverless",
    "web",
    "xai",
    "xai-oauth",
    "xiaomi",
    "xiaomi-token-plan-ams",
    "xiaomi-token-plan-cn",
    "xiaomi-token-plan-sgp",
    "yolo-auto",
    "zai",
    "zai-coding-plan",
    "zenmux",
    "zhipu-coding-plan",
];

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProviderModelThinking {
    pub mode: String,
    pub efforts: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_level: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_display: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProviderModelCost {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<f64>,
}

impl CustomProviderModelCost {
    fn is_empty(&self) -> bool {
        self.input.is_none() && self.output.is_none() && self.cache_read.is_none() && self.cache_write.is_none()
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProviderDiscovery {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProviderModelInput {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<CustomProviderModelThinking>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_tools: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<CustomProviderModelCost>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub premium_multiplier: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub omit_max_output_tokens: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
}

/// A provider entry as shown in the GUI (apiKey masked, never the real value).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProviderView {
    pub id: String,
    pub api: String,
    pub base_url: String,
    pub has_api_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key_preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_header: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discovery: Option<CustomProviderDiscovery>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disable_strict_tools: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra_body: Option<serde_json::Map<String, serde_json::Value>>,
    pub models: Vec<CustomProviderModelInput>,
    pub builtin: bool,
}

/// Absolute path to the agent's models file (`models.yml` preferred, `models.yaml` fallback).
pub fn models_path(agent_dir: &Path) -> PathBuf {
    let yml = agent_dir.join("models.yml");
    if yml.exists() {
        return yml;
    }
    let legacy = agent_dir.join("models.yaml");
    // A fresh install writes the preferred name; only an existing `models.yaml` keeps being used.
    if legacy.exists() { legacy } else { yml }
}

#[derive(Debug, thiserror::Error)]
pub enum ModelsConfigError {
    #[error("{0}")]
    InvalidYaml(String),
}

/// Parse `models.yml`'s `providers` map, tolerating free-form content:
/// unknown shapes degrade to an empty map rather than failing the read.
fn read_models_providers(agent_dir: &Path) -> Result<Vec<(String, Value)>, ModelsConfigError> {
    let file = models_path(agent_dir);
    let Ok(text) = std::fs::read_to_string(&file) else {
        return Ok(Vec::new());
    };
    let doc: Value = serde_yml::from_str(&text)
        .map_err(|error| ModelsConfigError::InvalidYaml(format!("{}: {error}", file.display())))?;
    let Some(mapping) = doc.get("providers").and_then(Value::as_mapping) else {
        return Ok(Vec::new());
    };
    Ok(mapping
        .iter()
        .filter_map(|(key, value)| key.as_str().map(|key| (key.to_string(), value.clone())))
        .collect())
}

fn as_string(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    if text.is_empty() { None } else { Some(text.to_string()) }
}

fn as_number(value: Option<&Value>) -> Option<f64> {
    value?.as_f64().filter(|n| n.is_finite())
}

fn as_bool(value: Option<&Value>) -> Option<bool> {
    value?.as_bool()
}

fn as_string_record(value: Option<&Value>) -> Option<BTreeMap<String, String>> {
    let mapping = value?.as_mapping()?;
    let out: BTreeMap<String, String> = mapping
        .iter()
        .filter_map(|(k, v)| Some((k.as_str()?.to_string(), v.as_str()?.to_string())))
        .collect();
    if out.is_empty() { None } else { Some(out) }
}

fn as_api(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    if CUSTOM_PROVIDER_APIS.contains(&text) { Some(text.to_string()) } else { None }
}

fn as_cost(value: Option<&Value>) -> Option<CustomProviderModelCost> {
    let mapping = value?.as_mapping()?;
    let get = |key: &str| mapping.get(key);
    let cost = CustomProviderModelCost {
        input: as_number(get("input")),
        output: as_number(get("output")),
        cache_read: as_number(get("cacheRead")),
        cache_write: as_number(get("cacheWrite")),
    };
    if cost.is_empty() { None } else { Some(cost) }
}

/// Effort ladder as the agent's `ModelThinkingSchema` resolves it: `efforts`
/// wins, then the legacy `levels` list, then the `minLevel`..`maxLevel` range.
fn thinking_efforts(mapping: &serde_yml::Mapping) -> Vec<String> {
    let is_effort = |value: &Value| value.as_str().is_some_and(|s| CUSTOM_MODEL_EFFORTS.contains(&s));
    let from_list = |value: Option<&Value>| -> Vec<String> {
        value
            .and_then(Value::as_sequence)
            .map(|seq| seq.iter().filter(|v| is_effort(v)).map(|v| v.as_str().unwrap_or_default().to_string()).collect())
            .unwrap_or_default()
    };
    let explicit = from_list(mapping.get("efforts"));
    if !explicit.is_empty() {
        return explicit;
    }
    let levels = from_list(mapping.get("levels"));
    if !levels.is_empty() {
        return levels;
    }
    let min_level = mapping.get("minLevel").filter(|v| is_effort(v)).and_then(Value::as_str);
    let max_level = mapping.get("maxLevel").filter(|v| is_effort(v)).and_then(Value::as_str);
    let (Some(min_level), Some(max_level)) = (min_level, max_level) else { return Vec::new() };
    let Some(min) = CUSTOM_MODEL_EFFORTS.iter().position(|e| *e == min_level) else { return Vec::new() };
    let Some(max) = CUSTOM_MODEL_EFFORTS.iter().position(|e| *e == max_level) else { return Vec::new() };
    CUSTOM_MODEL_EFFORTS[min..=min.max(max)].iter().map(|s| s.to_string()).collect()
}

fn as_thinking(value: Option<&Value>) -> Option<CustomProviderModelThinking> {
    let mapping = value?.as_mapping()?;
    let mode = mapping.get("mode").and_then(Value::as_str).filter(|mode| THINKING_MODES.contains(mode))?;
    let efforts = thinking_efforts(mapping);
    if efforts.is_empty() {
        return None;
    }
    let default_level = as_string(mapping.get("defaultLevel")).filter(|level| CUSTOM_MODEL_EFFORTS.contains(&level.as_str()));
    let supports_display = mapping.get("supportsDisplay").and_then(Value::as_bool);
    Some(CustomProviderModelThinking { mode: mode.to_string(), efforts, default_level, supports_display })
}

fn as_input(value: Option<&Value>) -> Option<Vec<String>> {
    let seq = value?.as_sequence()?;
    let out: Vec<String> = seq
        .iter()
        .filter_map(Value::as_str)
        .filter(|v| *v == "text" || *v == "image")
        .map(str::to_string)
        .collect();
    if out.is_empty() { None } else { Some(out) }
}

fn as_discovery(value: Option<&Value>) -> Option<CustomProviderDiscovery> {
    let mapping = value?.as_mapping()?;
    let kind = mapping.get("type").and_then(Value::as_str).filter(|kind| DISCOVERY_TYPES.contains(kind))?;
    let timeout_ms = as_number(mapping.get("timeoutMs"));
    Some(CustomProviderDiscovery { kind: kind.to_string(), timeout_ms })
}

fn model_to_view(raw: &Value) -> Option<CustomProviderModelInput> {
    let mapping = raw.as_mapping()?;
    let id = as_string(mapping.get("id"))?;
    Some(CustomProviderModelInput {
        id,
        name: as_string(mapping.get("name")),
        api: as_api(mapping.get("api")),
        base_url: as_string(mapping.get("baseUrl")),
        reasoning: (mapping.get("reasoning").and_then(Value::as_bool) == Some(true)).then_some(true),
        thinking: as_thinking(mapping.get("thinking")),
        input: as_input(mapping.get("input")),
        supports_tools: as_bool(mapping.get("supportsTools")),
        cost: as_cost(mapping.get("cost")),
        premium_multiplier: as_number(mapping.get("premiumMultiplier")),
        context_window: as_number(mapping.get("contextWindow")),
        max_tokens: as_number(mapping.get("maxTokens")),
        omit_max_output_tokens: as_bool(mapping.get("omitMaxOutputTokens")),
        headers: as_string_record(mapping.get("headers")),
    })
}

/// `serde_yml::Value` and `serde_json::Value` share the same serde data
/// model, so a direct structured conversion keeps numbers and booleans typed
/// (never a string round trip).
fn yaml_to_json(value: &Value) -> Option<serde_json::Value> {
    serde_json::to_value(value).ok()
}

fn to_view(id: &str, raw: &Value) -> CustomProviderView {
    let empty = serde_yml::Mapping::new();
    let mapping = raw.as_mapping().unwrap_or(&empty);
    let models: Vec<CustomProviderModelInput> = mapping
        .get("models")
        .and_then(Value::as_sequence)
        .map(|seq| seq.iter().filter_map(model_to_view).collect())
        .unwrap_or_default();
    let api_key = mapping.get("apiKey").and_then(Value::as_str);
    let (has_api_key, api_key_preview) = match api_key {
        Some(key) if !key.is_empty() => {
            let preview_len = MASK_PREVIEW_LEN.min(key.len());
            (true, Some(format!("\u{2022}\u{2022}\u{2022}{}", &key[key.len() - preview_len..])))
        }
        _ => (false, None),
    };
    let compat = mapping.get("compat").and_then(Value::as_mapping);
    let extra_body = compat
        .and_then(|compat| compat.get("extraBody"))
        .and_then(yaml_to_json)
        .and_then(|value| value.as_object().cloned())
        .filter(|object| !object.is_empty());
    let auth = as_string(mapping.get("auth")).filter(|auth| AUTH_MODES.contains(&auth.as_str()));
    CustomProviderView {
        id: id.to_string(),
        api: as_api(mapping.get("api")).unwrap_or_else(|| "openai-completions".to_string()),
        base_url: as_string(mapping.get("baseUrl")).unwrap_or_default(),
        has_api_key,
        api_key_preview,
        auth,
        auth_header: as_bool(mapping.get("authHeader")),
        headers: as_string_record(mapping.get("headers")),
        discovery: as_discovery(mapping.get("discovery")),
        disable_strict_tools: as_bool(mapping.get("disableStrictTools")),
        transport: (mapping.get("transport").and_then(Value::as_str) == Some("pi-native")).then(|| "pi-native".to_string()),
        extra_body,
        models,
        builtin: BUILTIN_PROVIDERS.contains(&id),
    }
}

/// List configured providers (custom + user overrides), apiKey masked.
pub fn list_models_providers(agent_dir: &Path) -> Result<Vec<CustomProviderView>, ModelsConfigError> {
    let providers = read_models_providers(agent_dir)?;
    Ok(providers.iter().map(|(id, raw)| to_view(id, raw)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, content: &str) {
        std::fs::write(dir.join(name), content).unwrap();
    }

    #[test]
    fn points_a_fresh_install_at_models_yml() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(models_path(dir.path()), dir.path().join("models.yml"));
    }

    #[test]
    fn keeps_using_an_existing_legacy_models_yaml() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "models.yaml", "providers: {}\n");
        assert_eq!(models_path(dir.path()), dir.path().join("models.yaml"));
    }

    #[test]
    fn reads_both_legacy_thinking_shapes_as_an_ordered_efforts_ladder() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "models.yml",
            "providers:\n  legacy-thinking:\n    api: openai-completions\n    baseUrl: https://api.test.com/v1\n    models:\n      - id: ranged-model\n        thinking:\n          mode: effort\n          minLevel: low\n          maxLevel: high\n      - id: levelled-model\n        thinking:\n          mode: budget\n          levels: [minimal, medium]\n          effortMap: {minimal: low}\n",
        );
        let providers = list_models_providers(dir.path()).unwrap();
        let loaded = providers.iter().find(|p| p.id == "legacy-thinking").expect("legacy-thinking provider missing after parse");
        assert_eq!(
            loaded.models[0].thinking,
            Some(CustomProviderModelThinking {
                mode: "effort".into(),
                efforts: vec!["low".into(), "medium".into(), "high".into()],
                default_level: None,
                supports_display: None,
            })
        );
        assert_eq!(
            loaded.models[1].thinking,
            Some(CustomProviderModelThinking {
                mode: "budget".into(),
                efforts: vec!["minimal".into(), "medium".into()],
                default_level: None,
                supports_display: None,
            })
        );
    }

    #[test]
    fn flags_a_hand_written_built_in_override_as_built_in_not_as_a_custom_provider() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "models.yml", "providers:\n  meta:\n    api: openai-completions\n    baseUrl: https://x.test/v1\n");
        let providers = list_models_providers(dir.path()).unwrap();
        assert_eq!(providers.iter().find(|p| p.id == "meta").map(|p| p.builtin), Some(true));
    }

    #[test]
    fn tolerates_malformed_file_content_without_throwing() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "models.yml",
            "\nproviders:\n  broken-provider:\n    api: 123\n    baseUrl: null\n    models: not-an-array\n    discovery: invalid\n    cost:\n      input: \"not a number\"\n",
        );
        let providers = list_models_providers(dir.path()).unwrap();
        let saved = providers.iter().find(|p| p.id == "broken-provider").expect("provider present");
        assert_eq!(saved.api, "openai-completions");
        assert_eq!(saved.base_url, "");
        assert!(saved.models.is_empty());
        assert!(saved.discovery.is_none());
    }
}
