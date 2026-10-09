//! Validation of the saved tab layouts before they reach a sidecar.
//! Missing workspaces are dropped; a deleted
//! transcript becomes a fresh tab at the same cwd instead of failing startup.

use std::collections::HashSet;
use std::path::Path;

use serde_json::Value;

use crate::ports::{IpcTabWorktree, PersistedTabDescriptor, PersistedTabLayout, PersistedTabSplit, SessionKind, TabSplitAxis};

pub(crate) const TAB_LAYOUT_VERSION: u32 = 1;
pub(crate) const MAX_PERSISTED_TABS: usize = 10;
/// A persisted title is display data only; bound it so prefs cannot grow.
pub(crate) const MAX_PERSISTED_TITLE: usize = 120;

/// The filesystem probes the sanitizer needs, so tests pass a fake set.
pub(crate) trait TabLayoutPathChecks {
    fn directory_exists(&self, path: &str) -> bool;
    fn file_exists(&self, path: &str) -> bool;
    /// Conservative content probe used only to migrate pre-placeholder layouts.
    fn session_has_content(&self, path: &str) -> bool;
}

/// The real filesystem.
pub(crate) struct DiskPathChecks;

impl TabLayoutPathChecks for DiskPathChecks {
    fn directory_exists(&self, path: &str) -> bool {
        Path::new(path).is_dir()
    }

    fn file_exists(&self, path: &str) -> bool {
        Path::new(path).is_file()
    }

    fn session_has_content(&self, path: &str) -> bool {
        let Ok(meta) = std::fs::metadata(path) else { return true };
        // Empty sessions are small. Treat a large transcript as contentful
        // without loading it during startup.
        if meta.len() > 128 * 1024 {
            return true;
        }
        let Ok(text) = std::fs::read_to_string(path) else { return true };
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(line) {
                Ok(value) if value.get("type").and_then(Value::as_str) == Some("message") => return true,
                Ok(_) => {}
                // A malformed line is not evidence that the transcript is empty.
                Err(_) => return true,
            }
        }
        false
    }
}

fn non_empty_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).filter(|text| !text.trim().is_empty()).map(str::to_string)
}

fn parse_kind(value: Option<&Value>) -> Option<SessionKind> {
    match value.and_then(Value::as_str) {
        Some("agent") => Some(SessionKind::Agent),
        Some("chat") => Some(SessionKind::Chat),
        _ => None,
    }
}

fn parse_worktree(value: Option<&Value>) -> Option<IpcTabWorktree> {
    let record = value.filter(|value| value.is_object())?;
    let name = non_empty_string(record.get("name"))?;
    let branch = non_empty_string(record.get("branch"))?;
    let base_cwd = non_empty_string(record.get("baseCwd"))?;
    Some(IpcTabWorktree { name, branch, base_cwd })
}

fn parse_axis(value: Option<&Value>) -> Option<TabSplitAxis> {
    match value.and_then(Value::as_str) {
        Some("columns") => Some(TabSplitAxis::Columns),
        Some("rows") => Some(TabSplitAxis::Rows),
        _ => None,
    }
}

/// A non-negative integer index, as the TS `Number.isInteger(x) && x >= 0` check read it.
fn parse_index(value: Option<&Value>) -> Option<usize> {
    let number = value?.as_f64()?;
    if number.fract() != 0.0 || number < 0.0 {
        return None;
    }
    Some(number as usize)
}

