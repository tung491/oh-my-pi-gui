//! The quick-entry bar: a small
//! frameless window summoned over whatever the user is doing, which hands its
//! prompt to a new tab in the main window. The bar is never a window record,
//! so the tray, the menus and tab-layout persistence never see it. The shell
//! keeps every accepted prompt until the chat window acknowledges it, and gives
//! back to the bar's restore list whatever a closed window never delivered; the
//! pure rules live in `quick_entry_core`.

use std::collections::{HashSet, BTreeMap};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use super::quick_entry_core::{
    ack, claim, close_window, consume_restored, enqueue, quick_entry_bounds, resolve_initial_target, return_prompt, validate_submit,
    QuickEntryFailure, QuickEntryPrompt, QuickEntryQueue, QuickEntryReturned, QuickEntryTarget, SubmitValidation, QUICK_ENTRY_SIZE,
    QUICK_ENTRY_WORKSPACE_LIMIT,
};
use super::windows::{QuickEntrySpec, WinEvent};
use super::{lock, survive, Desktop};
use crate::bridge::{self, DEEP_LINK_CHANNEL, QUICK_ENTRY_STATE_CHANNEL};
use crate::ctx::AppCtx;
use crate::i18n::MainLanguage;
use crate::ports::{SessionInfo, SessionKind, SessionScope, WindowId};
use crate::runtime_log;

/// How long a summon waits for the startup windows before showing the bar anyway.
pub(crate) const STARTUP_SETTLE_CEILING: Duration = Duration::from_secs(5);
const TARGET_PREF_KEY: &str = "quickEntryTarget";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QuickEntryWorkspace {
    pub cwd: String,
    pub name: String,
}

/// `QuickEntryBarState`: what the bar shows for one summon.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QuickEntryBarState {
    pub language: MainLanguage,
    pub target: QuickEntryTarget,
    pub workspaces: Vec<QuickEntryWorkspace>,
    pub restored: Vec<QuickEntryReturned>,
    pub show_id: u64,
}

#[derive(Default)]
struct BarState {
    /// The bar window exists.
    built: bool,
    queue: QuickEntryQueue,
    restored: Vec<QuickEntryReturned>,
    workspaces: Vec<QuickEntryWorkspace>,
    /// Workspaces offered during the current show: the cached list plus the refreshed one.
    offered: HashSet<String>,
    /// Workspaces of prompts that came back to the bar; still offered once the bar took them.
    restored_cwds: HashSet<String>,
    /// Startup windows that have not shown (or closed) yet.
    startup_pending: HashSet<WindowId>,
    startup_tracked: bool,
    settled: bool,
    ceiling_passed: bool,
    show_when_settled: bool,
}

pub(crate) struct QuickEntryController {
    state: Mutex<BarState>,
    show_id: AtomicU64,
}

impl Default for QuickEntryController {
    fn default() -> Self {
        Self { state: Mutex::new(BarState::default()), show_id: AtomicU64::new(0) }
    }
}

/// `recentWorkspaceCwds`: unique cwds ordered by their newest session.
pub(crate) fn recent_workspace_cwds(sessions: &[SessionInfo]) -> Vec<String> {
    let mut by_cwd: BTreeMap<String, i64> = BTreeMap::new();
    for session in sessions {
        let modified = chrono::DateTime::parse_from_rfc3339(&session.modified).map(|date| date.timestamp_millis()).unwrap_or(0);
        let entry = by_cwd.entry(session.cwd.clone()).or_insert(-1);
        if modified > *entry {
            *entry = modified;
        }
    }
    let mut cwds: Vec<(String, i64)> = by_cwd.into_iter().collect();
    cwds.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    cwds.into_iter().map(|(cwd, _)| cwd).collect()
}

