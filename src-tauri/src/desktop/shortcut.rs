//! The quick-entry shortcut, ported from `src/main/quick-entry-shortcut.ts`,
//! with two backends: the global-shortcut plugin (macOS, Windows, X11) and the
//! GlobalShortcuts portal on native Wayland, where the X11 grab fails silently.
//! Both register once at startup, in the same tick as the window toggle: a
//! portal session binds once, so a later request would be dropped. Native mode
//! rebinds live; portal mode only saves the change and says it applies after
//! a restart. The rules live in `shortcut_core`.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, Weak};

use serde_json::{json, Value};

use super::shortcut_core::{
    chord_to_accelerator, plan_shortcut_update, sanitize_shortcut_pref, saved_chord_replaced, shortcut_state, ChordRejection,
    QuickEntryShortcutPref, QuickEntryShortcutState, ShortcutMode, ShortcutPlan, ShortcutStateInput,
};
#[cfg(target_os = "linux")]
use super::gnome_keybindings::{find_conflict, parse_portal_trigger, GnomeBinding};
use super::{lock, Platform};
use crate::ports::WindowId;
use crate::runtime_log;

pub(crate) type Activation = Arc<dyn Fn() + Send + Sync>;

/// Stable ids for the portal: GNOME stores each binding under its id, so an id
/// must name the action, never a position that a new shortcut would shift.
pub(crate) const QUICK_ENTRY_SHORTCUT_ID: &str = "quick-entry";
pub(crate) const TOGGLE_WINDOW_SHORTCUT_ID: &str = "toggle-window";

/// The grab calls the shortcut makes: the plugin or the portal in the app, a fake in tests.
pub(crate) trait ShortcutRegistry: Send + Sync {
    /// Grab `accelerator` for the action `id`. `Ok(true)` registered (or
    /// requested), `Ok(false)` refused by the system, `Err` could not even be parsed.
    fn register(&self, id: &str, accelerator: &str, callback: Activation) -> Result<bool, String>;
    fn unregister(&self, accelerator: &str) -> Result<(), String>;
    /// Native only: stop handling while a shortcuts recorder captures keys.
    fn set_suspended(&self, suspended: bool);
    /// Startup registrations are complete; a portal backend binds them now, in one request.
    fn start(&self);
}

pub(crate) type ShortcutLog = Box<dyn Fn(&str, Value) + Send + Sync>;
pub(crate) type PrefReader = Box<dyn Fn() -> Option<Value> + Send + Sync>;
pub(crate) type PrefWriter = Box<dyn Fn(&QuickEntryShortcutPref) -> Result<(), String> + Send + Sync>;

pub(crate) struct ShortcutDeps {
    pub registry: Arc<dyn ShortcutRegistry>,
    pub log: ShortcutLog,
    pub read_pref: PrefReader,
    pub save_pref: PrefWriter,
    pub mode: ShortcutMode,
    pub desktop_entry_missing: bool,
    pub xwayland_only: bool,
    pub on_activate: Activation,
    pub platform: Platform,
}

struct ShortcutState {
    pref: QuickEntryShortcutPref,
    /// What this session registered (`None`: nothing).
    bound: Option<QuickEntryShortcutPref>,
    registered: Option<bool>,
    notice: Option<QuickEntryShortcutState>,
    notice_taken: bool,
    /// Windows whose shortcut recorder is capturing; handling stays suspended while any is.
    suspended_by: HashSet<WindowId>,
}

/// `QuickEntryShortcutResult`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ShortcutUpdateResult {
    Ok(QuickEntryShortcutState),
    Refused { reason: UpdateRefusal, state: QuickEntryShortcutState },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum UpdateRefusal {
    Invalid,
    Reserved,
    System,
    Refused,
}

impl From<ChordRejection> for UpdateRefusal {
    fn from(rejection: ChordRejection) -> Self {
        match rejection {
            ChordRejection::Invalid => UpdateRefusal::Invalid,
            ChordRejection::System => UpdateRefusal::System,
            ChordRejection::Reserved => UpdateRefusal::Reserved,
        }
    }
}

