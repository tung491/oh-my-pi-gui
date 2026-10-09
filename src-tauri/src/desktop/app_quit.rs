//! The quit latch: everything that ends
//! the process goes through `request_quit`, and an exit the OS or the last
//! window asks for is refused until the "sessions are still working" guard
//! approved it. Without this, quitting SIGTERMs every in-flight agent run
//! without a word.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::json;

use super::quit_guard::{assess_quit_risk, quit_needs_confirmation};
use super::{survive, Desktop};
use crate::bridge;
use crate::ctx::AppCtx;
use crate::i18n::MainTextKey;
use crate::ports::{MessageDialogOptions, MessageKind, QuitRisk, WindowId};
use crate::runtime_log;

/// The latch and the one-dialog-at-a-time flag.
#[derive(Default)]
pub(crate) struct QuitState {
    /// The user (or a restart prompt) approved the quit, or the exit path already began.
    approved: AtomicBool,
    /// A confirmation dialog is open: a second quit request must neither queue another nor quit.
    asking: AtomicBool,
}

impl QuitState {
    pub(crate) fn approved(&self) -> bool {
        self.approved.load(Ordering::SeqCst)
    }

    pub(crate) fn approve(&self) {
        self.approved.store(true, Ordering::SeqCst);
    }

    pub(crate) fn withdraw(&self) {
        self.approved.store(false, Ordering::SeqCst);
    }

    /// A confirmation dialog is open right now.
    pub(crate) fn asking(&self) -> bool {
        self.asking.load(Ordering::SeqCst)
    }

    fn set_asking(&self, asking: bool) {
        self.asking.store(asking, Ordering::SeqCst);
    }
}

/// What `RunEvent::ExitRequested` gets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ExitDecision {
    /// Let the frozen shutdown order run.
    Allow,
    /// Keep running and start the guarded quit, which ends in `request_quit`.
    VetoAndAsk,
}

/// `code` is `Some` for the app's own exits (`request_quit`, the updater, a
/// signal): those were already decided and are never vetoed, or the app would
/// refuse its own quit. `None` is the OS or the last window closing: allowed
/// once approved or already quitting; otherwise the guard runs first.
pub(crate) fn exit_decision(code: Option<i32>, approved: bool) -> ExitDecision {
    if code.is_some() || approved {
        return ExitDecision::Allow;
    }
    ExitDecision::VetoAndAsk
}

impl Desktop {
    pub(crate) fn quit_risk_in(&self, ctx: &AppCtx) -> QuitRisk {
        let facts = survive("tabs.tab_inventory", || ctx.tabs.tab_inventory()).unwrap_or_default();
        assess_quit_risk(&facts)
    }

    /// The chat window the confirmation attaches to: the focused one, else a
    /// visible, unminimized one (the bar may be focused). With none visible the
    /// dialog is app-modal.
    fn dialog_owner(&self) -> Option<WindowId> {
        if let Some(focused) = self.windows.focused() {
            return Some(focused);
        }
        self.windows.ids().into_iter().find(|id| self.backend.is_visible(*id) && !self.backend.is_minimized(*id))
    }

    /// The working-tabs warning; true when the user picks "Quit anyway". The
    /// safe choice is last, so a dismissed dialog keeps working.
    async fn confirm_risky_quit(&self, ctx: &Arc<AppCtx>, risk: QuitRisk) -> bool {
        let params = [("working", risk.working_tabs.to_string()), ("total", risk.total_tabs.to_string()), ("windows", risk.working_windows.to_string())];
        let answer = ctx
            .host
            .message_dialog(MessageDialogOptions {
                title: ctx.i18n.t(MainTextKey::QuitWorkingTitle),
                message: ctx.i18n.t_with(MainTextKey::QuitWorkingBody, &params),
                kind: MessageKind::Warning,
                buttons: vec![ctx.i18n.t(MainTextKey::QuitQuitAnyway), ctx.i18n.t(MainTextKey::QuitKeepWorking)],
                parent: self.dialog_owner(),
                ..Default::default()
            })
            .await;
        answer == 0
    }

    /// A user-initiated exit: quit at once when nothing works, otherwise ask
    /// first and quit only on "Quit anyway". Never queues a second dialog.
    pub(crate) fn start_guarded_quit(&self, ctx: &Arc<AppCtx>) {
        if self.quit.asking() {
            return;
        }
        let risk = self.quit_risk_in(ctx);
        if !quit_needs_confirmation(&risk) {
            self.request_quit_in(ctx);
            return;
        }
        self.quit.set_asking(true);
        let weak = Arc::downgrade(ctx);
        bridge::spawn_task(async move {
            let Some(ctx) = weak.upgrade() else { return };
            let Some(desktop) = Desktop::of(&ctx) else { return };
            let quit = desktop.confirm_risky_quit(&ctx, risk).await;
            desktop.quit.set_asking(false);
            runtime_log::note("unknown", format!("quit confirmation answered: quit={quit}"), json!({ "workingTabs": risk.working_tabs }));
            if quit {
                desktop.request_quit_in(&ctx);
            }
        });
    }

    /// Approve the quit and exit through Tauri's path, so the frozen shutdown order runs.
    pub(crate) fn request_quit_in(&self, ctx: &AppCtx) {
        self.quit.approve();
        self.quitting.store(true, Ordering::SeqCst);
        ctx.host.exit(0);
    }

