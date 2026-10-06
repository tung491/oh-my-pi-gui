//! The quick-entry rules that need no window, ported from
//! `src/main/quick-entry-core.ts`: where the bar goes, what a submit may carry,
//! which macOS chords the bar swallows, and the per-window prompt queue. The
//! shell owns a prompt until its chat window acknowledges it.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::window_bounds::Rect;
use super::Platform;
use crate::ports::WindowId;

pub(crate) const QUICK_ENTRY_MAX_CHARS: usize = 100_000;
/// Recent workspaces offered besides Work.
pub(crate) const QUICK_ENTRY_WORKSPACE_LIMIT: usize = 9;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Size {
    pub width: f64,
    pub height: f64,
}

pub(crate) const QUICK_ENTRY_SIZE: Size = Size { width: 680.0, height: 168.0 };

/// Centred horizontally, its top edge at 30% of the work area, never off it.
pub(crate) fn quick_entry_bounds(work_area: &Rect, size: Size) -> Rect {
    let width = size.width.min(work_area.width);
    let height = size.height.min(work_area.height);
    Rect {
        x: work_area.x + ((work_area.width - width) / 2.0).round(),
        y: work_area.y + (work_area.height * 0.3).round().min(work_area.height - height),
        width,
        height,
    }
}

/// `QuickEntryTarget`: where a quick-entry message starts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum QuickEntryTarget {
    Work,
    Workspace { cwd: String },
}

/// A well-formed target, rebuilt so no extra field from the sender survives.
/// Older builds and saved prefs still carry a "chat" target; it opens Work.
pub(crate) fn parse_target(value: Option<&Value>) -> Option<QuickEntryTarget> {
    let record = value.filter(|value| value.is_object())?;
    match record.get("kind").and_then(Value::as_str) {
        Some("chat" | "work") => Some(QuickEntryTarget::Work),
        Some("workspace") => match record.get("cwd").and_then(Value::as_str) {
            Some(cwd) if !cwd.is_empty() => Some(QuickEntryTarget::Workspace { cwd: cwd.to_string() }),
            _ => None,
        },
        _ => None,
    }
}

/// `QuickEntryFailure`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum QuickEntryFailure {
    TabCap,
    NoWindow,
    WorkspaceMissing,
    TabFailed,
    Interrupted,
    Invalid,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QuickEntryPrompt {
    pub id: String,
    pub text: String,
    pub target: QuickEntryTarget,
}

/// A prompt that did not reach a tab, waiting in the bar's restore list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QuickEntryReturned {
    #[serde(flatten)]
    pub prompt: QuickEntryPrompt,
    pub reason: QuickEntryFailure,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SubmitValidation {
    Ok { text: String, target: QuickEntryTarget },
    /// `invalid` or `workspace-missing`.
    Refused(QuickEntryFailure),
}

/// The shell re-checks everything the bar sends: trimmed text of 1 to
/// `QUICK_ENTRY_MAX_CHARS` characters, a known target, and a workspace that was
/// offered for this show and still exists. A crafted cwd therefore cannot open
/// an arbitrary directory as an agent workspace.
pub(crate) fn validate_submit(payload: Option<&Value>, offered_cwds: &HashSet<String>, is_directory: impl Fn(&str) -> bool) -> SubmitValidation {
    let Some(record) = payload.filter(|value| value.is_object()) else { return SubmitValidation::Refused(QuickEntryFailure::Invalid) };
    let Some(text) = record.get("text").and_then(Value::as_str) else { return SubmitValidation::Refused(QuickEntryFailure::Invalid) };
    let trimmed = text.trim();
    let length = trimmed.chars().count();
    if length == 0 || length > QUICK_ENTRY_MAX_CHARS {
        return SubmitValidation::Refused(QuickEntryFailure::Invalid);
    }
    let Some(target) = parse_target(record.get("target")) else { return SubmitValidation::Refused(QuickEntryFailure::Invalid) };
    if let QuickEntryTarget::Workspace { cwd } = &target {
        if !(offered_cwds.contains(cwd) && is_directory(cwd)) {
            return SubmitValidation::Refused(QuickEntryFailure::WorkspaceMissing);
        }
    }
    SubmitValidation::Ok { text: trimmed.to_string(), target }
}