/// The workspaces the bar offers besides Work: recent agent workspaces that still exist.
pub(crate) fn offered_workspaces(sessions: &[SessionInfo], work: &str, directory_exists: impl Fn(&str) -> bool) -> Vec<QuickEntryWorkspace> {
    let agent_sessions: Vec<SessionInfo> = sessions.iter().filter(|session| session.kind != Some(SessionKind::Chat)).cloned().collect();
    let mut workspaces = Vec::new();
    for cwd in recent_workspace_cwds(&agent_sessions) {
        if workspaces.len() == QUICK_ENTRY_WORKSPACE_LIMIT {
            break;
        }
        if cwd == work || !directory_exists(&cwd) {
            continue;
        }
        let name = Path::new(&cwd).file_name().map(|name| name.to_string_lossy().to_string()).filter(|name| !name.is_empty()).unwrap_or_else(|| cwd.clone());
        workspaces.push(QuickEntryWorkspace { cwd, name });
    }
    workspaces
}

impl QuickEntryController {
    /// The startup windows each show and take focus once ready; a summon before
    /// then would be blurred away, so the bar waits for all of them (or the ceiling).
    pub(crate) fn mark_startup_windows(&self, ctx: &Arc<AppCtx>, desktop: &Desktop, windows: &[WindowId]) {
        {
            let mut state = lock(&self.state);
            state.startup_tracked = true;
            state.startup_pending = windows.iter().copied().collect();
            if state.startup_pending.is_empty() {
                state.settled = true;
            }
        }
        let weak = Arc::downgrade(ctx);
        bridge::spawn_task(async move {
            tokio::time::sleep(STARTUP_SETTLE_CEILING).await;
            let Some(ctx) = weak.upgrade() else { return };
            let Some(desktop) = Desktop::of(&ctx) else { return };
            lock(&desktop.quick_entry.state).ceiling_passed = true;
            desktop.quick_entry.flush_deferred_show(&ctx, desktop);
        });
        if lock(&self.state).settled {
            self.flush_deferred_show(ctx, desktop);
        }
    }

    /// A startup window was shown (it took focus) or closed.
    pub(crate) fn note_startup_window_shown(&self, win_id: WindowId, desktop: &Desktop) {
        let settled_now = {
            let mut state = lock(&self.state);
            if !state.startup_tracked || state.settled {
                return;
            }
            state.startup_pending.remove(&win_id);
            if state.startup_pending.is_empty() {
                state.settled = true;
                true
            } else {
                false
            }
        };
        if settled_now {
            if let Some(ctx) = desktop.ctx() {
                self.flush_deferred_show(&ctx, desktop);
            }
        }
    }

    fn flush_deferred_show(&self, ctx: &AppCtx, desktop: &Desktop) {
        let show = {
            let mut state = lock(&self.state);
            std::mem::take(&mut state.show_when_settled)
        };
        if show {
            self.show(ctx, desktop);
        }
    }

    /// Show the bar now, or once startup has settled.
    pub(crate) fn show_when_settled(&self, ctx: &AppCtx, desktop: &Desktop) {
        let ready = {
            let state = lock(&self.state);
            state.settled || state.ceiling_passed
        };
        if ready {
            self.show(ctx, desktop);
        } else {
            lock(&self.state).show_when_settled = true;
        }
    }

    pub(crate) fn show(&self, ctx: &AppCtx, desktop: &Desktop) {
        if !self.ensure_window(desktop) {
            return;
        }
        self.show_id.fetch_add(1, Ordering::SeqCst);
        {
            let mut state = lock(&self.state);
            let mut offered: HashSet<String> = state.workspaces.iter().map(|workspace| workspace.cwd.clone()).collect();
            offered.extend(state.restored_cwds.iter().cloned());
            state.offered = offered;
        }
        self.push_state(ctx, desktop);
        self.refresh_workspaces(desktop);
        self.reveal(desktop);
    }

    pub(crate) fn hide(&self, desktop: &Desktop) {
        if desktop.backend.exists(WindowId::QUICK_ENTRY) && desktop.backend.is_visible(WindowId::QUICK_ENTRY) {
            desktop.backend.hide(WindowId::QUICK_ENTRY);
        }
    }

    pub(crate) fn toggle(&self, ctx: &AppCtx, desktop: &Desktop) {
        if self.is_showing(desktop) {
            self.hide(desktop);
        } else {
            self.show_when_settled(ctx, desktop);
        }
    }