/// Validate one window's saved layout. `None` when nothing restorable remains.
pub(crate) fn sanitize_persisted_tab_layout(value: &Value, paths: &dyn TabLayoutPathChecks) -> Option<PersistedTabLayout> {
    if !value.is_object() || value.get("version").and_then(Value::as_u64) != Some(u64::from(TAB_LAYOUT_VERSION)) {
        return None;
    }
    let tabs = value.get("tabs")?.as_array()?;
    let requested_active_index = parse_index(value.get("activeIndex")).unwrap_or(0);
    let mut retained: Vec<(PersistedTabDescriptor, usize)> = Vec::new();
    let mut session_paths: HashSet<String> = HashSet::new();

    for (source_index, candidate) in tabs.iter().enumerate() {
        if retained.len() >= MAX_PERSISTED_TABS {
            break;
        }
        if !candidate.is_object() {
            continue;
        }
        let (Some(cwd), Some(kind)) = (non_empty_string(candidate.get("cwd")), parse_kind(candidate.get("kind"))) else { continue };
        if !paths.directory_exists(&cwd) {
            continue;
        }
        let session_path = non_empty_string(candidate.get("sessionPath")).filter(|path| paths.file_exists(path));
        if let Some(path) = &session_path {
            if !session_paths.insert(path.clone()) {
                continue;
            }
        }
        let placeholder_flag = candidate.get("placeholder");
        let legacy_empty_startup_chat = placeholder_flag.is_none()
            && source_index == 0
            && kind == SessionKind::Chat
            && session_path.as_deref().map(|path| !paths.session_has_content(path)).unwrap_or(true);
        let placeholder = placeholder_flag.and_then(Value::as_bool) == Some(true) || legacy_empty_startup_chat;
        let title = non_empty_string(candidate.get("title")).map(|title| title.chars().take(MAX_PERSISTED_TITLE).collect());
        retained.push((
            PersistedTabDescriptor {
                cwd,
                session_path,
                kind,
                worktree: parse_worktree(candidate.get("worktree")),
                placeholder: placeholder.then_some(true),
                title,
            },
            source_index,
        ));
    }

    // Startup placeholders are disposable. Never restore the legacy tool-free
    // chat after Work mode became the default full-agent surface.
    let effective: Vec<(PersistedTabDescriptor, usize)> = retained.into_iter().filter(|(tab, _)| tab.placeholder != Some(true)).collect();
    if effective.is_empty() {
        return None;
    }
    let mut active_index = effective
        .iter()
        .position(|(_, source)| *source == requested_active_index)
        .or_else(|| effective.iter().position(|(_, source)| *source > requested_active_index))
        .unwrap_or(effective.len() - 1);

    let mut split = None;
    if let Some(saved) = value.get("split").filter(|split| split.is_object()) {
        let axis = parse_axis(saved.get("axis"));
        let first = parse_index(saved.get("firstIndex")).and_then(|index| effective.iter().position(|(_, source)| *source == index));
        let second = parse_index(saved.get("secondIndex")).and_then(|index| effective.iter().position(|(_, source)| *source == index));
        let ratio = saved.get("ratio").and_then(Value::as_f64).filter(|ratio| ratio.is_finite());
        if let (Some(axis), Some(first_index), Some(second_index), Some(ratio)) = (axis, first, second, ratio) {
            if first_index != second_index {
                // Both panes survived but the persisted focus was dropped: keep the
                // split and refocus a pane, or one bad launch forgets the layout for good.
                if active_index != first_index && active_index != second_index {
                    active_index = first_index;
                }
                split = Some(PersistedTabSplit { axis, first_index, second_index, ratio: ratio.clamp(0.2, 0.8) });
            }
        }
    }

    Some(PersistedTabLayout {
        version: TAB_LAYOUT_VERSION,
        tabs: effective.into_iter().map(|(tab, _)| tab).collect(),
        active_index,
        split,
    })
}

