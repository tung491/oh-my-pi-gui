//! Bundled Ollama model catalog and the pure sizing that turns it into the
//! onboarding cards. Works offline: nothing here touches the network.
//!
//! Sizing is a port of sai-welcome's unmeasured path
//! (`welcome-rs/welcome-core/src/modelfit`: `need.rs`, `class.rs`,
//! `quality.rs`, `sizing.rs`): every row is classed against this machine's
//! memory, then three tiers are picked and collapsed onto distinct models.
//! Install matching follows `llm/tags.rs` (`model_installed`).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Machine facts for model sizing (`hardware::read_machine`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineFacts {
    pub ram_bytes: u64,
    /// Dedicated GPU memory; `None` when there is no discrete GPU or it cannot be read.
    pub vram_bytes: Option<u64>,
    pub gpu_name: Option<String>,
    pub threads: u32,
    /// GPU and CPU share RAM (Apple Silicon); sizing counts it as RAM only.
    pub unified_memory: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelTier {
    Minimal,
    Recommended,
    Maximum,
}

/// Display order of tiers on a card.
pub const MODEL_TIERS: [ModelTier; 3] = [ModelTier::Minimal, ModelTier::Recommended, ModelTier::Maximum];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelFit {
    Vram,
    Ram,
    Offload,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelSpeed {
    Fast,
    Moderate,
    Slow,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    /// The Ollama tag, as `ollama pull` takes it and as `ollama/<tag>` names the model.
    pub tag: String,
    pub label: String,
    /// Parameter count in billions.
    pub params: f64,
    /// Parameters active per token, in billions (lower than `params` for mixture-of-experts models).
    pub active_params: f64,
    /// Download size.
    pub size_bytes: u64,
    /// Estimated resident footprint at the catalog context length; what decides `fit`.
    pub need_bytes: u64,
    pub fit: ModelFit,
    pub speed: ModelSpeed,
    /// Every tier this card won, in `MODEL_TIERS` order.
    pub tiers: Vec<ModelTier>,
    /// `None` when Ollama did not answer, so whether it is downloaded is unknown.
    pub installed: Option<bool>,
    /// Offered only because nothing else fits: the machine will be short of memory while it runs.
    pub tight: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelScreenStatus {
    Ok,
    /// Cards exist, but none runs well enough to recommend.
    RecommendedOmitted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EmptyReason {
    TooSmall,
    Unreadable,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelScreen {
    pub machine: Option<MachineFacts>,
    pub choices: Vec<ModelChoice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<ModelScreenStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub empty_reason: Option<EmptyReason>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OllamaCatalogEntry {
    /// The reference `ollama pull` takes; may omit the tag, as the `hf.co` refs do.
    pub tag: &'static str,
    pub label: &'static str,
    /// Parameter count in billions.
    pub params: f64,
    /// Parameters active per token, in billions.
    pub active_params: f64,
    /// Size of the model file.
    pub size_bytes: u64,
    /// Quantization rank: higher is better quality; breaks a parameter tie.
    pub quant_rank: u32,
}

/// The three QAT 4-bit Gemma 4 rows sai-welcome suggests (`SUGGEST_FAMILIES = ["gemma"]`).
/// Sizes, parameter counts and quant rank come from sai-welcome
/// `welcome-core/assets/hfmodels.json.gz` (fetched 2026-08-27). All three files
/// are Q4_0 (rank 10); none ends in `-q4_0.gguf`, so each ref carries no quant tag.
pub const OLLAMA_CATALOG: [OllamaCatalogEntry; 3] = [
    OllamaCatalogEntry {
        tag: "hf.co/google/gemma-4-E2B-it-qat-q4_0-gguf",
        label: "Gemma 4 E2B",
        params: 5.1,
        active_params: 2.3,
        size_bytes: 3_349_516_256,
        quant_rank: 10,
    },
    OllamaCatalogEntry {
        tag: "hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf",
        label: "Gemma 4 E4B",
        params: 8.0,
        active_params: 4.5,
        size_bytes: 5_154_941_280,
        quant_rank: 10,
    },
    OllamaCatalogEntry {
        tag: "hf.co/google/gemma-4-26B-A4B-it-qat-q4_0-gguf",
        label: "Gemma 4 26B A4B",
        params: 25.2,
        active_params: 3.8,
        size_bytes: 14_439_363_584,
        quant_rank: 10,
    },
];

/// Fitted proportional sizing ratio, 102/100, kept integral.
const OVERHEAD_NUM: u64 = 102;
const OVERHEAD_DEN: u64 = 100;
/// Fitted constant resident overhead (4.25 GiB); it covers runtime and context, so there is no separate KV term.
const FIXED_OVERHEAD_BYTES: u64 = 4_563_402_752;

/// GPU memory held back for the compositor and framebuffer.
const VRAM_RESERVE_BYTES: u64 = 1024 * 1024 * 1024;
/// The RAM reserve on a small machine, and the floor the proportional reserve never drops below.
const RAM_RESERVE_FLOOR_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// The reserve becomes a quarter of RAM once a quarter exceeds the floor (16 GiB).
const RAM_RESERVE_DIVISOR: u64 = 4;

/// Past this thread count, more threads stop buying decode speed.
const CPU_THREAD_PLATEAU: u32 = 16;
/// Below this thread count, CPU decode stops being near-interactive.
const CPU_THREAD_FLOOR: u32 = 8;
/// Past this active-parameter count (billions), CPU decode stops being near-interactive.
const CPU_ACTIVE_BUDGET: f64 = 9.0;

/// Rows below this parameter count (billions) are never suggested.
const MIN_PARAMS_B: f64 = 3.0;

/// Estimated resident footprint of a model file of `size_bytes`.
pub fn need_bytes(size_bytes: u64) -> u64 {
    size_bytes.saturating_mul(OVERHEAD_NUM).div_ceil(OVERHEAD_DEN) + FIXED_OVERHEAD_BYTES
}

/// RAM held back for the system and other apps: a quarter of RAM, never less than 4 GiB.
pub fn ram_reserve(ram_bytes: u64) -> u64 {
    let quarter = ram_bytes / RAM_RESERVE_DIVISOR;
    quarter.max(RAM_RESERVE_FLOOR_BYTES)
}

/// Where a model of this footprint runs, or `None` when it does not fit. A row
/// must fit one pool: VRAM plus RAM is never a budget. Unified memory adds no
/// VRAM, because sai-welcome counts integrated graphics as RAM only.
pub fn fit_of(need: u64, machine: &MachineFacts) -> Option<ModelFit> {
    let vram_budget = machine.vram_bytes.unwrap_or(0).saturating_sub(VRAM_RESERVE_BYTES);
    let ram_budget = machine.ram_bytes.saturating_sub(ram_reserve(machine.ram_bytes));
    if vram_budget > 0 && need <= vram_budget {
        Some(ModelFit::Vram)
    } else if vram_budget == 0 && need <= ram_budget {
        Some(ModelFit::Ram)
    } else if need <= ram_budget {
        Some(ModelFit::Offload)
    } else {
        None
    }
}

/// An expected-interactivity class, never a tokens-per-second figure.
pub fn speed_of(fit: ModelFit, active_params: f64, threads: u32) -> ModelSpeed {
    if fit == ModelFit::Vram {
        return ModelSpeed::Fast;
    }
    let effective = threads.min(CPU_THREAD_PLATEAU);
    if active_params <= CPU_ACTIVE_BUDGET && effective >= CPU_THREAD_FLOOR {
        ModelSpeed::Moderate
    } else {
        ModelSpeed::Slow
    }
}

/// The name Ollama lists for `tag`, or `None` when it is not installed.
/// Case-insensitive; an exact `name:tag` matches, a bare name matches any tag
/// of it at the `:` boundary, and blank input matches nothing.
pub fn installed_name(installed_tags: &[String], tag: &str) -> Option<String> {
    let want = tag.trim().to_lowercase();
    if want.is_empty() {
        return None;
    }
    for name in installed_tags {
        let got = name.to_lowercase();
        if got == want || got.starts_with(&format!("{want}:")) {
            return Some(name.clone());
        }
    }
    None
}

#[cfg(test)]
pub fn is_installed(installed_tags: &[String], tag: &str) -> bool {
    installed_name(installed_tags, tag).is_some()
}

/// `ref` with `:latest` appended when its last path segment carries no tag, as Ollama lists a fresh pull.
pub fn with_default_tag(ref_: &str) -> String {
    let name = ref_.rsplit('/').next().unwrap_or(ref_);
    if name.contains(':') {
        ref_.to_string()
    } else {
        format!("{ref_}:latest")
    }
}

#[derive(Clone, Copy, Debug)]
struct Sized<'a> {
    entry: &'a OllamaCatalogEntry,
    need: u64,
    fit: ModelFit,
    speed: ModelSpeed,
}

/// True when `a` ranks above `b`: more parameters, then higher quant rank, then tag ascending.
fn by_quality(a: &OllamaCatalogEntry, b: &OllamaCatalogEntry) -> bool {
    if a.params != b.params {
        return a.params > b.params;
    }
    if a.quant_rank != b.quant_rank {
        return a.quant_rank > b.quant_rank;
    }
    a.tag < b.tag
}

fn quality_order(a: &Sized, b: &Sized) -> std::cmp::Ordering {
    if by_quality(a.entry, b.entry) {
        std::cmp::Ordering::Less
    } else if by_quality(b.entry, a.entry) {
        std::cmp::Ordering::Greater
    } else {
        std::cmp::Ordering::Equal
    }
}

/// Sizes the catalog against this machine and picks up to three cards:
/// maximum = the best-quality row that fits; recommended = the first that fits
/// GPU memory, else the first that is not slow, else none (`recommended-omitted`);
/// minimal = the smallest need. Tiers on the same model share one card, never
/// padded to three.
///
/// When no row fits at all but RAM still exceeds the smallest row's download,
/// that row is offered alone as a slow, tight-fit minimal card.
///
/// `installed_tags` of `None` means Ollama did not answer, so every card's
/// `installed` is unknown rather than false.
pub fn choose_models(
    machine: Option<&MachineFacts>,
    catalog: &[OllamaCatalogEntry],
    installed_tags: Option<&[String]>,
) -> ModelScreen {
    let Some(machine) = machine.filter(|m| m.ram_bytes > 0) else {
        return ModelScreen { machine: None, choices: Vec::new(), status: None, empty_reason: Some(EmptyReason::Unreadable) };
    };

    let to_choice = |row: &Sized, tiers: Vec<ModelTier>, tight: bool| -> ModelChoice {
        let listed = installed_tags.and_then(|tags| installed_name(tags, row.entry.tag));
        ModelChoice {
            tag: listed.clone().unwrap_or_else(|| with_default_tag(row.entry.tag)),
            label: row.entry.label.to_string(),
            params: row.entry.params,
            active_params: row.entry.active_params,
            size_bytes: row.entry.size_bytes,
            need_bytes: row.need,
            fit: row.fit,
            speed: row.speed,
            tiers,
            installed: installed_tags.map(|_| listed.is_some()),
            tight,
        }
    };

    let mut pool: Vec<Sized> = Vec::new();
    let mut any_fits = false;
    for entry in catalog {
        if entry.size_bytes == 0 {
            continue;
        }
        let need = need_bytes(entry.size_bytes);
        let fit = fit_of(need, machine);
        if fit.is_some() {
            any_fits = true;
        }
        if let Some(fit) = fit {
            if entry.params >= MIN_PARAMS_B {
                pool.push(Sized { entry, need, fit, speed: speed_of(fit, entry.active_params, machine.threads) });
            }
        }
    }

    if pool.is_empty() {
        let mut smallest: Option<&OllamaCatalogEntry> = None;
        for entry in catalog {
            if entry.size_bytes == 0 {
                continue;
            }
            if smallest.is_none_or(|s| need_bytes(entry.size_bytes) < need_bytes(s.size_bytes)) {
                smallest = Some(entry);
            }
        }
        // Rows that fit but fall under the parameter floor are not "nothing fits".
        if any_fits || smallest.is_none_or(|s| machine.ram_bytes <= s.size_bytes) {
            return ModelScreen {
                machine: Some(machine.clone()),
                choices: Vec::new(),
                status: None,
                empty_reason: Some(EmptyReason::TooSmall),
            };
        }
        // `smallest` is `Some` here: the branch above returned unless it was `None`.
        let Some(smallest) = smallest else {
            return ModelScreen { machine: Some(machine.clone()), choices: Vec::new(), status: None, empty_reason: Some(EmptyReason::TooSmall) };
        };
        let row = Sized { entry: smallest, need: need_bytes(smallest.size_bytes), fit: ModelFit::Ram, speed: ModelSpeed::Slow };
        return ModelScreen {
            machine: Some(machine.clone()),
            choices: vec![to_choice(&row, vec![ModelTier::Minimal], true)],
            status: Some(ModelScreenStatus::RecommendedOmitted),
            empty_reason: None,
        };
    }

    pool.sort_by(quality_order);
    let maximum = pool[0];
    let recommended = pool.iter().find(|row| row.fit == ModelFit::Vram).or_else(|| pool.iter().find(|row| row.speed != ModelSpeed::Slow));
    let mut minimal = pool[0];
    for row in &pool {
        if row.need < minimal.need {
            minimal = *row;
        }
    }

    let mut choices: Vec<ModelChoice> = Vec::new();
    let mut card_index: HashMap<&'static str, usize> = HashMap::new();
    for tier in MODEL_TIERS {
        let row = match tier {
            ModelTier::Minimal => Some(minimal),
            ModelTier::Recommended => recommended.copied(),
            ModelTier::Maximum => Some(maximum),
        };
        let Some(row) = row else { continue };
        if let Some(&index) = card_index.get(row.entry.tag) {
            choices[index].tiers.push(tier);
            continue;
        }
        let card = to_choice(&row, vec![tier], false);
        card_index.insert(row.entry.tag, choices.len());
        choices.push(card);
    }
    ModelScreen {
        machine: Some(machine.clone()),
        choices,
        status: Some(if recommended.is_some() { ModelScreenStatus::Ok } else { ModelScreenStatus::RecommendedOmitted }),
        empty_reason: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * 1024 * 1024;
    const E2B: &str = "hf.co/google/gemma-4-E2B-it-qat-q4_0-gguf";
    const E4B: &str = "hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf";
    const A4B: &str = "hf.co/google/gemma-4-26B-A4B-it-qat-q4_0-gguf";

    fn machine(ram_bytes: u64, vram_bytes: Option<u64>, unified_memory: bool, threads: u32) -> MachineFacts {
        MachineFacts { ram_bytes, vram_bytes, gpu_name: None, unified_memory, threads }
    }

    fn base_machine() -> MachineFacts {
        machine(16 * GIB, None, false, 8)
    }

    fn cards(machine: &MachineFacts, installed: Option<&[String]>) -> Vec<(String, Vec<ModelTier>, ModelSpeed)> {
        choose_models(Some(machine), &OLLAMA_CATALOG, installed).choices.into_iter().map(|c| (c.tag, c.tiers, c.speed)).collect()
    }

    #[test]
    fn holds_the_three_gemma_4_rows_smallest_first_with_bare_unique_refs() {
        let tags: Vec<&str> = OLLAMA_CATALOG.iter().map(|e| e.tag).collect();
        assert_eq!(tags, [E2B, E4B, A4B]);
        let sizes: Vec<u64> = OLLAMA_CATALOG.iter().map(|e| e.size_bytes).collect();
        let mut sorted = sizes.clone();
        sorted.sort_unstable();
        assert_eq!(sizes, sorted);
        assert!(OLLAMA_CATALOG.iter().all(|e| !e.tag.contains(':')));
    }

    #[test]
    fn estimates_need_as_the_file_at_102_plus_the_fixed_4_25_gib_rounded_up() {
        assert_eq!(need_bytes(1_000_000_000), 5_583_402_752);
        assert_eq!(need_bytes(100), 102 + 4_563_402_752);
        assert_eq!(need_bytes(101), 104 + 4_563_402_752);
        assert_eq!(need_bytes(3_349_516_256), 7_979_909_334);
    }

    #[test]
    fn holds_back_a_quarter_of_ram_never_less_than_4_gib() {
        assert_eq!(fit_of(4 * GIB, &machine(8 * GIB, None, false, 8)), Some(ModelFit::Ram));
        assert_eq!(fit_of(4 * GIB + 1, &machine(8 * GIB, None, false, 8)), None);
        assert_eq!(fit_of(48 * GIB, &machine(64 * GIB, None, false, 8)), Some(ModelFit::Ram));
        assert_eq!(fit_of(48 * GIB + 1, &machine(64 * GIB, None, false, 8)), None);
    }

    #[test]
    fn classes_a_gpu_as_vram_within_its_budget_then_offload_against_ram_alone_never_the_sum() {
        let facts = machine(16 * GIB, Some(12 * GIB), false, 8);
        assert_eq!(fit_of(11 * GIB, &facts), Some(ModelFit::Vram));
        assert_eq!(fit_of(11 * GIB + 1, &facts), Some(ModelFit::Offload));
        assert_eq!(fit_of(12 * GIB, &facts), Some(ModelFit::Offload));
        assert_eq!(fit_of(12 * GIB + 1, &facts), None);
    }

    #[test]
    fn treats_a_gpu_at_or_under_the_1_gib_reserve_as_no_gpu() {
        assert_eq!(fit_of(GIB, &machine(16 * GIB, Some(GIB), false, 8)), Some(ModelFit::Ram));
    }

    #[test]
    fn gives_unified_memory_no_graphics_budget() {
        assert_eq!(fit_of(GIB, &machine(16 * GIB, None, true, 8)), Some(ModelFit::Ram));
    }

    #[test]
    fn rates_speed_by_where_it_runs_active_parameters_and_threads() {
        assert_eq!(speed_of(ModelFit::Vram, 30.0, 1), ModelSpeed::Fast);
        assert_eq!(speed_of(ModelFit::Ram, 9.0, 8), ModelSpeed::Moderate);
        assert_eq!(speed_of(ModelFit::Offload, 9.0, 8), ModelSpeed::Moderate);
        assert_eq!(speed_of(ModelFit::Ram, 9.1, 8), ModelSpeed::Slow);
        assert_eq!(speed_of(ModelFit::Ram, 4.5, 7), ModelSpeed::Slow);
        assert_eq!(speed_of(ModelFit::Ram, 4.5, 64), ModelSpeed::Moderate);
    }

    #[test]
    fn matches_an_exact_name_or_a_bare_name_against_any_of_its_tags() {
        assert!(is_installed(&["gemma-2:9b".to_string()], "gemma-2:9b"));
        assert!(is_installed(&["gemma4:26b".to_string()], "gemma4"));
        assert!(is_installed(&[format!("{E4B}:latest")], E4B));
    }

    #[test]
    fn ignores_case_on_both_sides() {
        assert!(is_installed(&["HF.CO/Google/Gemma-4-E4B-IT-QAT-Q4_0-GGUF:LATEST".to_string()], E4B));
    }

    #[test]
    fn rejects_a_shared_prefix_that_is_not_a_tag_boundary_and_a_blank_request() {
        assert!(!is_installed(&["gemma-2:9b".to_string()], "gemma"));
        assert!(!is_installed(&["gemma-2:9b".to_string()], "   "));
        assert!(!is_installed(&[], "gemma"));
    }

    #[test]
    fn name_cases() {
        let both = vec![ModelTier::Recommended, ModelTier::Maximum];
        let e2b = format!("{E2B}:latest");
        let e4b = format!("{E4B}:latest");
        let a4b = format!("{A4B}:latest");
        type ExpectedCard = (String, Vec<ModelTier>, ModelSpeed);
        let cases: [(MachineFacts, Vec<ExpectedCard>); 4] = [
            (base_machine(), vec![(e2b.clone(), vec![ModelTier::Minimal], ModelSpeed::Moderate), (e4b.clone(), both.clone(), ModelSpeed::Moderate)]),
            (
                machine(32 * GIB, None, false, 8),
                vec![(e2b.clone(), vec![ModelTier::Minimal], ModelSpeed::Moderate), (a4b.clone(), both.clone(), ModelSpeed::Moderate)],
            ),
            (
                machine(16 * GIB, Some(12 * GIB), false, 8),
                vec![(e2b.clone(), vec![ModelTier::Minimal], ModelSpeed::Fast), (e4b.clone(), both.clone(), ModelSpeed::Fast)],
            ),
            (
                machine(64 * GIB, Some(24 * GIB), false, 16),
                vec![(e2b.clone(), vec![ModelTier::Minimal], ModelSpeed::Fast), (a4b.clone(), both.clone(), ModelSpeed::Fast)],
            ),
        ];
        for (facts, expected) in cases {
            let screen = choose_models(Some(&facts), &OLLAMA_CATALOG, Some(&[]));
            assert_eq!(cards(&facts, Some(&[])), expected);
            assert_eq!(screen.status, Some(ModelScreenStatus::Ok));
            assert!(screen.choices.iter().all(|c| !c.tight));
        }
    }

    #[test]
    fn omits_the_recommended_card_when_every_fit_is_slow() {
        let facts = machine(16 * GIB, None, false, 4);
        let screen = choose_models(Some(&facts), &OLLAMA_CATALOG, Some(&[]));
        let got: Vec<(String, Vec<ModelTier>, ModelSpeed)> = screen.choices.iter().map(|c| (c.tag.clone(), c.tiers.clone(), c.speed)).collect();
        assert_eq!(
            got,
            vec![
                (format!("{E2B}:latest"), vec![ModelTier::Minimal], ModelSpeed::Slow),
                (format!("{E4B}:latest"), vec![ModelTier::Maximum], ModelSpeed::Slow),
            ]
        );
        assert_eq!(screen.status, Some(ModelScreenStatus::RecommendedOmitted));
    }

    #[test]
    fn carries_the_active_parameters_and_the_need_of_each_row() {
        let facts = base_machine();
        let screen = choose_models(Some(&facts), &OLLAMA_CATALOG, Some(&[]));
        let minimal = &screen.choices[0];
        let top = &screen.choices[1];
        assert_eq!((minimal.params, minimal.active_params, minimal.need_bytes), (5.1, 2.3, 7_979_909_334));
        assert_eq!((top.params, top.active_params), (8.0, 4.5));
    }

    #[test]
    fn offers_the_smallest_row_as_a_tight_slow_card_when_nothing_fits_but_ram_exceeds_its_download() {
        let facts = machine(8 * GIB, None, false, 8);
        let screen = choose_models(Some(&facts), &OLLAMA_CATALOG, Some(&[]));
        assert_eq!(screen.empty_reason, None);
        assert_eq!(screen.status, Some(ModelScreenStatus::RecommendedOmitted));
        assert_eq!(screen.choices.len(), 1);
        let card = &screen.choices[0];
        assert_eq!(card.tag, format!("{E2B}:latest"));
        assert_eq!(card.tiers, vec![ModelTier::Minimal]);
        assert_eq!(card.fit, ModelFit::Ram);
        assert_eq!(card.speed, ModelSpeed::Slow);
        assert!(card.tight);
        assert_eq!(card.installed, Some(false));
    }

    #[test]
    fn says_the_machine_is_too_small_when_ram_does_not_even_hold_the_smallest_download() {
        let facts = machine(2 * GIB, None, false, 8);
        let screen = choose_models(Some(&facts), &OLLAMA_CATALOG, Some(&[]));
        assert_eq!(screen.machine, Some(facts));
        assert!(screen.choices.is_empty());
        assert_eq!(screen.empty_reason, Some(EmptyReason::TooSmall));
    }

    #[test]
    fn says_the_machine_is_unreadable_when_there_are_no_facts() {
        let screen = choose_models(None, &OLLAMA_CATALOG, Some(&[]));
        assert_eq!(screen.machine, None);
        assert!(screen.choices.is_empty());
        assert_eq!(screen.empty_reason, Some(EmptyReason::Unreadable));
        let zero = machine(0, None, false, 8);
        assert_eq!(choose_models(Some(&zero), &OLLAMA_CATALOG, Some(&[])).empty_reason, Some(EmptyReason::Unreadable));
    }

    #[test]
    fn uses_the_name_ollama_lists_for_an_installed_card() {
        let listed = "HF.CO/Google/Gemma-4-E4B-IT-QAT-Q4_0-GGUF:LATEST".to_string();
        let facts = base_machine();
        let installed = [format!("{E4B}:latest"), "gemma-2:9b".to_string()];
        let screen = choose_models(Some(&facts), &OLLAMA_CATALOG, Some(&installed));
        let got: Vec<(String, Option<bool>)> = screen.choices.iter().map(|c| (c.tag.clone(), c.installed)).collect();
        assert_eq!(got, vec![(format!("{E2B}:latest"), Some(false)), (format!("{E4B}:latest"), Some(true))]);
        let mixed = [listed.clone()];
        let mixed_screen = choose_models(Some(&facts), &OLLAMA_CATALOG, Some(&mixed));
        let mixed_case = &mixed_screen.choices[1];
        assert_eq!((mixed_case.tag.clone(), mixed_case.installed), (listed, Some(true)));
    }

    #[test]
    fn appends_latest_to_an_untagged_ref_that_is_not_installed_so_a_fresh_pull_keeps_the_same_id() {
        let facts = base_machine();
        let installed = ["gemma".to_string()];
        let screen = choose_models(Some(&facts), &OLLAMA_CATALOG, Some(&installed));
        let got: Vec<(String, Option<bool>)> = screen.choices.iter().map(|c| (c.tag.clone(), c.installed)).collect();
        assert_eq!(got, vec![(format!("{E2B}:latest"), Some(false)), (format!("{E4B}:latest"), Some(false))]);
        let tagged = [OllamaCatalogEntry { tag: "gemma3:4b", ..OLLAMA_CATALOG[0] }];
        assert_eq!(choose_models(Some(&facts), &tagged, Some(&[])).choices[0].tag, "gemma3:4b");
        assert_eq!(OLLAMA_CATALOG[0].tag, E2B);
    }

    #[test]
    fn leaves_install_state_unknown_when_ollama_did_not_answer() {
        let facts = base_machine();
        let screen = choose_models(Some(&facts), &OLLAMA_CATALOG, None);
        let got: Vec<(String, Option<bool>)> = screen.choices.iter().map(|c| (c.tag.clone(), c.installed)).collect();
        assert_eq!(got, vec![(format!("{E2B}:latest"), None), (format!("{E4B}:latest"), None)]);
    }

    #[test]
    fn breaks_a_parameter_tie_by_quant_rank_then_by_ref_ascending() {
        let facts = base_machine();
        let base = OllamaCatalogEntry { tag: "", label: "X", params: 8.0, active_params: 4.0, size_bytes: GIB, quant_rank: 10 };
        let catalog = [
            OllamaCatalogEntry { tag: "b", quant_rank: 10, ..base },
            OllamaCatalogEntry { tag: "a", quant_rank: 10, ..base },
            OllamaCatalogEntry { tag: "c", quant_rank: 20, ..base },
        ];
        let screen = choose_models(Some(&facts), &catalog, Some(&[]));
        let got: Vec<(String, Vec<ModelTier>)> = screen.choices.iter().map(|c| (c.tag.clone(), c.tiers.clone())).collect();
        assert_eq!(got, vec![("c:latest".to_string(), vec![ModelTier::Minimal, ModelTier::Recommended, ModelTier::Maximum])]);
        let tied = choose_models(Some(&facts), &catalog[0..2], Some(&[]));
        let tied_tags: Vec<String> = tied.choices.iter().map(|c| c.tag.clone()).collect();
        assert_eq!(tied_tags, vec!["a:latest".to_string()]);
    }

    #[test]
    fn never_suggests_a_row_under_3b_parameters() {
        let facts = base_machine();
        let catalog = [OllamaCatalogEntry { tag: "tiny", label: "Tiny", params: 2.9, active_params: 2.9, size_bytes: GIB, quant_rank: 10 }];
        let screen = choose_models(Some(&facts), &catalog, Some(&[]));
        assert!(screen.choices.is_empty());
        assert_eq!(screen.empty_reason, Some(EmptyReason::TooSmall));
    }
}