/// The remembered target, unless it is malformed or names a workspace no longer offered.
pub(crate) fn resolve_initial_target(saved: Option<&Value>, offered_cwds: &HashSet<String>) -> QuickEntryTarget {
    match parse_target(saved) {
        Some(QuickEntryTarget::Workspace { cwd }) if !offered_cwds.contains(&cwd) => QuickEntryTarget::Work,
        Some(target) => target,
        None => QuickEntryTarget::Work,
    }
}

/// The parts of a key event the chord guard reads.
/// No Tauri hook sees key events before the page does (Electron's
/// `before-input-event`), so the guard below is kept for the day one exists
/// and is exercised by its tests only.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MenuChordInput {
    /// `keyDown` or `keyUp`.
    pub event_type: String,
    pub key: String,
    /// The physical key (`KeyC`), which stays Latin on Cyrillic, Greek or Hebrew layouts.
    pub code: String,
    pub meta: bool,
}

/// Editing and caret chords the bar's text field needs, plus ⌘Q.
#[cfg_attr(not(test), allow(dead_code))]
const MAC_BAR_CHORDS: [&str; 12] =
    ["a", "c", "v", "x", "z", "q", "arrowleft", "arrowright", "arrowup", "arrowdown", "backspace", "delete"];

/// macOS dispatches application-menu key equivalents while the bar is key, and
/// the menu targets the main window: ⌘W from the bar would close it. The bar
/// swallows every other ⌘ chord. Windows and Linux bars have no menu. A Latin
/// layout is judged by its character, as the menu matches it; a non-Latin
/// letter by its physical key, so ⌘C copies on a Russian layout.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn is_blocked_menu_chord(platform: Platform, input: &MenuChordInput) -> bool {
    if platform != Platform::Darwin || input.event_type != "keyDown" || !input.meta {
        return false;
    }
    let mut chars = input.key.chars();
    let non_ascii_single = matches!((chars.next(), chars.next()), (Some(first), None) if !first.is_ascii());
    let name = if non_ascii_single { input.code.strip_prefix("Key").unwrap_or(&input.code).to_string() } else { input.key.clone() };
    !MAC_BAR_CHORDS.contains(&name.to_lowercase().as_str())
}

/// One chat window's prompts: queued for it, then leased to its renderer until acknowledged.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct WindowQueue {
    pub pending: Vec<QuickEntryPrompt>,
    pub leased: Vec<QuickEntryPrompt>,
}

/// Keyed by the chat window.
pub(crate) type QuickEntryQueue = BTreeMap<WindowId, WindowQueue>;

fn with_window(queue: &mut QuickEntryQueue, window_id: WindowId, next: WindowQueue) {
    if next.pending.is_empty() && next.leased.is_empty() {
        queue.remove(&window_id);
    } else {
        queue.insert(window_id, next);
    }
}

pub(crate) fn enqueue(queue: &mut QuickEntryQueue, window_id: WindowId, prompt: QuickEntryPrompt) {
    queue.entry(window_id).or_default().pending.push(prompt);
}

/// Lease the window's pending prompts to its renderer. They stay in the shell
/// until acknowledged; the result holds only the prompts leased by this call,
/// so a prompt is handed out once per lease.
pub(crate) fn claim(queue: &mut QuickEntryQueue, window_id: WindowId) -> Vec<QuickEntryPrompt> {
    let Some(current) = queue.get_mut(&window_id) else { return Vec::new() };
    let claimed = std::mem::take(&mut current.pending);
    current.leased.extend(claimed.iter().cloned());
    claimed
}

/// The prompt reached its tab's composer: the shell forgets it.
pub(crate) fn ack(queue: &mut QuickEntryQueue, window_id: WindowId, id: &str) {
    let Some(current) = queue.get(&window_id).cloned() else { return };
    let leased = current.leased.into_iter().filter(|prompt| prompt.id != id).collect();
    with_window(queue, window_id, WindowQueue { pending: current.pending, leased });
}

