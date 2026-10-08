//! The one context-fit queue for the whole app: it measures local Ollama
//! models one at a time, only while no sidecar in any window is running or
//! compacting, records each result in the `ollamaContextFit` pref, and rewrites
//! the sidecar overlay that carries the limits. Every window's Ollama screen
//! asks it through IPC; nothing in a renderer schedules a measurement.
//!
//! Keeps step with `src/main/ollama/context-fit-scheduler.ts`; change both together.

use std::collections::{BTreeMap, BTreeSet, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::catalog::{installed_name, with_default_tag, MachineFacts};
use super::context_fit::{ContextFitProgress, ContextFitResult, ContextFitState, MeasureOutcome};
use super::context_fit_store::{
    clamp_cap, effective_context, effective_limits, failed_under_current, is_stale, needs_auto_measure, overlay_yaml, parse_context_fit_store,
    with_failure, with_measured, CapError, ContextFitEntry, ContextFitStore, MachineFingerprint, CONTEXT_FIT_PREF_KEY,
};
use super::local::{is_local_ollama_row, is_loopback_base_url, OllamaTagRow};
use super::pull::is_valid_model_tag;
use crate::paths::SIDECAR_DEFAULT_OLLAMA_CONTEXT;
use crate::prefs::JsonStore;

pub(crate) const CHANNEL_CONTEXT_PROGRESS: &str = "ollama:context-progress";
pub(crate) const CHANNEL_CONTEXT_CHANGED: &str = "ollama:context-changed";
/// An interrupted measurement goes back in the queue at most this many times per trigger.
const MAX_REQUEUES: u32 = 3;

/// What asked for a measurement. `Stale` comes only from the startup pass;
/// the renderer may send `Manual` or `Pulled`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MeasureReason {
    Manual,
    Pulled,
    Stale,
}