impl ShortcutUpdateResult {
    pub(crate) fn to_json(&self) -> Value {
        match self {
            ShortcutUpdateResult::Ok(state) => json!({ "ok": true, "state": state }),
            ShortcutUpdateResult::Refused { reason, state } => json!({ "ok": false, "reason": reason, "state": state }),
        }
    }
}

pub(crate) struct QuickEntryShortcut {
    deps: ShortcutDeps,
    state: Mutex<ShortcutState>,
}

impl QuickEntryShortcut {
    pub(crate) fn new(deps: ShortcutDeps) -> Arc<Self> {
        let pref = sanitize_shortcut_pref((deps.read_pref)().as_ref(), deps.platform);
        Arc::new(Self {
            deps,
            state: Mutex::new(ShortcutState { pref, bound: None, registered: None, notice: None, notice_taken: false, suspended_by: HashSet::new() }),
        })
    }

    /// The callback the registry fires. It reads the live flag, so turning the
    /// shortcut off in portal mode (where it stays bound until restart) mutes it at once.
    fn activation(self: &Arc<Self>) -> Activation {
        let weak: Weak<Self> = Arc::downgrade(self);
        Arc::new(move || {
            if let Some(shortcut) = weak.upgrade() {
                if lock(&shortcut.state).pref.enabled {
                    (shortcut.deps.on_activate)();
                }
            }
        })
    }

    pub(crate) fn register_at_startup(self: &Arc<Self>) {
        let raw = (self.deps.read_pref)();
        let pref = lock(&self.state).pref.clone();
        if saved_chord_replaced(raw.as_ref(), &pref) {
            (self.deps.log)("saved quick entry shortcut is not allowed; using the default", json!({ "chord": pref.chord }));
        }
        if !pref.enabled {
            return;
        }
        let Some(accelerator) = chord_to_accelerator(&pref.chord, self.deps.platform) else { return };
        let registered = self.register(&accelerator);
        {
            let mut state = lock(&self.state);
            state.registered = Some(registered);
            state.bound = Some(pref);
        }
        let portal = self.deps.mode == ShortcutMode::Portal;
        let message = if registered { "quick entry registered".to_string() } else { format!("globalShortcut.register refused {accelerator}") };
        (self.deps.log)(&message, json!({ "accelerator": accelerator, "portal": portal }));
        if !registered {
            let notice = self.state();
            lock(&self.state).notice = Some(notice);
        }
    }

    pub(crate) fn state(&self) -> QuickEntryShortcutState {
        let state = lock(&self.state);
        shortcut_state(ShortcutStateInput {
            pref: &state.pref,
            bound: state.bound.as_ref(),
            mode: self.deps.mode,
            registered: state.registered,
            desktop_entry_missing: self.deps.desktop_entry_missing,
            xwayland_only: self.deps.xwayland_only,
        })
    }

    /// Apply a change from `sender`'s shortcuts dialog. Saving ends that window's capture.
    pub(crate) fn update(self: &Arc<Self>, sender: WindowId, update: &Value) -> ShortcutUpdateResult {
        let native = self.deps.mode == ShortcutMode::Native;
        lock(&self.state).suspended_by.remove(&sender);
        // New registrations fail while handling is suspended.
        if native {
            self.deps.registry.set_suspended(false);
        }
        let result = self.apply(update);
        if native {
            let suspended = !lock(&self.state).suspended_by.is_empty();
            self.deps.registry.set_suspended(suspended);
        }
        result
    }