/// The whole session: one layout per window, in window order. Accepts the
/// current array and the pre-multi-window shape (a bare layout object). The
/// pool caps sidecars at `MAX_PERSISTED_TABS` in total, so the restored set is
/// trimmed to that budget.
pub(crate) fn sanitize_persisted_tab_layouts(value: Option<&Value>, paths: &dyn TabLayoutPathChecks) -> Vec<PersistedTabLayout> {
    let single;
    let candidates: &[Value] = match value {
        Some(Value::Array(items)) => items,
        Some(other) => {
            single = [other.clone()];
            &single
        }
        None => &[],
    };
    let mut layouts = Vec::new();
    let mut budget = MAX_PERSISTED_TABS;
    for candidate in candidates {
        if budget == 0 {
            break;
        }
        let Some(mut layout) = sanitize_persisted_tab_layout(candidate, paths) else { continue };
        if layout.tabs.len() > budget {
            layout.active_index = layout.active_index.min(budget - 1);
            layout.tabs.truncate(budget);
            layout.split = None;
        }
        budget -= layout.tabs.len();
        layouts.push(layout);
    }
    layouts
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct FakeChecks {
        directories: Vec<String>,
        files: Vec<String>,
        content_files: Vec<String>,
    }

    fn path_checks(directories: &[&str], files: &[&str]) -> FakeChecks {
        path_checks_with_content(directories, files, files)
    }

    fn path_checks_with_content(directories: &[&str], files: &[&str], content_files: &[&str]) -> FakeChecks {
        FakeChecks {
            directories: directories.iter().map(|s| s.to_string()).collect(),
            files: files.iter().map(|s| s.to_string()).collect(),
            content_files: content_files.iter().map(|s| s.to_string()).collect(),
        }
    }

    impl TabLayoutPathChecks for FakeChecks {
        fn directory_exists(&self, path: &str) -> bool {
            self.directories.iter().any(|d| d == path)
        }
        fn file_exists(&self, path: &str) -> bool {
            self.files.iter().any(|f| f == path)
        }
        fn session_has_content(&self, path: &str) -> bool {
            self.content_files.iter().any(|f| f == path)
        }
    }

    fn sanitized(value: &Value, paths: &FakeChecks) -> Option<Value> {
        sanitize_persisted_tab_layout(value, paths).map(|layout| serde_json::to_value(layout).unwrap())
    }

    fn sanitized_all(value: Option<&Value>, paths: &FakeChecks) -> Vec<Value> {
        sanitize_persisted_tab_layouts(value, paths).into_iter().map(|layout| serde_json::to_value(layout).unwrap()).collect()
    }

    #[test]
    fn preserves_valid_order_active_selection_session_kind_and_worktree_metadata() {
        let value = json!({
            "version": 1,
            "activeIndex": 1,
            "tabs": [
                { "cwd": "/a", "kind": "agent", "sessionPath": "/sessions/a.jsonl" },
                { "cwd": "/b", "kind": "chat", "worktree": { "name": "feature", "branch": "omp/gui/feature", "baseCwd": "/repo" } }
            ]
        });
        assert_eq!(sanitized(&value, &path_checks(&["/a", "/b"], &["/sessions/a.jsonl"])), Some(value));
    }

    #[test]
    fn carries_a_saved_title_and_bounds_the_one_read_back_from_prefs() {
        let layout = sanitize_persisted_tab_layout(
            &json!({
                "version": 1,
                "activeIndex": 0,
                "tabs": [
                    { "cwd": "/a", "kind": "agent", "title": "x".repeat(400) },
                    { "cwd": "/b", "kind": "agent", "title": 42 }
                ]
            }),
            &path_checks(&["/a", "/b"], &[]),
        )
        .unwrap();
        assert_eq!(layout.tabs[0].title.as_ref().map(|title| title.chars().count()), Some(MAX_PERSISTED_TITLE));
        assert_eq!(layout.tabs[1].title, None);
    }

    #[test]
    fn remaps_and_clamps_a_restored_two_pane_layout_after_invalid_tabs_are_dropped() {
        let value = json!({
            "version": 1,
            "activeIndex": 2,
            "tabs": [
                { "cwd": "/missing", "kind": "agent" },
                { "cwd": "/a", "kind": "agent" },
                { "cwd": "/b", "kind": "chat" }
            ],
            "split": { "axis": "rows", "firstIndex": 1, "secondIndex": 2, "ratio": 0.95 }
        });
        assert_eq!(
            sanitized(&value, &path_checks(&["/a", "/b"], &[])),
            Some(json!({
                "version": 1,
                "activeIndex": 1,
                "tabs": [{ "cwd": "/a", "kind": "agent" }, { "cwd": "/b", "kind": "chat" }],
                "split": { "axis": "rows", "firstIndex": 0, "secondIndex": 1, "ratio": 0.8 }
            }))
        );
    }

    #[test]
    fn drops_missing_workspaces_and_selects_the_nearest_surviving_tab() {
        let value = json!({
            "version": 1,
            "activeIndex": 1,
            "tabs": [
                { "cwd": "/before", "kind": "agent" },
                { "cwd": "/deleted", "kind": "agent" },
                { "cwd": "/after", "kind": "chat" }
            ]
        });
        assert_eq!(
            sanitized(&value, &path_checks(&["/before", "/after"], &[])),
            Some(json!({
                "version": 1,
                "activeIndex": 1,
                "tabs": [{ "cwd": "/before", "kind": "agent" }, { "cwd": "/after", "kind": "chat" }]
            }))
        );
    }

    #[test]
    fn turns_a_deleted_transcript_into_a_fresh_tab_and_removes_duplicate_session_attachments() {
        let value = json!({
            "version": 1,
            "activeIndex": 0,
            "tabs": [
                { "cwd": "/a", "kind": "agent", "sessionPath": "/sessions/deleted.jsonl" },
                { "cwd": "/b", "kind": "agent", "sessionPath": "/sessions/live.jsonl" },
                { "cwd": "/c", "kind": "agent", "sessionPath": "/sessions/live.jsonl" }
            ]
        });
        assert_eq!(
            sanitized(&value, &path_checks(&["/a", "/b", "/c"], &["/sessions/live.jsonl"])),
            Some(json!({
                "version": 1,
                "activeIndex": 0,
                "tabs": [{ "cwd": "/a", "kind": "agent" }, { "cwd": "/b", "kind": "agent", "sessionPath": "/sessions/live.jsonl" }]
            }))
        );
    }

    #[test]
    fn drops_the_disposable_startup_placeholder_once_an_explicit_tab_exists() {
        let value = json!({
            "version": 1,
            "activeIndex": 0,
            "tabs": [
                { "cwd": "/neutral", "kind": "chat", "placeholder": true },
                { "cwd": "/work", "kind": "agent", "sessionPath": "/sessions/work.jsonl" }
            ]
        });
        assert_eq!(
            sanitized(&value, &path_checks(&["/neutral", "/work"], &["/sessions/work.jsonl"])),
            Some(json!({
                "version": 1,
                "activeIndex": 0,
                "tabs": [{ "cwd": "/work", "kind": "agent", "sessionPath": "/sessions/work.jsonl" }]
            }))
        );
    }

    #[test]
    fn drops_a_lone_startup_placeholder_so_the_next_launch_uses_work() {
        let value = json!({ "version": 1, "activeIndex": 0, "tabs": [{ "cwd": "/neutral", "kind": "chat", "placeholder": true }] });
        assert_eq!(sanitized(&value, &path_checks(&["/neutral"], &[])), None);
    }

    #[test]
    fn migrates_an_empty_first_chat_from_layouts_saved_before_placeholder_metadata_existed() {
        let value = json!({
            "version": 1,
            "activeIndex": 0,
            "tabs": [
                { "cwd": "/neutral", "kind": "chat", "sessionPath": "/sessions/empty.jsonl" },
                { "cwd": "/work", "kind": "agent", "sessionPath": "/sessions/work.jsonl" }
            ]
        });
        assert_eq!(
            sanitized(
                &value,
                &path_checks_with_content(
                    &["/neutral", "/work"],
                    &["/sessions/empty.jsonl", "/sessions/work.jsonl"],
                    &["/sessions/work.jsonl"]
                )
            ),
            Some(json!({
                "version": 1,
                "activeIndex": 0,
                "tabs": [{ "cwd": "/work", "kind": "agent", "sessionPath": "/sessions/work.jsonl" }]
            }))
        );
        // A real first chat is never inferred to be a disposable placeholder.
        assert_eq!(
            sanitized(
                &value,
                &path_checks_with_content(
                    &["/neutral", "/work"],
                    &["/sessions/empty.jsonl", "/sessions/work.jsonl"],
                    &["/sessions/empty.jsonl", "/sessions/work.jsonl"]
                )
            ),
            Some(value)
        );
    }

    #[test]
    fn rejects_malformed_or_empty_snapshots_and_enforces_the_sidecar_cap() {
        let none = path_checks(&[], &[]);
        assert_eq!(sanitized(&Value::Null, &none), None);
        assert_eq!(sanitized(&json!({ "version": 2, "tabs": [] }), &none), None);
        assert_eq!(sanitized(&json!({ "version": 1, "activeIndex": 0, "tabs": [] }), &none), None);

        let tabs: Vec<Value> = (0..MAX_PERSISTED_TABS + 2).map(|index| json!({ "cwd": format!("/workspace-{index}"), "kind": "agent" })).collect();
        let directories: Vec<String> = tabs.iter().map(|tab| tab["cwd"].as_str().unwrap().to_string()).collect();
        let dir_refs: Vec<&str> = directories.iter().map(String::as_str).collect();
        let layout = sanitize_persisted_tab_layout(&json!({ "version": 1, "activeIndex": 11, "tabs": tabs }), &path_checks(&dir_refs, &[])).unwrap();
        assert_eq!(layout.tabs.len(), MAX_PERSISTED_TABS);
    }

    fn layout(cwd_count: usize, prefix: &str, active_index: usize) -> Value {
        json!({
            "version": 1,
            "activeIndex": active_index,
            "tabs": (0..cwd_count).map(|index| json!({ "cwd": format!("/{prefix}-{index}"), "kind": "agent" })).collect::<Vec<_>>()
        })
    }

    fn dirs(prefixes: &[&str]) -> Vec<String> {
        prefixes.iter().flat_map(|prefix| (0..12).map(move |index| format!("/{prefix}-{index}"))).collect()
    }

    fn checks_for(prefixes: &[&str]) -> FakeChecks {
        FakeChecks { directories: dirs(prefixes), files: Vec::new(), content_files: Vec::new() }
    }

    #[test]
    fn restores_one_layout_per_window_and_still_reads_the_pre_multi_window_single_object() {
        let first = layout(2, "a", 0);
        let second = layout(1, "b", 0);
        let paths = checks_for(&["a", "b"]);
        assert_eq!(sanitized_all(Some(&json!([first, second])), &paths), vec![first.clone(), second]);
        // An upgrade from the one-slot shape must not lose the session.
        assert_eq!(sanitized_all(Some(&first), &paths), vec![first]);
    }

    #[test]
    fn skips_an_unsalvageable_window_without_shifting_the_rest() {
        let second = layout(1, "b", 0);
        let restored = sanitized_all(
            Some(&json!([null, { "version": 1, "activeIndex": 0, "tabs": [{ "cwd": "/gone", "kind": "agent" }] }, second])),
            &checks_for(&["b"]),
        );
        assert_eq!(restored, vec![second]);
    }

    #[test]
    fn shares_the_sidecar_budget_across_windows_and_stops_once_it_is_spent() {
        let paths = checks_for(&["a", "b"]);
        // Window 1 alone consumes the pool's capacity: window 2 restores nothing.
        let full = sanitize_persisted_tab_layouts(Some(&json!([layout(MAX_PERSISTED_TABS, "a", 0), layout(2, "b", 0)])), &paths);
        assert_eq!(full.iter().map(|entry| entry.tabs.len()).collect::<Vec<_>>(), vec![MAX_PERSISTED_TABS]);

        // A partial overflow trims the last window's tabs, clamps its focus, and
        // drops a split whose panes no longer both exist.
        let mut second = layout(4, "b", 3);
        second["split"] = json!({ "axis": "rows", "firstIndex": 2, "secondIndex": 3, "ratio": 0.5 });
        let overflowing = sanitize_persisted_tab_layouts(Some(&json!([layout(MAX_PERSISTED_TABS - 2, "a", 0), second])), &paths);
        assert_eq!(overflowing.iter().map(|entry| entry.tabs.len()).collect::<Vec<_>>(), vec![MAX_PERSISTED_TABS - 2, 2]);
        assert_eq!(overflowing[1].tabs.iter().map(|tab| tab.cwd.as_str()).collect::<Vec<_>>(), vec!["/b-0", "/b-1"]);
        assert_eq!(overflowing[1].active_index, 1);
        assert_eq!(overflowing[1].split, None);
    }

    #[test]
    fn returns_nothing_for_a_session_with_no_restorable_window() {
        let none = path_checks(&[], &[]);
        assert!(sanitize_persisted_tab_layouts(Some(&json!([])), &none).is_empty());
        assert!(sanitize_persisted_tab_layouts(None, &none).is_empty());
    }
}
