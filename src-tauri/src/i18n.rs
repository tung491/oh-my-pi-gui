//! Main-process strings, ported from `src/main/i18n.ts`. The language comes
//! from the `language` pref, then the system locale, then English. Keys are
//! typed so a missing translation is a compile error, and a test keeps every
//! TypeScript entry mirrored while Electron still ships (the shell adds the
//! few keys its own menus need).

use crate::prefs::JsonStore;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MainLanguage {
    En,
    Vi,
}

impl MainLanguage {
    pub fn code(self) -> &'static str {
        match self {
            MainLanguage::En => "en",
            MainLanguage::Vi => "vi",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "en" => Some(MainLanguage::En),
            "vi" => Some(MainLanguage::Vi),
            _ => None,
        }
    }

    /// The language a locale string such as `vi_VN.UTF-8` or `en-US` selects.
    pub fn from_locale(locale: &str) -> Self {
        if locale.to_lowercase().starts_with("vi") {
            MainLanguage::Vi
        } else {
            MainLanguage::En
        }
    }
}

macro_rules! main_text {
    ($($variant:ident => $key:literal, $en:literal, $vi:literal;)*) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum MainTextKey {
            $($variant,)*
        }

        impl MainTextKey {
            pub const ALL: &'static [MainTextKey] = &[$(MainTextKey::$variant,)*];

            /// The dotted key the TypeScript table uses.
            pub fn key(self) -> &'static str {
                match self {
                    $(MainTextKey::$variant => $key,)*
                }
            }

            /// Look a key up by its dotted name.
            pub fn from_key(key: &str) -> Option<Self> {
                match key {
                    $($key => Some(MainTextKey::$variant),)*
                    _ => None,
                }
            }

            fn text(self, language: MainLanguage) -> &'static str {
                match (self, language) {
                    $(
                        (MainTextKey::$variant, MainLanguage::En) => $en,
                        (MainTextKey::$variant, MainLanguage::Vi) => $vi,
                    )*
                }
            }
        }
    };
}

