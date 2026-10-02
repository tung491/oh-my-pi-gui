//! The system tray, ported from `src/main/tray.ts`: a template mark with a
//! quick-access menu built from the snapshot the renderer pushes. The native
//! menu is rebuilt only when a visible label changes; actions route back to
//! the renderer through `menu:action`.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde_json::{json, Value};

use super::app_icons::{tray_icon_bitmap, tray_mark};
use super::tray_labels::{aggregate_tray_status, approval_label, format_tokens, menu_signature, t, tray_tooltip, TrayApprovalMode, TrayLabelKey, TrayState};
use super::windows::MenuItemModel;
use super::{lock, Desktop, Platform};
use crate::ctx::AppCtx;
use crate::i18n::MainLanguage;
use crate::ports::WindowId;
use crate::runtime_log;

const ID_USAGE: &str = "tray:open-usage";
const ID_ADD_WORKSPACE: &str = "tray:open-project";
const ID_NEW_SESSION: &str = "tray:new-session";
const ID_HANDOFF: &str = "tray:handoff";
const ID_TOGGLE_FAST: &str = "tray:toggle-fast";
const ID_CYCLE_THINKING: &str = "tray:cycle-thinking";
const ID_TOGGLE_LANGUAGE: &str = "tray:toggle-language";
const ID_SHOW_HIDE: &str = "tray:show-hide";
const ID_QUIT: &str = "tray:quit";
const PREFIX_SWITCH: &str = "tray:switch-project:";
const PREFIX_APPROVAL: &str = "tray:set-approval:";

/// Per-window snapshots and what the installed menu renders.
#[derive(Default)]
struct TrayCtl {
    states: BTreeMap<WindowId, TrayState>,
    /// The most recently pushed snapshot, its status replaced by the aggregate.
    displayed: Option<TrayState>,
    installed_signature: Option<String>,
    tooltip: Option<String>,
    installed: bool,
}

#[derive(Default)]
pub(crate) struct TrayController {
    state: Mutex<TrayCtl>,
}

/// The tray menu for a snapshot (or none, before the renderer pushed one).
pub(crate) fn build_tray_menu(state: Option<&TrayState>, fallback: MainLanguage) -> Vec<MenuItemModel> {
    let lang = state.map(|state| state.language).unwrap_or(fallback);
    let mut items = vec![MenuItemModel::disabled(tray_tooltip(state)), MenuItemModel::Separator];
    if let Some(state) = state {
        let model = state.model_id.clone().filter(|model| !model.is_empty()).unwrap_or_else(|| t(lang, TrayLabelKey::NoModel).to_string());
        items.push(MenuItemModel::disabled(format!("{model} · {} {}", t(lang, TrayLabelKey::Thinking), state.thinking_level)));
        let fast = format!("{}: {}", t(lang, TrayLabelKey::FastMode), if state.fast_mode { "✓" } else { "—" });
        items.push(MenuItemModel::disabled(format!("{fast} · {}: {}", t(lang, TrayLabelKey::Approval), approval_label(lang, state.approval_mode))));
        if state.context_percent.is_some() || state.context_tokens.is_some() {
            let share = state.context_percent.map(|p| format!("{}%", p.round() as i64)).unwrap_or_else(|| "—".into());
            let tokens = state.context_tokens.map(|n| format!(" · {} {}", format_tokens(n), t(lang, TrayLabelKey::Tokens))).unwrap_or_default();
            items.push(MenuItemModel::disabled(format!("{}: {share}{tokens}", t(lang, TrayLabelKey::Context))));
        }
        items.push(MenuItemModel::Separator);
    }
    items.push(MenuItemModel::item(ID_USAGE, t(lang, TrayLabelKey::UsageStats)));
    items.push(MenuItemModel::Separator);

    let mut workspaces: Vec<MenuItemModel> = state
        .map(|state| {
            state
                .workspaces
                .iter()
                .map(|ws| MenuItemModel::Item {
                    id: format!("{PREFIX_SWITCH}{}", ws.cwd),
                    label: format!("{}{}", if ws.current { "✓ " } else { "" }, ws.name),
                    enabled: !ws.current,
                    accelerator: None,
                })
                .collect()
        })
        .unwrap_or_default();
    if !workspaces.is_empty() {
        workspaces.push(MenuItemModel::Separator);
    }
    workspaces.push(MenuItemModel::item(ID_ADD_WORKSPACE, t(lang, TrayLabelKey::AddWorkspace)));
    items.push(MenuItemModel::submenu(t(lang, TrayLabelKey::Workspaces), workspaces));

    items.push(MenuItemModel::submenu(
        t(lang, TrayLabelKey::QuickStart),
        vec![
            MenuItemModel::item(ID_NEW_SESSION, t(lang, TrayLabelKey::NewSession)),
            MenuItemModel::item(ID_ADD_WORKSPACE, t(lang, TrayLabelKey::OpenProject)),
            MenuItemModel::item(ID_HANDOFF, t(lang, TrayLabelKey::Handoff)),
        ],
    ));
    items.push(MenuItemModel::submenu(
        t(lang, TrayLabelKey::QuickConfig),
        vec![
            MenuItemModel::Check { id: ID_TOGGLE_FAST.into(), label: t(lang, TrayLabelKey::FastMode).into(), checked: state.map(|s| s.fast_mode).unwrap_or(false), enabled: true },
            MenuItemModel::item(ID_CYCLE_THINKING, format!("{}: {}", t(lang, TrayLabelKey::Thinking), state.map(|s| s.thinking_level.as_str()).unwrap_or("off"))),
            MenuItemModel::submenu(
                t(lang, TrayLabelKey::Approval),
                TrayApprovalMode::ALL
                    .into_iter()
                    .map(|mode| MenuItemModel::Check {
                        id: format!("{PREFIX_APPROVAL}{}", mode.as_str()),
                        label: approval_label(lang, mode).into(),
                        checked: state.map(|s| s.approval_mode == mode).unwrap_or(false),
                        enabled: true,
                    })
                    .collect(),
            ),
            MenuItemModel::item(ID_TOGGLE_LANGUAGE, format!("{}: {}", t(lang, TrayLabelKey::Language), if lang == MainLanguage::Vi { "Tiếng Việt" } else { "English" })),
        ],
    ));
    items.push(MenuItemModel::Separator);
    items.push(MenuItemModel::item(ID_SHOW_HIDE, t(lang, TrayLabelKey::ShowHide)));
    items.push(MenuItemModel::Separator);
    items.push(MenuItemModel::item(ID_QUIT, t(lang, TrayLabelKey::Quit)));
    items
}