    /// A hidden bar would keep the app alive after its last chat window closed.
    pub(crate) fn destroy_window(&self, desktop: &Desktop) {
        if desktop.backend.exists(WindowId::QUICK_ENTRY) {
            desktop.backend.destroy(WindowId::QUICK_ENTRY);
        }
        lock(&self.state).built = false;
    }

    fn ensure_window(&self, desktop: &Desktop) -> bool {
        if lock(&self.state).built && desktop.backend.exists(WindowId::QUICK_ENTRY) {
            return true;
        }
        let portal = desktop.wayland_portal;
        // Native Wayland cannot place a window; elsewhere the bar opens on the cursor's display.
        let position = if portal { None } else { desktop.backend.work_area_at_cursor().map(|area| quick_entry_bounds(&area, QUICK_ENTRY_SIZE)).map(|rect| (rect.x, rect.y)) };
        match desktop.backend.build_quick_entry_window(QuickEntrySpec { position, dark: desktop.backend.prefers_dark() }) {
            Ok(()) => {
                lock(&self.state).built = true;
                true
            }
            Err(error) => {
                runtime_log::note("quick-entry", format!("Quick entry window could not be built: {error}"), json!({}));
                false
            }
        }
    }

    fn reveal(&self, desktop: &Desktop) {
        if desktop.wayland_portal {
            // Native Wayland cannot place a window, and focus() raises mutter's
            // "is ready" notification; a newly mapped window gets focus anyway.
            desktop.backend.show(WindowId::QUICK_ENTRY);
            return;
        }
        if let Some(area) = desktop.backend.work_area_at_cursor() {
            desktop.backend.set_bounds(WindowId::QUICK_ENTRY, quick_entry_bounds(&area, QUICK_ENTRY_SIZE));
        }
        desktop.backend.focus(WindowId::QUICK_ENTRY);
    }

    /// The bar's own window events.
    pub(crate) fn on_window_event(&self, ctx: &AppCtx, desktop: &Desktop, event: WinEvent) {
        match event {
            WinEvent::Focused(false) => self.on_blur(desktop),
            WinEvent::Destroyed => {
                lock(&self.state).built = false;
                let _ = ctx;
            }
            _ => {}
        }
    }

    fn on_blur(&self, desktop: &Desktop) {
        // While startup windows are still appearing, the one that just took focus
        // is the app's own; hiding would lose the summon the user asked for.
        if !lock(&self.state).settled {
            if let Some(focused) = desktop.backend.focused_window() {
                if desktop.windows.is_record(focused) {
                    return;
                }
            }
        }
        self.hide(desktop);
    }

    /// Visible, or about to be once its page has painted.
    fn is_showing(&self, desktop: &Desktop) -> bool {
        lock(&self.state).built && desktop.backend.is_visible(WindowId::QUICK_ENTRY)
    }

    pub(crate) fn bar_state(&self, ctx: &AppCtx) -> QuickEntryBarState {
        let state = lock(&self.state);
        QuickEntryBarState {
            language: ctx.i18n.language(),
            target: resolve_initial_target(ctx.prefs.get(TARGET_PREF_KEY).as_ref(), &state.offered),
            workspaces: state.workspaces.clone(),
            restored: state.restored.clone(),
            show_id: self.show_id.load(Ordering::SeqCst),
        }
    }

    fn push_state(&self, ctx: &AppCtx, desktop: &Desktop) {
        if !desktop.backend.exists(WindowId::QUICK_ENTRY) {
            return;
        }
        match serde_json::to_value(self.bar_state(ctx)) {
            Ok(value) => ctx.bridge.emit_to_window(WindowId::QUICK_ENTRY, QUICK_ENTRY_STATE_CHANNEL, value),
            Err(error) => runtime_log::note("quick-entry", format!("Quick entry state could not be serialized: {error}"), json!({})),
        }
    }

    /// Refresh the recent-workspace list from the session index, off the caller's thread.
    fn refresh_workspaces(&self, desktop: &Desktop) {
        let weak = desktop.ctx.clone();
        bridge::spawn_task(async move {
            let Some(ctx) = weak.upgrade() else { return };
            let Some(listing) = survive("services.sessions_list", || ctx.services.sessions_list(SessionScope::Global, None)) else { return };
            let sessions = match listing.await {
                Ok(sessions) => sessions,
                Err(error) => {
                    runtime_log::note("quick-entry", format!("Quick entry could not list workspaces: {error}"), json!({}));
                    return;
                }
            };
            let Some(desktop) = Desktop::of(&ctx) else { return };
            desktop.quick_entry.apply_workspaces(&ctx, desktop, &sessions);
        });
    }