main_text! {
    DialogOpenProject => "dialog.openProject", "Open project", "Mở dự án";
    MenuAbout => "menu.about", "About Sai ATLAS", "Giới thiệu về Sai ATLAS";
    MenuAddToDictionary => "menu.addToDictionary", "Add to dictionary", "Thêm vào từ điển";
    MenuCloseTab => "menu.closeTab", "Close Tab", "Đóng thẻ";
    MenuCloseWindow => "menu.closeWindow", "Close Window", "Đóng cửa sổ";
    MenuCommandCenter => "menu.commandCenter", "Command Center", "Trung tâm lệnh";
    MenuCapabilities => "menu.capabilities", "Capabilities", "Khả năng";
    MenuCheckForUpdates => "menu.checkForUpdates", "Check for Updates…", "Kiểm tra cập nhật…";
    MenuImportSession => "menu.importSession", "Import Session", "Nhập phiên";
    MenuBranchPicker => "menu.branchPicker", "Branch from Message", "Tạo nhánh từ tin nhắn";
    MenuSessionTree => "menu.sessionTree", "Session Tree", "Cây phiên";
    MenuModelPicker => "menu.modelPicker", "Select Model", "Chọn mô hình";
    MenuUsage => "menu.usage", "Usage", "Mức sử dụng";
    MenuWorkspaceChanges => "menu.workspaceChanges", "Git Changes", "Thay đổi Git";
    MenuRestartCore => "menu.restartCore", "Restart OMP Core", "Khởi động lại OMP Core";
    MenuContextReport => "menu.contextReport", "Context Report", "Báo cáo ngữ cảnh";
    MenuDebugConsole => "menu.debugConsole", "Debug Console", "Bảng điều khiển gỡ lỗi";
    MenuDocumentation => "menu.documentation", "Documentation", "Tài liệu";
    MenuEdit => "menu.edit", "Edit", "Chỉnh sửa";
    MenuExportHtml => "menu.exportHtml", "Export HTML", "Xuất HTML";
    MenuFile => "menu.file", "File", "Tệp";
    MenuHandoff => "menu.handoff", "Handoff", "Bàn giao (Handoff)";
    MenuHelp => "menu.help", "Help", "Trợ giúp";
    MenuHotkeys => "menu.hotkeys", "Keyboard Shortcuts", "Phím tắt bàn phím";
    MenuJobs => "menu.jobs", "Jobs", "Tác vụ";
    MenuAgentHub => "menu.agentHub", "Agent Hub", "Trung tâm Agent";
    MenuExtensions => "menu.extensions", "Extensions", "Tiện ích mở rộng";
    MenuInventory => "menu.inventory", "Plugins & Resources", "Plugin & Tài nguyên";
    MenuModes => "menu.modes", "Modes", "Chế độ";
    MenuModelRoles => "menu.modelRoles", "Model Roles", "Vai trò mô hình";
    MenuNewChatTab => "menu.newChatTab", "New Chat Tab", "Thẻ trò chuyện mới";
    MenuNewSession => "menu.newSession", "New Session", "Phiên mới";
    MenuNewTab => "menu.newTab", "New Tab", "Thẻ mới";
    MenuNewWindow => "menu.newWindow", "New Window", "Cửa sổ mới";
    MenuOpenProject => "menu.openProject", "Open Project…", "Mở dự án…";
    MenuPrCenter => "menu.prCenter", "PR Center", "Trung tâm PR";
    MenuProviders => "menu.providers", "Providers & Login", "Nhà cung cấp & Đăng nhập";
    MenuSession => "menu.session", "Session", "Phiên";
    MenuSessionInfo => "menu.sessionInfo", "Session Info", "Thông tin phiên";
    MenuShareSession => "menu.shareSession", "Share Session", "Chia sẻ phiên";
    MenuSettings => "menu.settings", "Settings…", "Cài đặt…";
    MenuStats => "menu.stats", "Session Stats", "Thống kê phiên";
    MenuTogglePanel => "menu.togglePanel", "Toggle Panel", "Bật/Tắt bảng điều khiển";
    MenuToggleSidebar => "menu.toggleSidebar", "Toggle Sidebar", "Bật/Tắt thanh bên";
    MenuTools => "menu.tools", "Tools", "Công cụ";
    MenuView => "menu.view", "View", "Xem";
    MenuWindow => "menu.window", "Window", "Cửa sổ";
    MenuWorkspaceDirs => "menu.workspaceDirs", "Workspace Directories", "Thư mục không gian làm việc";
    QuitKeepWorking => "quit.keepWorking", "Keep working", "Tiếp tục làm việc";
    QuitQuitAnyway => "quit.quitAnyway", "Quit anyway", "Vẫn thoát";
    QuitWorkingBody => "quit.workingBody", "{working} of {total} sessions are still working in {windows} window(s). Quitting stops them and their agents.", "{working} trên {total} phiên vẫn đang hoạt động trong {windows} cửa sổ. Thoát sẽ dừng các phiên này và các agent của chúng.";
    QuitWorkingTitle => "quit.workingTitle", "Sessions are still running", "Các phiên vẫn đang chạy";
    RestartBody => "restart.body", "Sai ATLAS's installed files were replaced while it was running, so this window can no longer load them reliably. {working} of {total} sessions are still working.", "Các tệp cài đặt của Sai ATLAS đã bị thay thế khi đang chạy, do đó cửa sổ này không thể tải chúng ổn định nữa. {working} trên {total} phiên vẫn đang hoạt động.";
    RestartLater => "restart.later", "Later", "Để sau";
    RestartNow => "restart.now", "Restart now", "Khởi động lại ngay";
    RestartTitle => "restart.title", "Restart to finish updating", "Khởi động lại để hoàn tất cập nhật";
    UpdatesDownloadFailed => "updates.downloadFailed", "The installer download failed.", "Tải xuống trình cài đặt thất bại.";
    UpdatesHashMismatch => "updates.hashMismatch", "The downloaded installer failed SHA-512 verification and was removed.", "Trình cài đặt đã tải xuống không vượt qua xác minh SHA-512 và đã bị xóa.";
    UpdatesInstallFailed => "updates.installFailed", "The update could not be installed.", "Không thể cài đặt bản cập nhật.";
    UpdatesInstallerMissing => "updates.installerMissing", "This release does not include the required installer for this Mac.", "Bản phát hành này không bao gồm trình cài đặt cần thiết cho máy Mac này.";
    UpdatesNoResult => "updates.noResult", "Update check completed without a result.", "Kiểm tra cập nhật hoàn tất nhưng không có kết quả.";
    UpdatesOpenInstallerFailed => "updates.openInstallerFailed", "The installer was downloaded, but macOS could not open it.", "Trình cài đặt đã được tải xuống, nhưng macOS không thể mở tệp.";
    UpdatesUnsupportedArchitecture => "updates.unsupportedArchitecture", "This Mac architecture does not have a supported installer.", "Kiến trúc máy Mac này không có trình cài đặt được hỗ trợ.";
}

