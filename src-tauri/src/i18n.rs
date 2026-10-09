//! Native-shell strings (menus, dialogs, tray, updater). The language comes
//! from the `language` pref, then the system locale, then English. Keys are
//! typed so a missing translation is a compile error.

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
    MenuModelPicker => "menu.modelPicker", "Select Model", "Chọn mô hình";
    MenuRestartCore => "menu.restartCore", "Restart the assistant", "Khởi động lại trợ lý";
    MenuDocumentation => "menu.documentation", "Documentation", "Tài liệu";
    MenuEdit => "menu.edit", "Edit", "Chỉnh sửa";
    MenuExportHtml => "menu.exportHtml", "Export HTML", "Xuất HTML";
    MenuFile => "menu.file", "File", "Tệp";
    MenuHelp => "menu.help", "Help", "Trợ giúp";
    MenuHotkeys => "menu.hotkeys", "Keyboard Shortcuts", "Phím tắt bàn phím";
    MenuJobs => "menu.jobs", "Jobs", "Tác vụ";
    MenuAgentHub => "menu.agentHub", "Agent Hub", "Trung tâm Agent";
    MenuNewSession => "menu.newSession", "New Session", "Phiên mới";
    MenuNewTab => "menu.newTab", "New Tab", "Thẻ mới";
    MenuNewWindow => "menu.newWindow", "New Window", "Cửa sổ mới";
    MenuProviders => "menu.providers", "Providers & Login", "Nhà cung cấp & Đăng nhập";
    MenuSession => "menu.session", "Session", "Phiên";
    MenuSessionInfo => "menu.sessionInfo", "Session Info", "Thông tin phiên";
    MenuSettings => "menu.settings", "Settings…", "Cài đặt…";
    MenuTogglePanel => "menu.togglePanel", "Toggle Panel", "Bật/Tắt bảng điều khiển";
    MenuToggleSidebar => "menu.toggleSidebar", "Toggle Sidebar", "Bật/Tắt thanh bên";
    MenuTools => "menu.tools", "Tools", "Công cụ";
    MenuView => "menu.view", "View", "Xem";
    MenuWindow => "menu.window", "Window", "Cửa sổ";
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
    UpdatesInstallerMissing => "updates.installerMissing", "This release does not include the required installer for this system.", "Bản phát hành này không bao gồm trình cài đặt cần thiết cho hệ thống này.";
    UpdatesNoResult => "updates.noResult", "Update check completed without a result.", "Kiểm tra cập nhật hoàn tất nhưng không có kết quả.";
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
