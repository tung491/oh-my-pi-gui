//! The measured context of each local Ollama model, as kept in `prefs.json`
//! under one main-owned key (`ollamaContextFit`; model tags contain dots, so
//! never a dotted path per tag), and the sidecar settings overlay built from
//! it. Pure helpers only: the scheduler and the IPC handlers do the reads and
//! writes. Keeps step with `src/shared/context-fit-store.ts`; change both together.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::catalog::MachineFacts;
use super::context_fit::{ContextFitResult, ContextPool, ContextVerdict, CONTEXT_FLOOR};
use crate::paths::EMPTY_CONTEXT_LIMITS_OVERLAY;

/// The prefs key. Only the `ollama` module writes it; `prefs:set` refuses it.
pub const CONTEXT_FIT_PREF_KEY: &str = "ollamaContextFit";
pub const CONTEXT_FIT_STORE_VERSION: u32 = 1;
/// RAM and VRAM readings are compared in steps of this size, so a few MiB of
/// reporting noise never counts as new hardware.
const FINGERPRINT_STEP_BYTES: u64 = 256 * 1024 * 1024;
/// `Number.MAX_SAFE_INTEGER`: the largest whole number both shells read exactly.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
/// A stored context above this (16M tokens) is not a real value.
const MAX_STORED_CONTEXT: u64 = 1 << 24;

/// The machine facts a measurement depends on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineFingerprint {
    pub ram_bytes: u64,
    /// Only `nvidia-smi` reports VRAM, so a reading here also means the GPU name came from it.
    pub vram_bytes: Option<u64>,
    pub gpu_name: Option<String>,
    pub unified_memory: bool,
}

impl From<&MachineFacts> for MachineFingerprint {
    fn from(machine: &MachineFacts) -> Self {
        Self {
            ram_bytes: machine.ram_bytes,
            vram_bytes: machine.vram_bytes,
            gpu_name: machine.gpu_name.clone(),
            unified_memory: machine.unified_memory,
        }
    }
}

/// One model's record. `max_context` stays `None` until a measurement succeeds;
/// `fingerprint` is the machine of the last attempt, successful or not.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextFitEntry {
    #[serde(default)]
    pub max_context: Option<u64>,
    #[serde(default)]
    pub trained_context: Option<u64>,
    #[serde(default)]
    pub pool: Option<ContextPool>,
    #[serde(default)]
    pub verdict: Option<ContextVerdict>,
    #[serde(default)]
    pub measured_at: Option<String>,
    pub fingerprint: MachineFingerprint,
    /// The user's lower limit; `None` runs the model at `max_context`.
    #[serde(default)]
    pub user_cap: Option<u64>,
    /// Failed attempts since the last successful measurement.
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub last_attempt_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextFitStore {
    pub version: u32,
    /// Keyed by the exact `/api/tags` model name.
    pub models: BTreeMap<String, ContextFitEntry>,
}

impl Default for ContextFitStore {
    fn default() -> Self {
        Self { version: CONTEXT_FIT_STORE_VERSION, models: BTreeMap::new() }
    }
}

/// Why `clamp_cap` refused a cap.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CapError {
    #[error("This model has not been measured yet")]
    Unmeasured,
    #[error("The context limit is outside the measured range")]
    OutOfRange { min: u64, max: u64 },
}

fn plausible(value: Option<u64>) -> bool {
    value.is_none_or(|n| (1..=MAX_STORED_CONTEXT).contains(&n))
}

/// An entry whose numbers make sense together; anything else is dropped on read.
fn is_sound(entry: &ContextFitEntry) -> bool {
    if !plausible(entry.max_context) || !plausible(entry.trained_context) || !plausible(entry.user_cap) {
        return false;
    }
    match (entry.max_context, entry.user_cap) {
        (None, Some(_)) => false,
        (Some(max), Some(cap)) => cap <= max,
        _ => true,
    }
}

/// Read the stored value, never failing: a missing or foreign value is an
/// empty store, and a malformed entry (or one under an empty key) is dropped
/// while the others survive.
pub fn parse_context_fit_store(raw: Option<&Value>) -> ContextFitStore {
    let mut store = ContextFitStore::default();
    let Some(object) = raw.and_then(Value::as_object) else { return store };
    if object.get("version").and_then(Value::as_u64) != Some(u64::from(CONTEXT_FIT_STORE_VERSION)) {
        return store;
    }
    let Some(models) = object.get("models").and_then(Value::as_object) else { return store };
    for (tag, value) in models {
        if tag.is_empty() {
            continue;
        }
        if let Ok(entry) = serde_json::from_value::<ContextFitEntry>(value.clone()) {
            if is_sound(&entry) {
                store.models.insert(tag.clone(), entry);
            }
        }
    }
    store
}