impl TrayController {
    /// Build the tray with the template mark and the empty menu.
    pub(crate) fn install(&self, ctx: &AppCtx, desktop: &Desktop) {
        let menu = build_tray_menu(None, ctx.i18n.language());
        match desktop.backend.install_tray(&tray_tooltip(None), &menu) {
            Ok(()) => {
                let mut state = lock(&self.state);
                state.installed = true;
                state.tooltip = Some(tray_tooltip(None));
                state.installed_signature = None;
            }
            Err(error) => runtime_log::note("unknown", format!("could not build the tray: {error}"), json!({})),
        }
    }

    /// The renderer pushed a snapshot for `win_id`: the hover text tracks the
    /// aggregate status, and the menu is rebuilt only when a visible label changed.
    pub(crate) fn push_state(&self, ctx: &AppCtx, desktop: &Desktop, win_id: WindowId, state: TrayState) {
        let (tooltip, menu) = {
            let mut ctl = lock(&self.state);
            ctl.states.insert(win_id, state.clone());
            let aggregate = aggregate_tray_status(ctl.states.values());
            let displayed = TrayState { status: aggregate, ..state };
            let tooltip = tray_tooltip(Some(&displayed));
            let tooltip_changed = ctl.tooltip.as_deref() != Some(tooltip.as_str());
            if tooltip_changed {
                ctl.tooltip = Some(tooltip.clone());
            }
            let signature = menu_signature(&displayed);
            let menu_changed = ctl.installed_signature.as_deref() != Some(signature.as_str());
            if menu_changed {
                ctl.installed_signature = Some(signature);
            }
            ctl.displayed = Some(displayed.clone());
            let installed = ctl.installed;
            (tooltip_changed.then_some(tooltip), (menu_changed && installed).then(|| build_tray_menu(Some(&displayed), ctx.i18n.language())))
        };
        if let Some(tooltip) = tooltip {
            desktop.backend.set_tray_tooltip(&tooltip);
        }
        if let Some(menu) = menu {
            if let Err(error) = desktop.backend.set_tray_menu(&menu) {
                runtime_log::note("unknown", format!("could not rebuild the tray menu: {error}"), json!({}));
            }
        }
    }

    /// A window closed: its snapshot leaves the aggregate.
    pub(crate) fn forget_window(&self, ctx: &AppCtx, desktop: &Desktop, win_id: WindowId) {
        let latest = {
            let mut ctl = lock(&self.state);
            if ctl.states.remove(&win_id).is_none() {
                return;
            }
            ctl.states.values().next_back().cloned()
        };
        if let Some(state) = latest {
            // Re-aggregate through the newest remaining snapshot.
            let owner = lock(&self.state).states.iter().find(|(_, s)| **s == state).map(|(id, _)| *id);
            if let Some(owner) = owner {
                self.push_state(ctx, desktop, owner, state);
            }
        }
    }

