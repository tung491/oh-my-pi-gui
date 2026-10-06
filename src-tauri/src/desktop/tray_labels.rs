//! Pure tray vocabulary, ported from `src/main/tray-labels.ts`: every string
//! the native menu shows, plus the signature that decides whether the menu has
//! to be rebuilt.

use serde::{Deserialize, Serialize};

use crate::i18n::MainLanguage;
use crate::product::PRODUCT_NAME;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TrayStatus {
    Idle,
    Streaming,
    Waiting,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum TrayApprovalMode {
    AlwaysAsk,
    Write,
    Yolo,
}

impl TrayApprovalMode {
    /// The wire spelling (`TrayState.approvalMode`).
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            TrayApprovalMode::AlwaysAsk => "always-ask",
            TrayApprovalMode::Write => "write",
            TrayApprovalMode::Yolo => "yolo",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrayWorkspace {
    pub cwd: String,
    pub name: String,
    pub current: bool,
}

/// `TrayState`: the snapshot the renderer pushes to build the tray menu.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrayState {
    pub status: TrayStatus,
    pub language: MainLanguage,
    pub cwd: Option<String>,
    pub project_name: String,
    pub model_id: Option<String>,
    pub thinking_level: String,
    pub fast_mode: bool,
    pub approval_mode: TrayApprovalMode,
    pub context_percent: Option<f64>,
    pub context_tokens: Option<f64>,
    pub workspaces: Vec<TrayWorkspace>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TrayLabelKey {
    ShowHide,
    Quit,
    NewSession,
    Workspaces,
    QuickStart,
    QuickConfig,
    FastMode,
    Thinking,
    Approval,
    Language,
    ApprovalYolo,
    ApprovalWrite,
    ApprovalAsk,
    Context,
    Tokens,
    NoModel,
    StatusIdle,
    StatusStreaming,
    StatusWaiting,
    StatusError,
}

/// Tray-label strings, translated in the shell (the renderer reports the language).
pub(crate) fn t(lang: MainLanguage, key: TrayLabelKey) -> &'static str {
    let (vi, en) = match key {
        TrayLabelKey::ShowHide => ("Hiện / Ẩn", "Show / Hide"),
        TrayLabelKey::Quit => ("Thoát", "Quit"),
        TrayLabelKey::NewSession => ("Phiên mới", "New Session"),
        TrayLabelKey::Workspaces => ("Chuyển không gian làm việc", "Switch Workspace"),
        TrayLabelKey::QuickStart => ("Khởi động nhanh", "Quick Start"),
        TrayLabelKey::QuickConfig => ("Cấu hình nhanh", "Quick Config"),
        TrayLabelKey::FastMode => ("Chế độ nhanh", "Fast Mode"),
        TrayLabelKey::Thinking => ("Mức suy nghĩ", "Thinking"),
        TrayLabelKey::Approval => ("Phê duyệt công cụ", "Tool Approval"),
        TrayLabelKey::Language => ("Ngôn ngữ", "Language"),
        TrayLabelKey::ApprovalYolo => ("Toàn quyền truy cập", "Full access"),
        TrayLabelKey::ApprovalWrite => ("Tự động chỉnh sửa", "Auto-edit"),
        TrayLabelKey::ApprovalAsk => ("Hỏi mỗi lần", "Ask every time"),
        TrayLabelKey::Context => ("Ngữ cảnh", "Context"),
        TrayLabelKey::Tokens => ("tokens", "tokens"),
        TrayLabelKey::NoModel => ("Chưa chọn mô hình", "No model"),
        TrayLabelKey::StatusIdle => ("Rảnh", "Idle"),
        TrayLabelKey::StatusStreaming => ("Đang chạy", "Running"),
        TrayLabelKey::StatusWaiting => ("Chờ phản hồi", "Needs input"),
        TrayLabelKey::StatusError => ("Lỗi", "Error"),
    };
    match lang {
        MainLanguage::Vi => vi,
        MainLanguage::En => en,
    }
}

/// Which run state to show; the aggregate across windows, never per-window.
pub(crate) fn status_label(lang: MainLanguage, status: TrayStatus) -> &'static str {
    match status {
        TrayStatus::Error => t(lang, TrayLabelKey::StatusError),
        TrayStatus::Streaming => t(lang, TrayLabelKey::StatusStreaming),
        TrayStatus::Waiting => t(lang, TrayLabelKey::StatusWaiting),
        TrayStatus::Idle => t(lang, TrayLabelKey::StatusIdle),
    }
}

/// Collapse per-window statuses to one: any error > streaming > waiting > idle.
pub(crate) fn aggregate_tray_status<'a>(states: impl IntoIterator<Item = &'a TrayState>) -> TrayStatus {
    // Precedence is app-global, so a single early return on the first window's
    // streaming would hide a later window's error.
    let mut streaming = false;
    let mut waiting = false;
    for state in states {
        match state.status {
            TrayStatus::Error => return TrayStatus::Error,
            TrayStatus::Streaming => streaming = true,
            TrayStatus::Waiting => waiting = true,
            TrayStatus::Idle => {}
        }
    }
    if streaming {
        TrayStatus::Streaming
    } else if waiting {
        TrayStatus::Waiting
    } else {
        TrayStatus::Idle
    }
}

