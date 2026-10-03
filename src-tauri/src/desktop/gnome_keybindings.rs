//! GNOME's own keybindings, read before the GlobalShortcuts portal binds.
//! Mutter refuses to grab a combination one of its schemas already binds, yet
//! xdg-desktop-portal-gnome still answers `BindShortcuts` with success, so the
//! only way to see the refusal is to compare the chord with those schemas up
//! front. Parsing and matching are pure; only `read_gnome_keybindings` touches
//! GSettings, and only with reads. Linux only (the module is gated in `mod.rs`).

use super::wayland_portal::Env;

/// The keybinding schemas mutter, gnome-shell and gnome-settings-daemon grab from.
pub(crate) const KEYBINDING_SCHEMAS: [&str; 5] = [
    "org.gnome.desktop.wm.keybindings",
    "org.gnome.shell.keybindings",
    "org.gnome.mutter.keybindings",
    "org.gnome.mutter.wayland.keybindings",
    "org.gnome.settings-daemon.plugins.media-keys",
];

/// The relocatable schema of a user's custom shortcut, listed by path in
/// `org.gnome.settings-daemon.plugins.media-keys custom-keybindings`.
pub(crate) const CUSTOM_KEYBINDING_SCHEMA: &str = "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding";
const MEDIA_KEYS_SCHEMA: &str = "org.gnome.settings-daemon.plugins.media-keys";
const CUSTOM_KEYBINDINGS_KEY: &str = "custom-keybindings";

/// One GNOME setting that holds accelerators, as `gsettings get <schema> <key>` shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GnomeBinding {
    pub schema: String,
    pub key: String,
    pub accelerators: Vec<String>,
}

impl GnomeBinding {
    /// `org.gnome.desktop.wm.keybindings switch-input-source`, for logs.
    pub(crate) fn owner(&self) -> String {
        format!("{} {}", self.schema, self.key)
    }
}

const CTRL: u8 = 1;
const SHIFT: u8 = 1 << 1;
const ALT: u8 = 1 << 2;
const LOGO: u8 = 1 << 3;
const META: u8 = 1 << 4;
const HYPER: u8 = 1 << 5;
const NUM: u8 = 1 << 6;

/// A key combination in one canonical form: a modifier set and a lowercase keysym name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Chord {
    modifiers: u8,
    key: String,
}

impl Chord {
    fn new(modifiers: u8, key: &str) -> Option<Self> {
        let key = key.trim().to_lowercase();
        (!key.is_empty()).then_some(Self { modifiers, key })
    }
}

/// A GTK accelerator as GSettings stores it: `<Shift><Control>space`,
/// `<Primary><Shift>space`, `<Super>Above_Tab`. Modifier names are matched
/// case-insensitively, as `gtk_accelerator_parse` does. `None` for an empty or
/// `disabled` entry, a release binding, or a modifier this matcher does not know.
pub(crate) fn parse_gnome_accelerator(accelerator: &str) -> Option<Chord> {
    let mut rest = accelerator.trim();
    let mut modifiers = 0;
    while let Some(after) = rest.strip_prefix('<') {
        let end = after.find('>')?;
        let bit = match after[..end].to_lowercase().as_str() {
            "control" | "ctrl" | "ctl" | "primary" => CTRL,
            "shift" | "shft" => SHIFT,
            "alt" | "mod1" => ALT,
            "super" | "mod4" => LOGO,
            "meta" => META,
            "hyper" => HYPER,
            "mod2" => NUM,
            // A `<Release>` binding fires on key-up and never competes for a press.
            _ => return None,
        };
        modifiers |= bit;
        rest = &after[end + 1..];
    }
    if rest.eq_ignore_ascii_case("disabled") {
        return None;
    }
    Chord::new(modifiers, rest)
}

/// A portal trigger as the XDG shortcuts spec writes it: `CTRL+SHIFT+space`.
pub(crate) fn parse_portal_trigger(trigger: &str) -> Option<Chord> {
    let mut parts: Vec<&str> = trigger.split('+').collect();
    let key = parts.pop()?;
    let mut modifiers = 0;
    for part in parts {
        modifiers |= match part.to_uppercase().as_str() {
            "CTRL" => CTRL,
            "SHIFT" => SHIFT,
            "ALT" => ALT,
            "LOGO" => LOGO,
            "NUM" => NUM,
            _ => return None,
        };
    }
    Chord::new(modifiers, key)
}