    pub(crate) fn destroy(&self, desktop: &Desktop) {
        let was_installed = std::mem::take(&mut *lock(&self.state)).installed;
        if was_installed {
            desktop.backend.destroy_tray();
        }
    }

    #[cfg(test)]
    pub(crate) fn displayed(&self) -> Option<TrayState> {
        lock(&self.state).displayed.clone()
    }

    /// A tray menu item was clicked.
    pub(crate) fn on_menu_id(&self, ctx: &AppCtx, desktop: &Desktop, id: &str) {
        if let Some(cwd) = id.strip_prefix(PREFIX_SWITCH) {
            desktop.send_menu_action(ctx, "switch-project", Some(json!({ "cwd": cwd })), true);
            return;
        }
        if let Some(mode) = id.strip_prefix(PREFIX_APPROVAL) {
            desktop.send_menu_action(ctx, "set-approval", Some(json!({ "approvalMode": mode })), true);
            return;
        }
        match id {
            ID_USAGE => desktop.send_menu_action(ctx, "open-usage", None, true),
            ID_ADD_WORKSPACE => desktop.send_menu_action(ctx, "open-project", None, true),
            ID_NEW_SESSION => desktop.send_menu_action(ctx, "new-session", None, true),
            ID_HANDOFF => desktop.send_menu_action(ctx, "handoff", None, true),
            ID_TOGGLE_FAST => desktop.send_menu_action(ctx, "toggle-fast", None, true),
            ID_CYCLE_THINKING => desktop.send_menu_action(ctx, "cycle-thinking", None, true),
            ID_TOGGLE_LANGUAGE => desktop.send_menu_action(ctx, "toggle-language", None, true),
            ID_SHOW_HIDE => desktop.toggle_target_window(ctx),
            ID_QUIT => desktop.start_guarded_quit_from(ctx),
            other => runtime_log::note("unknown", format!("unknown menu id {other}"), json!({ "id": other })),
        }
    }
}

impl Desktop {
    /// Show / Hide targets the focused window, else the main one, else opens one.
    pub(crate) fn toggle_target_window(&self, ctx: &AppCtx) {
        match self.windows.target_window() {
            Some(id) if self.backend.is_visible(id) => self.backend.hide(id),
            Some(id) => self.backend.focus(id),
            None => {
                self.spawn_window_in(ctx, None, None, None);
            }
        }
    }

    /// The tray icon was clicked (macOS and Windows; Linux has no click events).
    pub(crate) fn on_tray_click(&self, ctx: &AppCtx) {
        match self.windows.target_window() {
            Some(id) => self.backend.focus(id),
            None => {
                self.spawn_window_in(ctx, None, None, None);
            }
        }
    }

    /// Handle a `tray:state-push` from `win_id`.
    pub(crate) fn push_tray_state(&self, ctx: &AppCtx, win_id: WindowId, state: Value) -> Result<(), String> {
        let state: TrayState = serde_json::from_value(state).map_err(|error| error.to_string())?;
        self.tray.push_state(ctx, self, win_id, state);
        Ok(())
    }
}