    pub(crate) fn apply_workspaces(&self, ctx: &AppCtx, desktop: &Desktop, sessions: &[SessionInfo]) {
        let work = desktop.backend.default_workspace().map(|path| path.to_string_lossy().to_string()).unwrap_or_default();
        let workspaces = offered_workspaces(sessions, &work, |path| desktop.backend.directory_exists(path));
        {
            let mut state = lock(&self.state);
            for workspace in &workspaces {
                state.offered.insert(workspace.cwd.clone());
            }
            state.workspaces = workspaces;
        }
        if self.is_showing(desktop) {
            self.push_state(ctx, desktop);
        }
    }

    /// `quick-entry:submit` from the bar.
    pub(crate) fn submit(&self, ctx: &AppCtx, desktop: &Desktop, payload: Option<&Value>) -> Result<(), QuickEntryFailure> {
        let valid = {
            let state = lock(&self.state);
            validate_submit(payload, &state.offered, |path| desktop.backend.directory_exists(path))
        };
        let (text, target) = match valid {
            SubmitValidation::Ok { text, target } => (text, target),
            SubmitValidation::Refused(reason) => return Err(reason),
        };
        let existing = desktop.windows.main_window();
        // Fast path only: the tab spawn in the chat window is the authoritative cap check.
        if existing.is_some() && survive("tabs.at_cap", || ctx.tabs.at_cap()).unwrap_or(false) {
            return Err(QuickEntryFailure::TabCap);
        }
        let Some(win_id) = existing.or_else(|| desktop.spawn_window_in(ctx, None, None, None)) else { return Err(QuickEntryFailure::NoWindow) };
        let prompt = QuickEntryPrompt { id: uuid_v4(), text, target: target.clone() };
        enqueue(&mut lock(&self.state).queue, win_id, prompt);
        if let Ok(value) = serde_json::to_value(&target) {
            if let Err(error) = ctx.prefs.set(TARGET_PREF_KEY, value) {
                runtime_log::note("quick-entry", format!("could not save the quick entry target: {error}"), json!({}));
            }
        }
        // A window spawned just now shows itself once its page is ready.
        if existing.is_some() {
            desktop.backend.focus(win_id);
        }
        // A nudge only: the renderer claims the queue itself, and also drains at boot.
        ctx.bridge.emit_to_window(win_id, DEEP_LINK_CHANNEL, json!({ "action": "quick-entry" }));
        self.hide(desktop);
        Ok(())
    }

    pub(crate) fn consume_restored(&self, id: &str) {
        let mut state = lock(&self.state);
        state.restored = consume_restored(&state.restored, id);
    }

    pub(crate) fn claim(&self, win_id: WindowId) -> Vec<QuickEntryPrompt> {
        claim(&mut lock(&self.state).queue, win_id)
    }

    pub(crate) fn ack(&self, win_id: WindowId, id: &str) {
        ack(&mut lock(&self.state).queue, win_id, id);
    }

    pub(crate) fn return_prompt(&self, ctx: &AppCtx, desktop: &Desktop, win_id: WindowId, id: &str, reason: QuickEntryFailure) {
        let returned = return_prompt(&mut lock(&self.state).queue, win_id, id, reason);
        if let Some(returned) = returned {
            self.restore(ctx, desktop, vec![returned]);
        }
    }

    /// A chat window closed: every prompt it still held goes back to the bar.
    pub(crate) fn on_window_closed(&self, ctx: &AppCtx, win_id: WindowId, desktop: &Desktop) {
        let returned = close_window(&mut lock(&self.state).queue, win_id);
        if !returned.is_empty() {
            self.restore(ctx, desktop, returned);
        }
        self.note_startup_window_shown(win_id, desktop);
    }

