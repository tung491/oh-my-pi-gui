//! The quick-entry shortcut's rules, with the chord grammar of
//! `src/shared/chord.ts` it depends on: which chords may be grabbed
//! system-wide, how a saved or requested change applies in each mode, and what
//! the shortcuts dialog is told. A global grab breaks the chord in every other
//! app and survives restarts, so the policy is stricter than the in-app keymap's.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(crate) use super::wayland_portal::ShortcutMode;

// ---------------------------------------------------------------------------
// Chord grammar (`src/shared/chord.ts`)
// ---------------------------------------------------------------------------

/// Modifiers ⌃⌥⇧⌘ plus a canonical base key: uppercase letter, digit, literal
/// punctuation, glyph (↑↓←→↵⇥␣⎋⌫⌦) or F-key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Chord {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
    pub key: String,
}

fn text_modifier(name: &str) -> Option<&'static str> {
    match name.to_lowercase().as_str() {
        "ctrl" | "control" => Some("ctrl"),
        "alt" | "option" => Some("alt"),
        "shift" => Some("shift"),
        "cmd" | "command" | "meta" | "super" => Some("meta"),
        _ => None,
    }
}

fn named_key(name: &str) -> Option<&'static str> {
    Some(match name.to_lowercase().as_str() {
        "up" | "arrowup" => "↑",
        "down" | "arrowdown" => "↓",
        "left" | "arrowleft" => "←",
        "right" | "arrowright" => "→",
        "enter" | "return" => "↵",
        "tab" => "⇥",
        "space" | "spacebar" => "␣",
        "esc" | "escape" => "⎋",
        "backspace" => "⌫",
        "delete" | "del" => "⌦",
        _ => return None,
    })
}

fn normalize_base_key(raw: &str) -> Option<String> {
    let mut chars = raw.chars();
    match (chars.next(), chars.next()) {
        (None, _) => None,
        (Some(single), None) => Some(if single.is_ascii_alphabetic() { single.to_ascii_uppercase().to_string() } else { single.to_string() }),
        _ => {
            if let Some(alias) = named_key(raw) {
                return Some(alias.to_string());
            }
            let digits = raw.strip_prefix(['f', 'F'])?;
            let n: u32 = digits.parse().ok().filter(|_| digits.len() <= 2)?;
            (1..=12).contains(&n).then(|| format!("F{n}"))
        }
    }
}

/// Parse a chord (canonical glyph form or textual alias form). `None` for
/// anything without a base key or without at least one of ⌃/⌥/⌘: unmodified
/// and shift-only "chords" are unbindable by design.
pub(crate) fn parse_chord(input: &str) -> Option<Chord> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut chord = Chord { ctrl: false, alt: false, shift: false, meta: false, key: String::new() };
    let mut base = String::new();
    if trimmed.chars().any(|c| matches!(c, '⌃' | '⌥' | '⇧' | '⌘')) {
        for c in trimmed.chars() {
            match c {
                '⌃' => chord.ctrl = true,
                '⌥' => chord.alt = true,
                '⇧' => chord.shift = true,
                '⌘' => chord.meta = true,
                other => base.push(other),
            }
        }
    } else {
        // Consume leading "modifier<sep>" tokens; whatever remains is the base
        // key, so "ctrl+-" binds "-" and "ctrl++" binds "+".
        let mut rest = trimmed;
        loop {
            let word_end = rest.find(|c: char| !c.is_ascii_alphabetic()).unwrap_or(rest.len());
            let word = &rest[..word_end];
            let after = rest[word_end..].trim_start();
            let Some(separator) = after.strip_prefix(['+', '-']) else { break };
            let Some(modifier) = (!word.is_empty()).then(|| text_modifier(word)).flatten() else { break };
            match modifier {
                "ctrl" => chord.ctrl = true,
                "alt" => chord.alt = true,
                "shift" => chord.shift = true,
                _ => chord.meta = true,
            }
            rest = separator.trim_start();
        }
        base = rest.to_string();
    }
    chord.key = normalize_base_key(base.trim())?;
    if !chord.ctrl && !chord.alt && !chord.meta {
        return None;
    }
    Some(chord)
}