/// Build the native tray icon with the platform's mark.
pub(crate) fn build_tray(app: &tauri::AppHandle, tooltip: &str, items: &[MenuItemModel]) -> Result<tauri::tray::TrayIcon, String> {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let mark = tray_mark()?;
    let bitmap = tray_icon_bitmap(Platform::current(), mark);
    let size = bitmap.size as u32;
    let icon = tauri::image::Image::new_owned(bitmap.pixels, size, size);
    let menu = super::menu::build_menu(app, items)?;
    let mut builder = TrayIconBuilder::with_id("sai-atlas-tray").icon(icon).icon_as_template(bitmap.template).tooltip(tooltip).menu(&menu);
    if Platform::current() != Platform::Linux {
        // Left click focuses the main window as before; the menu stays on the right button.
        builder = builder.show_menu_on_left_click(false).on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                let app = tray.app_handle();
                if let Some(ctx) = tauri::Manager::try_state::<std::sync::Arc<AppCtx>>(app) {
                    if let Some(desktop) = Desktop::of(&ctx) {
                        desktop.on_tray_click(&ctx);
                    }
                }
            }
        });
    }
    builder.build(app).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::{dispatch_for_test, Envelope};
    use crate::desktop::testing::{attach_recording_sink, harness, Backend as _, DesktopPort as _, Harness};
    use crate::desktop::tray_labels::{sample_state, TrayStatus};
    use crate::ports::Caller;

    fn item_labels(items: &[MenuItemModel]) -> Vec<String> {
        items
            .iter()
            .filter_map(|item| match item {
                MenuItemModel::Item { label, .. } | MenuItemModel::Check { label, .. } | MenuItemModel::Submenu { label, .. } => Some(label.clone()),
                MenuItemModel::Separator | MenuItemModel::Predefined(_) => None,
            })
            .collect()
    }

    #[test]
    fn builds_the_menu_from_the_snapshot_with_the_header_carrying_the_status() {
        let menu = build_tray_menu(Some(&sample_state()), MainLanguage::En);
        let labels = item_labels(&menu);
        assert_eq!(labels[0], "Sai ATLAS — alpha · Idle");
        assert_eq!(labels[1], "gpt-x · Thinking medium");
        assert_eq!(labels[2], "Fast Mode: — · Tool Approval: Auto-edit");
        assert_eq!(labels[3], "Context: 42% · 12.3k tokens");
        assert!(labels.contains(&"Switch Workspace".to_string()));
        assert!(labels.contains(&"Quit".to_string()));
        let empty = build_tray_menu(None, MainLanguage::Vi);
        assert_eq!(item_labels(&empty)[0], "Sai ATLAS");
        assert!(item_labels(&empty).contains(&"Thoát".to_string()));
    }

    #[tokio::test]
    async fn aggregates_pushes_per_window_and_rebuilds_only_on_visible_changes() {
        let Harness { ctx, desktop, backend, .. } = harness(Platform::Linux);
        let first = desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        let second = desktop.spawn_window(Some("/w/beta".into()), None, None).unwrap();
        desktop.tray.install(&ctx, &desktop);
        backend.log.clear();
        let mut streaming = sample_state();
        streaming.status = TrayStatus::Streaming;
        dispatch_for_test(&ctx, Caller::main(first), "tray:state-push", vec![serde_json::to_value(&streaming).unwrap()]).await.unwrap();
        assert_eq!(backend.tray_tooltip.lock().unwrap().clone(), Some("Sai ATLAS — alpha · Running".into()));
        assert_eq!(backend.log.calls().iter().filter(|c| *c == "set_tray_menu()").count(), 1);
        // A second window's idle push keeps the streaming aggregate.
        dispatch_for_test(&ctx, Caller::main(second), "tray:state-push", vec![serde_json::to_value(sample_state()).unwrap()]).await.unwrap();
        assert_eq!(desktop.tray.displayed().map(|s| s.status), Some(TrayStatus::Streaming));
        // A push with only sub-bucket context changes leaves the menu alone.
        let mut nudged = streaming.clone();
        nudged.context_tokens = Some(12_348.0);
        let before = backend.log.calls().iter().filter(|c| *c == "set_tray_menu()").count();
        dispatch_for_test(&ctx, Caller::main(first), "tray:state-push", vec![serde_json::to_value(&nudged).unwrap()]).await.unwrap();
        assert_eq!(backend.log.calls().iter().filter(|c| *c == "set_tray_menu()").count(), before);
        // The streaming window closes: the aggregate drops to idle.
        desktop.tray.forget_window(&ctx, &desktop, first);
        assert_eq!(desktop.tray.displayed().map(|s| s.status), Some(TrayStatus::Idle));
        let bad = dispatch_for_test(&ctx, Caller::main(second), "tray:state-push", vec![json!({ "status": "nope" })]).await;
        assert!(bad.is_err());
        desktop.tray.destroy(&desktop);
        assert!(backend.tray_menu.lock().unwrap().is_none());
    }

    #[test]
    fn tray_actions_focus_the_target_window_and_reach_the_renderer() {
        let Harness { ctx, desktop, backend, fakes } = harness(Platform::Linux);
        let id = desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        let sink = attach_recording_sink(&ctx, id);
        backend.log.clear();
        desktop.on_menu_id(&ctx, &format!("{PREFIX_SWITCH}/w/beta"));
        desktop.on_menu_id(&ctx, &format!("{PREFIX_APPROVAL}yolo"));
        desktop.on_menu_id(&ctx, ID_USAGE);
        assert!(backend.log.calls().contains(&format!("focus({id})")));
        let sent: Vec<Envelope> = sink.sent();
        assert_eq!(sent[0].payload, json!({ "action": "switch-project", "cwd": "/w/beta" }));
        assert_eq!(sent[1].payload, json!({ "action": "set-approval", "approvalMode": "yolo" }));
        assert_eq!(sent[2].payload, json!({ "action": "open-usage" }));
        desktop.on_menu_id(&ctx, ID_SHOW_HIDE);
        assert!(!backend.is_visible(id));
        desktop.on_menu_id(&ctx, ID_SHOW_HIDE);
        assert!(backend.is_visible(id));
        desktop.on_menu_id(&ctx, ID_QUIT);
        assert_eq!(fakes.host.exit_codes.lock().unwrap().clone(), vec![0]);
    }
}