    fn apply(self: &Arc<Self>, update: &Value) -> ShortcutUpdateResult {
        let current = lock(&self.state).pref.clone();
        let plan = plan_shortcut_update(&current, update, self.deps.mode, self.deps.platform);
        let next = match plan {
            ShortcutPlan::Reject(reason) => return ShortcutUpdateResult::Refused { reason: reason.into(), state: self.state() },
            ShortcutPlan::Persist { next } => next,
            ShortcutPlan::Rebind { next, from, to } => {
                let registered = lock(&self.state).registered;
                let unchanged = from == to && (to.is_none() || registered == Some(true));
                if !unchanged {
                    if let Some(from) = &from {
                        self.unregister(from);
                    }
                    if let Some(to) = &to {
                        if !self.register(to) {
                            let restored = from.as_deref().map(|from| self.register(from));
                            lock(&self.state).registered = restored;
                            (self.deps.log)(&format!("globalShortcut.register refused {to}"), json!({ "accelerator": to, "portal": false }));
                            return ShortcutUpdateResult::Refused { reason: UpdateRefusal::Refused, state: self.state() };
                        }
                    }
                    let mut state = lock(&self.state);
                    state.registered = to.as_ref().map(|_| true);
                    state.bound = next.enabled.then(|| next.clone());
                }
                next
            }
        };
        lock(&self.state).pref = next.clone();
        if let Err(error) = (self.deps.save_pref)(&next) {
            (self.deps.log)(&format!("could not save the quick entry shortcut: {error}"), json!({}));
        }
        ShortcutUpdateResult::Ok(self.state())
    }

    /// Native only: the portal grabs the chord in the compositor, which suspension cannot reach.
    pub(crate) fn set_suspended(&self, sender: WindowId, suspended: bool) {
        if self.deps.mode != ShortcutMode::Native {
            return;
        }
        let any = {
            let mut state = lock(&self.state);
            if suspended {
                state.suspended_by.insert(sender);
            } else {
                state.suspended_by.remove(&sender);
            }
            !state.suspended_by.is_empty()
        };
        self.deps.registry.set_suspended(any);
    }

    /// A window that closes mid-capture must not leave shortcuts suspended.
    pub(crate) fn release_window(&self, sender: WindowId) {
        if lock(&self.state).suspended_by.contains(&sender) {
            self.set_suspended(sender, false);
        }
    }

    /// The startup refusal, once, for the first window that asks.
    pub(crate) fn take_startup_notice(&self) -> Option<QuickEntryShortcutState> {
        let mut state = lock(&self.state);
        if state.notice_taken {
            return None;
        }
        state.notice_taken = true;
        state.notice.clone()
    }

    /// A registry that cannot parse the accelerator fails rather than refusing;
    /// either way the chord is not registered, and startup must go on.
    fn register(self: &Arc<Self>, accelerator: &str) -> bool {
        match self.deps.registry.register(QUICK_ENTRY_SHORTCUT_ID, accelerator, self.activation()) {
            Ok(registered) => registered,
            Err(error) => {
                (self.deps.log)(&format!("globalShortcut.register threw for {accelerator}"), json!({ "accelerator": accelerator, "error": error }));
                false
            }
        }
    }

    fn unregister(&self, accelerator: &str) {
        // Never registered: the same parse failure made its register fail.
        let _ = self.deps.registry.unregister(accelerator);
    }
}

// ---------------------------------------------------------------------------
// Native backend: the global-shortcut plugin
// ---------------------------------------------------------------------------

/// Accelerators the plugin grabs for us. Suspension unregisters them in the
/// plugin while remembering them, so the recorder sees the keys.
pub(crate) struct PluginShortcutRegistry {
    app: tauri::AppHandle,
    bound: Mutex<HashMap<String, Activation>>,
    suspended: Mutex<bool>,
}

impl PluginShortcutRegistry {
    pub(crate) fn new(app: tauri::AppHandle) -> Self {
        Self { app, bound: Mutex::new(HashMap::new()), suspended: Mutex::new(false) }
    }

    fn grab(&self, accelerator: &str, callback: Activation) -> Result<(), String> {
        use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
        self.app
            .global_shortcut()
            .on_shortcut(accelerator, move |_app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    callback();
                }
            })
            .map_err(|error| error.to_string())
    }

    fn release(&self, accelerator: &str) -> Result<(), String> {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        self.app.global_shortcut().unregister(accelerator).map_err(|error| error.to_string())
    }
}