/// Canonical chord string: modifiers in ⌥⇧⌃⌘ order plus the canonical base key.
pub(crate) fn serialize_chord(chord: &Chord) -> String {
    let mut out = String::new();
    if chord.alt {
        out.push('⌥');
    }
    if chord.shift {
        out.push('⇧');
    }
    if chord.ctrl {
        out.push('⌃');
    }
    if chord.meta {
        out.push('⌘');
    }
    out.push_str(&chord.key);
    out
}

/// ⌘ → ⌃, re-serialized so the modifier order stays canonical; chords without ⌘ pass through.
pub(crate) fn ctrl_twin(chord: &str) -> String {
    match parse_chord(chord) {
        Some(parsed) if parsed.meta => serialize_chord(&Chord { meta: false, ctrl: true, ..parsed }),
        _ => chord.to_string(),
    }
}

/// The accelerator parser knows the named keys, printable ASCII and F-keys.
/// Any other base key (§, é, ¥ from a national layout) cannot be registered.
fn accelerator_key(key: &str) -> Option<String> {
    let named = match key {
        "␣" => Some("Space"),
        "↵" => Some("Enter"),
        "⇥" => Some("Tab"),
        "⎋" => Some("Escape"),
        "⌫" => Some("Backspace"),
        "⌦" => Some("Delete"),
        "↑" => Some("Up"),
        "↓" => Some("Down"),
        "←" => Some("Left"),
        "→" => Some("Right"),
        "+" => Some("Plus"),
        _ => None,
    };
    if let Some(named) = named {
        return Some(named.to_string());
    }
    let mut chars = key.chars();
    let printable_ascii = matches!((chars.next(), chars.next()), (Some(c), None) if ('\x21'..='\x7e').contains(&c));
    let f_key = key.strip_prefix('F').map(|digits| !digits.is_empty() && digits.len() <= 2 && digits.chars().all(|c| c.is_ascii_digit())).unwrap_or(false);
    (printable_ascii || f_key).then(|| key.to_string())
}

/// Accelerator for a chord: "⇧⌃␣" → "Control+Shift+Space". ⌘ is Super; it is
/// never widened to CommandOrControl.
pub(crate) fn chord_to_accelerator(chord: &str) -> Option<String> {
    let parsed = parse_chord(chord)?;
    let mut parts: Vec<&str> = Vec::new();
    if parsed.meta {
        parts.push("Super");
    }
    if parsed.ctrl {
        parts.push("Control");
    }
    if parsed.alt {
        parts.push("Alt");
    }
    if parsed.shift {
        parts.push("Shift");
    }
    let key = accelerator_key(&parsed.key)?;
    parts.push(&key);
    Some(parts.join("+"))
}

// ---------------------------------------------------------------------------
// Native chords (`src/shared/hotkeys.ts`)
// ---------------------------------------------------------------------------

/// Chords the shell's own menu and the window toggle own: `(id, canonical chord, accelerator)`.
pub(crate) const NATIVE_CHORDS: [(&str, &str, &str); 5] = [
    ("window.toggle", "⇧⌘O", "CommandOrControl+Shift+O"),
    ("session.new", "⌘N", "CmdOrCtrl+N"),
    ("session.exportHtml", "⌘E", "CmdOrCtrl+E"),
    ("window.new", "⇧⌘N", "CmdOrCtrl+Shift+N"),
    ("window.close", "⇧⌘W", "CmdOrCtrl+Shift+W"),
];

/// Accelerator for a native chord id.
pub(crate) fn native_accelerator(id: &str) -> Option<&'static str> {
    NATIVE_CHORDS.iter().find(|(entry, _, _)| *entry == id).map(|(_, _, accelerator)| *accelerator)
}

/// The quick-entry bar's system-wide chord: literal Control.
pub(crate) const QUICK_ENTRY_DEFAULT_CHORD: &str = "⇧⌃␣";

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/// Chords the window manager or the OS itself owns, in canonical form (⌘ is Cmd or Super).
const OS_CHORDS: [&str; 7] = ["⌥⇥", "⌥F4", "⌘⇥", "⌘␣", "⌘Q", "⌥⌃⌦", "⌘L"];

