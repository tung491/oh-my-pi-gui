//! Measures the largest context a local Ollama model holds without leaving its
//! memory pool: load it at an ascending ladder of `num_ctx` values and read
//! `/api/ps` after each load. On a GPU a rung fits while the whole model stays
//! in VRAM (`size_vram >= size`); from system memory, and always on unified
//! memory, it fits while `size` stays within the RAM budget. Ollama spills to
//! the CPU rather than failing, so a spill is read, never caught.
//!
//! Plain HTTP to the daemon, like `warm.rs`; never fails.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::catalog::{ram_reserve, MachineFacts};
use super::local::{is_local_ollama_row, is_loopback_base_url, OllamaTagRow};
use super::pull::is_valid_model_tag;

/// The smallest context worth running the agent at: its first request already needs about this much.
pub const CONTEXT_FLOOR: u64 = 16_384;
/// The ceiling assumed when Ollama reports no plausible trained context.
pub const UNKNOWN_TRAINED_CONTEXT: u64 = 131_072;
/// A trained context above this (16M tokens) is treated as unknown.
const MAX_PLAUSIBLE_CONTEXT: u64 = 1 << 24;
/// A rung predicted past the budget by more than this factor is certain to fail and is never loaded.
const PREDICTION_SLACK: f64 = 1.1;
/// Keep each probe resident just long enough to read `/api/ps`.
const PROBE_KEEP_ALIVE: &str = "30s";

/// Where a measured model runs: wholly on the GPU, or from system memory (always so on unified memory).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContextPool {
    Gpu,
    Ram,
}

/// `Spills`/`ExceedsRam`: even the smallest context tried did not fit, so `max_context` is that floor.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ContextVerdict {
    Fits,
    Spills,
    ExceedsRam,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextFitResult {
    /// The largest `num_ctx` that fits the pool, or the floor when none did.
    pub max_context: u64,
    /// The model's trained context; 131072 when Ollama reports none or an implausible one.
    pub trained_context: u64,
    pub pool: ContextPool,
    pub verdict: ContextVerdict,
}

/// How a measurement ended. `Interrupted` (a sidecar became busy, or another
/// model shared the daemon) is retried later and never recorded as a failure;
/// `Error` is a failed attempt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MeasureOutcome {
    Measured { result: ContextFitResult },
    Interrupted,
    Error { message: String },
}

/// `Running` comes from the engine; the scheduler reports `Queued`, `Done` and `Error`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContextFitState {
    Queued,
    Running,
    Done,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextFitProgress {
    pub tag: String,
    pub state: ContextFitState,
    /// The context being loaded while `Running`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub num_ctx: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContextFitTiming {
    /// Base timeout of one load; the first load adds `probe_ms_per_size_unit` per `probe_size_unit_bytes` of the model file.
    pub probe_timeout_ms: u64,
    pub probe_ms_per_size_unit: u64,
    pub probe_size_unit_bytes: u64,
    /// `/api/show`, `/api/ps` and the unload request.
    pub request_timeout_ms: u64,
    /// How long to wait for `/api/ps` to empty before re-probing a failing rung.
    pub unload_wait_ms: u64,
    pub unload_poll_ms: u64,
}

impl Default for ContextFitTiming {
    fn default() -> Self {
        Self {
            probe_timeout_ms: 120_000,
            probe_ms_per_size_unit: 1_000,
            probe_size_unit_bytes: 50_000_000,
            request_timeout_ms: 10_000,
            unload_wait_ms: 10_000,
            unload_poll_ms: 250,
        }
    }
}

pub struct MeasureContextFitInput<'a> {
    pub base_url: &'a str,
    /// The model's `/api/tags` row; `name` is the tag measured.
    pub row: &'a OllamaTagRow,
    pub machine: &'a MachineFacts,
    /// The largest context the sidecar can send for this model (its global cap);
    /// no rung above it is loaded. `trained_context` is still reported unchanged.
    pub max_context: Option<u64>,
    /// Re-checked before every load; true ends the run as `Interrupted`.
    pub is_busy: &'a (dyn Fn() -> bool + Send + Sync),
    pub on_progress: &'a (dyn Fn(ContextFitProgress) + Send + Sync),
    pub timing: ContextFitTiming,
}

/// The rungs to try, ascending: the floor doubled while it stays under the ceiling, then the ceiling itself.
pub fn context_ladder(ceiling: u64) -> Vec<u64> {
    let floor = CONTEXT_FLOOR.min(ceiling);
    let mut ladder = Vec::new();
    let mut n = floor;
    while n < ceiling {
        ladder.push(n);
        n *= 2;
    }
    ladder.push(ceiling);
    ladder
}

/// A JSON number that is a whole value in `[1, 2^24]`, as `Number.isSafeInteger` plus the range reads it.
fn plausible_context(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    let valid = number.fract() == 0.0 && (1.0..=MAX_PLAUSIBLE_CONTEXT as f64).contains(&number);
    // The range check above makes the cast exact.
    valid.then_some(number as u64)
}

/// `<general.architecture>.context_length` from `/api/show`, or `None` when absent or implausible.
pub fn trained_context_of(show: &Value) -> Option<u64> {
    let info = show.get("model_info")?.as_object()?;
    let arch = info.get("general.architecture")?.as_str().filter(|a| !a.is_empty())?;
    plausible_context(info.get(&format!("{arch}.context_length"))?)
}

