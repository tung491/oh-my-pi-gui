//! The application menu, as pure data that
//! the Tauri backend renders. A shortcut the renderer keymap owns is never a
//! menu accelerator: the menu would fire first and the user's remap would die.
//! Menu-only chords live in the native chord table the keymap reads as reserved.

use serde_json::{json, Value};

use super::shortcut_core::native_accelerator;
use super::windows::{MenuItemModel, PredefinedItem};
use super::{survive, Desktop, Platform};
use crate::ctx::AppCtx;
use crate::i18n::{MainI18n, MainTextKey};
use crate::runtime_log;

const MENU_ACTION_CHANNEL: &str = "menu:action";
pub(crate) const DOCUMENTATION_URL: &str = "https://github.com/tung491/oh-my-pi-gui";

/// Menu ids: `menu:action:<renderer action>` for actions the renderer handles, and a few the shell owns.
const ACTION_PREFIX: &str = "menu:action:";
pub(crate) const ID_NEW_WINDOW: &str = "menu:new-window";
pub(crate) const ID_CLOSE_WINDOW: &str = "menu:close-window";
pub(crate) const ID_DOCUMENTATION: &str = "menu:documentation";
pub(crate) const ID_CHECK_FOR_UPDATES: &str = "menu:check-for-updates";

fn action(i18n: &MainI18n, key: MainTextKey, action: &str) -> MenuItemModel {
    MenuItemModel::item(format!("{ACTION_PREFIX}{action}"), i18n.t(key))
}

/// The whole menu bar for `platform`.
pub(crate) fn build_app_menu(i18n: &MainI18n, platform: Platform) -> Vec<MenuItemModel> {
    let darwin = platform == Platform::Darwin;
    let mut bar = Vec::new();
    if darwin {
        bar.push(MenuItemModel::submenu(
            crate::product::PRODUCT_NAME,
            vec![
                MenuItemModel::Predefined(PredefinedItem::About),
                MenuItemModel::item(ID_CHECK_FOR_UPDATES, i18n.t(MainTextKey::MenuCheckForUpdates)),
                // No accelerator: ⌘, belongs to the renderer keymap so users can remap it.
                action(i18n, MainTextKey::MenuSettings, "open-settings"),
                MenuItemModel::Separator,
                MenuItemModel::Predefined(PredefinedItem::Services),
                MenuItemModel::Separator,
                MenuItemModel::Predefined(PredefinedItem::Hide),
                MenuItemModel::Predefined(PredefinedItem::HideOthers),
                MenuItemModel::Predefined(PredefinedItem::ShowAll),
                MenuItemModel::Separator,
                MenuItemModel::Predefined(PredefinedItem::Quit),
            ],
        ));
    }
    let mut file = vec![
        action(i18n, MainTextKey::MenuNewSession, "new-session").with_accelerator(native_accelerator("session.new")),
        // No accelerator: ⌘T/⇧⌘T live in the renderer keymap so users can remap them.
        action(i18n, MainTextKey::MenuNewTab, "new-tab"),
        MenuItemModel::item(ID_NEW_WINDOW, i18n.t(MainTextKey::MenuNewWindow)).with_accelerator(native_accelerator("window.new")),
    ];
    if !darwin {
        file.push(MenuItemModel::Separator);
        file.push(action(i18n, MainTextKey::MenuSettings, "open-settings"));
        file.push(MenuItemModel::item(ID_CHECK_FOR_UPDATES, i18n.t(MainTextKey::MenuCheckForUpdates)));
    }
    bar.push(MenuItemModel::submenu(i18n.t(MainTextKey::MenuFile), file));
    bar.push(MenuItemModel::submenu(
        i18n.t(MainTextKey::MenuEdit),
        vec![
            MenuItemModel::Predefined(PredefinedItem::Undo),
            MenuItemModel::Predefined(PredefinedItem::Redo),
            MenuItemModel::Separator,
            MenuItemModel::Predefined(PredefinedItem::Cut),
            MenuItemModel::Predefined(PredefinedItem::Copy),
            MenuItemModel::Predefined(PredefinedItem::Paste),
            MenuItemModel::Predefined(PredefinedItem::SelectAll),
        ],
    ));
    bar.push(MenuItemModel::submenu(
        i18n.t(MainTextKey::MenuView),
        vec![
            action(i18n, MainTextKey::MenuCommandCenter, "open-command-center"),
            action(i18n, MainTextKey::MenuJobs, "open-jobs"),
            action(i18n, MainTextKey::MenuHotkeys, "open-hotkeys"),
            MenuItemModel::Separator,
            // No accelerators: ⌘B and ⌘J belong to the renderer keymap.
            action(i18n, MainTextKey::MenuToggleSidebar, "toggle-sidebar"),
            action(i18n, MainTextKey::MenuTogglePanel, "toggle-panel"),
            MenuItemModel::Separator,
            MenuItemModel::Predefined(PredefinedItem::Fullscreen),
        ],
    ));
    // ⌘W closes a tab in the renderer keymap; ⇧⌘W closes the window.
    let mut window = vec![
        action(i18n, MainTextKey::MenuCloseTab, "close-tab"),
        MenuItemModel::item(ID_CLOSE_WINDOW, i18n.t(MainTextKey::MenuCloseWindow)).with_accelerator(native_accelerator("window.close")),
        MenuItemModel::Separator,
        MenuItemModel::Predefined(PredefinedItem::Minimize),
    ];
    if darwin {
        window.push(MenuItemModel::Predefined(PredefinedItem::Maximize));
    }
    bar.push(MenuItemModel::submenu(i18n.t(MainTextKey::MenuWindow), window));
    bar.push(MenuItemModel::submenu(
        i18n.t(MainTextKey::MenuSession),
        vec![
            action(i18n, MainTextKey::MenuSessionInfo, "open-session-info"),
            action(i18n, MainTextKey::MenuExportHtml, "export-html").with_accelerator(native_accelerator("session.exportHtml")),
        ],
    ));
    bar.push(MenuItemModel::submenu(
        i18n.t(MainTextKey::MenuTools),
        vec![
            action(i18n, MainTextKey::MenuAgentHub, "open-agent-hub"),
            action(i18n, MainTextKey::MenuProviders, "open-providers"),
            action(i18n, MainTextKey::MenuModelPicker, "open-model-picker"),
            action(i18n, MainTextKey::MenuCapabilities, "open-capabilities"),
            MenuItemModel::Separator,
            action(i18n, MainTextKey::MenuRestartCore, "restart-sidecar"),
        ],
    ));
    let mut help = Vec::new();
    if !darwin {
        help.push(MenuItemModel::Predefined(PredefinedItem::About));
    }
    help.push(MenuItemModel::item(ID_DOCUMENTATION, i18n.t(MainTextKey::MenuDocumentation)));
    bar.push(MenuItemModel::submenu(i18n.t(MainTextKey::MenuHelp), help));
    bar
}

