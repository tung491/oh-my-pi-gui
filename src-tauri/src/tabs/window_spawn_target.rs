//! The sidecar target for a newly
//! created window.
//!
//! The caller is the window spawn path, which the `desktop`
//! module owns in the Tauri core and resolves through its own code (cross-module
//! calls go through the frozen ports only). Nothing in this module calls it, so
//! `tabs/mod.rs` compiles it only for tests: it is the tested reference port.

use crate::ports::SessionKind;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WindowSpawnTarget {
    pub cwd: String,
    pub kind: SessionKind,
    pub fresh: bool,
    pub placeholder: bool,
}

/// A window created without an explicit workspace or session starts a full
/// agent in the GUI-owned Work workspace. It does not inherit the last Code
/// project, and `fresh` keeps the CLI's auto-resume from attaching an unrelated
/// transcript.
pub(crate) fn resolve_window_spawn_target(
    cwd: Option<&str>,
    pending_session_path: Option<&str>,
    kind: Option<SessionKind>,
    fallback_cwd: &str,
    default_workspace_cwd: &str,
) -> WindowSpawnTarget {
    let idle = cwd.is_none() && pending_session_path.is_none() && kind.is_none();
    if idle {
        return WindowSpawnTarget { cwd: default_workspace_cwd.to_string(), kind: SessionKind::Agent, fresh: true, placeholder: true };
    }
    WindowSpawnTarget {
        cwd: cwd.filter(|cwd| !cwd.is_empty()).unwrap_or(fallback_cwd).to_string(),
        kind: kind.unwrap_or(SessionKind::Agent),
        fresh: false,
        placeholder: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_an_untargeted_window_as_a_fresh_agent_in_the_default_work_workspace() {
        assert_eq!(
            resolve_window_spawn_target(None, None, None, "/last-project", "/neutral-home"),
            WindowSpawnTarget { cwd: "/neutral-home".into(), kind: SessionKind::Agent, fresh: true, placeholder: true }
        );
    }

    #[test]
    fn preserves_an_explicitly_selected_workspace_as_an_agent_window() {
        assert_eq!(
            resolve_window_spawn_target(Some("/selected-project"), None, None, "/last-project", "/neutral-home"),
            WindowSpawnTarget { cwd: "/selected-project".into(), kind: SessionKind::Agent, fresh: false, placeholder: false }
        );
    }

    #[test]
    fn uses_the_requested_session_kind_when_opening_a_known_transcript() {
        assert_eq!(
            resolve_window_spawn_target(None, Some("/sessions/chat.jsonl"), Some(SessionKind::Chat), "/session-cwd", "/neutral-home"),
            WindowSpawnTarget { cwd: "/session-cwd".into(), kind: SessionKind::Chat, fresh: false, placeholder: false }
        );
    }
}