/// The context the sidecar should send: `min(user cap or max, max, env cap)`,
/// or `None` before a successful measurement.
pub fn effective_context(entry: &ContextFitEntry, env_cap: Option<u64>) -> Option<u64> {
    let max = entry.max_context?;
    let capped = entry.user_cap.unwrap_or(max).min(max);
    Some(env_cap.map_or(capped, |cap| capped.min(cap)))
}

fn same_step(a: u64, b: u64) -> bool {
    a / FINGERPRINT_STEP_BYTES == b / FINGERPRINT_STEP_BYTES
}

/// Whether the machine changed since the entry's last attempt. RAM and VRAM
/// compare in 256 MiB steps; a missing VRAM reading is unknown, not a change;
/// the GPU name counts only when both readings came from `nvidia-smi`.
pub fn is_stale(entry: &ContextFitEntry, current: &MachineFingerprint) -> bool {
    let before = &entry.fingerprint;
    if !same_step(before.ram_bytes, current.ram_bytes) || before.unified_memory != current.unified_memory {
        return true;
    }
    match (before.vram_bytes, current.vram_bytes) {
        (Some(a), Some(b)) => !same_step(a, b) || before.gpu_name != current.gpu_name,
        _ => false,
    }
}

/// Whether the startup pass should measure this model: it has no record, or
/// the machine changed since its last attempt. A failure under the current
/// fingerprint is never retried automatically, since the fingerprint is the
/// one of that failed attempt and so is not stale.
pub fn needs_auto_measure(entry: Option<&ContextFitEntry>, current: &MachineFingerprint) -> bool {
    entry.is_none_or(|entry| is_stale(entry, current))
}

/// The last attempt failed on this same machine; automatic triggers leave such a model alone.
pub fn failed_under_current(entry: Option<&ContextFitEntry>, current: &MachineFingerprint) -> bool {
    entry.is_some_and(|entry| entry.last_error.is_some() && !is_stale(entry, current))
}

/// The entry after a successful measurement: a cap still below the new maximum survives.
pub fn with_measured(entry: Option<&ContextFitEntry>, result: &ContextFitResult, fingerprint: &MachineFingerprint, now: &str) -> ContextFitEntry {
    ContextFitEntry {
        max_context: Some(result.max_context),
        trained_context: Some(result.trained_context),
        pool: Some(result.pool),
        verdict: Some(result.verdict),
        measured_at: Some(now.to_string()),
        fingerprint: fingerprint.clone(),
        user_cap: entry.and_then(|entry| entry.user_cap).filter(|cap| *cap < result.max_context),
        attempts: entry.map_or(0, |entry| entry.attempts),
        last_error: None,
        last_attempt_at: Some(now.to_string()),
    }
}

/// The entry after a failed attempt: counted and remembered, with any earlier maximum kept.
pub fn with_failure(entry: Option<&ContextFitEntry>, message: &str, fingerprint: &MachineFingerprint, now: &str) -> ContextFitEntry {
    ContextFitEntry {
        max_context: entry.and_then(|entry| entry.max_context),
        trained_context: entry.and_then(|entry| entry.trained_context),
        pool: entry.and_then(|entry| entry.pool),
        verdict: entry.and_then(|entry| entry.verdict),
        measured_at: entry.and_then(|entry| entry.measured_at.clone()),
        fingerprint: fingerprint.clone(),
        user_cap: entry.and_then(|entry| entry.user_cap),
        attempts: entry.map_or(0, |entry| entry.attempts).saturating_add(1),
        last_error: Some(message.to_string()),
        last_attempt_at: Some(now.to_string()),
    }
}

/// Each model's effective context, for the models that have one.
pub fn effective_limits(store: &ContextFitStore, env_cap: Option<u64>) -> BTreeMap<String, u64> {
    store.models.iter().filter_map(|(tag, entry)| Some((tag.clone(), effective_context(entry, env_cap)?))).collect()
}