impl ShortcutRegistry for PluginShortcutRegistry {
    fn register(&self, _id: &str, accelerator: &str, callback: Activation) -> Result<bool, String> {
        let suspended = *lock(&self.suspended);
        if !suspended {
            if let Err(error) = self.grab(accelerator, callback.clone()) {
                // An unparsable accelerator is an error; a chord another client holds is a refusal.
                if error.to_lowercase().contains("parse") || error.to_lowercase().contains("invalid") {
                    return Err(error);
                }
                runtime_log::note("global-shortcut", format!("register refused {accelerator}: {error}"), json!({ "accelerator": accelerator }));
                return Ok(false);
            }
        }
        lock(&self.bound).insert(accelerator.to_string(), callback);
        Ok(true)
    }

    fn unregister(&self, accelerator: &str) -> Result<(), String> {
        lock(&self.bound).remove(accelerator);
        if *lock(&self.suspended) {
            return Ok(());
        }
        self.release(accelerator)
    }

    fn set_suspended(&self, suspended: bool) {
        let changed = {
            let mut current = lock(&self.suspended);
            let changed = *current != suspended;
            *current = suspended;
            changed
        };
        if !changed {
            return;
        }
        let bound: Vec<(String, Activation)> = lock(&self.bound).iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        for (accelerator, callback) in bound {
            let result = if suspended { self.release(&accelerator) } else { self.grab(&accelerator, callback) };
            if let Err(error) = result {
                runtime_log::note("global-shortcut", format!("suspend={suspended} failed for {accelerator}: {error}"), json!({ "accelerator": accelerator }));
            }
        }
    }

    fn start(&self) {}
}

// ---------------------------------------------------------------------------
// Wayland backend: the GlobalShortcuts portal
// ---------------------------------------------------------------------------

/// Translate a plugin accelerator (`Control+Shift+Space`) into the portal's
/// trigger description (`CTRL+SHIFT+space`: XDG modifiers and XKB keysym names).
/// The portal only exists on Linux, where `CommandOrControl` means Control.
pub(crate) fn accelerator_to_portal_trigger(accelerator: &str) -> String {
    accelerator
        .split('+')
        .map(|part| match part {
            "Control" | "Ctrl" | "CommandOrControl" | "CmdOrCtrl" | "CommandOrCtrl" | "CmdOrControl" => "CTRL".to_string(),
            "Alt" | "Option" => "ALT".to_string(),
            "Shift" => "SHIFT".to_string(),
            "Super" | "Command" | "Meta" => "LOGO".to_string(),
            "Space" => "space".to_string(),
            "Enter" => "Return".to_string(),
            "Backspace" => "BackSpace".to_string(),
            "Plus" => "plus".to_string(),
            "Tab" | "Escape" | "Delete" | "Up" | "Down" | "Left" | "Right" => part.to_string(),
            key if key.len() == 1 => match key.chars().next().unwrap_or(' ') {
                c if c.is_ascii_alphabetic() => c.to_ascii_lowercase().to_string(),
                c if c.is_ascii_digit() => c.to_string(),
                ',' => "comma".into(),
                '.' => "period".into(),
                '/' => "slash".into(),
                '-' => "minus".into(),
                '=' => "equal".into(),
                ';' => "semicolon".into(),
                '\'' => "apostrophe".into(),
                '`' => "grave".into(),
                '[' => "bracketleft".into(),
                ']' => "bracketright".into(),
                '\\' => "backslash".into(),
                other => other.to_string(),
            },
            other => other.to_string(),
        })
        .collect::<Vec<_>>()
        .join("+")
}

/// One startup registration waiting for the portal session.
#[cfg(target_os = "linux")]
struct PendingShortcut {
    id: String,
    accelerator: String,
    callback: Activation,
}

/// Binds every registered accelerator in one portal session at `start`.
/// GNOME's portal reports a chord mutter refused as bound, so a chord one of
/// GNOME's own keybindings already holds is answered as refused here. It is
/// still bound, so the user can rebind it in GNOME Settings.
#[cfg(target_os = "linux")]
pub(crate) struct PortalShortcutRegistry {
    pending: Mutex<Vec<PendingShortcut>>,
    gnome_bindings: Vec<GnomeBinding>,
}

#[cfg(target_os = "linux")]
impl PortalShortcutRegistry {
    /// `gnome_bindings`: GNOME's keybindings at startup (empty outside GNOME).
    pub(crate) fn new(gnome_bindings: Vec<GnomeBinding>) -> Self {
        Self { pending: Mutex::new(Vec::new()), gnome_bindings }
    }