/// The renderer action behind a `menu:action:*` id.
pub(crate) fn action_of(id: &str) -> Option<&str> {
    id.strip_prefix(ACTION_PREFIX)
}

impl Desktop {
    /// Deliver a `menu:action` to the target window; with none open (macOS
    /// keep-running) spawn one and let the bridge hold the action until its
    /// page attaches. `focus` brings the window forward first (tray actions).
    pub(crate) fn send_menu_action(&self, ctx: &AppCtx, action: &str, payload: Option<Value>, focus: bool) {
        let mut body = json!({ "action": action });
        if let (Some(target), Some(extra)) = (body.as_object_mut(), payload.as_ref().and_then(Value::as_object)) {
            for (key, value) in extra {
                target.insert(key.clone(), value.clone());
            }
        }
        let target = match self.windows.target_window() {
            Some(id) => {
                if focus {
                    self.backend.focus(id);
                }
                id
            }
            None => match self.spawn_window_in(ctx, None, None, None) {
                Some(id) => id,
                None => return,
            },
        };
        runtime_log::note("unknown", format!("menu action {action} → window {target}"), json!({ "action": action, "winId": target.0 }));
        ctx.bridge.emit_to_window(target, MENU_ACTION_CHANNEL, body);
    }

    /// A menu item was clicked, in the app menu or the tray menu.
    pub(crate) fn on_menu_id(&self, ctx: &AppCtx, id: &str) {
        if let Some(action) = action_of(id) {
            self.send_menu_action(ctx, action, None, false);
            return;
        }
        match id {
            ID_NEW_WINDOW => {
                // A parallel window in the target window's project; with none to
                // inherit, the request for the GUI-owned workspace.
                let cwd = self.windows.target_window().and_then(|id| self.windows.record(id)).map(|record| record.cwd);
                self.spawn_window_in(ctx, cwd, None, None);
            }
            ID_CLOSE_WINDOW => {
                if let Some(id) = self.windows.target_window() {
                    self.backend.close(id);
                }
            }
            ID_DOCUMENTATION => {
                if let Err(error) = ctx.host.open_url(DOCUMENTATION_URL) {
                    runtime_log::note("unknown", format!("could not open the documentation: {error}"), json!({}));
                }
            }
            ID_CHECK_FOR_UPDATES => {
                survive("updater.check_now", || ctx.updater.check_now());
            }
            other => self.tray.on_menu_id(ctx, self, other),
        }
    }