/// Validate a requested cap: `null` clears it; a number must be a safe integer
/// in `[min(16384, max), max]`. A cap equal to `max` is stored as no cap.
pub fn clamp_cap(entry: &ContextFitEntry, cap: &Value) -> Result<Option<u64>, CapError> {
    let max = entry.max_context.ok_or(CapError::Unmeasured)?;
    if cap.is_null() {
        return Ok(None);
    }
    let min = CONTEXT_FLOOR.min(max);
    let out_of_range = CapError::OutOfRange { min, max };
    let number = cap.as_f64().ok_or_else(|| out_of_range.clone())?;
    if number.fract() != 0.0 || !(0.0..=MAX_SAFE_INTEGER).contains(&number) {
        return Err(out_of_range);
    }
    // Whole and within the safe range, so the cast is exact.
    let n = number as u64;
    if n < min || n > max {
        return Err(out_of_range);
    }
    Ok((n != max).then_some(n))
}

/// The sidecar overlay: every model with an effective context under
/// `ollama.contextLimits`, tags quoted.
pub fn overlay_yaml(store: &ContextFitStore, env_cap: Option<u64>) -> String {
    let limits: Vec<String> = effective_limits(store, env_cap)
        .iter()
        .filter_map(|(tag, effective)| {
            // A JSON string is a valid YAML double-quoted scalar.
            let quoted = serde_json::to_string(tag).ok()?;
            Some(format!("    {quoted}: {effective}\n"))
        })
        .collect();
    if limits.is_empty() {
        return EMPTY_CONTEXT_LIMITS_OVERLAY.to_string();
    }
    format!("ollama:\n  contextLimits:\n{}", limits.concat())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const MIB: u64 = 1024 * 1024;
    const GIB: u64 = 1024 * MIB;

    fn fingerprint() -> MachineFingerprint {
        MachineFingerprint {
            ram_bytes: 32 * GIB,
            vram_bytes: Some(8 * GIB),
            gpu_name: Some("NVIDIA RTX 4060".into()),
            unified_memory: false,
        }
    }

    fn entry(max_context: Option<u64>) -> ContextFitEntry {
        ContextFitEntry {
            max_context,
            trained_context: Some(131_072),
            pool: max_context.map(|_| ContextPool::Gpu),
            verdict: max_context.map(|_| ContextVerdict::Fits),
            measured_at: max_context.map(|_| "2026-10-07T10:00:00.000Z".to_string()),
            fingerprint: fingerprint(),
            user_cap: None,
            attempts: 0,
            last_error: None,
            last_attempt_at: Some("2026-10-07T10:00:00.000Z".into()),
        }
    }

    fn entry_json() -> Value {
        json!({
            "maxContext": 65536,
            "trainedContext": 131072,
            "pool": "gpu",
            "verdict": "fits",
            "measuredAt": "2026-10-07T10:00:00.000Z",
            "fingerprint": { "ramBytes": 32 * GIB, "vramBytes": 8 * GIB, "gpuName": "NVIDIA RTX 4060", "unifiedMemory": false },
            "userCap": 32768,
            "attempts": 0,
            "lastError": null,
            "lastAttemptAt": "2026-10-07T10:00:00.000Z",
        })
    }

    #[test]
    fn parses_a_valid_store() {
        let raw = json!({ "version": 1, "models": { "qwen3:8b": entry_json() } });
        let store = parse_context_fit_store(Some(&raw));
        let parsed = &store.models["qwen3:8b"];
        assert_eq!(parsed.max_context, Some(65_536));
        assert_eq!(parsed.user_cap, Some(32_768));
        assert_eq!(parsed.pool, Some(ContextPool::Gpu));
        assert_eq!(parsed.fingerprint, fingerprint());
        // It writes back in the same camelCase shape it was read from.
        assert_eq!(serde_json::to_value(&store).unwrap(), raw);
    }

    #[test]
    fn drops_malformed_entries_without_throwing() {
        let mut negative = entry_json();
        negative["maxContext"] = json!(-1);
        let mut fractional = entry_json();
        fractional["userCap"] = json!(1.5);
        let mut cap_above_max = entry_json();
        cap_above_max["userCap"] = json!(131_072);
        let mut no_fingerprint = entry_json();
        no_fingerprint.as_object_mut().unwrap().remove("fingerprint");
        let mut unknown_pool = entry_json();
        unknown_pool["pool"] = json!("disk");
        let mut absurd = entry_json();
        absurd["maxContext"] = json!(1u64 << 40);
        let raw = json!({
            "version": 1,
            "models": {
                "good:latest": entry_json(),
                "negative:latest": negative,
                "fractional:latest": fractional,
                "cap-above-max:latest": cap_above_max,
                "no-fingerprint:latest": no_fingerprint,
                "unknown-pool:latest": unknown_pool,
                "absurd:latest": absurd,
                "": entry_json(),
                "string:latest": "nope",
            }
        });
        let store = parse_context_fit_store(Some(&raw));
        assert_eq!(store.models.keys().collect::<Vec<_>>(), vec!["good:latest"]);
        for garbage in [json!(null), json!([]), json!("x"), json!({ "version": 2, "models": {} }), json!({ "version": 1, "models": [] })] {
            assert_eq!(parse_context_fit_store(Some(&garbage)), ContextFitStore::default(), "{garbage}");
        }
        assert_eq!(parse_context_fit_store(None), ContextFitStore::default());
    }

    #[test]
    fn computes_the_effective_context_from_the_cap_the_max_and_the_env_cap() {
        let mut measured = entry(Some(65_536));
        assert_eq!(effective_context(&measured, None), Some(65_536));
        assert_eq!(effective_context(&measured, Some(32_768)), Some(32_768));
        assert_eq!(effective_context(&measured, Some(131_072)), Some(65_536));
        measured.user_cap = Some(24_576);
        assert_eq!(effective_context(&measured, None), Some(24_576));
        assert_eq!(effective_context(&measured, Some(16_384)), Some(16_384));
        assert_eq!(effective_context(&measured, Some(40_000)), Some(24_576));
    }

    #[test]
    fn returns_no_effective_context_before_a_measurement() {
        let mut failed = entry(None);
        failed.last_error = Some("boom".into());
        assert_eq!(effective_context(&failed, None), None);
        assert_eq!(effective_context(&failed, Some(8_192)), None);
    }

    #[test]
    fn treats_a_null_vram_reading_as_unchanged() {
        let measured = entry(Some(65_536));
        let unknown = MachineFingerprint { vram_bytes: None, gpu_name: None, ..fingerprint() };
        assert!(!is_stale(&measured, &unknown));
        let earlier_unknown = ContextFitEntry { fingerprint: unknown.clone(), ..entry(Some(65_536)) };
        assert!(!is_stale(&earlier_unknown, &fingerprint()));
        let bigger_card = MachineFingerprint { vram_bytes: Some(16 * GIB), ..fingerprint() };
        assert!(is_stale(&measured, &bigger_card));
    }

    #[test]
    fn detects_a_ram_change_at_256_mib_granularity() {
        let measured = entry(Some(65_536));
        let noise = MachineFingerprint { ram_bytes: 32 * GIB + 40 * MIB, ..fingerprint() };
        assert!(!is_stale(&measured, &noise));
        let upgrade = MachineFingerprint { ram_bytes: 64 * GIB, ..fingerprint() };
        assert!(is_stale(&measured, &upgrade));
        let step_down = MachineFingerprint { ram_bytes: 32 * GIB - MIB, ..fingerprint() };
        assert!(is_stale(&measured, &step_down));
        let unified = MachineFingerprint { unified_memory: true, ..fingerprint() };
        assert!(is_stale(&measured, &unified));
    }

    #[test]
    fn ignores_a_gpu_name_change_unless_both_readings_come_from_nvidia_smi() {
        let from_lspci = ContextFitEntry {
            fingerprint: MachineFingerprint { vram_bytes: None, gpu_name: Some("GA106".into()), ..fingerprint() },
            ..entry(Some(65_536))
        };
        assert!(!is_stale(&from_lspci, &fingerprint()));
        let measured = entry(Some(65_536));
        let renamed_by_lspci = MachineFingerprint { vram_bytes: None, gpu_name: Some("GA106".into()), ..fingerprint() };
        assert!(!is_stale(&measured, &renamed_by_lspci));
        let other_card = MachineFingerprint { gpu_name: Some("NVIDIA RTX 4070".into()), ..fingerprint() };
        assert!(is_stale(&measured, &other_card));
    }

    #[test]
    fn needs_an_auto_measure_for_a_model_with_no_entry() {
        assert!(needs_auto_measure(None, &fingerprint()));
        assert!(!needs_auto_measure(Some(&entry(Some(65_536))), &fingerprint()));
        let upgrade = MachineFingerprint { ram_bytes: 64 * GIB, ..fingerprint() };
        assert!(needs_auto_measure(Some(&entry(Some(65_536))), &upgrade));
    }

    #[test]
    fn does_not_auto_retry_a_failure_under_the_current_fingerprint() {
        let failed = ContextFitEntry { attempts: 1, last_error: Some("load failed".into()), ..entry(None) };
        assert!(!needs_auto_measure(Some(&failed), &fingerprint()));
        assert!(failed_under_current(Some(&failed), &fingerprint()));
        assert!(!failed_under_current(Some(&entry(Some(65_536))), &fingerprint()));
        // A failure records the attempt and keeps an earlier maximum and cap.
        let capped = ContextFitEntry { user_cap: Some(32_768), ..entry(Some(65_536)) };
        let again = with_failure(Some(&capped), "boom", &fingerprint(), "now");
        assert_eq!((again.max_context, again.user_cap, again.attempts, again.last_error.as_deref()), (Some(65_536), Some(32_768), 1, Some("boom")));
        // After new hardware the failure no longer applies.
        let upgrade = MachineFingerprint { ram_bytes: 64 * GIB, ..fingerprint() };
        assert!(needs_auto_measure(Some(&failed), &upgrade));
    }

    #[test]
    fn clamps_a_cap_into_the_allowed_range() {
        let measured = entry(Some(65_536));
        assert_eq!(clamp_cap(&measured, &json!(16_384)), Ok(Some(16_384)));
        assert_eq!(clamp_cap(&measured, &json!(40_000)), Ok(Some(40_000)));
        assert_eq!(clamp_cap(&measured, &Value::Null), Ok(None));
        let range = CapError::OutOfRange { min: 16_384, max: 65_536 };
        for bad in [json!(16_383), json!(65_537), json!(0), json!(-1), json!(20_000.5), json!(1e300), json!("32768"), json!(true)] {
            assert_eq!(clamp_cap(&measured, &bad), Err(range.clone()), "{bad}");
        }
        // A model whose maximum sits under the floor accepts down to that maximum only.
        let small = entry(Some(8_192));
        assert_eq!(clamp_cap(&small, &json!(4_096)), Err(CapError::OutOfRange { min: 8_192, max: 8_192 }));
        assert_eq!(clamp_cap(&entry(None), &json!(16_384)), Err(CapError::Unmeasured));
        assert_eq!(clamp_cap(&entry(None), &Value::Null), Err(CapError::Unmeasured));
    }

    #[test]
    fn stores_a_cap_equal_to_the_max_as_null() {
        assert_eq!(clamp_cap(&entry(Some(65_536)), &json!(65_536)), Ok(None));
        assert_eq!(clamp_cap(&entry(Some(8_192)), &json!(8_192)), Ok(None));
    }

    #[test]
    fn quotes_tags_in_the_overlay_yaml() {
        let mut store = ContextFitStore::default();
        store.models.insert("qwen3:8b".into(), entry(Some(65_536)));
        store.models.insert("hf.co/org/model-GGUF:Q4_K_M".into(), ContextFitEntry { user_cap: Some(32_768), ..entry(Some(65_536)) });
        assert_eq!(
            overlay_yaml(&store, None),
            "ollama:\n  contextLimits:\n    \"hf.co/org/model-GGUF:Q4_K_M\": 32768\n    \"qwen3:8b\": 65536\n"
        );
        let parsed: serde_yml::Value = serde_yml::from_str(&overlay_yaml(&store, None)).unwrap();
        assert_eq!(parsed["ollama"]["contextLimits"]["qwen3:8b"].as_u64(), Some(65_536));
    }

    #[test]
    fn leaves_models_without_an_effective_value_out_of_the_overlay() {
        let mut store = ContextFitStore::default();
        assert_eq!(overlay_yaml(&store, None), "ollama:\n  contextLimits: {}\n");
        store.models.insert("failed:latest".into(), ContextFitEntry { last_error: Some("boom".into()), ..entry(None) });
        assert_eq!(overlay_yaml(&store, None), "ollama:\n  contextLimits: {}\n");
        store.models.insert("qwen3:8b".into(), entry(Some(65_536)));
        assert_eq!(overlay_yaml(&store, Some(32_768)), "ollama:\n  contextLimits:\n    \"qwen3:8b\": 32768\n");
    }
}