/// The Modelfile's `num_ctx` from `/api/show`'s `parameters` text, or `None`.
pub fn modelfile_num_ctx(show: &Value) -> Option<u64> {
    let parameters = show.get("parameters")?.as_str()?;
    for line in parameters.lines() {
        let Some(rest) = line.trim().strip_prefix("num_ctx") else { continue };
        if !rest.starts_with(char::is_whitespace) {
            continue;
        }
        let digits = rest.trim();
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        return digits.parse::<u64>().ok().and_then(|n| plausible_context(&json!(n)));
    }
    None
}

/// Ordinary least squares `size = a + b·n` over the fitting probes, evaluated at `n`; `None` under two points.
pub fn predict_size(points: &[(f64, f64)], n: f64) -> Option<f64> {
    if points.len() < 2 {
        return None;
    }
    let count = points.len() as f64;
    let mean_n = points.iter().map(|(x, _)| x).sum::<f64>() / count;
    let mean_s = points.iter().map(|(_, y)| y).sum::<f64>() / count;
    let (mut cov, mut var_n) = (0.0, 0.0);
    for (x, y) in points {
        cov += (x - mean_n) * (y - mean_s);
        var_n += (x - mean_n).powi(2);
    }
    if var_n == 0.0 {
        return None;
    }
    Some(mean_s + cov / var_n * (n - mean_n))
}

/// Why a run stopped early.
enum Stop {
    /// Outcome `Error`.
    Failed(String),
    /// The probe cannot be trusted; outcome `Interrupted`.
    Discarded(String),
}

struct PsEntry {
    name: String,
    model: String,
    size: Option<f64>,
    size_vram: Option<f64>,
    context_length: Option<u64>,
}

struct Probe {
    size: f64,
    size_vram: f64,
    /// The context Ollama actually loaded; below the requested one when it clamped at the trained context.
    context_length: u64,
}

/// One probe's reading: whether it fits, and the context Ollama clamped to, if it did.
struct Reading {
    fits: bool,
    clamped_at: Option<u64>,
}

enum LoadResult {
    Loaded(Probe),
    /// HTTP 500: Ollama has no memory for this load.
    Refused,
}

fn byte_count(value: Option<&Value>) -> Option<f64> {
    value?.as_f64().filter(|v| v.is_finite() && *v >= 0.0)
}

fn snippet(text: &str) -> &str {
    let mut end = text.len().min(300);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn note(message: String) {
    crate::runtime_log::note("ollama", message, json!({}));
}

struct Daemon<'a> {
    client: reqwest::Client,
    base_url: &'a str,
    tag: &'a str,
    timing: ContextFitTiming,
}

impl Daemon<'_> {
    /// POST `body` as JSON, or GET when it is `None`. Network failures and timeouts end the run.
    async fn send(&self, path: &str, body: Option<Value>, timeout_ms: u64) -> Result<(u16, String), Stop> {
        let url = format!("{}{path}", self.base_url);
        let request = match body {
            Some(body) => self.client.post(url).json(&body),
            None => self.client.get(url),
        };
        let response = request
            .timeout(Duration::from_millis(timeout_ms))
            .send()
            .await
            .map_err(|error| Stop::Failed(format!("{path} failed: {error}")))?;
        let status = response.status().as_u16();
        let text = response.text().await.map_err(|error| Stop::Failed(format!("{path} failed: {error}")))?;
        Ok((status, text))
    }

    async fn json(&self, path: &str, body: Option<Value>) -> Result<Value, Stop> {
        let (status, text) = self.send(path, body, self.timing.request_timeout_ms).await?;
        if !(200..=299).contains(&status) {
            return Err(Stop::Failed(format!("{path} answered HTTP {status}: {}", snippet(&text))));
        }
        serde_json::from_str(&text).map_err(|_| Stop::Failed(format!("{path} returned invalid JSON")))
    }

    async fn show(&self) -> Result<Value, Stop> {
        self.json("/api/show", Some(json!({ "model": self.tag }))).await
    }

    async fn ps(&self) -> Result<Vec<PsEntry>, Stop> {
        let body = self.json("/api/ps", None).await?;
        let models = body
            .get("models")
            .and_then(Value::as_array)
            .ok_or_else(|| Stop::Failed("/api/ps returned an unexpected shape".into()))?;
        Ok(models
            .iter()
            .filter(|row| row.is_object())
            .map(|row| PsEntry {
                name: row.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
                model: row.get("model").and_then(Value::as_str).unwrap_or_default().to_string(),
                size: byte_count(row.get("size")),
                size_vram: byte_count(row.get("size_vram")),
                context_length: row.get("context_length").and_then(Value::as_u64),
            })
            .collect())
    }

    fn is_ours(&self, entry: &PsEntry) -> bool {
        entry.name.eq_ignore_ascii_case(self.tag) || entry.model.eq_ignore_ascii_case(self.tag)
    }

    /// Load at `num_ctx`, then read `/api/ps`. HTTP 500 (no memory for it) is `Refused`.
    async fn load(&self, num_ctx: u64, timeout_ms: u64) -> Result<LoadResult, Stop> {
        let body = json!({
            "model": self.tag,
            "keep_alive": PROBE_KEEP_ALIVE,
            "stream": false,
            "options": { "num_ctx": num_ctx },
        });
        let (status, text) = self.send("/api/generate", Some(body), timeout_ms).await?;
        if status == 500 {
            return Ok(LoadResult::Refused);
        }
        if !(200..=299).contains(&status) {
            return Err(Stop::Failed(format!(
                "loading at num_ctx {num_ctx} answered HTTP {status}: {}",
                snippet(&text)
            )));
        }
        let entries = self.ps().await?;
        let Some(entry) = entries.iter().find(|candidate| self.is_ours(candidate)) else {
            return Err(Stop::Discarded("/api/ps does not list the model".into()));
        };
        if entries.len() > 1 {
            return Err(Stop::Discarded("another model is loaded".into()));
        }
        let (Some(size), Some(size_vram)) = (entry.size, entry.size_vram) else {
            return Err(Stop::Discarded("/api/ps did not report the model's size".into()));
        };
        // A smaller context is Ollama's silent clamp at the trained context and is
        // measured as loaded; a larger or missing one cannot be explained.
        let context_length = match entry.context_length {
            Some(context) if context <= num_ctx && context > 0 => context,
            _ => return Err(Stop::Discarded(format!("Ollama loaded a different context than {num_ctx}"))),
        };
        Ok(LoadResult::Loaded(Probe { size, size_vram, context_length }))
    }

    /// Ask Ollama to drop the model now; failures are logged, never returned.
    async fn unload(&self) {
        let body = json!({ "model": self.tag, "keep_alive": 0, "stream": false });
        match self.send("/api/generate", Some(body), self.timing.request_timeout_ms).await {
            Ok((status, _)) if (200..=299).contains(&status) => {}
            Ok((status, text)) => note(format!("unloading {} failed: HTTP {status} {}", self.tag, snippet(&text))),
            Err(Stop::Failed(message) | Stop::Discarded(message)) => {
                note(format!("unloading {} failed: {message}", self.tag));
            }
        }
    }

    /// Unload, then poll `/api/ps` until it lists nothing or the wait runs out.
    async fn unload_and_settle(&self) -> Result<(), Stop> {
        self.unload().await;
        let deadline = Instant::now() + Duration::from_millis(self.timing.unload_wait_ms);
        while !self.ps().await?.is_empty() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(self.timing.unload_poll_ms)).await;
        }
        Ok(())
    }
}