/// The first GNOME setting that already binds `chord`.
pub(crate) fn find_conflict<'a>(chord: &Chord, bindings: &'a [GnomeBinding]) -> Option<&'a GnomeBinding> {
    bindings.iter().find(|binding| binding.accelerators.iter().any(|accelerator| parse_gnome_accelerator(accelerator).as_ref() == Some(chord)))
}

/// True inside a GNOME session (`XDG_CURRENT_DESKTOP` is a colon list, e.g. `ubuntu:GNOME`).
pub(crate) fn is_gnome_session(env: &Env) -> bool {
    env.get("XDG_CURRENT_DESKTOP").is_some_and(|value| value.split(':').any(|desktop| desktop.trim().eq_ignore_ascii_case("gnome")))
}

/// A GSettings path a relocatable schema accepts: absolute, ending in `/`,
/// with no empty segment. `g_settings_new_full` aborts on anything else.
pub(crate) fn is_valid_settings_path(path: &str) -> bool {
    path.len() > 1 && path.starts_with('/') && path.ends_with('/') && !path.contains("//")
}

/// Every accelerator the GNOME keybinding schemas hold right now, custom
/// shortcuts included. Schemas missing on this machine are skipped (GIO aborts
/// on an unknown schema id, so each is looked up first). Reads come from the
/// dconf database in memory, so this does not block on a subprocess or D-Bus.
pub(crate) fn read_gnome_keybindings() -> Vec<GnomeBinding> {
    use gtk::gio;
    use gtk::gio::prelude::SettingsExt;

    let Some(source) = gio::SettingsSchemaSource::default() else { return Vec::new() };
    let mut bindings = Vec::new();
    for schema_id in KEYBINDING_SCHEMAS {
        let Some(schema) = source.lookup(schema_id, true) else { continue };
        // A schema without its own path is relocatable and cannot be opened bare.
        if schema.path().is_none() {
            continue;
        }
        let settings = gio::Settings::new_full(&schema, None::<&gio::SettingsBackend>, None);
        for key in schema.list_keys() {
            if schema_id == MEDIA_KEYS_SCHEMA && key.as_str() == CUSTOM_KEYBINDINGS_KEY {
                continue;
            }
            let accelerators = accelerators_of(&settings.value(&key));
            if !accelerators.is_empty() {
                bindings.push(GnomeBinding { schema: schema_id.to_string(), key: key.to_string(), accelerators });
            }
        }
        if schema_id == MEDIA_KEYS_SCHEMA && schema.has_key(CUSTOM_KEYBINDINGS_KEY) {
            let paths: Vec<String> = settings.value(CUSTOM_KEYBINDINGS_KEY).get().unwrap_or_default();
            bindings.extend(read_custom_keybindings(&source, &paths));
        }
    }
    bindings
}

fn read_custom_keybindings(source: &gtk::gio::SettingsSchemaSource, paths: &[String]) -> Vec<GnomeBinding> {
    use gtk::gio;
    use gtk::gio::prelude::SettingsExt;

    let Some(schema) = source.lookup(CUSTOM_KEYBINDING_SCHEMA, true) else { return Vec::new() };
    if schema.path().is_some() || !schema.has_key("binding") {
        return Vec::new();
    }
    paths
        .iter()
        .filter(|path| is_valid_settings_path(path))
        .filter_map(|path| {
            let settings = gio::Settings::new_full(&schema, None::<&gio::SettingsBackend>, Some(path));
            let accelerators = accelerators_of(&settings.value("binding"));
            (!accelerators.is_empty()).then(|| GnomeBinding { schema: format!("{CUSTOM_KEYBINDING_SCHEMA}:{path}"), key: "binding".to_string(), accelerators })
        })
        .collect()
}