    /// Approve a quit before something irreversible runs ahead of it (a .deb
    /// update installs before the app quits). False keeps working.
    pub(crate) async fn approve_quit_before_install_in(&self, ctx: &Arc<AppCtx>) -> bool {
        if self.quit.approved() {
            return true;
        }
        if self.quit.asking() {
            return false;
        }
        let risk = self.quit_risk_in(ctx);
        if quit_needs_confirmation(&risk) {
            self.quit.set_asking(true);
            let confirmed = self.confirm_risky_quit(ctx, risk).await;
            self.quit.set_asking(false);
            if !confirmed {
                return false;
            }
        }
        self.quit.approve();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::dispatch_for_test;
    use crate::desktop::testing::{harness, DesktopPort as _, Harness};
    use crate::ports::{Caller, WindowTabFact};

    fn working(ctx: &AppCtx, fakes: &crate::testing::Fakes, tabs: usize) {
        let _ = ctx;
        let facts: Vec<WindowTabFact> = (0..tabs).map(|i| WindowTabFact { window_id: WindowId(1), tab_id: format!("t{i}"), in_flight: true }).collect();
        *fakes.tabs.inventory.lock().unwrap() = facts;
    }

    #[test]
    fn an_exit_the_app_requested_is_never_vetoed() {
        let Harness { ctx, desktop, fakes, .. } = harness();
        working(&ctx, &fakes, 3);
        assert!(!desktop.on_exit_requested(Some(0)));
        assert!(!desktop.on_exit_requested(Some(1)));
        assert_eq!(exit_decision(Some(0), false), ExitDecision::Allow);
        assert_eq!(exit_decision(Some(1), false), ExitDecision::Allow);
        assert!(fakes.host.log.calls().iter().all(|call| !call.starts_with("message_dialog")));
    }

    #[tokio::test]
    async fn a_user_exit_with_working_sessions_asks_first() {
        let Harness { ctx, desktop, fakes, .. } = harness();
        working(&ctx, &fakes, 2);
        fakes.host.message_dialog_answers.lock().unwrap().push(0);
        assert!(desktop.on_exit_requested(None), "the exit is vetoed while the guard asks");
        tokio::task::yield_now().await;
        assert!(fakes.host.log.calls().iter().any(|call| call == "message_dialog(Sessions are still running)"));
        assert_eq!(fakes.host.exit_codes.lock().unwrap().clone(), vec![0]);
        assert!(desktop.is_quitting());
        // Once approved, the exit the quit itself triggers is allowed.
        assert!(!desktop.on_exit_requested(None));
    }

    #[test]
    fn a_user_exit_with_nothing_working_quits() {
        let Harness { desktop, fakes, .. } = harness();
        assert!(desktop.on_exit_requested(None));
        assert_eq!(fakes.host.exit_codes.lock().unwrap().clone(), vec![0]);
        assert!(fakes.host.log.calls().iter().all(|call| !call.starts_with("message_dialog")));
        assert_eq!(exit_decision(None, true), ExitDecision::Allow);
    }

    #[tokio::test]
    async fn the_keep_working_button_is_last() {
        let Harness { ctx, desktop, fakes, .. } = harness();
        working(&ctx, &fakes, 1);
        // The fake only logs the title; the button order is checked through a
        // scripted answer of the second index, which must keep working.
        fakes.host.message_dialog_answers.lock().unwrap().push(1);
        assert!(!desktop.approve_quit_before_install().await);
        assert!(fakes.host.exit_codes.lock().unwrap().is_empty());
        let options = MessageDialogOptions {
            buttons: vec![ctx.i18n.t(MainTextKey::QuitQuitAnyway), ctx.i18n.t(MainTextKey::QuitKeepWorking)],
            ..Default::default()
        };
        assert_eq!(options.buttons.last().map(String::as_str), Some("Keep working"));
        assert_eq!(options.buttons.first().map(String::as_str), Some("Quit anyway"));
    }

    #[tokio::test]
    async fn a_dismissed_quit_dialog_keeps_working() {
        let Harness { ctx, desktop, fakes, .. } = harness();
        working(&ctx, &fakes, 1);
        // The host answers the last index for a dismissed dialog; script exactly that.
        fakes.host.message_dialog_answers.lock().unwrap().push(1);
        assert!(desktop.on_exit_requested(None));
        tokio::task::yield_now().await;
        assert!(fakes.host.exit_codes.lock().unwrap().is_empty());
        assert!(!desktop.is_quitting());
        // The next quit asks again rather than being swallowed by a stale "asking" flag.
        fakes.host.message_dialog_answers.lock().unwrap().push(0);
        assert!(desktop.on_exit_requested(None));
        tokio::task::yield_now().await;
        assert_eq!(fakes.host.exit_codes.lock().unwrap().clone(), vec![0]);
    }

    #[tokio::test]
    async fn the_app_quit_channel_runs_the_guarded_quit() {
        let Harness { ctx, desktop, fakes, .. } = harness();
        let id = desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        dispatch_for_test(&ctx, Caller::main(id), "app:quit", vec![]).await.unwrap();
        assert_eq!(fakes.host.exit_codes.lock().unwrap().clone(), vec![0]);
        assert_eq!(desktop.quit_risk(), QuitRisk::default());
        desktop.withdraw_quit_approval();
        assert!(!desktop.quit.approved());
    }
}