    fn restore(&self, ctx: &AppCtx, desktop: &Desktop, returned: Vec<QuickEntryReturned>) {
        {
            let mut state = lock(&self.state);
            // A restored prompt's workspace was offered when it was first sent, and
            // the bar lists it again; submit still checks that it exists.
            for entry in &returned {
                if let QuickEntryTarget::Workspace { cwd } = &entry.prompt.target {
                    state.restored_cwds.insert(cwd.clone());
                    state.offered.insert(cwd.clone());
                }
            }
            state.restored.extend(returned);
        }
        // An open bar picks them up now; otherwise the next summon shows them.
        if self.is_showing(desktop) {
            self.push_state(ctx, desktop);
        }
    }

    #[cfg(test)]
    pub(crate) fn restored(&self) -> Vec<QuickEntryReturned> {
        lock(&self.state).restored.clone()
    }

    #[cfg(test)]
    pub(crate) fn queue(&self) -> QuickEntryQueue {
        lock(&self.state).queue.clone()
    }
}

impl Desktop {
    pub(crate) fn on_quick_entry_window_event(&self, ctx: &AppCtx, event: WinEvent) {
        self.quick_entry.on_window_event(ctx, self, event);
    }

    pub(crate) fn is_chat_window(&self, win_id: WindowId) -> bool {
        self.windows.is_record(win_id)
    }
}