/// The renderer reloaded: its leases go back to pending, ahead of newer prompts, for the boot drain.
/// Nothing in this module observes a page reload (the bridge detaches on page
/// load in the foundation), so this runs in tests only.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn release_leases(queue: &mut QuickEntryQueue, window_id: WindowId) {
    let Some(current) = queue.get_mut(&window_id) else { return };
    if current.leased.is_empty() {
        return;
    }
    let mut pending = std::mem::take(&mut current.leased);
    pending.append(&mut current.pending);
    current.pending = pending;
}

/// The renderer gave a leased prompt back. The shell's own copy is returned,
/// so the restore list never carries text the chat window rewrote.
pub(crate) fn return_prompt(queue: &mut QuickEntryQueue, window_id: WindowId, id: &str, reason: QuickEntryFailure) -> Option<QuickEntryReturned> {
    let current = queue.get(&window_id).cloned()?;
    let prompt = current.leased.iter().find(|entry| entry.id == id).cloned()?;
    let leased = current.leased.into_iter().filter(|entry| entry.id != id).collect();
    with_window(queue, window_id, WindowQueue { pending: current.pending, leased });
    Some(QuickEntryReturned { prompt, reason })
}

/// The window closed: every prompt it still held goes back to the bar, one entry each, oldest first.
pub(crate) fn close_window(queue: &mut QuickEntryQueue, window_id: WindowId) -> Vec<QuickEntryReturned> {
    let Some(current) = queue.remove(&window_id) else { return Vec::new() };
    current
        .leased
        .into_iter()
        .chain(current.pending)
        .map(|prompt| QuickEntryReturned { prompt, reason: QuickEntryFailure::Interrupted })
        .collect()
}