/// Keybinding keys hold `as` (most) or `s` (custom shortcuts, older media keys); anything else is not a binding.
fn accelerators_of(value: &gtk::glib::Variant) -> Vec<String> {
    if let Some(list) = value.get::<Vec<String>>() {
        return list.into_iter().filter(|accelerator| !accelerator.trim().is_empty()).collect();
    }
    match value.get::<String>() {
        Some(single) if !single.trim().is_empty() => vec![single],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(schema: &str, key: &str, accelerators: &[&str]) -> GnomeBinding {
        GnomeBinding { schema: schema.into(), key: key.into(), accelerators: accelerators.iter().map(|accelerator| accelerator.to_string()).collect() }
    }

    /// Shaped like this machine's `gsettings list-recursively` output.
    fn table() -> Vec<GnomeBinding> {
        vec![
            binding("org.gnome.desktop.wm.keybindings", "close", &["<Super>q", "<Alt>F4"]),
            binding("org.gnome.desktop.wm.keybindings", "switch-input-source", &["<Shift><Control>space"]),
            binding("org.gnome.desktop.wm.keybindings", "switch-input-source-backward", &["<Control>space"]),
            binding("org.gnome.shell.keybindings", "toggle-overview", &["<Super>s"]),
            binding("org.gnome.mutter.keybindings", "toggle-tiled-left", &["<Super>Left"]),
            binding("org.gnome.settings-daemon.plugins.media-keys", "screensaver", &["<Super>Escape", "<Control><Alt>l"]),
            binding("org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom3/", "binding", &["<Super><Shift><Control>space"]),
        ]
    }

    #[test]
    fn treats_every_spelling_of_a_chord_as_the_same_chord() {
        let expected = parse_portal_trigger("CTRL+SHIFT+space");
        assert!(expected.is_some());
        for accelerator in ["<Shift><Control>space", "<Primary><Shift>space", "<Control><Shift>Space", "<ctrl><shift>space", "<Ctl><Shft>space"] {
            assert_eq!(parse_gnome_accelerator(accelerator), expected, "{accelerator}");
        }
        assert_eq!(parse_portal_trigger("SHIFT+CTRL+space"), expected);
        assert_eq!(parse_gnome_accelerator("<Mod4>Left"), parse_gnome_accelerator("<Super>left"));
        assert_eq!(parse_gnome_accelerator("<Mod1>F4"), parse_portal_trigger("ALT+F4"));
        assert_ne!(parse_gnome_accelerator("<Control>space"), expected);
        assert_ne!(parse_gnome_accelerator("<Super><Shift><Control>space"), expected);
    }

    #[test]
    fn skips_entries_that_bind_no_press() {
        for accelerator in ["", "  ", "disabled", "<Release>space", "<Bogus>space", "<Control>", "<Control"] {
            assert_eq!(parse_gnome_accelerator(accelerator), None, "{accelerator:?}");
        }
        assert_eq!(parse_portal_trigger("CTRL+"), None);
        assert_eq!(parse_portal_trigger("CommandOrControl+SHIFT+o"), None);
    }

    #[test]
    fn finds_the_gnome_setting_that_already_owns_a_chord() {
        let bindings = table();
        let owner = parse_portal_trigger("CTRL+SHIFT+space").and_then(|chord| find_conflict(&chord, &bindings).cloned());
        assert_eq!(owner.map(|binding| binding.owner()), Some("org.gnome.desktop.wm.keybindings switch-input-source".to_string()));
        let custom = parse_portal_trigger("CTRL+SHIFT+LOGO+space").and_then(|chord| find_conflict(&chord, &bindings).cloned());
        assert_eq!(custom.map(|binding| binding.key), Some("binding".to_string()));
        let second_entry = parse_portal_trigger("ALT+F4").and_then(|chord| find_conflict(&chord, &bindings).cloned());
        assert_eq!(second_entry.map(|binding| binding.key), Some("close".to_string()));
    }

    #[test]
    fn reports_no_conflict_for_a_free_chord() {
        let bindings = table();
        for trigger in ["CTRL+SHIFT+o", "ALT+SHIFT+k", "CTRL+ALT+space"] {
            let chord = parse_portal_trigger(trigger);
            assert!(chord.is_some(), "{trigger}");
            assert_eq!(chord.and_then(|chord| find_conflict(&chord, &bindings).cloned()), None, "{trigger}");
        }
        let chord = parse_portal_trigger("CTRL+SHIFT+space");
        assert_eq!(chord.and_then(|chord| find_conflict(&chord, &[]).cloned()), None);
    }

    #[test]
    fn detects_a_gnome_session_from_the_desktop_list() {
        let env = |value: &str| -> Env { [("XDG_CURRENT_DESKTOP".to_string(), value.to_string())].into_iter().collect() };
        assert!(is_gnome_session(&env("GNOME")));
        assert!(is_gnome_session(&env("ubuntu:GNOME")));
        assert!(!is_gnome_session(&env("KDE")));
        assert!(!is_gnome_session(&env("GNOME-Flashback-ish")));
        assert!(!is_gnome_session(&Env::new()));
    }

    #[test]
    fn opens_only_well_formed_custom_shortcut_paths() {
        assert!(is_valid_settings_path("/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/"));
        for path in ["", "/", "relative/", "/no-trailing-slash", "/double//slash/"] {
            assert!(!is_valid_settings_path(path), "{path:?}");
        }
    }
}