/// `QuickEntryShortcutPref`: the saved shortcut (`quickEntryShortcut` pref).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QuickEntryShortcutPref {
    /// Canonical chord, e.g. "⇧⌃␣".
    pub chord: String,
    pub enabled: bool,
}

impl QuickEntryShortcutPref {
    pub(crate) fn default_pref() -> Self {
        Self { chord: QUICK_ENTRY_DEFAULT_CHORD.into(), enabled: true }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ChordRejection {
    Invalid,
    System,
    Reserved,
}

/// The app chord this one would collide with: a `NATIVE_CHORDS` id (CommandOrControl, which is Ctrl on Linux).
pub(crate) fn reserved_global_chord(chord: &str) -> Option<&'static str> {
    let canonical = serialize_chord(&parse_chord(chord)?);
    NATIVE_CHORDS.iter().find_map(|(id, native, _)| (ctrl_twin(native) == canonical).then_some(*id))
}

/// The one global-chord policy. `Invalid`: unparsable, or a key that cannot
/// be registered; `System`: Ctrl and/or Cmd alone or a window-manager chord;
/// `Reserved`: one of the app's own native chords.
pub(crate) fn validate_global_chord(chord: &str) -> Option<ChordRejection> {
    let Some(parsed) = parse_chord(chord) else { return Some(ChordRejection::Invalid) };
    if chord_to_accelerator(chord).is_none() {
        return Some(ChordRejection::Invalid);
    }
    if !parsed.alt && !parsed.shift {
        return Some(ChordRejection::System);
    }
    if OS_CHORDS.contains(&serialize_chord(&parsed).as_str()) {
        return Some(ChordRejection::System);
    }
    if reserved_global_chord(chord).is_some() {
        return Some(ChordRejection::Reserved);
    }
    None
}

/// The saved shortcut, or the default chord when the saved one is missing,
/// malformed or no longer allowed. A boolean `enabled` survives, so a user's
/// "off" is kept even when the chord falls back.
pub(crate) fn sanitize_shortcut_pref(raw: Option<&Value>) -> QuickEntryShortcutPref {
    let record = raw.filter(|value| value.is_object());
    let enabled = record.and_then(|r| r.get("enabled")).and_then(Value::as_bool).unwrap_or(true);
    let chord = record.and_then(|r| r.get("chord")).and_then(Value::as_str).unwrap_or("");
    match parse_chord(chord) {
        Some(parsed) if validate_global_chord(chord).is_none() => QuickEntryShortcutPref { chord: serialize_chord(&parsed), enabled },
        _ => QuickEntryShortcutPref { enabled, ..QuickEntryShortcutPref::default_pref() },
    }
}

/// `ollamaContextFit` holds each local model's measured context; only the
/// `ollama` module writes it, through `ollama:context-set-cap` and its scheduler.
const MAIN_OWNED_PREF_KEYS: [&str; 3] = ["quickEntryShortcut", "quickEntryTarget", "ollamaContextFit"];

/// Keys only the shell writes, through validated channels; the generic
/// `prefs:set` refuses them. The store reads "a.b" as a path, so the first segment counts.
pub(crate) fn is_main_owned_pref_key(key: &str) -> bool {
    MAIN_OWNED_PREF_KEYS.contains(&key.split('.').next().unwrap_or(""))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ShortcutPlan {
    Reject(ChordRejection),
    /// Portal: the desktop owns the binding; the change applies after a restart.
    Persist { next: QuickEntryShortcutPref },
    /// Native: the accelerators to unregister and register (`None` when off).
    Rebind { next: QuickEntryShortcutPref, from: Option<String>, to: Option<String> },
}

/// `QuickEntryShortcutUpdate`: `{ chord } | { enabled } | { reset: true }`.
fn next_pref(current: &QuickEntryShortcutPref, update: &Value) -> Result<QuickEntryShortcutPref, ChordRejection> {
    if !update.is_object() {
        return Err(ChordRejection::Invalid);
    }
    if update.get("reset").and_then(Value::as_bool) == Some(true) {
        return Ok(QuickEntryShortcutPref::default_pref());
    }
    if let Some(enabled) = update.get("enabled").and_then(Value::as_bool) {
        return Ok(QuickEntryShortcutPref { chord: current.chord.clone(), enabled });
    }
    let Some(chord) = update.get("chord").and_then(Value::as_str) else { return Err(ChordRejection::Invalid) };
    if let Some(reason) = validate_global_chord(chord) {
        return Err(reason);
    }
    let parsed = parse_chord(chord).ok_or(ChordRejection::Invalid)?;
    // Picking a new chord means the user wants it to work.
    Ok(QuickEntryShortcutPref { chord: serialize_chord(&parsed), enabled: true })
}

pub(crate) fn plan_shortcut_update(current: &QuickEntryShortcutPref, update: &Value, mode: ShortcutMode) -> ShortcutPlan {
    let next = match next_pref(current, update) {
        Ok(next) => next,
        Err(reason) => return ShortcutPlan::Reject(reason),
    };
    if mode == ShortcutMode::Portal {
        return ShortcutPlan::Persist { next };
    }
    let accelerator = |pref: &QuickEntryShortcutPref| if pref.enabled { chord_to_accelerator(&pref.chord) } else { None };
    let from = accelerator(current);
    let to = accelerator(&next);
    ShortcutPlan::Rebind { next, from, to }
}

/// A saved chord was replaced by the default, as opposed to kept or only re-spelled.
pub(crate) fn saved_chord_replaced(raw: Option<&Value>, pref: &QuickEntryShortcutPref) -> bool {
    let Some(raw) = raw else { return false };
    let chord = raw.get("chord").and_then(Value::as_str);
    match chord.and_then(parse_chord) {
        Some(parsed) => serialize_chord(&parsed) != pref.chord,
        None => true,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ShortcutStatus {
    Registered,
    Requested,
    Refused,
    Off,
}

/// `QuickEntryShortcutState`: what the shortcuts dialog is told.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QuickEntryShortcutState {
    pub chord: String,
    pub enabled: bool,
    pub mode: ShortcutModeName,
    pub status: ShortcutStatus,
    pub restart_required: bool,
    pub desktop_entry_missing: bool,
    pub xwayland_only: bool,
}

/// `"native" | "portal"` on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ShortcutModeName {
    Native,
    Portal,
}

impl From<ShortcutMode> for ShortcutModeName {
    fn from(mode: ShortcutMode) -> Self {
        match mode {
            ShortcutMode::Native => ShortcutModeName::Native,
            ShortcutMode::Portal => ShortcutModeName::Portal,
        }
    }
}

pub(crate) struct ShortcutStateInput<'a> {
    pub pref: &'a QuickEntryShortcutPref,
    /// What this session registered at startup or on the last native rebind (`None`: nothing).
    pub bound: Option<&'a QuickEntryShortcutPref>,
    pub mode: ShortcutMode,
    /// The last register result; `None` when none was attempted.
    pub registered: Option<bool>,
    pub desktop_entry_missing: bool,
    pub xwayland_only: bool,
}

pub(crate) fn shortcut_state(input: ShortcutStateInput<'_>) -> QuickEntryShortcutState {
    let portal = input.mode == ShortcutMode::Portal;
    let status = match (input.pref.enabled, input.registered) {
        (false, _) | (_, None) => ShortcutStatus::Off,
        (_, Some(false)) => ShortcutStatus::Refused,
        (_, Some(true)) if portal => ShortcutStatus::Requested,
        (_, Some(true)) => ShortcutStatus::Registered,
    };
    QuickEntryShortcutState {
        chord: input.pref.chord.clone(),
        enabled: input.pref.enabled,
        mode: input.mode.into(),
        status,
        // Turning it off and back on applies live (activations are muted), so only
        // a chord this session never asked the desktop for needs a restart.
        restart_required: portal && input.pref.enabled && input.bound.map(|bound| bound.chord.as_str()) != Some(input.pref.chord.as_str()),
        desktop_entry_missing: portal && input.desktop_entry_missing,
        xwayland_only: !portal && input.xwayland_only,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn default() -> QuickEntryShortcutPref {
        QuickEntryShortcutPref { chord: "⇧⌃␣".into(), enabled: true }
    }

    #[test]
    fn treats_the_context_fit_pref_as_main_owned() {
        assert!(is_main_owned_pref_key("ollamaContextFit"));
        assert!(is_main_owned_pref_key("ollamaContextFit.models"));
        assert!(!is_main_owned_pref_key("ollamaContextFitness"));
    }

    #[test]
    fn refuses_ctrl_or_cmd_alone_and_the_window_manager_s_chords() {
        for chord in ["⌃V", "⌘C", "⌘Q", "⌥F4", "⌘␣", "⌃⌘Q", "⌥⇥", "⌥⌃⌦"] {
            assert_eq!(validate_global_chord(chord), Some(ChordRejection::System), "{chord}");
        }
        assert_eq!(validate_global_chord("⌃A"), Some(ChordRejection::System));
    }

    #[test]
    fn accepts_chords_with_alt_or_shift_beyond_ctrl_cmd() {
        for chord in ["⌥␣", "⇧⌃␣", "⌥⇧K", "⇧⌘K"] {
            assert_eq!(validate_global_chord(chord), None, "{chord}");
        }
    }

    #[test]
    fn refuses_what_does_not_parse() {
        assert_eq!(validate_global_chord("⇧A"), Some(ChordRejection::Invalid));
        assert_eq!(validate_global_chord("hello"), Some(ChordRejection::Invalid));
    }

    #[test]
    fn refuses_a_key_electron_cannot_register_which_would_throw_rather_than_fail() {
        assert_eq!(validate_global_chord("⇧⌃§"), Some(ChordRejection::Invalid));
        assert_eq!(validate_global_chord("⌥⇧\u{1}"), Some(ChordRejection::Invalid));
        assert_eq!(sanitize_shortcut_pref(Some(&json!({ "chord": "⇧⌃§", "enabled": true }))), default());
    }

    #[test]
    fn refuses_the_app_s_own_native_chords_in_their_platform_spelling() {
        assert_eq!(reserved_global_chord("⇧⌃O"), Some("window.toggle"));
        assert_eq!(reserved_global_chord("⇧⌘O"), None);
        assert_eq!(validate_global_chord("⇧⌃O"), Some(ChordRejection::Reserved));
        assert_eq!(validate_global_chord("⇧⌃W"), Some(ChordRejection::Reserved));
    }

    #[test]
    fn keeps_a_valid_saved_chord_in_canonical_form() {
        assert_eq!(
            sanitize_shortcut_pref(Some(&json!({ "chord": "alt+shift+k", "enabled": false }))),
            QuickEntryShortcutPref { chord: "⌥⇧K".into(), enabled: false }
        );
    }

    #[test]
    fn falls_back_to_the_default_for_garbage_or_a_missing_value() {
        assert_eq!(sanitize_shortcut_pref(None), default());
        for raw in [Value::Null, json!("⇧⌃␣"), json!({ "chord": 3 }), json!({ "chord": "nope", "enabled": true })] {
            assert_eq!(sanitize_shortcut_pref(Some(&raw)), default(), "{raw}");
        }
    }

    #[test]
    fn treats_a_missing_enabled_flag_as_on() {
        assert_eq!(
            sanitize_shortcut_pref(Some(&json!({ "chord": "⌥␣" }))),
            QuickEntryShortcutPref { chord: "⌥␣".into(), enabled: true }
        );
    }

    #[test]
    fn replaces_a_saved_editing_chord_with_the_default_keeping_the_user_s_off_switch() {
        assert_eq!(sanitize_shortcut_pref(Some(&json!({ "chord": "⌃V", "enabled": true }))), default());
        assert_eq!(
            sanitize_shortcut_pref(Some(&json!({ "chord": "⌃V", "enabled": false }))),
            QuickEntryShortcutPref { enabled: false, ..default() }
        );
    }

    #[test]
    fn reports_a_replaced_chord_not_a_re_spelled_one_or_a_first_run() {
        let keep = |raw: Option<Value>| saved_chord_replaced(raw.as_ref(), &sanitize_shortcut_pref(raw.as_ref()));
        assert!(keep(Some(json!({ "chord": "⌃V", "enabled": true }))));
        assert!(keep(Some(json!("⇧⌃␣"))));
        assert!(!keep(Some(json!({ "chord": "alt+shift+k", "enabled": true }))));
        assert!(!keep(Some(json!({ "chord": "⇧⌃␣", "enabled": "yes" }))));
        assert!(!keep(None));
    }

    #[test]
    fn covers_the_quick_entry_keys_only() {
        assert!(is_main_owned_pref_key("quickEntryShortcut"));
        assert!(is_main_owned_pref_key("quickEntryTarget"));
        assert!(!is_main_owned_pref_key("language"));
        assert!(!is_main_owned_pref_key("quickEntryShortcutX"));
    }

    #[test]
    fn covers_a_dotted_path_into_a_main_owned_key() {
        assert!(is_main_owned_pref_key("quickEntryShortcut.chord"));
        assert!(is_main_owned_pref_key("quickEntryTarget.cwd"));
    }

    #[test]
    fn rebinds_live_in_native_mode() {
        assert_eq!(
            plan_shortcut_update(&default(), &json!({ "chord": "⌥⇧K" }), ShortcutMode::Native),
            ShortcutPlan::Rebind {
                next: QuickEntryShortcutPref { chord: "⌥⇧K".into(), enabled: true },
                from: Some("Control+Shift+Space".into()),
                to: Some("Alt+Shift+K".into()),
            }
        );
    }

    #[test]
    fn only_persists_in_portal_mode() {
        assert_eq!(
            plan_shortcut_update(&default(), &json!({ "chord": "⌥⇧K" }), ShortcutMode::Portal),
            ShortcutPlan::Persist { next: QuickEntryShortcutPref { chord: "⌥⇧K".into(), enabled: true } }
        );
    }

    #[test]
    fn unregisters_on_disable_registers_on_enable_and_resets_to_the_default() {
        let off = QuickEntryShortcutPref { enabled: false, ..default() };
        assert_eq!(
            plan_shortcut_update(&default(), &json!({ "enabled": false }), ShortcutMode::Native),
            ShortcutPlan::Rebind { next: off.clone(), from: Some("Control+Shift+Space".into()), to: None }
        );
        assert_eq!(
            plan_shortcut_update(&off, &json!({ "enabled": true }), ShortcutMode::Native),
            ShortcutPlan::Rebind { next: default(), from: None, to: Some("Control+Shift+Space".into()) }
        );
        let moved_off = QuickEntryShortcutPref { chord: "⌥⇧K".into(), enabled: false };
        assert_eq!(
            plan_shortcut_update(&moved_off, &json!({ "reset": true }), ShortcutMode::Native),
            ShortcutPlan::Rebind { next: default(), from: None, to: Some("Control+Shift+Space".into()) }
        );
    }

    #[test]
    fn rejects_with_the_policy_s_reason_before_touching_anything() {
        assert_eq!(
            plan_shortcut_update(&default(), &json!({ "chord": "⌘C" }), ShortcutMode::Native),
            ShortcutPlan::Reject(ChordRejection::System)
        );
        assert_eq!(
            plan_shortcut_update(&default(), &json!({ "chord": "⇧A" }), ShortcutMode::Native),
            ShortcutPlan::Reject(ChordRejection::Invalid)
        );
        assert_eq!(plan_shortcut_update(&default(), &json!(null), ShortcutMode::Native), ShortcutPlan::Reject(ChordRejection::Invalid));
    }

    struct Base {
        pref: QuickEntryShortcutPref,
        bound: Option<QuickEntryShortcutPref>,
        mode: ShortcutMode,
        registered: Option<bool>,
        desktop_entry_missing: bool,
        xwayland_only: bool,
    }

    fn base() -> Base {
        Base { pref: default(), bound: Some(default()), mode: ShortcutMode::Native, registered: Some(true), desktop_entry_missing: true, xwayland_only: false }
    }

    fn state(base: &Base) -> QuickEntryShortcutState {
        shortcut_state(ShortcutStateInput {
            pref: &base.pref,
            bound: base.bound.as_ref(),
            mode: base.mode,
            registered: base.registered,
            desktop_entry_missing: base.desktop_entry_missing,
            xwayland_only: base.xwayland_only,
        })
    }

    #[test]
    fn reports_native_registration_refusal_and_off() {
        assert_eq!(state(&base()).status, ShortcutStatus::Registered);
        assert_eq!(state(&Base { registered: Some(false), ..base() }).status, ShortcutStatus::Refused);
        assert_eq!(state(&Base { pref: QuickEntryShortcutPref { enabled: false, ..default() }, ..base() }).status, ShortcutStatus::Off);
    }

    #[test]
    fn never_claims_a_portal_binding_succeeded() {
        assert_eq!(state(&Base { mode: ShortcutMode::Portal, ..base() }).status, ShortcutStatus::Requested);
    }

    #[test]
    fn asks_for_a_restart_only_for_a_portal_chord_this_session_never_requested() {
        let moved = QuickEntryShortcutPref { chord: "⌥⇧K".into(), enabled: true };
        assert!(state(&Base { mode: ShortcutMode::Portal, pref: moved.clone(), ..base() }).restart_required);
        assert!(!state(&Base { mode: ShortcutMode::Native, pref: moved, ..base() }).restart_required);
        assert!(!state(&Base { mode: ShortcutMode::Portal, pref: QuickEntryShortcutPref { enabled: false, ..default() }, ..base() }).restart_required);
    }

    #[test]
    fn passes_the_portal_and_xwayland_caveats_through_only_in_their_own_mode() {
        assert!(state(&Base { mode: ShortcutMode::Portal, ..base() }).desktop_entry_missing);
        assert!(!state(&base()).desktop_entry_missing);
        assert!(state(&Base { xwayland_only: true, ..base() }).xwayland_only);
        assert!(!state(&Base { mode: ShortcutMode::Portal, xwayland_only: true, ..base() }).xwayland_only);
    }

    #[test]
    fn the_chord_grammar_matches_the_shared_typescript_module() {
        assert_eq!(parse_chord("ctrl+shift+p").map(|c| serialize_chord(&c)), Some("⇧⌃P".into()));
        assert_eq!(parse_chord("Control-Shift-P").map(|c| serialize_chord(&c)), Some("⇧⌃P".into()));
        assert_eq!(parse_chord("ctrl+-").map(|c| c.key), Some("-".into()));
        assert_eq!(parse_chord("ctrl++").map(|c| c.key), Some("+".into()));
        assert_eq!(parse_chord("alt+f4").map(|c| serialize_chord(&c)), Some("⌥F4".into()));
        assert_eq!(parse_chord("shift+k"), None);
        assert_eq!(parse_chord("k"), None);
        assert_eq!(parse_chord("⌘⇧O").map(|c| serialize_chord(&c)), Some("⇧⌘O".into()));
        assert_eq!(chord_to_accelerator("⇧⌘K"), Some("Super+Shift+K".into()));
        assert_eq!(chord_to_accelerator("⌃+"), Some("Control+Plus".into()));
        assert_eq!(ctrl_twin("⇧⌘O"), "⇧⌃O");
        assert_eq!(ctrl_twin("⌥⇧K"), "⌥⇧K");
        let hotkeys = include_str!("../../../src/shared/hotkeys.ts");
        for (id, chord, accelerator) in NATIVE_CHORDS {
            assert!(hotkeys.contains(&format!("id: \"{id}\"")), "{id} missing from hotkeys.ts");
            assert!(hotkeys.contains(&format!("chord: \"{chord}\"")), "{chord} missing from hotkeys.ts");
            assert!(hotkeys.contains(&format!("accelerator: \"{accelerator}\"")), "{accelerator} missing from hotkeys.ts");
        }
        assert!(hotkeys.contains(&format!("QUICK_ENTRY_DEFAULT_CHORD = \"{QUICK_ENTRY_DEFAULT_CHORD}\"")));
    }
}