/// The bar took a restored prompt into its draft; it is listed exactly once.
pub(crate) fn consume_restored(restored: &[QuickEntryReturned], id: &str) -> Vec<QuickEntryReturned> {
    restored.iter().filter(|entry| entry.prompt.id != id).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect { x, y, width, height }
    }

    #[test]
    fn centres_the_bar_horizontally_at_30_of_the_work_area_s_height() {
        assert_eq!(quick_entry_bounds(&rect(0.0, 25.0, 1920.0, 1055.0), QUICK_ENTRY_SIZE), rect(620.0, 25.0 + 317.0, 680.0, 168.0));
    }

    #[test]
    fn places_it_on_an_offset_display_s_own_work_area() {
        assert_eq!(
            quick_entry_bounds(&rect(-1440.0, -200.0, 1440.0, 900.0), QUICK_ENTRY_SIZE),
            rect(-1440.0 + 380.0, -200.0 + 270.0, 680.0, 168.0)
        );
    }

    #[test]
    fn shrinks_and_clamps_to_a_work_area_smaller_than_the_bar() {
        assert_eq!(quick_entry_bounds(&rect(10.0, 10.0, 500.0, 200.0), QUICK_ENTRY_SIZE), rect(10.0, 10.0 + 32.0, 500.0, 168.0));
        assert_eq!(quick_entry_bounds(&rect(0.0, 0.0, 800.0, 150.0), QUICK_ENTRY_SIZE), rect(60.0, 0.0, 680.0, 150.0));
    }

    fn offered() -> HashSet<String> {
        ["/work/app", "/work/gone"].into_iter().map(String::from).collect()
    }

    fn is_directory(path: &str) -> bool {
        path != "/work/gone"
    }

    fn ok(text: &str, target: QuickEntryTarget) -> SubmitValidation {
        SubmitValidation::Ok { text: text.into(), target }
    }

    #[test]
    fn forwards_trimmed_text_with_a_rebuilt_target() {
        let payload = json!({ "text": "  hello \n", "target": { "kind": "chat", "extra": 1 } });
        assert_eq!(validate_submit(Some(&payload), &offered(), is_directory), ok("hello", QuickEntryTarget::Work));
        let workspace = json!({ "text": "x", "target": { "kind": "workspace", "cwd": "/work/app" } });
        assert_eq!(
            validate_submit(Some(&workspace), &offered(), is_directory),
            ok("x", QuickEntryTarget::Workspace { cwd: "/work/app".into() })
        );
    }

    #[test]
    fn refuses_empty_and_whitespace_only_text() {
        let empty = json!({ "text": "", "target": { "kind": "work" } });
        assert_eq!(validate_submit(Some(&empty), &offered(), is_directory), SubmitValidation::Refused(QuickEntryFailure::Invalid));
        let blank = json!({ "text": " \n\t ", "target": { "kind": "work" } });
        assert_eq!(validate_submit(Some(&blank), &offered(), is_directory), SubmitValidation::Refused(QuickEntryFailure::Invalid));
    }

    #[test]
    fn refuses_text_over_the_limit() {
        let text = "a".repeat(QUICK_ENTRY_MAX_CHARS + 1);
        let over = json!({ "text": text, "target": { "kind": "work" } });
        assert_eq!(validate_submit(Some(&over), &offered(), is_directory), SubmitValidation::Refused(QuickEntryFailure::Invalid));
        let at_limit = json!({ "text": &text[1..], "target": { "kind": "work" } });
        assert!(matches!(validate_submit(Some(&at_limit), &offered(), is_directory), SubmitValidation::Ok { .. }));
    }

    #[test]
    fn refuses_malformed_payloads_and_unknown_target_kinds() {
        for payload in [Value::Null, json!("hi"), json!({ "text": 1, "target": { "kind": "work" } }), json!({ "text": "hi" })] {
            assert_eq!(validate_submit(Some(&payload), &offered(), is_directory), SubmitValidation::Refused(QuickEntryFailure::Invalid));
        }
        assert_eq!(validate_submit(None, &offered(), is_directory), SubmitValidation::Refused(QuickEntryFailure::Invalid));
        let shell = json!({ "text": "hi", "target": { "kind": "shell" } });
        assert_eq!(validate_submit(Some(&shell), &offered(), is_directory), SubmitValidation::Refused(QuickEntryFailure::Invalid));
        let bad_cwd = json!({ "text": "hi", "target": { "kind": "workspace", "cwd": 7 } });
        assert_eq!(validate_submit(Some(&bad_cwd), &offered(), is_directory), SubmitValidation::Refused(QuickEntryFailure::Invalid));
    }

    #[test]
    fn refuses_a_workspace_that_was_not_offered() {
        let payload = json!({ "text": "hi", "target": { "kind": "workspace", "cwd": "/etc" } });
        assert_eq!(validate_submit(Some(&payload), &offered(), |_| true), SubmitValidation::Refused(QuickEntryFailure::WorkspaceMissing));
    }

    #[test]
    fn refuses_an_offered_workspace_that_was_deleted() {
        let payload = json!({ "text": "hi", "target": { "kind": "workspace", "cwd": "/work/gone" } });
        assert_eq!(
            validate_submit(Some(&payload), &offered(), is_directory),
            SubmitValidation::Refused(QuickEntryFailure::WorkspaceMissing)
        );
    }

    fn one_offered() -> HashSet<String> {
        HashSet::from(["/work/app".to_string()])
    }

    #[test]
    fn reads_a_saved_chat_target_as_work_and_keeps_work_or_a_still_offered_workspace() {
        assert_eq!(resolve_initial_target(Some(&json!({ "kind": "chat" })), &one_offered()), QuickEntryTarget::Work);
        assert_eq!(resolve_initial_target(Some(&json!({ "kind": "work" })), &one_offered()), QuickEntryTarget::Work);
        assert_eq!(
            resolve_initial_target(Some(&json!({ "kind": "workspace", "cwd": "/work/app" })), &one_offered()),
            QuickEntryTarget::Workspace { cwd: "/work/app".into() }
        );
    }

    #[test]
    fn falls_back_to_work_for_a_stale_workspace_or_garbage() {
        assert_eq!(resolve_initial_target(Some(&json!({ "kind": "workspace", "cwd": "/old" })), &one_offered()), QuickEntryTarget::Work);
        assert_eq!(resolve_initial_target(None, &one_offered()), QuickEntryTarget::Work);
        for saved in [Value::Null, json!("work"), json!({ "kind": 3 })] {
            assert_eq!(resolve_initial_target(Some(&saved), &one_offered()), QuickEntryTarget::Work);
        }
    }

    fn chord(key: &str, event_type: &str, code: &str) -> MenuChordInput {
        MenuChordInput { event_type: event_type.into(), key: key.into(), code: code.into(), meta: true }
    }

    fn down(key: &str) -> MenuChordInput {
        chord(key, "keyDown", "")
    }

    #[test]
    fn swallows_w_and_n_on_macos() {
        assert!(is_blocked_menu_chord(Platform::Darwin, &down("w")));
        assert!(is_blocked_menu_chord(Platform::Darwin, &down("n")));
        assert!(is_blocked_menu_chord(Platform::Darwin, &down(",")));
    }

    #[test]
    fn lets_editing_chords_and_q_through() {
        for key in ["v", "c", "x", "a", "z", "Z", "q", "ArrowLeft", "Backspace"] {
            assert!(!is_blocked_menu_chord(Platform::Darwin, &down(key)), "{key}");
        }
    }

    #[test]
    fn lets_editing_chords_through_on_non_latin_layouts_by_their_physical_key() {
        assert!(!is_blocked_menu_chord(Platform::Darwin, &chord("с", "keyDown", "KeyC")));
        assert!(!is_blocked_menu_chord(Platform::Darwin, &chord("м", "keyDown", "KeyV")));
        assert!(is_blocked_menu_chord(Platform::Darwin, &chord("ц", "keyDown", "KeyW")));
    }

    #[test]
    fn judges_a_latin_layout_by_the_character_the_menu_matches() {
        // Dvorak: the C character sits on the I key; AZERTY: W sits on the Z key.
        assert!(!is_blocked_menu_chord(Platform::Darwin, &chord("c", "keyDown", "KeyI")));
        assert!(is_blocked_menu_chord(Platform::Darwin, &chord("W", "keyDown", "KeyZ")));
        assert!(is_blocked_menu_chord(Platform::Darwin, &chord("w", "keyDown", "KeyZ")));
    }

    #[test]
    fn ignores_key_up_events_and_keys_without() {
        assert!(!is_blocked_menu_chord(Platform::Darwin, &chord("w", "keyUp", "")));
        let no_meta = MenuChordInput { event_type: "keyDown".into(), key: "w".into(), code: "KeyW".into(), meta: false };
        assert!(!is_blocked_menu_chord(Platform::Darwin, &no_meta));
    }

    #[test]
    fn never_blocks_on_linux_or_windows() {
        assert!(!is_blocked_menu_chord(Platform::Linux, &down("w")));
        assert!(!is_blocked_menu_chord(Platform::Win32, &down("w")));
    }

    fn prompt(id: &str) -> QuickEntryPrompt {
        QuickEntryPrompt { id: id.into(), text: format!("text {id}"), target: QuickEntryTarget::Work }
    }

    fn ids(prompts: &[QuickEntryPrompt]) -> Vec<&str> {
        prompts.iter().map(|p| p.id.as_str()).collect()
    }

    const W1: WindowId = WindowId(1);
    const W2: WindowId = WindowId(2);
    const W3: WindowId = WindowId(3);

    #[test]
    fn leases_on_claim_without_deleting_and_hands_each_prompt_out_once() {
        let mut queue = QuickEntryQueue::new();
        enqueue(&mut queue, W1, prompt("a"));
        enqueue(&mut queue, W1, prompt("b"));
        let first = claim(&mut queue, W1);
        assert_eq!(ids(&first), vec!["a", "b"]);
        assert_eq!(queue.get(&W1), Some(&WindowQueue { pending: vec![], leased: vec![prompt("a"), prompt("b")] }));
        assert!(claim(&mut queue, W1).is_empty());
    }

    #[test]
    fn keeps_each_window_s_prompts_apart() {
        let mut queue = QuickEntryQueue::new();
        enqueue(&mut queue, W1, prompt("a"));
        enqueue(&mut queue, W2, prompt("b"));
        assert_eq!(ids(&claim(&mut queue, W2)), vec!["b"]);
        assert!(claim(&mut queue, W3).is_empty());
        assert_eq!(queue.get(&W1).map(|q| q.pending.len()), Some(1));
    }

    #[test]
    fn drops_a_prompt_on_ack() {
        let mut queue = QuickEntryQueue::new();
        enqueue(&mut queue, W1, prompt("a"));
        enqueue(&mut queue, W1, prompt("b"));
        claim(&mut queue, W1);
        ack(&mut queue, W1, "a");
        assert_eq!(queue.get(&W1), Some(&WindowQueue { pending: vec![], leased: vec![prompt("b")] }));
        ack(&mut queue, W1, "b");
        assert!(!queue.contains_key(&W1));
    }

    #[test]
    fn returns_leases_to_pending_after_a_reload_ahead_of_newer_prompts() {
        let mut queue = QuickEntryQueue::new();
        enqueue(&mut queue, W1, prompt("a"));
        claim(&mut queue, W1);
        enqueue(&mut queue, W1, prompt("b"));
        release_leases(&mut queue, W1);
        assert_eq!(queue.get(&W1), Some(&WindowQueue { pending: vec![prompt("a"), prompt("b")], leased: vec![] }));
        assert_eq!(ids(&claim(&mut queue, W1)), vec!["a", "b"]);
    }

    #[test]
    fn gives_a_leased_prompt_back_with_main_s_copy_of_the_text() {
        let mut queue = QuickEntryQueue::new();
        enqueue(&mut queue, W1, prompt("a"));
        claim(&mut queue, W1);
        let returned = return_prompt(&mut queue, W1, "a", QuickEntryFailure::TabCap);
        assert_eq!(returned, Some(QuickEntryReturned { prompt: prompt("a"), reason: QuickEntryFailure::TabCap }));
        assert!(!queue.contains_key(&W1));
        assert_eq!(return_prompt(&mut queue, W1, "a", QuickEntryFailure::TabCap), None);
    }

    #[test]
    fn moves_every_prompt_of_a_closed_window_to_the_restore_list_one_entry_each() {
        let mut queue = QuickEntryQueue::new();
        enqueue(&mut queue, W1, prompt("a"));
        claim(&mut queue, W1);
        enqueue(&mut queue, W1, prompt("b"));
        let returned = close_window(&mut queue, W1);
        assert_eq!(
            returned,
            vec![
                QuickEntryReturned { prompt: prompt("a"), reason: QuickEntryFailure::Interrupted },
                QuickEntryReturned { prompt: prompt("b"), reason: QuickEntryFailure::Interrupted },
            ]
        );
        assert!(!queue.contains_key(&W1));
        assert!(close_window(&mut queue, W1).is_empty());
    }

    #[test]
    fn consumes_a_restored_entry_exactly_once() {
        let mut queue = QuickEntryQueue::new();
        enqueue(&mut queue, W1, prompt("a"));
        enqueue(&mut queue, W1, prompt("b"));
        let restored = close_window(&mut queue, W1);
        let once = consume_restored(&restored, "a");
        assert_eq!(once.iter().map(|entry| entry.prompt.id.as_str()).collect::<Vec<_>>(), vec!["b"]);
        assert_eq!(consume_restored(&once, "a"), once);
    }

    #[test]
    fn returned_prompts_serialize_flat_like_the_typescript_shape() {
        let returned = QuickEntryReturned { prompt: prompt("a"), reason: QuickEntryFailure::TabCap };
        assert_eq!(
            serde_json::to_value(&returned).unwrap(),
            json!({ "id": "a", "text": "text a", "target": { "kind": "work" }, "reason": "tab-cap" })
        );
    }
}
