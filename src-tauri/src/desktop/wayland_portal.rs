//! Native-Wayland global shortcuts.
//! The X11 grab the shortcut plugin uses does nothing under a Wayland
//! compositor, so a Wayland session goes through the GlobalShortcuts portal,
//! which needs an installed `<app_id>.desktop` entry. Pure so the decision is
//! unit-tested; `shortcut.rs` applies it. Electron's Chromium feature flags
//! have no Tauri meaning: GTK's `GDK_BACKEND` is the one override a user has
//! to force XWayland (or Wayland) inside a session.

use std::collections::HashMap;

pub(crate) type Env = HashMap<String, String>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ShortcutMode {
    Native,
    Portal,
}

/// The GDK backend a session forces, if any: the first entry of `GDK_BACKEND`
/// (GTK tries them in order), lowercased, with `*` and an empty value meaning "no preference".
fn forced_gdk_backend(env: &Env) -> Option<String> {
    let value = env.get("GDK_BACKEND")?;
    let first = value.split(',').next().unwrap_or("").trim().to_lowercase();
    if first.is_empty() || first == "*" {
        return None;
    }
    Some(first)
}

/// True when this Linux session talks to the GlobalShortcuts portal: a forced
/// `GDK_BACKEND` wins, otherwise a Wayland session (`XDG_SESSION_TYPE=wayland`).
pub(crate) fn uses_shortcut_portal(env: &Env) -> bool {
    if let Some(backend) = forced_gdk_backend(env) {
        return backend == "wayland";
    }
    env.get("XDG_SESSION_TYPE").map(String::as_str) == Some("wayland")
}

pub(crate) fn shortcut_mode(env: &Env) -> ShortcutMode {
    if uses_shortcut_portal(env) {
        ShortcutMode::Portal
    } else {
        ShortcutMode::Native
    }
}

/// Native mode inside a Wayland session (XWayland): the X11 grab fires only while the app has focus.
pub(crate) fn xwayland_only(env: &Env) -> bool {
    !uses_shortcut_portal(env) && env.get("XDG_SESSION_TYPE").map(String::as_str) == Some("wayland")
}

fn join(dir: &str, segments: &[&str]) -> String {
    let mut path = dir.trim_end_matches('/').to_string();
    for segment in segments {
        path.push('/');
        path.push_str(segment);
    }
    path
}

/// Where the desktop looks for `file_name`: `$XDG_DATA_HOME/applications`,
/// then each `$XDG_DATA_DIRS` entry's `applications`, with the XDG defaults for
/// unset or empty variables.
pub(crate) fn desktop_entry_candidates(file_name: &str, env: &Env, home: &str) -> Vec<String> {
    let data_home = env
        .get("XDG_DATA_HOME")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| join(home, &[".local", "share"]));
    let data_dirs = env
        .get("XDG_DATA_DIRS")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "/usr/local/share:/usr/share".to_string());
    std::iter::once(data_home.as_str())
        .chain(data_dirs.split(':').filter(|dir| !dir.is_empty()))
        .map(|dir| join(dir, &["applications", file_name]))
        .collect()
}

/// The process environment as the detection functions read it.
pub(crate) fn process_env() -> Env {
    std::env::vars().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn wayland() -> Env {
        env(&[("XDG_SESSION_TYPE", "wayland")])
    }

    #[test]
    fn adds_the_portal_features_to_an_empty_value() {
        // Tauri needs no Chromium feature list: a plain Wayland session is portal mode on its own.
        assert_eq!(shortcut_mode(&wayland()), ShortcutMode::Portal);
        assert_eq!(shortcut_mode(&env(&[("XDG_SESSION_TYPE", "wayland"), ("GDK_BACKEND", "")])), ShortcutMode::Portal);
    }

    #[test]
    fn keeps_the_user_s_features_first_and_never_duplicates_one() {
        // A user's own GDK preference is honoured as given; repeating it changes nothing.
        let forced = env(&[("XDG_SESSION_TYPE", "wayland"), ("GDK_BACKEND", "wayland,wayland")]);
        assert_eq!(shortcut_mode(&forced), ShortcutMode::Portal);
        let wildcard = env(&[("XDG_SESSION_TYPE", "wayland"), ("GDK_BACKEND", "*")]);
        assert_eq!(shortcut_mode(&wildcard), ShortcutMode::Portal);
    }

    #[test]
    fn uses_the_portal_in_a_linux_wayland_session() {
        assert!(uses_shortcut_portal(&wayland()));
    }

    #[test]
    fn does_not_use_it_in_an_x11_session() {
        assert!(!uses_shortcut_portal(&env(&[("XDG_SESSION_TYPE", "x11")])));
    }

    #[test]
    fn honours_ozone_platform_x11_in_a_wayland_session() {
        // GDK_BACKEND=x11 is GTK's way of forcing XWayland.
        assert!(!uses_shortcut_portal(&env(&[("XDG_SESSION_TYPE", "wayland"), ("GDK_BACKEND", "x11")])));
        assert!(xwayland_only(&env(&[("XDG_SESSION_TYPE", "wayland"), ("GDK_BACKEND", "x11")])));
    }

    #[test]
    fn honours_ozone_platform_hint_x11_in_a_wayland_session() {
        // GTK tries the listed backends in order: the first one decides.
        assert!(!uses_shortcut_portal(&env(&[("XDG_SESSION_TYPE", "wayland"), ("GDK_BACKEND", "x11,wayland")])));
    }

    #[test]
    fn lets_an_explicit_platform_win_over_the_hint() {
        assert!(uses_shortcut_portal(&env(&[("XDG_SESSION_TYPE", "x11"), ("GDK_BACKEND", "wayland")])));
        assert!(uses_shortcut_portal(&env(&[("XDG_SESSION_TYPE", "wayland"), ("GDK_BACKEND", "Wayland,x11")])));
    }

    #[test]
    fn treats_an_auto_hint_as_the_session_s_choice() {
        assert!(uses_shortcut_portal(&env(&[("XDG_SESSION_TYPE", "wayland"), ("GDK_BACKEND", "*")])));
        assert!(!uses_shortcut_portal(&env(&[("GDK_BACKEND", "*")])));
        assert!(!xwayland_only(&env(&[("XDG_SESSION_TYPE", "x11")])));
    }

    #[test]
    fn falls_back_to_the_xdg_defaults() {
        assert_eq!(
            desktop_entry_candidates("app.desktop", &env(&[]), "/home/me"),
            vec![
                "/home/me/.local/share/applications/app.desktop",
                "/usr/local/share/applications/app.desktop",
                "/usr/share/applications/app.desktop"
            ]
        );
    }

    #[test]
    fn searches_the_data_home_first_then_each_data_dir() {
        assert_eq!(
            desktop_entry_candidates(
                "app.desktop",
                &env(&[("XDG_DATA_HOME", "/data/home"), ("XDG_DATA_DIRS", "/opt/share::/usr/share")]),
                "/home/me"
            ),
            vec!["/data/home/applications/app.desktop", "/opt/share/applications/app.desktop", "/usr/share/applications/app.desktop"]
        );
    }

    #[test]
    fn treats_empty_variables_as_unset() {
        assert_eq!(
            desktop_entry_candidates("app.desktop", &env(&[("XDG_DATA_HOME", ""), ("XDG_DATA_DIRS", "")]), "/home/me"),
            desktop_entry_candidates("app.desktop", &env(&[]), "/home/me")
        );
    }
}