pub(crate) fn approval_label(lang: MainLanguage, mode: TrayApprovalMode) -> &'static str {
    match mode {
        TrayApprovalMode::Yolo => t(lang, TrayLabelKey::ApprovalYolo),
        TrayApprovalMode::Write => t(lang, TrayLabelKey::ApprovalWrite),
        TrayApprovalMode::AlwaysAsk => t(lang, TrayLabelKey::ApprovalAsk),
    }
}

pub(crate) fn format_tokens(n: f64) -> String {
    if n >= 1_000_000.0 {
        format!("{:.1}M", n / 1_000_000.0)
    } else if n >= 1_000.0 {
        format!("{:.1}k", n / 1_000.0)
    } else {
        format!("{n}")
    }
}

/// Hover text: the icon itself stays a static template mark by design.
pub(crate) fn tray_tooltip(state: Option<&TrayState>) -> String {
    match state {
        None => PRODUCT_NAME.to_string(),
        Some(state) => format!("{PRODUCT_NAME} — {} · {}", state.project_name, status_label(state.language, state.status)),
    }
}

/// Everything a rebuilt menu can differ in, as one string. Context share is
/// bucketed to what the menu prints (whole percent, rendered token string) so
/// token-level streaming stays out.
pub(crate) fn menu_signature(state: &TrayState) -> String {
    let percent = state.context_percent.map(|value| format!("{}", value.round() as i64)).unwrap_or_else(|| "—".into());
    let tokens = state.context_tokens.map(format_tokens).unwrap_or_else(|| "—".into());
    let workspaces: Vec<String> =
        state.workspaces.iter().map(|ws| format!("{}\u{0}{}\u{0}{}", ws.cwd, ws.name, ws.current)).collect();
    [
        state.language.code().to_string(),
        serde_json::to_value(state.status).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default(),
        state.project_name.clone(),
        state.model_id.clone().unwrap_or_else(|| "—".into()),
        state.thinking_level.clone(),
        state.fast_mode.to_string(),
        state.approval_mode.as_str().to_string(),
        percent,
        tokens,
        workspaces.join("\u{1}"),
    ]
    .join("\u{2}")
}