    async fn bind(shortcuts: Vec<PendingShortcut>) -> Result<(), String> {
        use ashpd::desktop::global_shortcuts::{GlobalShortcuts, NewShortcut};
        use futures_util::StreamExt;

        // xdg-desktop-portal 1.20+ rejects GlobalShortcuts from unregistered host apps.
        let app_id = ashpd::AppID::try_from(crate::product::APP_ID).map_err(|error| format!("bad app id: {error}"))?;
        match ashpd::register_host_app(app_id).await {
            Ok(()) => runtime_log::note("global-shortcut", "host registry: registered", json!({ "appId": crate::product::APP_ID })),
            Err(error) => runtime_log::note("global-shortcut", format!("host registry registration failed: {error}"), json!({})),
        }
        let portal = GlobalShortcuts::new().await.map_err(|error| format!("GlobalShortcuts proxy: {error}"))?;
        let session = portal.create_session().await.map_err(|error| format!("create_session: {error}"))?;
        let triggers: Vec<String> = shortcuts.iter().map(|shortcut| accelerator_to_portal_trigger(&shortcut.accelerator)).collect();
        let requested: Vec<NewShortcut> = shortcuts
            .iter()
            .zip(&triggers)
            .map(|(shortcut, trigger)| {
                NewShortcut::new(shortcut.id.as_str(), format!("{} ({})", crate::product::PRODUCT_NAME, shortcut.accelerator)).preferred_trigger(trigger.as_str())
            })
            .collect();
        let request = portal.bind_shortcuts(&session, &requested, None).await.map_err(|error| format!("bind_shortcuts: {error}"))?;
        let bound = request.response().map_err(|error| format!("bind_shortcuts response: {error}"))?;
        for shortcut in bound.shortcuts() {
            // Accepted is all the portal can say: GNOME's answers success even for a chord mutter refused.
            runtime_log::note(
                "global-shortcut",
                format!("portal accepted {} as '{}'", shortcut.id(), shortcut.trigger_description()),
                json!({ "id": shortcut.id(), "trigger": shortcut.trigger_description() }),
            );
        }
        let mut activated = portal.receive_activated().await.map_err(|error| format!("receive_activated: {error}"))?;
        runtime_log::note("global-shortcut", "portal session listening for activations", json!({ "shortcuts": triggers }));
        while let Some(event) = activated.next().await {
            let id = event.shortcut_id();
            runtime_log::note("global-shortcut", format!("portal activated {id}"), json!({ "id": id }));
            if let Some(shortcut) = shortcuts.iter().find(|shortcut| shortcut.id == id) {
                (shortcut.callback)();
            }
        }
        // The session keeps the bindings alive; dropping it would release them.
        drop(session);
        Ok(())
    }
}

#[cfg(target_os = "linux")]
impl ShortcutRegistry for PortalShortcutRegistry {
    fn register(&self, id: &str, accelerator: &str, callback: Activation) -> Result<bool, String> {
        let conflict = parse_portal_trigger(&accelerator_to_portal_trigger(accelerator)).and_then(|chord| find_conflict(&chord, &self.gnome_bindings).cloned());
        let mut pending = lock(&self.pending);
        pending.retain(|shortcut| shortcut.id != id);
        pending.push(PendingShortcut { id: id.to_string(), accelerator: accelerator.to_string(), callback });
        drop(pending);
        match conflict {
            Some(owner) => {
                runtime_log::note(
                    "global-shortcut",
                    format!("{accelerator} is already a GNOME keybinding ({}); mutter will not grab it", owner.owner()),
                    json!({ "id": id, "accelerator": accelerator, "schema": owner.schema, "key": owner.key }),
                );
                Ok(false)
            }
            None => Ok(true),
        }
    }

    fn unregister(&self, _accelerator: &str) -> Result<(), String> {
        // The desktop owns a portal binding until restart; the shortcut mutes itself instead.
        Ok(())
    }

    fn set_suspended(&self, _suspended: bool) {}