/// The ladder walk, with its state across probes.
struct Walk<'a> {
    input: &'a MeasureContextFitInput<'a>,
    daemon: Daemon<'a>,
    ram_budget: f64,
    first_timeout_ms: u64,
    pool: Option<ContextPool>,
    loaded: bool,
    fitting: Vec<(f64, f64)>,
}

impl Walk<'_> {
    async fn probe(&mut self, n: u64) -> Result<Reading, Stop> {
        if (self.input.is_busy)() {
            return Err(Stop::Discarded("a session became busy".into()));
        }
        (self.input.on_progress)(ContextFitProgress {
            tag: self.input.row.name.clone(),
            state: ContextFitState::Running,
            num_ctx: Some(n),
        });
        let timeout_ms = if self.loaded { self.input.timing.probe_timeout_ms } else { self.first_timeout_ms };
        self.loaded = true;
        let probe = match self.daemon.load(n, timeout_ms).await? {
            LoadResult::Refused => {
                // Ollama refuses a load beyond system memory; with no pool seen yet, that pool is RAM.
                self.pool.get_or_insert(ContextPool::Ram);
                return Ok(Reading { fits: false, clamped_at: None });
            }
            LoadResult::Loaded(probe) => probe,
        };
        let pool = *self.pool.get_or_insert(if probe.size_vram > 0.0 { ContextPool::Gpu } else { ContextPool::Ram });
        let fits = match pool {
            ContextPool::Gpu => probe.size_vram >= probe.size,
            ContextPool::Ram => probe.size <= self.ram_budget,
        };
        if fits {
            self.fitting.push((probe.context_length as f64, probe.size));
        }
        Ok(Reading { fits, clamped_at: (probe.context_length < n).then_some(probe.context_length) })
    }

    async fn run(&mut self) -> Result<ContextFitResult, Stop> {
        let show = self.daemon.show().await?;
        let trained_context = trained_context_of(&show).unwrap_or(UNKNOWN_TRAINED_CONTEXT);
        let mut ceiling = modelfile_num_ctx(&show).map_or(trained_context, |n| n.min(trained_context));
        if let Some(cap) = self.input.max_context.filter(|cap| *cap > 0) {
            ceiling = ceiling.min(cap);
        }
        let ladder = context_ladder(ceiling);
        let floor = ladder.first().copied().unwrap_or(ceiling);

        let mut best: Option<u64> = None;
        let mut failed_once = false;
        for &n in &ladder {
            let budget = match self.pool {
                Some(ContextPool::Gpu) => self.input.machine.vram_bytes.map(|v| v as f64),
                _ => Some(self.ram_budget),
            };
            if let (Some(predicted), Some(budget)) = (predict_size(&self.fitting, n as f64), budget) {
                if predicted > budget * PREDICTION_SLACK {
                    break;
                }
            }
            let mut reading = self.probe(n).await?;
            if !reading.fits && !failed_once {
                failed_once = true;
                self.daemon.unload_and_settle().await?;
                reading = self.probe(n).await?;
            }
            if let Some(clamped) = reading.clamped_at {
                // Ollama will never load more than this context: it is the ceiling.
                if reading.fits && best.is_none_or(|b| clamped > b) {
                    best = Some(clamped);
                }
                break;
            }
            if !reading.fits {
                break;
            }
            best = Some(n);
        }

        let pool = self.pool.unwrap_or(ContextPool::Ram);
        let verdict = match (best, pool) {
            (Some(_), _) => ContextVerdict::Fits,
            (None, ContextPool::Gpu) => ContextVerdict::Spills,
            (None, ContextPool::Ram) => ContextVerdict::ExceedsRam,
        };
        Ok(ContextFitResult { max_context: best.unwrap_or(floor), trained_context, pool, verdict })
    }
}