/// A random v4 UUID in canonical form, for prompt ids.
fn uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    let mut seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0) ^ NEXT.fetch_add(0x9e37_79b9_7f4a_7c15, Ordering::Relaxed);
    for chunk in bytes.chunks_mut(8) {
        // SplitMix64 step: enough entropy for an id that only has to be unique within one process.
        seed = seed.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = seed;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^= z >> 31;
        chunk.copy_from_slice(&z.to_le_bytes()[..chunk.len()]);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex::encode(bytes);
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

static NEXT: AtomicU64 = AtomicU64::new(0x1234_5678_9abc_def0);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::{dispatch_for_test, Envelope};
    use crate::desktop::testing::{attach_recording_sink, harness, Backend as _, DesktopPort as _, Harness};
    use crate::ports::{Caller, SessionStatus};

    fn session(cwd: &str, modified: &str, kind: Option<SessionKind>) -> SessionInfo {
        SessionInfo {
            path: format!("{cwd}/s.jsonl"),
            id: cwd.into(),
            title: None,
            cwd: cwd.into(),
            created: modified.into(),
            modified: modified.into(),
            message_count: 1,
            size: 1,
            status: SessionStatus::Complete,
            kind,
            parent_session_path: None,
            first_message: String::new(),
        }
    }

    #[test]
    fn offers_recent_agent_workspaces_newest_first_without_work_or_missing_ones() {
        let sessions = vec![
            session("/w/alpha", "2026-10-01T10:00:00Z", None),
            session("/w/beta", "2026-10-02T10:00:00Z", Some(SessionKind::Agent)),
            session("/w/gone", "2026-10-03T10:00:00Z", None),
            session("/work", "2026-10-04T10:00:00Z", None),
            session("/w/chat", "2026-10-05T10:00:00Z", Some(SessionKind::Chat)),
        ];
        let offered = offered_workspaces(&sessions, "/work", |path| path != "/w/gone");
        assert_eq!(offered, vec![
            QuickEntryWorkspace { cwd: "/w/beta".into(), name: "beta".into() },
            QuickEntryWorkspace { cwd: "/w/alpha".into(), name: "alpha".into() },
        ]);
        assert!(uuid_v4() != uuid_v4());
        assert_eq!(uuid_v4().len(), 36);
    }

    #[tokio::test]
    async fn submit_queues_the_prompt_for_the_main_window_and_nudges_it() {
        let Harness { ctx, desktop, backend, .. } = harness();
        let id = desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        let sink = attach_recording_sink(&ctx, id);
        desktop.quick_entry.show(&ctx, &desktop);
        assert!(backend.is_visible(WindowId::QUICK_ENTRY));
        let result = dispatch_for_test(&ctx, Caller::quick_entry(), "quick-entry:submit", vec![json!({ "text": "  hello ", "target": { "kind": "work" } })]).await.unwrap();
        assert_eq!(result, json!({ "ok": true }));
        assert!(!backend.is_visible(WindowId::QUICK_ENTRY), "the bar hides after a submit");
        let sent: Vec<Envelope> = sink.sent();
        assert_eq!(sent.last().map(|e| (e.channel.as_str(), e.payload.clone())), Some((DEEP_LINK_CHANNEL, json!({ "action": "quick-entry" }))));
        assert_eq!(ctx.prefs.get("quickEntryTarget"), Some(json!({ "kind": "work" })));
        let claimed = dispatch_for_test(&ctx, Caller::main(id), "quick-entry:claim", vec![]).await.unwrap();
        assert_eq!(claimed[0]["text"], "hello");
        assert_eq!(claimed[0]["target"], json!({ "kind": "work" }));
        let prompt_id = claimed[0]["id"].as_str().unwrap().to_string();
        dispatch_for_test(&ctx, Caller::main(id), "quick-entry:ack", vec![json!(prompt_id)]).await.unwrap();
        assert!(desktop.quick_entry.queue().is_empty());
    }

    #[tokio::test]
    async fn submit_refuses_bad_payloads_and_the_pool_cap() {
        let Harness { ctx, desktop, fakes, .. } = harness();
        desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        let invalid = dispatch_for_test(&ctx, Caller::quick_entry(), "quick-entry:submit", vec![json!({ "text": "" })]).await.unwrap();
        assert_eq!(invalid, json!({ "ok": false, "reason": "invalid" }));
        let missing = dispatch_for_test(&ctx, Caller::quick_entry(), "quick-entry:submit", vec![json!({ "text": "hi", "target": { "kind": "workspace", "cwd": "/etc" } })]).await.unwrap();
        assert_eq!(missing, json!({ "ok": false, "reason": "workspace-missing" }));
        *fakes.tabs.at_cap.lock().unwrap() = true;
        let capped = dispatch_for_test(&ctx, Caller::quick_entry(), "quick-entry:submit", vec![json!({ "text": "hi", "target": { "kind": "work" } })]).await.unwrap();
        assert_eq!(capped, json!({ "ok": false, "reason": "tab-cap" }));
        // The bar's channels are not for chat windows and vice versa.
        assert!(dispatch_for_test(&ctx, Caller::main(WindowId(1)), "quick-entry:submit", vec![]).await.is_err());
        assert!(dispatch_for_test(&ctx, Caller::quick_entry(), "quick-entry:claim", vec![]).await.is_err());
    }

    #[tokio::test]
    async fn submit_without_a_window_spawns_one() {
        let Harness { ctx, desktop, .. } = harness();
        let result = dispatch_for_test(&ctx, Caller::quick_entry(), "quick-entry:submit", vec![json!({ "text": "hi", "target": { "kind": "work" } })]).await.unwrap();
        assert_eq!(result, json!({ "ok": true }));
        let id = desktop.main_window().unwrap();
        assert_eq!(desktop.quick_entry.claim(id).len(), 1);
    }

    #[tokio::test]
    async fn returned_and_interrupted_prompts_land_in_the_restore_list_once() {
        let Harness { ctx, desktop, backend, .. } = harness();
        let id = desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        desktop.quick_entry.show(&ctx, &desktop);
        dispatch_for_test(&ctx, Caller::quick_entry(), "quick-entry:submit", vec![json!({ "text": "one", "target": { "kind": "work" } })]).await.unwrap();
        dispatch_for_test(&ctx, Caller::quick_entry(), "quick-entry:submit", vec![json!({ "text": "two", "target": { "kind": "chat" } })]).await.unwrap();
        let claimed = dispatch_for_test(&ctx, Caller::main(id), "quick-entry:claim", vec![]).await.unwrap();
        let first = claimed[0].clone();
        dispatch_for_test(&ctx, Caller::main(id), "quick-entry:return", vec![json!({ "prompt": first, "reason": "tab-cap" })]).await.unwrap();
        let restored = desktop.quick_entry.restored();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].reason, QuickEntryFailure::TabCap);
        assert_eq!(restored[0].prompt.text, "one");
        // The second, still leased, comes back as interrupted when the window closes.
        backend.destroy(id);
        desktop.on_window_event(&ctx, id, WinEvent::Destroyed);
        let restored = desktop.quick_entry.restored();
        assert_eq!(restored.len(), 2);
        assert_eq!(restored[1].reason, QuickEntryFailure::Interrupted);
        let consumed = first["id"].as_str().unwrap();
        dispatch_for_test(&ctx, Caller::quick_entry(), "quick-entry:consume-restored", vec![json!(consumed)]).await.unwrap();
        assert_eq!(desktop.quick_entry.restored().len(), 1);
        let state = desktop.quick_entry.bar_state(&ctx);
        assert_eq!(state.restored.len(), 1);
        assert_eq!(state.target, QuickEntryTarget::Work);
    }

    #[tokio::test]
    async fn dismiss_hides_the_bar_and_blur_hides_it_once_startup_settled() {
        let Harness { ctx, desktop, backend, .. } = harness();
        desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        desktop.quick_entry.mark_startup_windows(&ctx, &desktop, &[]);
        desktop.quick_entry.show(&ctx, &desktop);
        let spec = backend.quick_entry_specs.lock().unwrap()[0].clone();
        assert_eq!(spec.position, Some((620.0, 324.0)));
        assert!(backend.is_visible(WindowId::QUICK_ENTRY));
        dispatch_for_test(&ctx, Caller::quick_entry(), "quick-entry:dismiss", vec![]).await.unwrap();
        assert!(!backend.is_visible(WindowId::QUICK_ENTRY));
        desktop.quick_entry.toggle(&ctx, &desktop);
        assert!(backend.is_visible(WindowId::QUICK_ENTRY));
        desktop.on_window_event(&ctx, WindowId::QUICK_ENTRY, WinEvent::Focused(false));
        assert!(!backend.is_visible(WindowId::QUICK_ENTRY));
    }

    #[tokio::test]
    async fn the_shortcut_channels_serve_chat_windows_only() {
        let Harness { ctx, desktop, .. } = harness();
        let id = desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        let state = dispatch_for_test(&ctx, Caller::main(id), "quick-entry:shortcut-get", vec![]).await.unwrap();
        assert_eq!(state["chord"], "⇧⌃␣");
        assert_eq!(state["mode"], "native");
        let result = dispatch_for_test(&ctx, Caller::main(id), "quick-entry:shortcut-set", vec![json!({ "chord": "⌥⇧K" })]).await.unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(result["state"]["chord"], "⌥⇧K");
        assert_eq!(ctx.prefs.get("quickEntryShortcut"), Some(json!({ "chord": "⌥⇧K", "enabled": true })));
        dispatch_for_test(&ctx, Caller::main(id), "quick-entry:shortcut-suspend", vec![json!(true)]).await.unwrap();
        let notice = dispatch_for_test(&ctx, Caller::main(id), "quick-entry:shortcut-notice", vec![]).await.unwrap();
        assert_eq!(notice, Value::Null);
        assert!(dispatch_for_test(&ctx, Caller::main(WindowId(42)), "quick-entry:shortcut-get", vec![]).await.is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn a_summon_before_startup_settles_waits_for_the_windows_or_the_ceiling() {
        let Harness { ctx, desktop, backend, .. } = harness();
        let id = desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        desktop.quick_entry.mark_startup_windows(&ctx, &desktop, &[id]);
        desktop.quick_entry.show_when_settled(&ctx, &desktop);
        assert!(!backend.exists(WindowId::QUICK_ENTRY), "the bar waits for the startup window");
        desktop.on_window_event(&ctx, id, WinEvent::Focused(true));
        assert!(backend.is_visible(WindowId::QUICK_ENTRY));
        // A fresh controller with a window that never shows gives up at the ceiling.
        let Harness { ctx, desktop, backend, .. } = harness();
        let id = desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        desktop.quick_entry.mark_startup_windows(&ctx, &desktop, &[id]);
        desktop.quick_entry.show_when_settled(&ctx, &desktop);
        tokio::time::sleep(STARTUP_SETTLE_CEILING + Duration::from_millis(10)).await;
        assert!(backend.is_visible(WindowId::QUICK_ENTRY));
    }
}