/// Fill `{name}` placeholders from `params`; unknown names stay as written.
pub fn fill_placeholders(template: &str, params: &[(&str, String)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('}') {
            Some(end) if end > 0 && after[..end].chars().all(|c| c.is_ascii_alphanumeric() || c == '_') => {
                let name = &after[..end];
                match params.iter().find(|(key, _)| *key == name) {
                    Some((_, value)) => out.push_str(value),
                    None => {
                        out.push('{');
                        out.push_str(name);
                        out.push('}');
                    }
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Translate `key` in `language`, with optional `{name}` parameters.
pub fn main_t(key: MainTextKey, language: MainLanguage, params: &[(&str, String)]) -> String {
    let text = key.text(language);
    if params.is_empty() {
        text.to_string()
    } else {
        fill_placeholders(text, params)
    }
}

/// The main-process translator bound to the prefs store and the system locale.
#[derive(Clone, Debug)]
pub struct MainI18n {
    prefs: JsonStore,
    system_locale: Option<String>,
}

impl MainI18n {
    pub fn new(prefs: JsonStore, system_locale: Option<String>) -> Self {
        Self { prefs, system_locale }
    }

    /// The `language` pref when it is `en` or `vi`, otherwise the system locale's language.
    pub fn language(&self) -> MainLanguage {
        if let Some(stored) = self.prefs.get_string("language").and_then(|value| MainLanguage::parse(&value)) {
            return stored;
        }
        self.system_locale.as_deref().map(MainLanguage::from_locale).unwrap_or(MainLanguage::En)
    }

    pub fn t(&self, key: MainTextKey) -> String {
        main_t(key, self.language(), &[])
    }

    pub fn t_with(&self, key: MainTextKey, params: &[(&str, String)]) -> String {
        main_t(key, self.language(), params)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const MAIN_I18N_TS: &str = include_str!("../../src/main/i18n.ts");

    fn ts_entries() -> Vec<(String, String, String)> {
        let pattern = regex::Regex::new(
            r#"(?s)"([a-zA-Z.]+)":\s*\{\s*en:\s*"((?:[^"\\]|\\.)*)",\s*vi:\s*"((?:[^"\\]|\\.)*)",?\s*\}"#,
        )
        .unwrap();
        let start = MAIN_I18N_TS.find("const TEXT").unwrap();
        pattern.captures_iter(&MAIN_I18N_TS[start..]).map(|c| (c[1].to_string(), c[2].to_string(), c[3].to_string())).collect()
    }

    /// Keys the Tauri shell needs that the Electron table never had (its menu has no such item).
    const RUST_ONLY_KEYS: &[MainTextKey] = &[MainTextKey::MenuCheckForUpdates];

    #[test]
    fn mirrors_every_text_key_in_the_typescript_table() {
        let entries = ts_entries();
        assert_eq!(entries.len() + RUST_ONLY_KEYS.len(), MainTextKey::ALL.len());
        for key in RUST_ONLY_KEYS {
            assert!(entries.iter().all(|(name, _, _)| name != key.key()), "{} is in the TS table too", key.key());
        }
        for (key, en, vi) in entries {
            let typed = MainTextKey::from_key(&key).unwrap_or_else(|| panic!("{key} is missing from MainTextKey"));
            assert_eq!(main_t(typed, MainLanguage::En, &[]), en, "{key} (en)");
            assert_eq!(main_t(typed, MainLanguage::Vi, &[]), vi, "{key} (vi)");
            assert_eq!(typed.key(), key);
        }
    }

    #[test]
    fn fills_placeholders_and_keeps_unknown_ones() {
        let text = main_t(
            MainTextKey::QuitWorkingBody,
            MainLanguage::En,
            &[("working", "2".into()), ("total", "5".into()), ("windows", "1".into())],
        );
        assert_eq!(text, "2 of 5 sessions are still working in 1 window(s). Quitting stops them and their agents.");
        assert_eq!(fill_placeholders("{a} and {b}", &[("a", "x".into())]), "x and {b}");
        assert_eq!(fill_placeholders("{ not a param", &[]), "{ not a param");
    }

    #[test]
    fn prefers_the_language_pref_over_the_system_locale() {
        let dir = tempfile::tempdir().unwrap();
        let prefs = JsonStore::open(dir.path().join("prefs.json"));
        let i18n = MainI18n::new(prefs.clone(), Some("vi_VN.UTF-8".into()));
        assert_eq!(i18n.language(), MainLanguage::Vi);
        prefs.set("language", json!("en")).unwrap();
        assert_eq!(i18n.language(), MainLanguage::En);
        prefs.set("language", json!("fr")).unwrap();
        assert_eq!(i18n.language(), MainLanguage::Vi);
        assert_eq!(MainI18n::new(prefs, None).language(), MainLanguage::En);
        assert_eq!(MainLanguage::from_locale("en-US"), MainLanguage::En);
    }
}