    fn start(&self) {
        let shortcuts = std::mem::take(&mut *lock(&self.pending));
        if shortcuts.is_empty() {
            return;
        }
        crate::bridge::spawn_task(async move {
            if let Err(error) = Self::bind(shortcuts).await {
                runtime_log::note("global-shortcut", format!("portal shortcuts unavailable: {error}"), json!({}));
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Clone, Copy)]
    enum Outcome {
        Refuse,
        Throw,
    }

    /// A registry stand-in: records every call and lets a test refuse or fail per accelerator.
    struct FakeRegistry {
        calls: Mutex<Vec<String>>,
        bound: Mutex<HashMap<String, Activation>>,
        outcomes: HashMap<String, Outcome>,
    }

    impl FakeRegistry {
        fn new(outcomes: &[(&str, Outcome)]) -> Arc<Self> {
            Arc::new(Self {
                calls: Mutex::new(Vec::new()),
                bound: Mutex::new(HashMap::new()),
                outcomes: outcomes.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
            })
        }

        fn calls(&self) -> Vec<String> {
            lock(&self.calls).clone()
        }

        fn clear(&self) {
            lock(&self.calls).clear();
        }

        fn bound_keys(&self) -> Vec<String> {
            let mut keys: Vec<String> = lock(&self.bound).keys().cloned().collect();
            keys.sort();
            keys
        }

        fn fire(&self, accelerator: &str) {
            // The clone must finish, dropping the guard, before invoking the
            // callback: an `if let` scrutinee would otherwise keep `self.bound`
            // locked for the call, and a callback that re-registers a shortcut
            // would deadlock on itself.
            let callback = lock(&self.bound).get(accelerator).cloned();
            if let Some(callback) = callback {
                callback();
            }
        }
    }

    impl ShortcutRegistry for FakeRegistry {
        fn register(&self, id: &str, accelerator: &str, callback: Activation) -> Result<bool, String> {
            assert_eq!(id, QUICK_ENTRY_SHORTCUT_ID);
            lock(&self.calls).push(format!("register {accelerator}"));
            match self.outcomes.get(accelerator) {
                Some(Outcome::Throw) => Err(format!("conversion failure from {accelerator}")),
                Some(Outcome::Refuse) => Ok(false),
                None => {
                    lock(&self.bound).insert(accelerator.to_string(), callback);
                    Ok(true)
                }
            }
        }

        fn unregister(&self, accelerator: &str) -> Result<(), String> {
            lock(&self.calls).push(format!("unregister {accelerator}"));
            lock(&self.bound).remove(accelerator);
            Ok(())
        }

        fn set_suspended(&self, suspended: bool) {
            lock(&self.calls).push(format!("suspend {suspended}"));
        }

        fn start(&self) {}
    }

    const DEFAULT_ACCELERATOR: &str = "Control+Shift+Space";

    struct Built {
        shortcut: Arc<QuickEntryShortcut>,
        saves: Arc<Mutex<Vec<QuickEntryShortcutPref>>>,
        activations: Arc<Mutex<u32>>,
    }

    fn shortcut(mode: ShortcutMode, registry: Arc<dyn ShortcutRegistry>, saved: Option<QuickEntryShortcutPref>) -> Built {
        let saves = Arc::new(Mutex::new(Vec::new()));
        let activations = Arc::new(Mutex::new(0));
        let saves_sink = saves.clone();
        let count = activations.clone();
        let shortcut = QuickEntryShortcut::new(ShortcutDeps {
            registry,
            log: Box::new(|_, _| {}),
            read_pref: Box::new(move || saved.as_ref().map(|pref| serde_json::to_value(pref).unwrap_or(Value::Null))),
            save_pref: Box::new(move |pref| {
                lock(&saves_sink).push(pref.clone());
                Ok(())
            }),
            mode,
            desktop_entry_missing: false,
            xwayland_only: false,
            on_activate: Arc::new(move || *lock(&count) += 1),
            platform: Platform::Linux,
        });
        Built { shortcut, saves, activations }
    }

    #[test]
    fn resumes_handling_before_it_registers_and_re_suspends_while_another_window_still_captures() {
        let registry = FakeRegistry::new(&[]);
        let Built { shortcut, .. } = shortcut(ShortcutMode::Native, registry.clone(), None);
        shortcut.register_at_startup();
        shortcut.set_suspended(WindowId(1), true);
        shortcut.set_suspended(WindowId(2), true);
        registry.clear();
        assert!(matches!(shortcut.update(WindowId(1), &json!({ "chord": "⌥⇧K" })), ShortcutUpdateResult::Ok(_)));
        assert_eq!(
            registry.calls(),
            vec!["suspend false".to_string(), format!("unregister {DEFAULT_ACCELERATOR}"), "register Alt+Shift+K".to_string(), "suspend true".to_string()]
        );
    }

    #[test]
    fn puts_the_old_chord_back_when_the_system_refuses_the_new_one() {
        let registry = FakeRegistry::new(&[("Alt+Shift+K", Outcome::Refuse)]);
        let Built { shortcut, saves, .. } = shortcut(ShortcutMode::Native, registry.clone(), None);
        shortcut.register_at_startup();
        let result = shortcut.update(WindowId(1), &json!({ "chord": "⌥⇧K" }));
        match result {
            ShortcutUpdateResult::Refused { reason, state } => {
                assert_eq!(reason, UpdateRefusal::Refused);
                assert_eq!(state.chord, "⇧⌃␣");
                assert_eq!(state.status, super::super::shortcut_core::ShortcutStatus::Registered);
            }
            other => panic!("unexpected {other:?}"),
        }
        let calls = registry.calls();
        assert_eq!(calls[calls.len() - 2], format!("register {DEFAULT_ACCELERATOR}"));
        assert_eq!(registry.bound_keys(), vec![DEFAULT_ACCELERATOR.to_string()]);
        assert!(lock(&saves).is_empty());
    }

    #[test]
    fn treats_a_register_that_throws_as_a_refusal_and_keeps_the_old_chord() {
        let registry = FakeRegistry::new(&[("Alt+Shift+K", Outcome::Throw)]);
        let Built { shortcut, .. } = shortcut(ShortcutMode::Native, registry.clone(), None);
        shortcut.register_at_startup();
        assert!(matches!(shortcut.update(WindowId(1), &json!({ "chord": "⌥⇧K" })), ShortcutUpdateResult::Refused { reason: UpdateRefusal::Refused, .. }));
        assert_eq!(registry.bound_keys(), vec![DEFAULT_ACCELERATOR.to_string()]);
    }

    #[test]
    fn survives_a_register_that_throws_and_reports_the_refusal_once() {
        let registry = FakeRegistry::new(&[(DEFAULT_ACCELERATOR, Outcome::Throw)]);
        let Built { shortcut, .. } = shortcut(ShortcutMode::Native, registry, None);
        shortcut.register_at_startup();
        assert_eq!(shortcut.take_startup_notice().map(|notice| notice.status), Some(super::super::shortcut_core::ShortcutStatus::Refused));
        assert_eq!(shortcut.take_startup_notice(), None);
    }

    #[test]
    fn registers_nothing_for_a_saved_shortcut_that_is_off() {
        let registry = FakeRegistry::new(&[]);
        let Built { shortcut, .. } = shortcut(ShortcutMode::Native, registry.clone(), Some(QuickEntryShortcutPref { chord: "⌥⇧K".into(), enabled: false }));
        shortcut.register_at_startup();
        assert!(registry.calls().is_empty());
        assert_eq!(shortcut.state().status, super::super::shortcut_core::ShortcutStatus::Off);
    }

    #[test]
    fn only_saves_a_change_and_a_disable_mutes_the_chord_bound_at_startup() {
        let registry = FakeRegistry::new(&[]);
        let Built { shortcut, saves, activations } = shortcut(ShortcutMode::Portal, registry.clone(), None);
        shortcut.register_at_startup();
        registry.clear();
        match shortcut.update(WindowId(1), &json!({ "chord": "⌥⇧K" })) {
            ShortcutUpdateResult::Ok(state) => assert!(state.restart_required),
            other => panic!("unexpected {other:?}"),
        }
        shortcut.update(WindowId(1), &json!({ "enabled": false }));
        assert!(registry.calls().is_empty());
        assert_eq!(lock(&saves).last(), Some(&QuickEntryShortcutPref { chord: "⌥⇧K".into(), enabled: false }));
        registry.fire(DEFAULT_ACCELERATOR);
        assert_eq!(*lock(&activations), 0);
        shortcut.update(WindowId(1), &json!({ "enabled": true }));
        registry.fire(DEFAULT_ACCELERATOR);
        assert_eq!(*lock(&activations), 1);
    }

    #[test]
    fn translates_accelerators_into_portal_triggers() {
        assert_eq!(accelerator_to_portal_trigger("Control+Shift+Space"), "CTRL+SHIFT+space");
        assert_eq!(accelerator_to_portal_trigger("CommandOrControl+Shift+O"), "CTRL+SHIFT+o");
        assert_eq!(accelerator_to_portal_trigger("CmdOrCtrl+Shift+O"), "CTRL+SHIFT+o");
        assert_eq!(accelerator_to_portal_trigger("Alt+Shift+K"), "ALT+SHIFT+k");
        assert_eq!(accelerator_to_portal_trigger("Super+F12"), "LOGO+F12");
        assert_eq!(accelerator_to_portal_trigger("Control+Plus"), "CTRL+plus");
        assert_eq!(accelerator_to_portal_trigger("Control+,"), "CTRL+comma");
    }

    #[cfg(target_os = "linux")]
    fn gnome_table() -> Vec<GnomeBinding> {
        vec![GnomeBinding {
            schema: "org.gnome.desktop.wm.keybindings".into(),
            key: "switch-input-source".into(),
            accelerators: vec!["<Shift><Control>space".into()],
        }]
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_portal_chord_gnome_already_binds_is_refused_at_startup_with_a_notice() {
        let registry = Arc::new(PortalShortcutRegistry::new(gnome_table()));
        let Built { shortcut, .. } = shortcut(ShortcutMode::Portal, registry.clone(), None);
        shortcut.register_at_startup();
        assert_eq!(shortcut.state().status, super::super::shortcut_core::ShortcutStatus::Refused);
        let notice = shortcut.take_startup_notice();
        assert_eq!(notice.map(|notice| (notice.chord, notice.status)), Some(("⇧⌃␣".to_string(), super::super::shortcut_core::ShortcutStatus::Refused)));
        // Still bound under its stable id, so GNOME Settings can rebind it.
        let pending: Vec<(String, String)> = lock(&registry.pending).iter().map(|entry| (entry.id.clone(), entry.accelerator.clone())).collect();
        assert_eq!(pending, vec![(QUICK_ENTRY_SHORTCUT_ID.to_string(), DEFAULT_ACCELERATOR.to_string())]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_free_portal_chord_is_requested_and_keeps_its_stable_id() {
        let registry = PortalShortcutRegistry::new(gnome_table());
        let noop: Activation = Arc::new(|| {});
        assert_eq!(registry.register(TOGGLE_WINDOW_SHORTCUT_ID, "CommandOrControl+Shift+O", noop.clone()), Ok(true));
        assert_eq!(registry.register(QUICK_ENTRY_SHORTCUT_ID, "Alt+Shift+K", noop.clone()), Ok(true));
        assert_eq!(registry.register(QUICK_ENTRY_SHORTCUT_ID, "Control+Shift+Space", noop), Ok(false));
        let ids: Vec<String> = lock(&registry.pending).iter().map(|entry| format!("{} {}", entry.id, entry.accelerator)).collect();
        assert_eq!(ids, vec!["toggle-window CommandOrControl+Shift+O".to_string(), "quick-entry Control+Shift+Space".to_string()]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn outside_gnome_the_portal_trusts_the_desktop() {
        let registry = Arc::new(PortalShortcutRegistry::new(Vec::new()));
        let Built { shortcut, .. } = shortcut(ShortcutMode::Portal, registry, None);
        shortcut.register_at_startup();
        assert_eq!(shortcut.state().status, super::super::shortcut_core::ShortcutStatus::Requested);
        assert_eq!(shortcut.take_startup_notice(), None);
    }
}