fn reject(message: String) -> MeasureOutcome {
    note(format!("context measurement refused: {message}"));
    MeasureOutcome::Error { message }
}

/// Walk the ladder for `row.name` and return the largest rung that fits.
/// Never loads a rung predicted past the budget, and always unloads the model
/// after any load.
pub async fn measure_context_fit(input: MeasureContextFitInput<'_>) -> MeasureOutcome {
    let tag = input.row.name.as_str();
    if !is_valid_model_tag(tag) {
        let shown: String = tag.chars().take(100).collect();
        return reject(format!("invalid model name {shown:?}"));
    }
    if !is_local_ollama_row(input.row) {
        return reject(format!("{tag} is not a local model"));
    }
    if !is_loopback_base_url(input.base_url) {
        return reject(format!("{} is not this computer", input.base_url));
    }

    let timing = input.timing;
    let model_bytes = input.row.size.unwrap_or(0);
    let units = model_bytes.checked_div(timing.probe_size_unit_bytes).unwrap_or(0);
    let ram_bytes = input.machine.ram_bytes;
    let mut walk = Walk {
        input: &input,
        daemon: Daemon { client: reqwest::Client::new(), base_url: input.base_url, tag, timing },
        ram_budget: ram_bytes.saturating_sub(ram_reserve(ram_bytes)) as f64,
        first_timeout_ms: timing.probe_timeout_ms.saturating_add(units.saturating_mul(timing.probe_ms_per_size_unit)),
        pool: input.machine.unified_memory.then_some(ContextPool::Ram),
        loaded: false,
        fitting: Vec::new(),
    };
    let outcome = match walk.run().await {
        Ok(result) => MeasureOutcome::Measured { result },
        Err(Stop::Discarded(reason)) => {
            note(format!("context measurement of {tag} interrupted: {reason}"));
            MeasureOutcome::Interrupted
        }
        Err(Stop::Failed(message)) => {
            note(format!("context measurement of {tag} failed: {message}"));
            MeasureOutcome::Error { message }
        }
    };
    if walk.loaded {
        walk.daemon.unload().await;
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ollama::test_fake_ollama::{send_json, start_fake_ollama, FakeOllama};
    use std::sync::{Arc, Mutex, MutexGuard};

    const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
    const GIB_U64: u64 = 1024 * 1024 * 1024;
    const TAG: &str = "qwen3:8b";

    /// A stand-in for the daemon's memory behaviour: a model of `weights`
    /// bytes plus `kv_per_token` per context token, loaded onto a GPU of
    /// `gpu_bytes` (the rest spills, as Ollama does), or wholly in RAM.
    #[derive(Clone)]
    struct SimOptions {
        trained: Value,
        parameters: Option<String>,
        weights: f64,
        kv_per_token: f64,
        /// VRAM Ollama can use; `None` runs on the CPU (size_vram 0).
        gpu_bytes: Option<f64>,
        /// Unified memory: Ollama reports the whole model as VRAM.
        unified: bool,
        /// Loads whose size exceeds this answer HTTP 500, as a load beyond system memory does.
        refuse_above: Option<f64>,
        show_status: Option<u16>,
        ps_status: Option<u16>,
        /// Another model stays loaded throughout.
        foreign_runner: bool,
        /// Ollama silently clamps `num_ctx` to this.
        clamp_context_at: Option<u64>,
        /// `/api/ps` never lists the loaded model.
        hide_from_ps: bool,
        /// The first load at `.0` finds `.1` bytes less VRAM free (another process held it).
        transient_shortfall: Option<(u64, f64)>,
    }

    fn sim_options(weights: f64, kv_per_token: f64, gpu_bytes: Option<f64>) -> SimOptions {
        SimOptions {
            trained: json!(131_072),
            parameters: None,
            weights,
            kv_per_token,
            gpu_bytes,
            unified: false,
            refuse_above: None,
            show_status: None,
            ps_status: None,
            foreign_runner: false,
            clamp_context_at: None,
            hide_from_ps: false,
            transient_shortfall: None,
        }
    }

    #[derive(Clone, Debug, PartialEq)]
    struct SimRequest {
        path: String,
        body: Option<Value>,
    }

    #[derive(Default)]
    struct SimState {
        requests: Vec<SimRequest>,
        loads: Vec<u64>,
        shortfall_used: bool,
        /// size, size_vram, context_length
        loaded: Option<(f64, f64, u64)>,
    }

    #[derive(Clone, Default)]
    struct Sim(Arc<Mutex<SimState>>);

    impl Sim {
        fn state(&self) -> MutexGuard<'_, SimState> {
            self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        }
        fn loads(&self) -> Vec<u64> {
            self.state().loads.clone()
        }
        fn requests(&self) -> Vec<SimRequest> {
            self.state().requests.clone()
        }
        fn last_request(&self) -> Option<SimRequest> {
            self.state().requests.last().cloned()
        }
        fn resident(&self) -> bool {
            self.state().loaded.is_some()
        }
    }

    fn answer(sim: &Sim, options: &SimOptions, path: &str, body: &str) -> Option<(u16, Value)> {
        let parsed: Option<Value> = serde_json::from_str(body).ok();
        let mut state = sim.state();
        state.requests.push(SimRequest { path: path.to_string(), body: parsed.clone() });
        match path {
            "/api/show" => {
                if let Some(status) = options.show_status {
                    return send_json(json!({ "error": "model not found" }), status);
                }
                let mut show = json!({
                    "model_info": { "general.architecture": "qwen3", "qwen3.context_length": options.trained },
                });
                if let Some(parameters) = &options.parameters {
                    show["parameters"] = json!(parameters);
                }
                send_json(show, 200)
            }
            "/api/generate" => {
                let parsed = parsed.unwrap_or_default();
                if parsed.get("keep_alive") == Some(&json!(0)) {
                    state.loaded = None;
                    return send_json(json!({ "model": TAG, "done": true, "done_reason": "unload" }), 200);
                }
                let num_ctx = parsed.pointer("/options/num_ctx").and_then(Value::as_u64).unwrap_or_default();
                state.loads.push(num_ctx);
                let size = options.weights + options.kv_per_token * num_ctx as f64;
                if options.refuse_above.is_some_and(|limit| size > limit) {
                    state.loaded = None;
                    return send_json(
                        json!({ "error": "model requires more system memory (12.0 GiB) than is available" }),
                        500,
                    );
                }
                let mut gpu = options.gpu_bytes.unwrap_or(0.0);
                if let Some((at, bytes)) = options.transient_shortfall {
                    if at == num_ctx && !state.shortfall_used {
                        state.shortfall_used = true;
                        gpu -= bytes;
                    }
                }
                let size_vram = if options.unified { size } else { size.min(gpu).max(0.0) };
                let context = options.clamp_context_at.map_or(num_ctx, |clamp| num_ctx.min(clamp));
                state.loaded = Some((size, size_vram, context));
                send_json(json!({ "model": TAG, "done": true, "done_reason": "load" }), 200)
            }
            "/api/ps" => {
                if let Some(status) = options.ps_status {
                    return send_json(json!({ "error": "boom" }), status);
                }
                let mut models = Vec::new();
                if let Some((size, size_vram, context)) = state.loaded.filter(|_| !options.hide_from_ps) {
                    models.push(json!({
                        "name": TAG, "model": TAG, "size": size, "size_vram": size_vram, "context_length": context,
                    }));
                }
                if options.foreign_runner {
                    models.push(json!({
                        "name": "other:1b", "model": "other:1b", "size": GIB, "size_vram": GIB, "context_length": 4096,
                    }));
                }
                send_json(json!({ "models": models }), 200)
            }
            _ => send_json(json!({ "error": "not found" }), 404),
        }
    }

    async fn simulate(options: SimOptions) -> (Sim, FakeOllama) {
        let sim = Sim::default();
        let handler_sim = sim.clone();
        let fake = start_fake_ollama(move |path, body| answer(&handler_sim, &options, path, body)).await;
        (sim, fake)
    }

    fn machine() -> MachineFacts {
        MachineFacts {
            ram_bytes: 32 * GIB_U64,
            vram_bytes: Some(8 * GIB_U64),
            gpu_name: Some("NVIDIA RTX 4060".into()),
            threads: 16,
            unified_memory: false,
        }
    }

    /// `gib` GiB of KV cache per 1024 tokens, as bytes per token.
    fn kv(gib: f64) -> f64 {
        gib * GIB / 1024.0
    }

    fn tag_row(name: &str) -> OllamaTagRow {
        OllamaTagRow { name: name.into(), model: Some(name.into()), size: Some(5 * GIB_U64), ..OllamaTagRow::default() }
    }

    struct Run<'a> {
        base_url: &'a str,
        row: OllamaTagRow,
        machine: MachineFacts,
        is_busy: &'a (dyn Fn() -> bool + Send + Sync),
        max_context: Option<u64>,
        progress: Arc<Mutex<Vec<ContextFitProgress>>>,
    }

    fn not_busy() -> bool {
        false
    }

    impl<'a> Run<'a> {
        fn new(base_url: &'a str) -> Self {
            Self {
                base_url,
                row: tag_row(TAG),
                machine: machine(),
                is_busy: &not_busy,
                max_context: None,
                progress: Arc::new(Mutex::new(Vec::new())),
            }
        }

        async fn go(&self) -> MeasureOutcome {
            let progress = self.progress.clone();
            let on_progress = move |p: ContextFitProgress| {
                progress.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(p);
            };
            measure_context_fit(MeasureContextFitInput {
                base_url: self.base_url,
                row: &self.row,
                machine: &self.machine,
                max_context: self.max_context,
                is_busy: self.is_busy,
                on_progress: &on_progress,
                timing: ContextFitTiming { unload_wait_ms: 200, unload_poll_ms: 5, ..ContextFitTiming::default() },
            })
            .await
        }
    }

    fn measured(max_context: u64, trained_context: u64, pool: ContextPool, verdict: ContextVerdict) -> MeasureOutcome {
        MeasureOutcome::Measured { result: ContextFitResult { max_context, trained_context, pool, verdict } }
    }

    fn result_of(outcome: &MeasureOutcome) -> ContextFitResult {
        match outcome {
            MeasureOutcome::Measured { result } => result.clone(),
            other => panic!("expected a measurement, got {other:?}"),
        }
    }

    fn is_error(outcome: &MeasureOutcome) -> bool {
        matches!(outcome, MeasureOutcome::Error { .. })
    }

    fn is_unload(request: Option<SimRequest>) -> bool {
        request.is_some_and(|r| {
            r.path == "/api/generate"
                && r.body.as_ref().and_then(|b| b.get("model")) == Some(&json!(TAG))
                && r.body.as_ref().and_then(|b| b.get("keep_alive")) == Some(&json!(0))
        })
    }

    #[tokio::test]
    async fn picks_the_largest_rung_that_stays_on_the_gpu() {
        let (sim, fake) = simulate(sim_options(2.0 * GIB, kv(0.1), Some(8.0 * GIB))).await;
        let run = Run::new(&fake.url);
        let outcome = run.go().await;
        assert_eq!(outcome, measured(32_768, 131_072, ContextPool::Gpu, ContextVerdict::Fits));
        assert_eq!(sim.loads(), vec![16_384, 32_768, 65_536, 65_536]);
        let progress = run.progress.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        let expected: Vec<ContextFitProgress> = sim
            .loads()
            .into_iter()
            .map(|n| ContextFitProgress { tag: TAG.into(), state: ContextFitState::Running, num_ctx: Some(n) })
            .collect();
        assert_eq!(progress, expected);
        fake.close().await;
    }

    #[tokio::test]
    async fn returns_the_ceiling_when_every_rung_fits() {
        let (sim, fake) =
            simulate(SimOptions { trained: json!(32_768), ..sim_options(2.0 * GIB, kv(0.01), Some(8.0 * GIB)) }).await;
        let outcome = Run::new(&fake.url).go().await;
        assert_eq!(outcome, measured(32_768, 32_768, ContextPool::Gpu, ContextVerdict::Fits));
        assert_eq!(sim.loads(), vec![16_384, 32_768]);
        fake.close().await;
    }

    #[tokio::test]
    async fn uses_a_trained_context_that_is_not_a_power_of_two_as_the_top_rung() {
        let (sim, fake) =
            simulate(SimOptions { trained: json!(40_960), ..sim_options(2.0 * GIB, kv(0.01), Some(8.0 * GIB)) }).await;
        let result = result_of(&Run::new(&fake.url).go().await);
        assert_eq!((result.max_context, result.trained_context), (40_960, 40_960));
        assert_eq!(sim.loads(), vec![16_384, 32_768, 40_960]);
        fake.close().await;
    }

    #[tokio::test]
    async fn caps_the_ceiling_at_the_modelfile_num_ctx() {
        let parameters =
            "stop                           \"<|im_end|>\"\nnum_ctx                        32768\ntemperature                    0.6";
        let (sim, fake) = simulate(SimOptions {
            parameters: Some(parameters.into()),
            ..sim_options(2.0 * GIB, kv(0.01), Some(8.0 * GIB))
        })
        .await;
        let result = result_of(&Run::new(&fake.url).go().await);
        assert_eq!((result.max_context, result.trained_context), (32_768, 131_072));
        assert_eq!(sim.loads(), vec![16_384, 32_768]);
        fake.close().await;
    }

    #[tokio::test]
    async fn handles_a_trained_context_below_the_floor() {
        let (sim, fake) =
            simulate(SimOptions { trained: json!(8_192), ..sim_options(2.0 * GIB, kv(0.01), Some(8.0 * GIB)) }).await;
        let outcome = Run::new(&fake.url).go().await;
        assert_eq!(outcome, measured(8_192, 8_192, ContextPool::Gpu, ContextVerdict::Fits));
        assert_eq!(sim.loads(), vec![8_192]);
        fake.close().await;
    }

    #[tokio::test]
    async fn treats_an_absurd_trained_context_as_unknown() {
        for trained in [json!(1u64 << 40), json!(-1), json!(0), json!(1.5), json!("lots"), Value::Null] {
            let (sim, fake) =
                simulate(SimOptions { trained: trained.clone(), ..sim_options(2.0 * GIB, kv(0.01), Some(8.0 * GIB)) })
                    .await;
            let result = result_of(&Run::new(&fake.url).go().await);
            assert_eq!((result.max_context, result.trained_context), (131_072, 131_072), "{trained}");
            assert_eq!(sim.loads(), vec![16_384, 32_768, 65_536, 131_072], "{trained}");
            fake.close().await;
        }
    }

    #[tokio::test]
    async fn decides_the_pool_from_size_vram_not_from_nvidia_smi() {
        // nvidia-smi found no GPU, yet Ollama put the model in VRAM.
        let (_sim, fake) = simulate(sim_options(2.0 * GIB, kv(0.1), Some(8.0 * GIB))).await;
        let mut run = Run::new(&fake.url);
        run.machine.vram_bytes = None;
        run.machine.gpu_name = None;
        let on_gpu = result_of(&run.go().await);
        assert_eq!((on_gpu.pool, on_gpu.max_context), (ContextPool::Gpu, 32_768));
        fake.close().await;

        // nvidia-smi reported a GPU, yet Ollama ran the model on the CPU.
        let (_sim, fake) = simulate(sim_options(2.0 * GIB, kv(0.01), None)).await;
        let on_cpu = result_of(&Run::new(&fake.url).go().await);
        assert_eq!((on_cpu.pool, on_cpu.max_context, on_cpu.verdict), (ContextPool::Ram, 131_072, ContextVerdict::Fits));
        fake.close().await;
    }

    #[tokio::test]
    async fn uses_the_ram_budget_on_unified_memory() {
        // 16 GiB RAM keeps 4 GiB back: 12 GiB budget. 64k needs 12.32 GiB, predicted within the slack, so it is tried.
        let (sim, fake) = simulate(SimOptions { unified: true, ..sim_options(4.0 * GIB, kv(0.13), None) }).await;
        let mut run = Run::new(&fake.url);
        run.machine = MachineFacts { ram_bytes: 16 * GIB_U64, vram_bytes: None, unified_memory: true, ..machine() };
        assert_eq!(run.go().await, measured(32_768, 131_072, ContextPool::Ram, ContextVerdict::Fits));
        assert_eq!(sim.loads(), vec![16_384, 32_768, 65_536, 65_536]);
        fake.close().await;
    }

    #[tokio::test]
    async fn skips_a_rung_predicted_to_exceed_the_budget() {
        // 12 GiB budget; 16k and 32k fit, and the line through them puts 64k at 16.8 GiB.
        let (sim, fake) = simulate(sim_options(4.0 * GIB, kv(0.2), None)).await;
        let mut run = Run::new(&fake.url);
        run.machine = MachineFacts { ram_bytes: 16 * GIB_U64, vram_bytes: None, ..machine() };
        let result = result_of(&run.go().await);
        assert_eq!((result.max_context, result.pool, result.verdict), (32_768, ContextPool::Ram, ContextVerdict::Fits));
        assert_eq!(sim.loads(), vec![16_384, 32_768]);
        fake.close().await;
    }

    #[tokio::test]
    async fn re_probes_the_first_failing_rung_once_after_unloading() {
        let (sim, fake) = simulate(SimOptions {
            transient_shortfall: Some((32_768, 4.0 * GIB)),
            ..sim_options(2.0 * GIB, kv(0.1), Some(8.0 * GIB))
        })
        .await;
        let result = result_of(&Run::new(&fake.url).go().await);
        assert_eq!((result.max_context, result.pool, result.verdict), (32_768, ContextPool::Gpu, ContextVerdict::Fits));
        // 32k spilled once and fit after the unload; 64k spilled, and a second failure is not re-probed.
        assert_eq!(sim.loads(), vec![16_384, 32_768, 32_768, 65_536]);
        let requests = sim.requests();
        let at_32k: Vec<usize> = requests
            .iter()
            .enumerate()
            .filter(|(_, r)| r.body.as_ref().and_then(|b| b.pointer("/options/num_ctx")) == Some(&json!(32_768)))
            .map(|(i, _)| i)
            .collect();
        assert!(is_unload(requests.get(at_32k[0] + 2).cloned()));
        let between: Vec<&str> = requests[at_32k[0] + 2..at_32k[1]].iter().map(|r| r.path.as_str()).collect();
        assert_eq!(between, vec!["/api/generate", "/api/ps"]);
        fake.close().await;
    }

    #[tokio::test]
    async fn treats_http_500_on_load_as_not_fitting() {
        let (sim, fake) =
            simulate(SimOptions { refuse_above: Some(10.0 * GIB), ..sim_options(4.0 * GIB, kv(0.1), None) }).await;
        let mut run = Run::new(&fake.url);
        run.machine.vram_bytes = None;
        assert_eq!(run.go().await, measured(32_768, 131_072, ContextPool::Ram, ContextVerdict::Fits));
        assert_eq!(sim.loads(), vec![16_384, 32_768, 65_536, 65_536]);
        fake.close().await;
    }

    #[tokio::test]
    async fn reports_spills_at_the_floor() {
        let (sim, fake) = simulate(sim_options(4.0 * GIB, kv(0.1), Some(4.0 * GIB))).await;
        assert_eq!(Run::new(&fake.url).go().await, measured(16_384, 131_072, ContextPool::Gpu, ContextVerdict::Spills));
        assert_eq!(sim.loads(), vec![16_384, 16_384]);
        fake.close().await;

        // From RAM: 8 GiB keeps 4 GiB back, and the floor needs 5.6 GiB.
        let (_sim, fake) = simulate(sim_options(4.0 * GIB, kv(0.1), None)).await;
        let mut run = Run::new(&fake.url);
        run.machine = MachineFacts { ram_bytes: 8 * GIB_U64, vram_bytes: None, ..machine() };
        let result = result_of(&run.go().await);
        assert_eq!((result.max_context, result.pool, result.verdict), (16_384, ContextPool::Ram, ContextVerdict::ExceedsRam));
        fake.close().await;
    }

    #[tokio::test]
    async fn returns_error_on_a_non_2xx_from_api_show_or_api_ps() {
        let (show_sim, fake) =
            simulate(SimOptions { show_status: Some(404), ..sim_options(2.0 * GIB, kv(0.1), Some(8.0 * GIB)) }).await;
        assert!(is_error(&Run::new(&fake.url).go().await));
        let paths: Vec<String> = show_sim.requests().into_iter().map(|r| r.path).collect();
        assert_eq!(paths, vec!["/api/show".to_string()]);
        fake.close().await;

        let (ps_sim, fake) =
            simulate(SimOptions { ps_status: Some(500), ..sim_options(2.0 * GIB, kv(0.1), Some(8.0 * GIB)) }).await;
        assert!(is_error(&Run::new(&fake.url).go().await));
        assert!(is_unload(ps_sim.last_request()));
        assert!(!ps_sim.resident());
        fake.close().await;
    }

    #[tokio::test]
    async fn discards_a_probe_with_a_foreign_runner() {
        let (sim, fake) =
            simulate(SimOptions { foreign_runner: true, ..sim_options(2.0 * GIB, kv(0.1), Some(8.0 * GIB)) }).await;
        assert_eq!(Run::new(&fake.url).go().await, MeasureOutcome::Interrupted);
        assert_eq!(sim.loads(), vec![16_384]);
        assert!(!sim.resident());
        fake.close().await;
    }

    #[tokio::test]
    async fn caps_the_ceiling_at_the_global_cap() {
        let (sim, fake) = simulate(sim_options(2.0 * GIB, kv(0.01), Some(8.0 * GIB))).await;
        let mut run = Run::new(&fake.url);
        run.max_context = Some(32_768);
        assert_eq!(run.go().await, measured(32_768, 131_072, ContextPool::Gpu, ContextVerdict::Fits));
        assert_eq!(sim.loads(), vec![16_384, 32_768]);
        fake.close().await;
    }

    #[tokio::test]
    async fn stops_at_a_clamped_context_length_and_keeps_it_as_the_ceiling() {
        let (sim, fake) =
            simulate(SimOptions { clamp_context_at: Some(40_000), ..sim_options(2.0 * GIB, kv(0.01), Some(8.0 * GIB)) })
                .await;
        assert_eq!(Run::new(&fake.url).go().await, measured(40_000, 131_072, ContextPool::Gpu, ContextVerdict::Fits));
        assert_eq!(sim.loads(), vec![16_384, 32_768, 65_536]);
        assert!(!sim.resident());
        fake.close().await;
    }

    #[tokio::test]
    async fn discards_a_probe_whose_model_is_not_listed() {
        let (sim, fake) =
            simulate(SimOptions { hide_from_ps: true, ..sim_options(2.0 * GIB, kv(0.01), Some(8.0 * GIB)) }).await;
        assert_eq!(Run::new(&fake.url).go().await, MeasureOutcome::Interrupted);
        assert_eq!(sim.loads(), vec![16_384]);
        assert!(is_unload(sim.last_request()));
        fake.close().await;
    }

    #[tokio::test]
    async fn aborts_as_interrupted_when_a_sidecar_becomes_busy() {
        let (sim, fake) = simulate(sim_options(2.0 * GIB, kv(0.01), Some(8.0 * GIB))).await;
        let watched = sim.clone();
        let busy = move || !watched.loads().is_empty();
        let mut run = Run::new(&fake.url);
        run.is_busy = &busy;
        assert_eq!(run.go().await, MeasureOutcome::Interrupted);
        assert_eq!(sim.loads(), vec![16_384]);
        fake.close().await;
    }

    #[tokio::test]
    async fn unloads_the_model_after_measuring_also_after_an_abort() {
        let (measured_sim, fake) = simulate(sim_options(2.0 * GIB, kv(0.01), Some(8.0 * GIB))).await;
        assert!(matches!(Run::new(&fake.url).go().await, MeasureOutcome::Measured { .. }));
        assert_eq!(
            measured_sim.last_request(),
            Some(SimRequest {
                path: "/api/generate".into(),
                body: Some(json!({ "model": TAG, "keep_alive": 0, "stream": false })),
            })
        );
        assert!(!measured_sim.resident());
        fake.close().await;

        let (aborted, fake) = simulate(sim_options(2.0 * GIB, kv(0.01), Some(8.0 * GIB))).await;
        let watched = aborted.clone();
        let busy = move || watched.loads().len() >= 2;
        let mut run = Run::new(&fake.url);
        run.is_busy = &busy;
        assert_eq!(run.go().await, MeasureOutcome::Interrupted);
        assert!(is_unload(aborted.last_request()));
        assert!(!aborted.resident());
        fake.close().await;
    }

    #[tokio::test]
    async fn rejects_a_cloud_tag_a_remote_copy_and_a_non_loopback_host_without_any_request() {
        let (sim, fake) = simulate(sim_options(2.0 * GIB, kv(0.01), Some(8.0 * GIB))).await;
        let rows = [
            tag_row("gpt-oss:120b-cloud"),
            OllamaTagRow {
                remote_host: Some("https://ollama.com:443".into()),
                remote_model: Some("gpt-oss:120b".into()),
                ..tag_row("mine:latest")
            },
        ];
        for row in rows {
            let mut run = Run::new(&fake.url);
            run.row = row.clone();
            assert!(is_error(&run.go().await), "{}", row.name);
        }
        for base_url in ["http://192.168.1.5:11434", "http://127.0.0.1.example.com:11434"] {
            assert!(is_error(&Run::new(base_url).go().await), "{base_url}");
        }
        assert!(sim.requests().is_empty());
        fake.close().await;
    }

    #[tokio::test]
    async fn rejects_an_invalid_tag_without_any_request() {
        let (sim, fake) = simulate(sim_options(2.0 * GIB, kv(0.01), Some(8.0 * GIB))).await;
        for name in ["bad name".to_string(), String::new(), "-leading:dash".to_string(), "x".repeat(300)] {
            let mut run = Run::new(&fake.url);
            run.row = OllamaTagRow { name: name.clone(), ..OllamaTagRow::default() };
            assert!(is_error(&run.go().await), "{name}");
        }
        assert!(sim.requests().is_empty());
        fake.close().await;
    }
}