/// A model row's place in the queue, for `ollama:context-list`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RowState {
    Idle,
    Queued,
    Running,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ListReason {
    /// The daemon is not on this computer: nothing is measured or limited.
    RemoteHost,
    /// The user's models config defines an `ollama` provider, which turns the
    /// built-in one off: the limits have no effect.
    ConfiguredProvider,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextFitRow {
    pub tag: String,
    pub entry: Option<ContextFitEntry>,
    pub effective: Option<u64>,
    pub stale: bool,
    pub env_cap: Option<u64>,
    pub state: RowState,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextFitList {
    pub rows: Vec<ContextFitRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<ListReason>,
}

/// Everything one engine run needs, owned so the run can outlive the caller's borrow.
pub(crate) struct MeasureRequest {
    pub base_url: String,
    pub row: OllamaTagRow,
    pub machine: MachineFacts,
    /// The sidecar's global cap for this model; no rung above it is loaded.
    pub max_context: u64,
    pub is_busy: Arc<dyn Fn() -> bool + Send + Sync>,
    pub on_progress: Arc<dyn Fn(ContextFitProgress) + Send + Sync>,
}

/// The scheduler's view of the rest of the app; production wires it to the
/// application context, tests to fakes.
pub(crate) trait SchedulerHost: Send + Sync {
    /// `prefs.json`; `None` once the app context is gone.
    fn prefs(&self) -> Option<JsonStore>;
    /// `<userData>/ollama-context-limits.yml`.
    fn overlay_path(&self) -> Option<PathBuf>;
    fn base_url(&self) -> BoxFuture<'static, String>;
    fn read_machine(&self) -> BoxFuture<'static, Option<MachineFacts>>;
    /// The user's own `OLLAMA_CONTEXT_LENGTH` (process env, else login shell), never the GUI's default.
    fn env_cap(&self) -> BoxFuture<'static, Option<u64>>;
    /// Any sidecar in any window is running or compacting.
    fn any_in_flight(&self) -> bool;
    /// The welcome dialog has closed, so onboarding's own model calls are over.
    fn welcome_completed(&self) -> bool;
    /// The user's models config has an `ollama` provider entry.
    fn configured_ollama_provider(&self) -> bool;
    fn measure(&self, request: MeasureRequest) -> BoxFuture<'static, MeasureOutcome>;
    /// Session files of ready tabs with nothing in flight.
    fn idle_sessions(&self) -> Vec<String>;
    /// `command_for_idle_session`: `None` when the session has no idle owner.
    fn session_command(&self, session_path: &str, command: Value) -> BoxFuture<'static, Option<Value>>;
    /// Send to every chat window.
    fn broadcast(&self, channel: &str, payload: Value);
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct SchedulerTiming {
    /// How often a blocked queue looks again (busy pool, welcome dialog, Ollama down).
    pub gate_poll_ms: u64,
    pub request_timeout_ms: u64,
    /// How long resident models get to leave `/api/ps` before a measurement.
    pub unload_wait_ms: u64,
    pub unload_poll_ms: u64,
    /// How long an idle session gets to report a lowered window before the compaction decision.
    pub rebind_wait_ms: u64,
    pub rebind_poll_ms: u64,
}

impl Default for SchedulerTiming {
    fn default() -> Self {
        Self { gate_poll_ms: 3_000, request_timeout_ms: 10_000, unload_wait_ms: 10_000, unload_poll_ms: 250, rebind_wait_ms: 2_000, rebind_poll_ms: 200 }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Item {
    tag: String,
    reason: MeasureReason,
    requeues: u32,
}

#[derive(Default)]
struct State {
    queue: VecDeque<Item>,
    running: Option<String>,
    startup: StartupPass,
    worker_started: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum StartupPass {
    #[default]
    Pending,
    Running,
    Done,
}

/// What one `step` did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    /// Nothing queued.
    Idle,
    /// Work is queued but a gate holds it: a busy sidecar, the welcome dialog, the daemon.
    Waiting,
    /// An item left the queue (measured, failed, re-queued or dropped).
    Ran,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn note(message: String) {
    crate::runtime_log::note("ollama", message, json!({}));
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// The store key for a model: the `/api/tags` `model` field, the id model discovery assigns.
fn key_of(row: &OllamaTagRow) -> String {
    row.model.clone().filter(|model| !model.is_empty()).unwrap_or_else(|| row.name.clone())
}

/// A row the app may measure and limit: a valid name, served by this computer.
fn is_measurable(row: &OllamaTagRow) -> bool {
    is_valid_model_tag(&row.name) && is_valid_model_tag(&key_of(row)) && is_local_ollama_row(row)
}

/// Resolve an incoming tag to an installed local model and its store key. A
/// bare name gets `:latest`, as Ollama lists a fresh pull; matching is
/// case-insensitive. Cloud tags, remote copies and invalid names are refused.
pub(crate) fn resolve_local(rows: &[OllamaTagRow], tag: &str) -> Result<(String, OllamaTagRow), String> {
    if !is_valid_model_tag(tag) {
        return Err("Invalid model name".to_string());
    }
    let names: Vec<String> = rows.iter().map(|row| row.name.clone()).collect();
    let row = installed_name(&names, &with_default_tag(tag))
        .and_then(|name| rows.iter().find(|row| row.name == name))
        .ok_or_else(|| format!("{tag} is not installed"))?;
    if !is_measurable(row) {
        return Err(format!("{tag} does not run on this computer"));
    }
    Ok((key_of(row), row.clone()))
}

/// Write `text` to `path` through a unique temp file and a rename.
fn write_atomically(path: &Path, text: &str) -> std::io::Result<()> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let dir = path.parent().ok_or_else(|| std::io::Error::other("the overlay path has no directory"))?;
    std::fs::create_dir_all(dir)?;
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let temp = dir.join(format!(".{name}.{}.{}.tmp", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed)));
    std::fs::write(&temp, text)?;
    std::fs::rename(&temp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })
}

/// Change the stored document through `mutate`, which sees the parsed store
/// and returns `Err` to leave the document as it was. The read and the write
/// happen under the store's lock with no await between them, so a concurrent
/// change to another model (or a cap set during a measurement) is never lost.
fn update_store<T>(prefs: &JsonStore, mutate: impl FnOnce(&mut ContextFitStore) -> Result<T, String>) -> Result<T, String> {
    let mut outcome: Result<T, String> = Err("the preferences store was not updated".to_string());
    prefs
        .update(CONTEXT_FIT_PREF_KEY, |current| {
            let mut store = parse_context_fit_store(current.as_ref());
            match mutate(&mut store).and_then(|value| serde_json::to_value(&store).map(|next| (value, next)).map_err(|error| error.to_string())) {
                Ok((value, next)) => {
                    outcome = Ok(value);
                    Some(next)
                }
                Err(error) => {
                    outcome = Err(error);
                    current
                }
            }
        })
        .map_err(|error| error.to_string())?;
    outcome
}

/// The overlay last written and the limits the sidecars were last given;
/// `limits` is `None` before the first sync.
#[derive(Default)]
struct Synced {
    yaml: Option<String>,
    limits: Option<BTreeMap<String, u64>>,
}

pub(crate) struct ContextFitScheduler {
    host: Arc<dyn SchedulerHost>,
    timing: SchedulerTiming,
    state: Mutex<State>,
    wake: tokio::sync::Notify,
    stopped: Arc<AtomicBool>,
    /// Serializes overlay syncs, so an older document never lands last.
    synced: Mutex<Synced>,
    client: reqwest::Client,
}

impl ContextFitScheduler {
    pub(crate) fn new(host: Arc<dyn SchedulerHost>, timing: SchedulerTiming) -> Arc<Self> {
        Arc::new(Self {
            host,
            timing,
            state: Mutex::new(State::default()),
            wake: tokio::sync::Notify::new(),
            stopped: Arc::new(AtomicBool::new(false)),
            synced: Mutex::new(Synced::default()),
            client: reqwest::Client::new(),
        })
    }

    /// Start the one worker that drains the queue. Idempotent.
    pub(crate) fn start(self: &Arc<Self>) {
        {
            let mut state = lock(&self.state);
            if state.worker_started {
                return;
            }
            state.worker_started = true;
        }
        let worker = self.clone();
        crate::bridge::spawn_task(async move { worker.run_worker().await });
    }

    /// Stop the worker and empty the queue; a measurement under way ends as
    /// interrupted at its next probe.
    pub(crate) fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        lock(&self.state).queue.clear();
        self.wake.notify_one();
    }

    async fn run_worker(self: Arc<Self>) {
        while !self.stopped.load(Ordering::SeqCst) {
            match self.step().await {
                Step::Ran => continue,
                Step::Waiting => {
                    let _ = tokio::time::timeout(Duration::from_millis(self.timing.gate_poll_ms), self.wake.notified()).await;
                }
                Step::Idle => self.wake.notified().await,
            }
        }
    }

    /// Every status probe reports here: the first answer from Ollama starts
    /// the startup pass, and any answer wakes a waiting queue.
    pub(crate) async fn note_ollama_answered(&self) {
        self.wake.notify_one();
        self.startup_pass().await;
    }

    fn progress(&self, tag: &str, state: ContextFitState) {
        let progress = ContextFitProgress { tag: tag.to_string(), state, num_ctx: None };
        if let Ok(payload) = serde_json::to_value(progress) {
            self.host.broadcast(CHANNEL_CONTEXT_PROGRESS, payload);
        }
    }

    fn changed(&self, tag: &str) {
        self.host.broadcast(CHANNEL_CONTEXT_CHANGED, json!({ "tag": tag }));
    }

    /// Queue `tag` (a resolved store key). A new manual request goes ahead of
    /// every automatic one; a tag already queued is not queued twice, but a new
    /// trigger restarts its retry budget and a manual one moves it to the front.
    /// A tag being measured right now is left alone.
    pub(crate) fn enqueue(&self, tag: &str, reason: MeasureReason) {
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        let added = {
            let mut state = lock(&self.state);
            if let Some(index) = state.queue.iter().position(|queued| queued.tag == tag) {
                state.queue[index].requeues = 0;
                if reason == MeasureReason::Manual && state.queue[index].reason != MeasureReason::Manual {
                    if let Some(mut item) = state.queue.remove(index) {
                        item.reason = MeasureReason::Manual;
                        state.queue.push_front(item);
                    }
                }
                false
            } else if state.running.as_deref() == Some(tag) {
                false
            } else {
                let item = Item { tag: tag.to_string(), reason, requeues: 0 };
                if reason == MeasureReason::Manual {
                    let at = state.queue.iter().position(|queued| queued.reason != MeasureReason::Manual).unwrap_or(state.queue.len());
                    state.queue.insert(at, item);
                } else {
                    state.queue.push_back(item);
                }
                true
            }
        };
        if added {
            self.progress(tag, ContextFitState::Queued);
        }
        self.wake.notify_one();
    }

    pub(crate) fn row_state(&self, tag: &str) -> RowState {
        let state = lock(&self.state);
        if state.running.as_deref() == Some(tag) {
            RowState::Running
        } else if state.queue.iter().any(|item| item.tag == tag) {
            RowState::Queued
        } else {
            RowState::Idle
        }
    }

    #[cfg(test)]
    fn queued(&self) -> Vec<(String, MeasureReason)> {
        lock(&self.state).queue.iter().map(|item| (item.tag.clone(), item.reason)).collect()
    }

    /// `/api/tags` rows, or `None` when the daemon does not answer.
    async fn tags(&self, base_url: &str) -> Option<Vec<OllamaTagRow>> {
        let response = self
            .client
            .get(format!("{base_url}/api/tags"))
            .timeout(Duration::from_millis(self.timing.request_timeout_ms))
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let body: Value = response.json().await.ok()?;
        let rows = body.get("models")?.as_array()?;
        Some(rows.iter().filter_map(|row| serde_json::from_value::<OllamaTagRow>(row.clone()).ok()).filter(|row| !row.name.is_empty()).collect())
    }

    async fn ps_names(&self, base_url: &str) -> Option<Vec<String>> {
        let response = self
            .client
            .get(format!("{base_url}/api/ps"))
            .timeout(Duration::from_millis(self.timing.request_timeout_ms))
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let body: Value = response.json().await.ok()?;
        let models = body.get("models")?.as_array()?;
        Some(models.iter().filter_map(|row| row.get("name").and_then(Value::as_str)).filter(|name| !name.is_empty()).map(str::to_string).collect())
    }

    /// Unload every model the daemon holds, then wait (bounded) for `/api/ps`
    /// to empty, so the measurement sees only its own model. The next chat
    /// turn loads its model again. A model that stays makes the measurement
    /// end as interrupted instead.
    async fn unload_residents(&self, base_url: &str) {
        let Some(resident) = self.ps_names(base_url).await else { return };
        if resident.is_empty() {
            return;
        }
        let unloads = resident.iter().map(|name| {
            self.client
                .post(format!("{base_url}/api/generate"))
                .json(&json!({ "model": name, "keep_alive": 0, "stream": false }))
                .timeout(Duration::from_millis(self.timing.request_timeout_ms))
                .send()
        });
        for (name, result) in resident.iter().zip(futures_util::future::join_all(unloads).await) {
            match result {
                Ok(response) if response.status().is_success() => {}
                Ok(response) => note(format!("unloading {name} failed: HTTP {}", response.status().as_u16())),
                Err(error) => note(format!("unloading {name} failed: {error}")),
            }
        }
        let deadline = Instant::now() + Duration::from_millis(self.timing.unload_wait_ms);
        while Instant::now() < deadline {
            match self.ps_names(base_url).await {
                Some(names) if !names.is_empty() => tokio::time::sleep(Duration::from_millis(self.timing.unload_poll_ms)).await,
                _ => return,
            }
        }
    }

    /// The daemon's `/api/tags` rows, when it is on this computer and answers.
    async fn local_rows(&self) -> Result<Vec<OllamaTagRow>, String> {
        let base_url = self.host.base_url().await;
        if !is_loopback_base_url(&base_url) {
            return Err("Ollama is not running on this computer".to_string());
        }
        self.tags(&base_url).await.ok_or_else(|| "Ollama is not answering".to_string())
    }

    /// `ollama:context-measure`: queue a manual or pulled measurement of an
    /// installed local model.
    pub(crate) async fn request_measure(&self, tag: &str, reason: MeasureReason) -> Result<(), String> {
        if reason == MeasureReason::Stale {
            return Err("Invalid measurement reason".to_string());
        }
        if !is_valid_model_tag(tag) {
            return Err("Invalid model name".to_string());
        }
        let (key, _) = resolve_local(&self.local_rows().await?, tag)?;
        self.enqueue(&key, reason);
        Ok(())
    }

    /// Queue every installed local model that was never measured or whose
    /// machine changed, once per app run, the first time the daemon answers.
    /// Skipped while a configured `ollama` provider turns the built-in one off
    /// and for a daemon on another computer.
    pub(crate) async fn startup_pass(&self) {
        {
            let mut state = lock(&self.state);
            if state.startup != StartupPass::Pending || self.stopped.load(Ordering::SeqCst) {
                return;
            }
            state.startup = StartupPass::Running;
        }
        let finished = self.run_startup_pass().await;
        lock(&self.state).startup = if finished { StartupPass::Done } else { StartupPass::Pending };
    }

    /// False when the daemon did not answer, so a later probe tries again.
    async fn run_startup_pass(&self) -> bool {
        if self.host.configured_ollama_provider() {
            return true;
        }
        let base_url = self.host.base_url().await;
        if !is_loopback_base_url(&base_url) {
            return true;
        }
        let Some(rows) = self.tags(&base_url).await else { return false };
        let Some(machine) = self.host.read_machine().await else {
            note("context startup pass skipped: this computer's memory could not be read".into());
            return true;
        };
        let current = MachineFingerprint::from(&machine);
        let store = self.read_store();
        for row in rows.iter().filter(|row| is_measurable(row)) {
            let key = key_of(row);
            if needs_auto_measure(store.models.get(&key), &current) {
                self.enqueue(&key, MeasureReason::Stale);
            }
        }
        true
    }

    fn read_store(&self) -> ContextFitStore {
        let raw = self.host.prefs().and_then(|prefs| prefs.get(CONTEXT_FIT_PREF_KEY));
        parse_context_fit_store(raw.as_ref())
    }

    /// `ollama:context-list`: every installed local model with what is known about its context.
    pub(crate) async fn list(&self) -> ContextFitList {
        let base_url = self.host.base_url().await;
        if !is_loopback_base_url(&base_url) {
            return ContextFitList { rows: Vec::new(), reason: Some(ListReason::RemoteHost) };
        }
        let (rows, machine, env_cap) = tokio::join!(self.tags(&base_url), self.host.read_machine(), self.host.env_cap());
        let current = machine.as_ref().map(MachineFingerprint::from);
        let store = self.read_store();
        let mut seen = HashSet::new();
        let rows = rows
            .unwrap_or_default()
            .iter()
            .filter(|row| is_measurable(row))
            .filter_map(|row| {
                let tag = key_of(row);
                if !seen.insert(tag.clone()) {
                    return None;
                }
                let entry = store.models.get(&tag).cloned();
                let effective = entry.as_ref().and_then(|entry| effective_context(entry, env_cap));
                let stale = match (&entry, &current) {
                    (Some(entry), Some(current)) => is_stale(entry, current),
                    _ => false,
                };
                let state = self.row_state(&tag);
                Some(ContextFitRow { tag, entry, effective, stale, env_cap, state })
            })
            .collect();
        let reason = self.host.configured_ollama_provider().then_some(ListReason::ConfiguredProvider);
        ContextFitList { rows, reason }
    }

    /// `ollama:context-set-cap`: set or clear the user's limit of a measured model.
    pub(crate) async fn set_cap(&self, tag: &str, cap: &Value) -> Result<ContextFitEntry, String> {
        if !is_valid_model_tag(tag) {
            return Err("Invalid model name".to_string());
        }
        let (key, _) = resolve_local(&self.local_rows().await?, tag)?;
        let prefs = self.host.prefs().ok_or_else(|| "The app is shutting down".to_string())?;
        let entry = update_store(&prefs, |store| {
            let entry = store.models.get_mut(&key).ok_or_else(|| CapError::Unmeasured.to_string())?;
            entry.user_cap = clamp_cap(entry, cap).map_err(|error| error.to_string())?;
            Ok(entry.clone())
        })?;
        self.sync_overlay(Some(&key)).await;
        Ok(entry)
    }

    /// Recompute the overlay, for example once the login shell's `OLLAMA_CONTEXT_LENGTH` is known.
    pub(crate) async fn refresh_overlay(&self) {
        self.sync_overlay(None).await;
    }

    /// Write the overlay when it changed, tell every window which models
    /// changed (`touched` always counts), and compact the idle sessions whose
    /// model just got a smaller window.
    async fn sync_overlay(&self, touched: Option<&str>) {
        let env_cap = self.host.env_cap().await;
        let mut changed: BTreeSet<String> = touched.map(str::to_string).into_iter().collect();
        let mut dropped: Vec<(String, u64)> = Vec::new();
        {
            let mut synced = lock(&self.synced);
            let store = self.read_store();
            let limits = effective_limits(&store, env_cap);
            let yaml = overlay_yaml(&store, env_cap);
            if synced.yaml.as_deref() != Some(yaml.as_str()) {
                match self.host.overlay_path().map(|path| write_atomically(&path, &yaml).map_err(|error| (path, error))) {
                    Some(Ok(())) => synced.yaml = Some(yaml),
                    Some(Err((path, error))) => note(format!("could not write {}: {error}", path.display())),
                    None => {}
                }
            }
            if let Some(previous) = synced.limits.replace(limits.clone()) {
                // A model with no limit runs at the global cap, or the user's own.
                let fallback = env_cap.unwrap_or(SIDECAR_DEFAULT_OLLAMA_CONTEXT);
                for tag in previous.keys().chain(limits.keys()).collect::<BTreeSet<_>>() {
                    let before = previous.get(tag).copied().unwrap_or(fallback);
                    let after = limits.get(tag).copied().unwrap_or(fallback);
                    if before == after {
                        continue;
                    }
                    changed.insert(tag.clone());
                    if after < before {
                        dropped.push((tag.clone(), after));
                    }
                }
            }
        }
        for (tag, window) in dropped {
            let host = self.host.clone();
            let timing = self.timing;
            crate::bridge::spawn_task(async move { compact_after_drop(host.as_ref(), &tag, window, timing).await });
        }
        for tag in changed {
            self.changed(&tag);
        }
    }

    /// Run the next eligible queued item, if every gate is open.
    pub(crate) async fn step(&self) -> Step {
        let tag = {
            let state = lock(&self.state);
            if state.running.is_some() {
                return Step::Waiting;
            }
            if state.queue.is_empty() {
                return Step::Idle;
            }
            let welcome = self.host.welcome_completed();
            match state.queue.iter().find(|item| item.reason != MeasureReason::Pulled || welcome) {
                Some(item) => item.tag.clone(),
                None => return Step::Waiting,
            }
        };
        if self.host.any_in_flight() {
            return Step::Waiting;
        }
        let base_url = self.host.base_url().await;
        if !is_loopback_base_url(&base_url) {
            // Never measure a model on another computer; the queue empties until Ollama is local again.
            let dropped: Vec<Item> = lock(&self.state).queue.drain(..).collect();
            for item in dropped {
                self.changed(&item.tag);
            }
            return Step::Ran;
        }
        let Some(rows) = self.tags(&base_url).await else { return Step::Waiting };
        let item = {
            let mut state = lock(&self.state);
            let Some(index) = state.queue.iter().position(|item| item.tag == tag) else { return Step::Ran };
            let Some(item) = state.queue.remove(index) else { return Step::Ran };
            item
        };
        self.run_item(&base_url, &rows, item).await;
        Step::Ran
    }

    async fn run_item(&self, base_url: &str, rows: &[OllamaTagRow], item: Item) {
        let tag = item.tag.clone();
        let row = rows.iter().find(|row| key_of(row) == tag && is_measurable(row)).cloned();
        let machine = self.host.read_machine().await;
        let (Some(row), Some(machine)) = (row, machine) else {
            note(format!("context measurement of {tag} skipped: it is not installed, or this computer's memory could not be read"));
            self.changed(&tag);
            return;
        };
        let fingerprint = MachineFingerprint::from(&machine);
        let stored = self.read_store();
        let entry = stored.models.get(&tag);
        let skip = item.reason != MeasureReason::Manual
            && (failed_under_current(entry, &fingerprint) || (item.reason == MeasureReason::Stale && !needs_auto_measure(entry, &fingerprint)));
        if skip {
            self.changed(&tag);
            return;
        }

        lock(&self.state).running = Some(tag.clone());
        let env_cap = self.host.env_cap().await;
        let outcome = if self.host.any_in_flight() {
            MeasureOutcome::Interrupted
        } else {
            self.unload_residents(base_url).await;
            let host = self.host.clone();
            let stopped = self.stopped.clone();
            let progress_host = self.host.clone();
            let progress_tag = tag.clone();
            self.host
                .measure(MeasureRequest {
                    base_url: base_url.to_string(),
                    row,
                    machine,
                    max_context: env_cap.unwrap_or(SIDECAR_DEFAULT_OLLAMA_CONTEXT),
                    is_busy: Arc::new(move || stopped.load(Ordering::SeqCst) || host.any_in_flight()),
                    on_progress: Arc::new(move |mut progress: ContextFitProgress| {
                        progress.tag = progress_tag.clone();
                        if let Ok(payload) = serde_json::to_value(progress) {
                            progress_host.broadcast(CHANNEL_CONTEXT_PROGRESS, payload);
                        }
                    }),
                })
                .await
        };
        lock(&self.state).running = None;

        match outcome {
            MeasureOutcome::Interrupted => {
                if item.requeues < MAX_REQUEUES && !self.stopped.load(Ordering::SeqCst) {
                    lock(&self.state).queue.push_front(Item { requeues: item.requeues + 1, ..item });
                    self.progress(&tag, ContextFitState::Queued);
                } else {
                    note(format!("context measurement of {tag} dropped after {} retries", item.requeues));
                    self.changed(&tag);
                }
            }
            MeasureOutcome::Measured { result } => self.commit(&tag, Ok(result), &fingerprint).await,
            MeasureOutcome::Error { message } => self.commit(&tag, Err(message), &fingerprint).await,
        }
    }

    /// Re-read the store and write only `tag`, so a cap set during the measurement survives.
    async fn commit(&self, tag: &str, outcome: Result<ContextFitResult, String>, fingerprint: &MachineFingerprint) {
        let now = now_iso();
        let written = self.host.prefs().ok_or_else(|| "The app is shutting down".to_string()).and_then(|prefs| {
            update_store(&prefs, |store| {
                let previous = store.models.get(tag);
                let next = match &outcome {
                    Ok(result) => with_measured(previous, result, fingerprint, &now),
                    Err(message) => with_failure(previous, message, fingerprint, &now),
                };
                store.models.insert(tag.to_string(), next);
                Ok(())
            })
        });
        if let Err(error) = written {
            note(format!("saving the context of {tag} failed: {error}"));
        }
        self.progress(tag, if outcome.is_ok() { ContextFitState::Done } else { ContextFitState::Error });
        self.sync_overlay(Some(tag)).await;
    }
}

/// The `data` of a successful RPC response.
fn response_data(response: Option<Value>) -> Option<Value> {
    let response = response?;
    if response.get("success") != Some(&Value::Bool(true)) {
        return None;
    }
    response.get("data").cloned().filter(Value::is_object)
}

/// Why a `compact` response failed, with the sidecar's error text; `None` on success.
fn compact_failure(response: Option<Value>) -> Option<String> {
    let Some(response) = response else { return Some("the session is no longer idle".to_string()) };
    if response.get("success") == Some(&Value::Bool(true)) {
        return None;
    }
    Some(response.get("error").and_then(Value::as_str).unwrap_or("no error text").to_string())
}

/// After `tag`'s window dropped to `window`: for each idle session on
/// `ollama/<tag>`, wait (bounded) until it runs at the new window, then compact
/// it when its last context usage no longer fits, since Ollama would cut its
/// prompt. A session on another model, one that started a turn, or one that
/// never took the new window is left alone.
pub(crate) async fn compact_after_drop(host: &dyn SchedulerHost, tag: &str, window: u64, timing: SchedulerTiming) {
    for session in host.idle_sessions() {
        let deadline = Instant::now() + Duration::from_millis(timing.rebind_wait_ms);
        loop {
            let Some(state) = response_data(host.session_command(&session, json!({ "type": "get_state" })).await) else { break };
            let model = state.get("model");
            let on_tag = model.and_then(|m| m.get("provider")).and_then(Value::as_str) == Some("ollama")
                && model.and_then(|m| m.get("id")).and_then(Value::as_str) == Some(tag);
            if !on_tag {
                break;
            }
            if model.and_then(|m| m.get("contextWindow")).and_then(Value::as_u64).is_some_and(|reported| reported <= window) {
                let tokens = state.pointer("/contextUsage/tokens").and_then(Value::as_u64).unwrap_or(0);
                if tokens > window {
                    let response = host.session_command(&session, json!({ "type": "compact" })).await;
                    if let Some(failure) = compact_failure(response) {
                        note(format!("compacting a session on {tag} after its context dropped to {window} did not succeed: {failure}"));
                    }
                }
                break;
            }
            if Instant::now() >= deadline {
                note(format!("a session on {tag} did not take the new context window; not compacting it"));
                break;
            }
            tokio::time::sleep(Duration::from_millis(timing.rebind_poll_ms)).await;
        }
    }
}

/// A `'static` boxed future, named so the test module below needs no lifetime
/// syntax (the TS parity checker reads Rust test bodies with a JS tokenizer).
#[cfg(test)]
type StaticFuture<T> = BoxFuture<'static, T>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ollama::context_fit::{ContextFitResult, ContextPool, ContextVerdict};
    use crate::ollama::test_fake_ollama::{send_json, start_fake_ollama, FakeOllama};
    use std::collections::HashMap;
    use std::sync::OnceLock;

    const GIB: u64 = 1024 * 1024 * 1024;

    fn machine() -> MachineFacts {
        MachineFacts { ram_bytes: 32 * GIB, vram_bytes: Some(8 * GIB), gpu_name: Some("NVIDIA RTX 4060".into()), threads: 16, unified_memory: false }
    }

    fn measured(max_context: u64) -> MeasureOutcome {
        MeasureOutcome::Measured {
            result: ContextFitResult { max_context, trained_context: 131_072, pool: ContextPool::Gpu, verdict: ContextVerdict::Fits },
        }
    }

    /// A daemon with fixed `/api/tags` rows whose `/api/ps` lists `resident` until each is unloaded.
    #[derive(Clone, Default)]
    struct Daemon {
        rows: Vec<Value>,
        resident: Arc<Mutex<Vec<String>>>,
        requests: Arc<Mutex<Vec<(String, Value)>>>,
    }

    impl Daemon {
        fn new(tags: &[&str]) -> Self {
            Self { rows: tags.iter().map(|tag| json!({ "name": tag, "model": tag, "size": 5 * GIB })).collect(), ..Self::default() }
        }

        async fn start(&self) -> FakeOllama {
            let daemon = self.clone();
            start_fake_ollama(move |path, body| {
                let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
                lock(&daemon.requests).push((path.to_string(), parsed.clone()));
                match path {
                    "/api/tags" => send_json(json!({ "models": daemon.rows }), 200),
                    "/api/ps" => {
                        let models: Vec<Value> = lock(&daemon.resident).iter().map(|name| json!({ "name": name, "model": name })).collect();
                        send_json(json!({ "models": models }), 200)
                    }
                    "/api/generate" => {
                        if parsed.get("keep_alive") == Some(&json!(0)) {
                            let name = parsed.get("model").and_then(Value::as_str).unwrap_or_default().to_string();
                            lock(&daemon.resident).retain(|resident| *resident != name);
                        }
                        send_json(json!({ "done": true }), 200)
                    }
                    _ => send_json(json!({ "error": "not found" }), 404),
                }
            })
            .await
        }
    }

    struct Recorded {
        tag: String,
        max_context: u64,
        busy_at_start: bool,
    }

    type MeasureHook = Box<dyn Fn(&FakeHost, &str) -> StaticFuture<()> + Send + Sync>;

    struct FakeHost {
        dir: tempfile::TempDir,
        prefs: JsonStore,
        base_url: Mutex<String>,
        env_cap: Mutex<Option<u64>>,
        busy: Arc<AtomicBool>,
        welcome: AtomicBool,
        configured: AtomicBool,
        outcomes: Mutex<VecDeque<MeasureOutcome>>,
        measured: Arc<Mutex<Vec<Recorded>>>,
        /// Runs inside `measure`, before its outcome is returned.
        during: Mutex<Option<MeasureHook>>,
        /// Observed by the daemon when a measurement starts: what `/api/ps` listed then.
        resident_at_measure: Mutex<Vec<Vec<String>>>,
        daemon: Mutex<Option<Daemon>>,
        idle: Vec<String>,
        sessions: Mutex<HashMap<String, VecDeque<Value>>>,
        commands: Mutex<Vec<(String, String)>>,
        broadcasts: Mutex<Vec<(String, Value)>>,
        scheduler: OnceLock<std::sync::Weak<ContextFitScheduler>>,
    }

    impl FakeHost {
        fn new(base_url: &str) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let prefs = JsonStore::open(dir.path().join("prefs.json"));
            Self {
                dir,
                prefs,
                base_url: Mutex::new(base_url.to_string()),
                env_cap: Mutex::new(None),
                busy: Arc::new(AtomicBool::new(false)),
                welcome: AtomicBool::new(true),
                configured: AtomicBool::new(false),
                outcomes: Mutex::new(VecDeque::new()),
                measured: Arc::new(Mutex::new(Vec::new())),
                during: Mutex::new(None),
                resident_at_measure: Mutex::new(Vec::new()),
                daemon: Mutex::new(None),
                idle: Vec::new(),
                sessions: Mutex::new(HashMap::new()),
                commands: Mutex::new(Vec::new()),
                broadcasts: Mutex::new(Vec::new()),
                scheduler: OnceLock::new(),
            }
        }

        fn overlay(&self) -> String {
            std::fs::read_to_string(self.dir.path().join("ollama-context-limits.yml")).unwrap_or_default()
        }

        fn store(&self) -> ContextFitStore {
            parse_context_fit_store(self.prefs.get(CONTEXT_FIT_PREF_KEY).as_ref())
        }

        fn measured_tags(&self) -> Vec<String> {
            lock(&self.measured).iter().map(|recorded| recorded.tag.clone()).collect()
        }

        fn progress_states(&self, tag: &str) -> Vec<String> {
            lock(&self.broadcasts)
                .iter()
                .filter(|(channel, payload)| channel == CHANNEL_CONTEXT_PROGRESS && payload["tag"] == tag)
                .map(|(_, payload)| payload["state"].as_str().unwrap_or_default().to_string())
                .collect()
        }
    }

    impl SchedulerHost for FakeHost {
        fn prefs(&self) -> Option<JsonStore> {
            Some(self.prefs.clone())
        }

        fn overlay_path(&self) -> Option<PathBuf> {
            Some(self.dir.path().join("ollama-context-limits.yml"))
        }

        fn base_url(&self) -> StaticFuture<String> {
            Box::pin(std::future::ready(lock(&self.base_url).clone()))
        }

        fn read_machine(&self) -> StaticFuture<Option<MachineFacts>> {
            Box::pin(std::future::ready(Some(machine())))
        }

        fn env_cap(&self) -> StaticFuture<Option<u64>> {
            Box::pin(std::future::ready(*lock(&self.env_cap)))
        }

        fn any_in_flight(&self) -> bool {
            self.busy.load(Ordering::SeqCst)
        }

        fn welcome_completed(&self) -> bool {
            self.welcome.load(Ordering::SeqCst)
        }

        fn configured_ollama_provider(&self) -> bool {
            self.configured.load(Ordering::SeqCst)
        }

        fn measure(&self, request: MeasureRequest) -> StaticFuture<MeasureOutcome> {
            lock(&self.measured).push(Recorded { tag: request.row.name.clone(), max_context: request.max_context, busy_at_start: (request.is_busy)() });
            if let Some(daemon) = lock(&self.daemon).as_ref() {
                lock(&self.resident_at_measure).push(lock(&daemon.resident).clone());
            }
            let outcome = lock(&self.outcomes).pop_front().unwrap_or_else(|| measured(65_536));
            let during = lock(&self.during).as_ref().map(|hook| hook(self, &request.row.name));
            Box::pin(async move {
                if let Some(during) = during {
                    during.await;
                }
                outcome
            })
        }

        fn idle_sessions(&self) -> Vec<String> {
            self.idle.clone()
        }

        fn session_command(&self, session_path: &str, command: Value) -> StaticFuture<Option<Value>> {
            let kind = command["type"].as_str().unwrap_or_default().to_string();
            lock(&self.commands).push((session_path.to_string(), kind.clone()));
            let answer = if kind == "get_state" {
                let mut sessions = lock(&self.sessions);
                let states = sessions.entry(session_path.to_string()).or_default();
                let state = if states.len() > 1 { states.pop_front() } else { states.front().cloned() };
                state.map(|data| json!({ "type": "response", "command": "get_state", "success": true, "data": data }))
            } else {
                Some(json!({ "type": "response", "command": kind, "success": true }))
            };
            Box::pin(std::future::ready(answer))
        }

        fn broadcast(&self, channel: &str, payload: Value) {
            lock(&self.broadcasts).push((channel.to_string(), payload));
        }
    }

    fn timing() -> SchedulerTiming {
        SchedulerTiming { gate_poll_ms: 5, request_timeout_ms: 2_000, unload_wait_ms: 500, unload_poll_ms: 5, rebind_wait_ms: 200, rebind_poll_ms: 5 }
    }

    struct Setup {
        host: Arc<FakeHost>,
        scheduler: Arc<ContextFitScheduler>,
        fake: FakeOllama,
        daemon: Daemon,
    }

    async fn setup(tags: &[&str], configure: impl FnOnce(&mut FakeHost)) -> Setup {
        let daemon = Daemon::new(tags);
        setup_with(daemon, configure).await
    }

    async fn setup_with(daemon: Daemon, configure: impl FnOnce(&mut FakeHost)) -> Setup {
        let fake = daemon.start().await;
        let mut host = FakeHost::new(&fake.url);
        *lock(&host.daemon) = Some(daemon.clone());
        configure(&mut host);
        let host = Arc::new(host);
        let scheduler = ContextFitScheduler::new(host.clone(), timing());
        let _ = host.scheduler.set(Arc::downgrade(&scheduler));
        Setup { host, scheduler, fake, daemon }
    }

    async fn drain(scheduler: &ContextFitScheduler) {
        for _ in 0..50 {
            if scheduler.step().await != Step::Ran {
                return;
            }
        }
    }

    fn failed_entry(fingerprint: MachineFingerprint) -> Value {
        json!({
            "maxContext": null, "trainedContext": null, "pool": null, "verdict": null, "measuredAt": null,
            "fingerprint": fingerprint, "userCap": null, "attempts": 1, "lastError": "load failed",
            "lastAttemptAt": "2026-10-07T10:00:00.000Z",
        })
    }

    fn measured_entry(max_context: u64, user_cap: Option<u64>) -> Value {
        json!({
            "maxContext": max_context, "trainedContext": 131072, "pool": "gpu", "verdict": "fits",
            "measuredAt": "2026-10-07T10:00:00.000Z", "fingerprint": MachineFingerprint::from(&machine()),
            "userCap": user_cap, "attempts": 0, "lastError": null, "lastAttemptAt": "2026-10-07T10:00:00.000Z",
        })
    }

    #[tokio::test]
    async fn waits_while_any_sidecar_is_running_or_compacting() {
        let s = setup(&["qwen3:8b"], |host| host.busy.store(true, Ordering::SeqCst)).await;
        s.scheduler.request_measure("qwen3:8b", MeasureReason::Manual).await.unwrap();
        assert_eq!(s.scheduler.step().await, Step::Waiting);
        assert_eq!(s.scheduler.step().await, Step::Waiting);
        assert!(s.host.measured_tags().is_empty());
        assert_eq!(s.scheduler.row_state("qwen3:8b"), RowState::Queued);

        s.host.busy.store(false, Ordering::SeqCst);
        assert_eq!(s.scheduler.step().await, Step::Ran);
        assert_eq!(s.host.measured_tags(), vec!["qwen3:8b"]);
        // The engine re-checks the same gate before every probe.
        assert!(!lock(&s.host.measured)[0].busy_at_start);
        assert_eq!(s.scheduler.step().await, Step::Idle);
        s.fake.close().await;
    }

    #[tokio::test]
    async fn puts_manual_requests_first_and_removes_duplicates() {
        let s = setup(&["a:latest", "b:latest", "c:latest", "d:latest"], |_| {}).await;
        s.scheduler.enqueue("a:latest", MeasureReason::Stale);
        s.scheduler.enqueue("b:latest", MeasureReason::Pulled);
        s.scheduler.enqueue("c:latest", MeasureReason::Manual);
        s.scheduler.enqueue("a:latest", MeasureReason::Manual);
        s.scheduler.enqueue("b:latest", MeasureReason::Pulled);
        s.scheduler.enqueue("c:latest", MeasureReason::Stale);
        s.scheduler.enqueue("d:latest", MeasureReason::Stale);
        assert_eq!(
            s.scheduler.queued(),
            vec![
                ("a:latest".to_string(), MeasureReason::Manual),
                ("c:latest".to_string(), MeasureReason::Manual),
                ("b:latest".to_string(), MeasureReason::Pulled),
                ("d:latest".to_string(), MeasureReason::Stale),
            ]
        );
        // Each tag announced "queued" once.
        assert_eq!(s.host.progress_states("a:latest"), vec!["queued"]);
        drain(&s.scheduler).await;
        assert_eq!(s.host.measured_tags(), vec!["a:latest", "c:latest", "b:latest", "d:latest"]);
        s.fake.close().await;
    }

    #[tokio::test]
    async fn requeues_an_interrupted_run_at_most_three_times() {
        let s = setup(&["qwen3:8b"], |host| {
            *lock(&host.outcomes) = VecDeque::from(vec![MeasureOutcome::Interrupted; 4]);
        })
        .await;
        s.scheduler.request_measure("qwen3:8b", MeasureReason::Manual).await.unwrap();
        drain(&s.scheduler).await;
        // The first run and three retries, then the item is dropped until the next trigger.
        assert_eq!(s.host.measured_tags().len(), 4);
        assert!(s.scheduler.queued().is_empty());
        assert_eq!(s.host.progress_states("qwen3:8b"), vec!["queued"; 4]);
        // The windows hear that the item left the queue.
        assert!(lock(&s.host.broadcasts).iter().any(|(channel, payload)| channel == CHANNEL_CONTEXT_CHANGED && payload["tag"] == "qwen3:8b"));
        // Nothing is stored for an interruption.
        assert!(s.host.store().models.is_empty());
        // A new trigger starts over, and this time the measurement completes.
        s.scheduler.request_measure("qwen3:8b", MeasureReason::Manual).await.unwrap();
        drain(&s.scheduler).await;
        assert_eq!(s.host.measured_tags().len(), 5);
        assert_eq!(s.host.store().models["qwen3:8b"].max_context, Some(65_536));
        s.fake.close().await;
    }

    #[tokio::test]
    async fn does_not_auto_retry_a_failed_model_but_retries_a_manual_request() {
        let s = setup(&["a:latest", "b:latest"], |host| {
            host.prefs
                .set(CONTEXT_FIT_PREF_KEY, json!({ "version": 1, "models": { "a:latest": failed_entry(MachineFingerprint::from(&machine())) } }))
                .unwrap();
            *lock(&host.outcomes) = VecDeque::from(vec![measured(65_536), MeasureOutcome::Error { message: "boom".into() }]);
        })
        .await;
        s.scheduler.startup_pass().await;
        assert_eq!(s.scheduler.queued(), vec![("b:latest".to_string(), MeasureReason::Stale)]);
        drain(&s.scheduler).await;
        // The startup pass runs once per app run.
        s.scheduler.startup_pass().await;
        assert!(s.scheduler.queued().is_empty());

        s.scheduler.request_measure("a:latest", MeasureReason::Manual).await.unwrap();
        drain(&s.scheduler).await;
        assert_eq!(s.host.measured_tags(), vec!["b:latest", "a:latest"]);
        let failed = &s.host.store().models["a:latest"];
        assert_eq!((failed.attempts, failed.last_error.as_deref(), failed.max_context), (2, Some("boom"), None));
        // A pull is an automatic trigger too: it leaves the failed model alone.
        s.scheduler.request_measure("a:latest", MeasureReason::Pulled).await.unwrap();
        drain(&s.scheduler).await;
        assert_eq!(s.host.measured_tags(), vec!["b:latest", "a:latest"]);
        assert_eq!(s.host.store().models["a:latest"].attempts, 2);
        s.fake.close().await;
    }

    #[tokio::test]
    async fn holds_a_pulled_model_until_the_welcome_dialog_has_closed() {
        let s = setup(&["qwen3:8b", "gemma3:latest"], |host| host.welcome.store(false, Ordering::SeqCst)).await;
        s.scheduler.request_measure("qwen3:8b", MeasureReason::Pulled).await.unwrap();
        assert_eq!(s.scheduler.step().await, Step::Waiting);
        assert!(s.host.measured_tags().is_empty());
        // A manual request is not held behind it.
        s.scheduler.request_measure("gemma3:latest", MeasureReason::Manual).await.unwrap();
        assert_eq!(s.scheduler.step().await, Step::Ran);
        assert_eq!(s.scheduler.step().await, Step::Waiting);
        assert_eq!(s.host.measured_tags(), vec!["gemma3:latest"]);

        s.host.welcome.store(true, Ordering::SeqCst);
        drain(&s.scheduler).await;
        assert_eq!(s.host.measured_tags(), vec!["gemma3:latest", "qwen3:8b"]);
        s.fake.close().await;
    }

    #[tokio::test]
    async fn stores_a_pulled_bare_tag_under_its_latest_name() {
        let s = setup(&["gemma3:latest"], |_| {}).await;
        s.scheduler.request_measure("gemma3", MeasureReason::Pulled).await.unwrap();
        assert_eq!(s.scheduler.queued(), vec![("gemma3:latest".to_string(), MeasureReason::Pulled)]);
        drain(&s.scheduler).await;
        assert!(s.host.store().models.contains_key("gemma3:latest"));
        let list = s.scheduler.list().await;
        assert_eq!(list.rows.len(), 1);
        assert_eq!(list.rows[0].tag, "gemma3:latest");
        assert_eq!(list.rows[0].effective, Some(65_536));
        assert_eq!(list.rows[0].entry.as_ref().and_then(|entry| entry.max_context), Some(65_536));
        assert_eq!((list.rows[0].stale, list.rows[0].state, list.reason), (false, RowState::Idle, None));
        assert_eq!(serde_json::to_value(&list).unwrap()["rows"][0]["envCap"], Value::Null);
        s.fake.close().await;
    }

    #[tokio::test]
    async fn keeps_a_cap_set_during_a_measurement() {
        let s = setup(&["qwen3:8b"], |host| {
            host.prefs.set(CONTEXT_FIT_PREF_KEY, json!({ "version": 1, "models": { "qwen3:8b": measured_entry(65_536, None) } })).unwrap();
            *lock(&host.outcomes) = VecDeque::from(vec![measured(131_072), measured(24_576)]);
            // The user lowers the context through the Ollama window while the model is being measured.
            *lock(&host.during) = Some(Box::new(|host: &FakeHost, tag: &str| {
                let scheduler = host.scheduler.get().and_then(std::sync::Weak::upgrade);
                let tag = tag.to_string();
                Box::pin(async move {
                    if let Some(scheduler) = scheduler {
                        scheduler.set_cap(&tag, &json!(32_768)).await.unwrap();
                    }
                })
            }));
        })
        .await;
        s.scheduler.request_measure("qwen3:8b", MeasureReason::Manual).await.unwrap();
        drain(&s.scheduler).await;
        let entry = &s.host.store().models["qwen3:8b"];
        assert_eq!((entry.max_context, entry.user_cap), (Some(131_072), Some(32_768)));
        assert!(s.host.overlay().contains("\"qwen3:8b\": 32768"));

        // A new maximum below the cap drops it.
        *lock(&s.host.during) = None;
        s.scheduler.request_measure("qwen3:8b", MeasureReason::Manual).await.unwrap();
        drain(&s.scheduler).await;
        let entry = &s.host.store().models["qwen3:8b"];
        assert_eq!((entry.max_context, entry.user_cap), (Some(24_576), None));
        s.fake.close().await;
    }

    #[tokio::test]
    async fn lowers_the_overlay_value_with_the_env_cap() {
        let s = setup(&["qwen3:8b"], |host| *lock(&host.env_cap) = Some(32_768)).await;
        s.scheduler.request_measure("qwen3:8b", MeasureReason::Manual).await.unwrap();
        drain(&s.scheduler).await;
        assert_eq!(s.host.overlay(), "ollama:\n  contextLimits:\n    \"qwen3:8b\": 32768\n");
        assert_eq!(s.host.store().models["qwen3:8b"].max_context, Some(65_536));
        let changed: Vec<Value> = lock(&s.host.broadcasts).iter().filter(|(c, _)| c == CHANNEL_CONTEXT_CHANGED).map(|(_, p)| p.clone()).collect();
        assert_eq!(changed, vec![json!({ "tag": "qwen3:8b" })]);
        // Without the env cap the measured maximum applies.
        *lock(&s.host.env_cap) = None;
        s.scheduler.refresh_overlay().await;
        assert_eq!(s.host.overlay(), "ollama:\n  contextLimits:\n    \"qwen3:8b\": 65536\n");
        s.fake.close().await;
    }

    fn session_state(model: &str, tokens: u64, window: u64) -> Value {
        json!({
            "model": { "provider": "ollama", "id": model, "contextWindow": window },
            "contextUsage": { "tokens": tokens, "contextWindow": window, "percent": 0 },
            "isStreaming": false,
        })
    }

    #[tokio::test]
    async fn compacts_only_idle_sessions_above_the_new_window_after_the_rebind() {
        let mut host = FakeHost::new("http://127.0.0.1:1");
        host.idle = vec!["/s/rebinds-late.jsonl".into(), "/s/fits.jsonl".into(), "/s/other-model.jsonl".into(), "/s/no-usage.jsonl".into()];
        {
            let mut sessions = lock(&host.sessions);
            // Reports the old window twice before the overlay reaches it.
            sessions.insert(
                "/s/rebinds-late.jsonl".into(),
                VecDeque::from(vec![session_state("qwen3:8b", 50_000, 131_072), session_state("qwen3:8b", 50_000, 131_072), session_state("qwen3:8b", 50_000, 32_768)]),
            );
            sessions.insert("/s/fits.jsonl".into(), VecDeque::from(vec![session_state("qwen3:8b", 10_000, 32_768)]));
            sessions.insert("/s/other-model.jsonl".into(), VecDeque::from(vec![session_state("gemma3:latest", 90_000, 131_072)]));
            sessions.insert(
                "/s/no-usage.jsonl".into(),
                VecDeque::from(vec![json!({ "model": { "provider": "ollama", "id": "qwen3:8b", "contextWindow": 32_768 }, "contextUsage": null })]),
            );
        }
        compact_after_drop(&host, "qwen3:8b", 32_768, timing()).await;
        let commands = lock(&host.commands).clone();
        let compacted: Vec<&str> = commands.iter().filter(|(_, kind)| kind == "compact").map(|(session, _)| session.as_str()).collect();
        assert_eq!(compacted, vec!["/s/rebinds-late.jsonl"]);
        // It polled until the late session reported the new window, and compacted only after that.
        let late: Vec<&str> = commands.iter().filter(|(session, _)| session == "/s/rebinds-late.jsonl").map(|(_, kind)| kind.as_str()).collect();
        assert_eq!(late, vec!["get_state", "get_state", "get_state", "compact"]);
    }

    #[tokio::test]
    async fn skips_the_startup_pass_when_a_configured_ollama_provider_exists() {
        let s = setup(&["qwen3:8b"], |host| host.configured.store(true, Ordering::SeqCst)).await;
        s.scheduler.startup_pass().await;
        assert!(s.scheduler.queued().is_empty());
        let list = s.scheduler.list().await;
        assert_eq!(list.reason, Some(ListReason::ConfiguredProvider));
        assert_eq!(serde_json::to_value(&list).unwrap()["reason"], "configured-provider");
        assert_eq!(list.rows.len(), 1);
        // Manual measurement still works.
        s.scheduler.request_measure("qwen3:8b", MeasureReason::Manual).await.unwrap();
        drain(&s.scheduler).await;
        assert_eq!(s.host.measured_tags(), vec!["qwen3:8b"]);
        s.fake.close().await;
    }

    #[tokio::test]
    async fn unloads_resident_models_before_measuring() {
        let daemon = Daemon::new(&["qwen3:8b"]);
        *lock(&daemon.resident) = vec!["other:1b".into(), "qwen3:8b".into()];
        let s = setup_with(daemon, |_| {}).await;
        s.scheduler.request_measure("qwen3:8b", MeasureReason::Manual).await.unwrap();
        drain(&s.scheduler).await;
        assert_eq!(*lock(&s.host.resident_at_measure), vec![Vec::<String>::new()]);
        let unloads: Vec<Value> = lock(&s.daemon.requests)
            .iter()
            .filter(|(path, body)| path == "/api/generate" && body.get("keep_alive") == Some(&json!(0)))
            .map(|(_, body)| body["model"].clone())
            .collect();
        assert_eq!(unloads, vec![json!("other:1b"), json!("qwen3:8b")]);
        s.fake.close().await;
    }

    #[tokio::test]
    async fn passes_the_global_cap_as_the_engine_ceiling() {
        let s = setup(&["qwen3:8b"], |_| {}).await;
        s.scheduler.request_measure("qwen3:8b", MeasureReason::Manual).await.unwrap();
        drain(&s.scheduler).await;
        *lock(&s.host.env_cap) = Some(65_536);
        s.scheduler.request_measure("qwen3:8b", MeasureReason::Manual).await.unwrap();
        drain(&s.scheduler).await;
        let ceilings: Vec<u64> = lock(&s.host.measured).iter().map(|recorded| recorded.max_context).collect();
        assert_eq!(ceilings, vec![SIDECAR_DEFAULT_OLLAMA_CONTEXT, 65_536]);
        assert_eq!(SIDECAR_DEFAULT_OLLAMA_CONTEXT, 131_072);
        s.fake.close().await;
    }

    #[tokio::test]
    async fn never_measures_a_cloud_tag_or_a_remote_host() {
        let mut daemon = Daemon::new(&["qwen3:8b", "gpt-oss:120b-cloud"]);
        daemon.rows.push(json!({ "name": "mine:latest", "model": "mine:latest", "remote_host": "https://ollama.com:443", "remote_model": "gpt-oss:120b" }));
        let s = setup_with(daemon, |_| {}).await;
        s.scheduler.startup_pass().await;
        assert_eq!(s.scheduler.queued(), vec![("qwen3:8b".to_string(), MeasureReason::Stale)]);
        for tag in ["gpt-oss:120b-cloud", "mine:latest", "bad name"] {
            assert!(s.scheduler.request_measure(tag, MeasureReason::Manual).await.is_err(), "{tag}");
        }
        assert_eq!(s.scheduler.list().await.rows.iter().map(|row| row.tag.as_str()).collect::<Vec<_>>(), vec!["qwen3:8b"]);
        drain(&s.scheduler).await;
        assert_eq!(s.host.measured_tags(), vec!["qwen3:8b"]);

        // A daemon elsewhere: nothing is listed, queued or measured.
        let remote = Arc::new(FakeHost::new("http://192.168.1.5:11434"));
        let scheduler = ContextFitScheduler::new(remote.clone(), timing());
        scheduler.startup_pass().await;
        assert!(scheduler.request_measure("qwen3:8b", MeasureReason::Manual).await.is_err());
        let list = scheduler.list().await;
        assert_eq!((list.rows.len(), list.reason), (0, Some(ListReason::RemoteHost)));
        scheduler.enqueue("qwen3:8b", MeasureReason::Manual);
        drain(&scheduler).await;
        assert!(remote.measured_tags().is_empty());
        assert!(scheduler.queued().is_empty());
        s.fake.close().await;
    }
}