#[cfg(test)]
pub(crate) fn sample_state() -> TrayState {
    TrayState {
        status: TrayStatus::Idle,
        language: MainLanguage::En,
        cwd: Some("/w/alpha".into()),
        project_name: "alpha".into(),
        model_id: Some("gpt-x".into()),
        thinking_level: "medium".into(),
        fast_mode: false,
        approval_mode: TrayApprovalMode::Write,
        context_percent: Some(42.3),
        context_tokens: Some(12345.0),
        workspaces: vec![TrayWorkspace { cwd: "/w/alpha".into(), name: "alpha".into(), current: true }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(update: impl FnOnce(&mut TrayState)) -> TrayState {
        let mut state = sample_state();
        update(&mut state);
        state
    }

    #[test]
    fn names_the_run_state_in_the_hover_text_in_the_language_the_renderer_reports() {
        assert_eq!(tray_tooltip(Some(&state(|s| s.status = TrayStatus::Streaming))), "Sai ATLAS — alpha · Running");
        assert_eq!(
            tray_tooltip(Some(&state(|s| {
                s.status = TrayStatus::Waiting;
                s.language = MainLanguage::Vi;
            }))),
            "Sai ATLAS — alpha · Chờ phản hồi"
        );
        assert!(tray_tooltip(Some(&state(|s| s.status = TrayStatus::Error))).contains("Error"));
        assert!(tray_tooltip(Some(&state(|_| {}))).contains("Idle"));
    }

    #[test]
    fn labels_the_project_before_any_renderer_state_arrives() {
        assert_eq!(tray_tooltip(None), PRODUCT_NAME);
    }

    #[test]
    fn maps_each_approval_mode_to_the_label_the_header_shows() {
        assert_eq!(approval_label(MainLanguage::En, TrayApprovalMode::Yolo), "Full access");
        assert_eq!(approval_label(MainLanguage::En, TrayApprovalMode::Write), "Auto-edit");
        assert_eq!(approval_label(MainLanguage::En, TrayApprovalMode::AlwaysAsk), "Ask every time");
        assert_eq!(approval_label(MainLanguage::Vi, TrayApprovalMode::AlwaysAsk), "Hỏi mỗi lần");
    }

    #[test]
    fn renders_token_counts_at_the_precision_the_menu_prints() {
        assert_eq!(format_tokens(999.0), "999");
        assert_eq!(format_tokens(12_345.0), "12.3k");
        assert_eq!(format_tokens(2_400_000.0), "2.4M");
    }

    #[test]
    fn holds_the_menu_still_for_pushes_that_change_no_visible_label() {
        let nudged = state(|s| {
            s.context_percent = Some(42.4);
            s.context_tokens = Some(12_348.0);
        });
        assert_eq!(menu_signature(&nudged), menu_signature(&sample_state()));
    }

    #[test]
    fn rebuilds_when_a_label_the_user_can_read_changes() {
        let base = menu_signature(&sample_state());
        assert_ne!(menu_signature(&state(|s| s.status = TrayStatus::Error)), base);
        assert_ne!(menu_signature(&state(|s| s.model_id = Some("gpt-y".into()))), base);
        assert_ne!(menu_signature(&state(|s| s.thinking_level = "high".into())), base);
        assert_ne!(menu_signature(&state(|s| s.fast_mode = true)), base);
        assert_ne!(menu_signature(&state(|s| s.approval_mode = TrayApprovalMode::Yolo)), base);
        assert_ne!(menu_signature(&state(|s| s.language = MainLanguage::Vi)), base);
        assert_ne!(menu_signature(&state(|s| s.project_name = "beta".into())), base);
        // Crossing the printed bucket (42% → 43%) is a visible change.
        assert_ne!(menu_signature(&state(|s| s.context_percent = Some(42.6))), base);
    }

    #[test]
    fn rebuilds_when_a_workspace_entry_changes_even_under_a_stable_name() {
        let moved = state(|s| s.workspaces = vec![TrayWorkspace { cwd: "/w/other".into(), name: "alpha".into(), current: false }]);
        assert_ne!(menu_signature(&moved), menu_signature(&sample_state()));
    }

    #[test]
    fn keeps_unknown_context_capacity_distinct_from_zero() {
        let unknown = state(|s| {
            s.context_percent = None;
            s.context_tokens = None;
        });
        let zero = state(|s| {
            s.context_percent = Some(0.0);
            s.context_tokens = Some(0.0);
        });
        assert_ne!(menu_signature(&unknown), menu_signature(&zero));
    }

    #[test]
    fn gives_every_status_its_own_text() {
        let labels: std::collections::HashSet<&str> = [TrayStatus::Idle, TrayStatus::Streaming, TrayStatus::Waiting, TrayStatus::Error]
            .into_iter()
            .map(|status| status_label(MainLanguage::En, status))
            .collect();
        assert_eq!(labels.len(), 4);
    }

    #[test]
    fn lets_the_loudest_window_win_regardless_of_push_order() {
        let windows = |statuses: &[TrayStatus]| statuses.iter().map(|status| state(|s| s.status = *status)).collect::<Vec<_>>();
        // A streaming window pushed before an erroring one must not mask the error.
        assert_eq!(aggregate_tray_status(&windows(&[TrayStatus::Streaming, TrayStatus::Error])), TrayStatus::Error);
        assert_eq!(aggregate_tray_status(&windows(&[TrayStatus::Idle, TrayStatus::Error])), TrayStatus::Error);
        assert_eq!(aggregate_tray_status(&windows(&[TrayStatus::Waiting, TrayStatus::Streaming])), TrayStatus::Streaming);
        assert_eq!(aggregate_tray_status(&windows(&[TrayStatus::Idle, TrayStatus::Waiting])), TrayStatus::Waiting);
    }

    /// The renderer action behind every clickable tray item, submenus included.
    fn tray_actions(state: Option<&TrayState>) -> Vec<String> {
        use crate::desktop::windows::MenuItemModel;
        fn walk(items: &[MenuItemModel], out: &mut Vec<String>) {
            for item in items {
                match item {
                    MenuItemModel::Item { id, .. } | MenuItemModel::Check { id, .. } => {
                        if let Some(rest) = id.strip_prefix("tray:") {
                            out.push(rest.split(':').next().unwrap_or(rest).to_string());
                        }
                    }
                    MenuItemModel::Submenu { items, .. } => walk(items, out),
                    MenuItemModel::Separator | MenuItemModel::Predefined(_) => {}
                }
            }
        }
        let mut out = Vec::new();
        walk(&crate::desktop::tray::build_tray_menu(state, MainLanguage::En), &mut out);
        out
    }

    #[test]
    fn tray_offers_no_developer_actions() {
        let actions = [tray_actions(Some(&sample_state())), tray_actions(None)].concat();
        assert!(actions.contains(&"new-session".to_string()));
        for removed in ["open-usage", "open-project", "handoff"] {
            assert!(!actions.contains(&removed.to_string()), "{removed} is still in the tray");
        }
    }

    #[test]
    fn tray_offers_no_approval_choice() {
        let actions = [tray_actions(Some(&sample_state())), tray_actions(None)].concat();
        assert!(!actions.contains(&"set-approval".to_string()));
        let menu = crate::desktop::tray::build_tray_menu(Some(&sample_state()), MainLanguage::En);
        let read_only = menu.iter().any(|item| {
            matches!(item, crate::desktop::windows::MenuItemModel::Item { label, enabled: false, .. } if label == "Fast Mode: — · Tool Approval: Auto-edit")
        });
        assert!(read_only, "the read-only approval label is missing");
    }

    #[test]
    fn is_idle_with_nothing_to_aggregate() {
        assert_eq!(aggregate_tray_status(&[]), TrayStatus::Idle);
        assert_eq!(aggregate_tray_status(&[sample_state()]), TrayStatus::Idle);
    }
}