    /// Install (or reinstall, after a language change) the application menu.
    pub(crate) fn install_app_menu(&self, ctx: &AppCtx) {
        let model = build_app_menu(&ctx.i18n, self.backend.platform());
        if let Err(error) = self.backend.set_app_menu(&model) {
            runtime_log::note("unknown", format!("could not install the application menu: {error}"), json!({}));
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri rendering of a menu model
// ---------------------------------------------------------------------------

/// Render a model into a Tauri menu. Every item carries its model id, so one
/// `on_menu_event` handler routes app-menu and tray clicks alike.
pub(crate) fn build_menu(app: &tauri::AppHandle, items: &[MenuItemModel]) -> Result<tauri::menu::Menu<tauri::Wry>, String> {
    let menu = tauri::menu::Menu::new(app).map_err(|error| error.to_string())?;
    for item in items {
        let built = build_item(app, item)?;
        menu.append(built.as_ref()).map_err(|error| error.to_string())?;
    }
    Ok(menu)
}

fn build_item(app: &tauri::AppHandle, item: &MenuItemModel) -> Result<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>, String> {
    use tauri::menu::{CheckMenuItem, MenuItem, PredefinedMenuItem, Submenu};
    let err = |error: tauri::Error| error.to_string();
    Ok(match item {
        MenuItemModel::Item { id, label, enabled, accelerator } => {
            let id = if id.is_empty() { format!("menu:noop:{label}") } else { id.clone() };
            Box::new(MenuItem::with_id(app, id, label, *enabled, accelerator.as_deref()).map_err(err)?)
        }
        MenuItemModel::Check { id, label, checked, enabled } => Box::new(CheckMenuItem::with_id(app, id, label, *enabled, *checked, None::<&str>).map_err(err)?),
        MenuItemModel::Separator => Box::new(PredefinedMenuItem::separator(app).map_err(err)?),
        MenuItemModel::Submenu { label, items } => {
            let submenu = Submenu::new(app, label, true).map_err(err)?;
            for child in items {
                let built = build_item(app, child)?;
                submenu.append(built.as_ref()).map_err(err)?;
            }
            Box::new(submenu)
        }
        MenuItemModel::Predefined(kind) => Box::new(
            match kind {
                PredefinedItem::Undo => PredefinedMenuItem::undo(app, None),
                PredefinedItem::Redo => PredefinedMenuItem::redo(app, None),
                PredefinedItem::Cut => PredefinedMenuItem::cut(app, None),
                PredefinedItem::Copy => PredefinedMenuItem::copy(app, None),
                PredefinedItem::Paste => PredefinedMenuItem::paste(app, None),
                PredefinedItem::SelectAll => PredefinedMenuItem::select_all(app, None),
                PredefinedItem::Minimize => PredefinedMenuItem::minimize(app, None),
                PredefinedItem::Maximize => PredefinedMenuItem::maximize(app, None),
                PredefinedItem::Fullscreen => PredefinedMenuItem::fullscreen(app, None),
                PredefinedItem::Quit => PredefinedMenuItem::quit(app, None),
                PredefinedItem::About => PredefinedMenuItem::about(
                    app,
                    None,
                    Some(tauri::menu::AboutMetadata {
                        name: Some(crate::product::PRODUCT_NAME.to_string()),
                        version: Some(app.package_info().version.to_string()),
                        ..Default::default()
                    }),
                ),
                PredefinedItem::Services => PredefinedMenuItem::services(app, None),
                PredefinedItem::Hide => PredefinedMenuItem::hide(app, None),
                PredefinedItem::HideOthers => PredefinedMenuItem::hide_others(app, None),
                PredefinedItem::ShowAll => PredefinedMenuItem::show_all(app, None),
            }
            .map_err(err)?,
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::Envelope;
    use crate::desktop::testing::{attach_recording_sink, harness, DesktopPort as _, Harness};
    use crate::i18n::MainLanguage;
    use crate::ports::WindowId;
    use crate::prefs::JsonStore;

    fn labels(items: &[MenuItemModel]) -> Vec<String> {
        items
            .iter()
            .filter_map(|item| match item {
                MenuItemModel::Submenu { label, .. } => Some(label.clone()),
                MenuItemModel::Item { label, .. } => Some(label.clone()),
                _ => None,
            })
            .collect()
    }

    fn find_item<'a>(items: &'a [MenuItemModel], wanted: &str) -> Option<&'a MenuItemModel> {
        items.iter().find_map(|item| match item {
            MenuItemModel::Item { id, .. } if id == wanted => Some(item),
            MenuItemModel::Submenu { items, .. } => find_item(items, wanted),
            _ => None,
        })
    }

    #[test]
    fn builds_the_menu_bar_in_the_current_language() {
        let dir = tempfile::tempdir().unwrap();
        let prefs = JsonStore::open(dir.path().join("prefs.json"));
        let i18n = MainI18n::new(prefs.clone(), None);
        let linux = build_app_menu(&i18n, Platform::Linux);
        assert_eq!(labels(&linux), vec!["File", "Edit", "View", "Window", "Session", "Tools", "Help"]);
        assert!(find_item(&linux, ID_CHECK_FOR_UPDATES).is_some());
        assert!(matches!(find_item(&linux, "menu:action:new-session"), Some(MenuItemModel::Item { accelerator: Some(a), .. }) if a == "CmdOrCtrl+N"));
        assert!(matches!(find_item(&linux, "menu:action:new-tab"), Some(MenuItemModel::Item { accelerator: None, .. })));
        assert!(matches!(find_item(&linux, ID_CLOSE_WINDOW), Some(MenuItemModel::Item { accelerator: Some(a), .. }) if a == "CmdOrCtrl+Shift+W"));
        assert_eq!(i18n.language(), MainLanguage::En);
        prefs.set("language", json!("vi")).unwrap();
        let vi = build_app_menu(&i18n, Platform::Darwin);
        assert_eq!(labels(&vi)[0], crate::product::PRODUCT_NAME);
        assert_eq!(labels(&vi)[1], "Tệp");
        assert_eq!(action_of("menu:action:open-jobs"), Some("open-jobs"));
        assert_eq!(action_of(ID_NEW_WINDOW), None);
    }

    fn menu_actions(items: &[MenuItemModel], out: &mut std::collections::BTreeSet<String>) {
        for item in items {
            match item {
                MenuItemModel::Item { id, .. } => {
                    if let Some(action) = action_of(id) {
                        out.insert(action.to_string());
                    }
                }
                MenuItemModel::Submenu { items, .. } => menu_actions(items, out),
                _ => {}
            }
        }
    }

    #[test]
    fn app_menu_offers_no_developer_actions_and_keeps_the_everyday_actions() {
        const EVERYDAY: [&str; 16] = [
            "close-tab",
            "export-html",
            "new-session",
            "new-tab",
            "open-agent-hub",
            "open-capabilities",
            "open-command-center",
            "open-hotkeys",
            "open-jobs",
            "open-model-picker",
            "open-providers",
            "open-session-info",
            "open-settings",
            "restart-sidecar",
            "toggle-panel",
            "toggle-sidebar",
        ];
        const DEVELOPER: [&str; 18] = [
            "new-chat-tab",
            "open-branch-picker",
            "open-context-report",
            "open-debug",
            "open-extensions",
            "open-git",
            "open-import",
            "open-inventory",
            "open-model-roles",
            "open-modes",
            "open-pr-center",
            "open-project",
            "open-session-tree",
            "open-share-session",
            "open-stats",
            "open-usage",
            "open-workspace-dirs",
            "handoff",
        ];
        let dir = tempfile::tempdir().unwrap();
        let i18n = MainI18n::new(JsonStore::open(dir.path().join("prefs.json")), None);
        for platform in [Platform::Linux, Platform::Darwin] {
            let mut actions = std::collections::BTreeSet::new();
            menu_actions(&build_app_menu(&i18n, platform), &mut actions);
            for removed in DEVELOPER {
                assert!(!actions.contains(removed), "{platform:?}: {removed} is still in the menu");
            }
            assert_eq!(actions, EVERYDAY.iter().map(|a| a.to_string()).collect(), "{platform:?}");
        }
    }

    #[test]
    fn menu_clicks_reach_the_target_window_or_open_one() {
        let Harness { ctx, desktop, fakes, backend } = harness(Platform::Linux);
        // Without a window the action spawns one and the bridge queues it until the page attaches.
        desktop.on_menu_id(&ctx, "menu:action:open-settings");
        let id = desktop.main_window().unwrap();
        let sink = attach_recording_sink(&ctx, id);
        let sent: Vec<Envelope> = sink.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].channel, "menu:action");
        assert_eq!(sent[0].payload, json!({ "action": "open-settings" }));

        desktop.on_menu_id(&ctx, ID_NEW_WINDOW);
        assert_eq!(desktop.records().len(), 2);
        assert_eq!(desktop.record(WindowId(2)).map(|r| r.cwd), Some("/work".into()));
        desktop.on_menu_id(&ctx, ID_DOCUMENTATION);
        assert!(fakes.host.log.calls().contains(&format!("open_url({DOCUMENTATION_URL})")));
        desktop.on_menu_id(&ctx, ID_CHECK_FOR_UPDATES);
        assert!(fakes.updater.log.calls().contains(&"check_now()".to_string()));
        desktop.on_menu_id(&ctx, ID_CLOSE_WINDOW);
        assert!(backend.log.calls().iter().any(|call| call.starts_with("close(")));
        desktop.rebuild_menu();
        assert!(backend.app_menu.lock().unwrap().is_some());
    }
}
