//! App lifecycle and close ordering (the last window closing and the
//! closed-window subscribers) so a
//! multi-window session restores in full and no hidden process stays behind.

use std::sync::Arc;

use serde_json::json;

use super::quit_guard::quit_needs_confirmation;
use super::windows::WinEvent;
use super::Desktop;
use crate::ctx::AppCtx;
use crate::ports::WindowId;
use crate::runtime_log;

impl Desktop {
    /// One of our windows reported an event. Returns true when a close must be prevented.
    pub(crate) fn on_window_event(&self, ctx: &Arc<AppCtx>, win_id: WindowId, event: WinEvent) -> bool {
        if win_id == WindowId::QUICK_ENTRY {
            self.on_quick_entry_window_event(ctx, event);
            return false;
        }
        match event {
            WinEvent::Moved | WinEvent::Resized => self.note_window_geometry(win_id),
            WinEvent::CloseRequested => {
                // The geometry is read now, on the reporting thread, and written at once.
                self.note_window_geometry(win_id);
                self.persist_window_state(ctx, win_id, None);
                // Before the shortcut release: "Keep working" leaves this window
                // open, and it must keep the quick-entry suspension it holds.
                if self.guard_last_window_close(ctx, win_id) {
                    return true;
                }
                self.shortcut_release_window(win_id);
            }
            WinEvent::Destroyed => self.on_window_destroyed(ctx, win_id),
            WinEvent::Focused(focused) => {
                self.windows.note_focus(win_id, focused);
                if focused {
                    self.quick_entry.note_startup_window_shown(win_id, self);
                }
            }
        }
        false
    }

    /// Closing the last chat window quits the app, and its
    /// tabs are released (their sidecars killed) as soon as the window is
    /// destroyed, before Tauri's `ExitRequested` arrives. The working-sessions
    /// guard therefore runs here, while the window and its tabs still exist.
    /// True vetoes the close and starts the guarded quit (the tray's Quit flow):
    /// "Quit anyway" exits, "Keep working" leaves the window open.
    fn guard_last_window_close(&self, ctx: &Arc<AppCtx>, win_id: WindowId) -> bool {
        if self.is_quitting_latched() || self.quit.approved() {
            return false;
        }
        if self.windows.ids() != vec![win_id] {
            return false;
        }
        if !self.quit.asking() && !quit_needs_confirmation(&self.quit_risk_in(ctx)) {
            // Nothing works: the window closes and `Destroyed` quits, as before.
            return false;
        }
        // A no-op while a confirmation is already open: the close stays vetoed.
        self.start_guarded_quit(ctx);
        true
    }

    /// A window is gone: notify the subscribers while its record still exists,
    /// drop the record, then let the bridge forget it. Then the prompts it held
    /// go back to the bar, its tray and progress snapshots leave the aggregate,
    /// the saved session is rewritten (unless quitting), and closing the last
    /// chat window quits the app.
    fn on_window_destroyed(&self, ctx: &Arc<AppCtx>, win_id: WindowId) {
        if let Some(record) = self.windows.record(win_id) {
            // Clone the listener list (each entry is an `Arc`, so this is cheap) and
            // drop the guard before calling any of them: a `for` loop driven straight
            // off the guard keeps it locked for every iteration, and a listener that
            // registers another one (`on_window_closed`) would deadlock on itself.
            let listeners = super::lock(&self.closed_listeners).clone();
            for listener in listeners.iter() {
                listener(&record);
            }
        }
        self.windows.remove(win_id);
        ctx.bridge.unregister_window(win_id);
        self.quick_entry.on_window_closed(ctx, win_id, self);
        self.shortcut_release_window(win_id);
        self.tray.forget_window(ctx, self, win_id);
        self.forget_progress(win_id);
        self.persist_tab_layouts(ctx);
        if self.windows.count() == 0 && !self.is_quitting_latched() {
            self.quick_entry.destroy_window(self);
            self.request_quit_in(ctx);
        }
    }

    /// The last step of the frozen shutdown order: the bar and the tray go;
    /// chat windows close with the app.
    pub(crate) fn shutdown_in(&self) {
        self.quick_entry.destroy_window(self);
        self.tray.destroy(self);
        runtime_log::note("unknown", "desktop surfaces destroyed", json!({ "windows": self.windows.count() }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::testing::{harness, Backend as _, DesktopPort as _, Harness};
    use crate::ports::{Caller, PersistedTabLayout, WindowRecord, WindowTabFact};
    use std::sync::Mutex;

    fn layout(cwd: &str) -> PersistedTabLayout {
        PersistedTabLayout {
            version: 1,
            tabs: vec![crate::ports::PersistedTabDescriptor {
                cwd: cwd.into(),
                session_path: None,
                kind: crate::ports::SessionKind::Agent,
                worktree: None,
                placeholder: None,
                title: None,
            }],
            active_index: 0,
            split: None,
        }
    }

    #[test]
    fn quit_with_three_windows_keeps_three_saved_layouts() {
        let Harness { ctx, desktop, fakes, backend } = harness();
        let ids: Vec<WindowId> = ["/w/alpha", "/w/beta", "/work"].iter().map(|cwd| desktop.spawn_window(Some(cwd.to_string()), None, None).unwrap()).collect();
        for (id, cwd) in ids.iter().zip(["/w/alpha", "/w/beta", "/work"]) {
            fakes.tabs.layouts.lock().unwrap().insert(*id, layout(cwd));
        }
        desktop.persist_tab_layouts(&ctx);
        assert_eq!(ctx.prefs.get("tabLayouts").and_then(|v| v.as_array().map(Vec::len)), Some(3));

        // The frozen shutdown order sets the latch first; the windows then close one by one.
        desktop.mark_quitting();
        for id in &ids {
            fakes.tabs.layouts.lock().unwrap().remove(id);
            backend.destroy(*id);
            desktop.on_window_event(&ctx, *id, WinEvent::Destroyed);
        }
        assert_eq!(ctx.prefs.get("tabLayouts").and_then(|v| v.as_array().map(Vec::len)), Some(3));
        assert!(desktop.records().is_empty());
    }

    fn seed_working_tab(fakes: &crate::testing::Fakes, window_id: WindowId) {
        *fakes.tabs.inventory.lock().unwrap() = vec![WindowTabFact { window_id, tab_id: "t0".into(), in_flight: true }];
    }

    fn dialog_requested(fakes: &crate::testing::Fakes) -> bool {
        fakes.host.log.calls().iter().any(|call| call == "message_dialog(Sessions are still running)")
    }

    #[test]
    fn closing_the_last_window_quits_on_linux() {
        let Harness { ctx, desktop, fakes, backend } = harness();
        let id = desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        desktop.quick_entry.show(&ctx, &desktop);
        assert!(backend.exists(WindowId::QUICK_ENTRY));
        // The runtime order: the close request first, then the window is destroyed.
        assert!(!desktop.on_window_event(&ctx, id, WinEvent::CloseRequested), "with nothing working the close goes ahead");
        assert!(!dialog_requested(&fakes));
        backend.destroy(id);
        desktop.on_window_event(&ctx, id, WinEvent::Destroyed);
        assert!(!backend.exists(WindowId::QUICK_ENTRY), "the hidden bar must not keep the process alive");
        assert_eq!(fakes.host.exit_codes.lock().unwrap().clone(), vec![0]);
        assert!(desktop.is_quitting());
        assert!(!dialog_requested(&fakes));
    }

    #[tokio::test]
    async fn closing_the_last_window_with_a_working_tab_asks_first() {
        let Harness { ctx, desktop, fakes, backend } = harness();
        let id = desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        seed_working_tab(&fakes, id);
        let closed = Arc::new(Mutex::new(Vec::new()));
        let sink = closed.clone();
        desktop.on_window_closed(Box::new(move |record| sink.lock().unwrap().push(record.id)));

        // "Keep working" (also what a dismissal answers): the window and its tabs stay.
        fakes.host.message_dialog_answers.lock().unwrap().push(1);
        assert!(desktop.on_window_event(&ctx, id, WinEvent::CloseRequested), "the close is vetoed while the guard asks");
        tokio::task::yield_now().await;
        assert!(dialog_requested(&fakes), "the working-sessions dialog is shown");
        assert!(backend.exists(id));
        assert!(desktop.record(id).is_some());
        assert!(closed.lock().unwrap().is_empty(), "the window's tabs are not released");
        assert!(fakes.host.exit_codes.lock().unwrap().is_empty());
        assert!(!desktop.is_quitting());

        // "Quit anyway": the app exits with 0 through the guarded quit.
        fakes.host.message_dialog_answers.lock().unwrap().push(0);
        assert!(desktop.on_window_event(&ctx, id, WinEvent::CloseRequested));
        tokio::task::yield_now().await;
        assert_eq!(fakes.host.exit_codes.lock().unwrap().clone(), vec![0]);
        assert!(desktop.is_quitting());
        // The shutdown then closes the window; that close neither asks nor exits again.
        let dialogs = fakes.host.log.calls().iter().filter(|call| call.starts_with("message_dialog")).count();
        assert!(!desktop.on_window_event(&ctx, id, WinEvent::CloseRequested));
        backend.destroy(id);
        desktop.on_window_event(&ctx, id, WinEvent::Destroyed);
        assert_eq!(fakes.host.log.calls().iter().filter(|call| call.starts_with("message_dialog")).count(), dialogs);
        assert_eq!(fakes.host.exit_codes.lock().unwrap().clone(), vec![0]);
    }

    #[test]
    fn closing_a_window_that_is_not_the_last_never_asks() {
        let Harness { ctx, desktop, fakes, backend } = harness();
        let first = desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        let second = desktop.spawn_window(Some("/w/beta".into()), None, None).unwrap();
        seed_working_tab(&fakes, first);
        assert!(!desktop.on_window_event(&ctx, first, WinEvent::CloseRequested));
        backend.destroy(first);
        desktop.on_window_event(&ctx, first, WinEvent::Destroyed);
        assert!(!dialog_requested(&fakes));
        assert!(fakes.host.exit_codes.lock().unwrap().is_empty());
        assert!(!desktop.is_quitting());
        assert_eq!(desktop.records().iter().map(|record| record.id).collect::<Vec<_>>(), vec![second]);
    }

    #[test]
    fn closing_a_window_notifies_subscribers_before_the_record_and_the_bridge_entry_go() {
        let Harness { ctx, desktop, backend, .. } = harness();
        let first = desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        let second = desktop.spawn_window(Some("/w/beta".into()), None, None).unwrap();
        let seen: Arc<Mutex<Vec<(WindowRecord, bool, bool)>>> = Arc::new(Mutex::new(Vec::new()));
        let weak = Arc::downgrade(&ctx);
        let sink = seen.clone();
        desktop.on_window_closed(Box::new(move |record| {
            let ctx = weak.upgrade().unwrap();
            let record_alive = ctx.desktop.record(record.id).is_some();
            let bridge_alive = ctx.bridge.windows().contains(&Caller::main(record.id));
            sink.lock().unwrap().push((record.clone(), record_alive, bridge_alive));
        }));
        backend.destroy(first);
        desktop.on_window_event(&ctx, first, WinEvent::Destroyed);
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0.id, first);
        assert_eq!(seen[0].0.cwd, "/w/alpha");
        assert!(seen[0].1, "the record is still readable inside the listener");
        assert!(seen[0].2, "the bridge still knows the window inside the listener");
        assert!(desktop.record(first).is_none());
        assert!(!ctx.bridge.windows().contains(&Caller::main(first)));
        assert!(ctx.bridge.windows().contains(&Caller::main(second)));
    }

    /// A listener that registers another listener runs while `closed_listeners`
    /// is mid-notification. `on_window_destroyed` must have already cloned the
    /// list out of its guard before calling listeners, or `on_window_closed`'s
    /// push deadlocks on itself. Run off-thread with a timeout so a regression
    /// fails the test instead of hanging the whole run.
    #[test]
    fn a_listener_that_registers_another_listener_does_not_deadlock() {
        let Harness { ctx, desktop, backend, .. } = harness();
        let first = desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();

        let probe_ctx = Arc::downgrade(&ctx);
        desktop.on_window_closed(Box::new(move |_record| {
            if let Some(ctx) = probe_ctx.upgrade() {
                if let Some(desktop) = Desktop::of(&ctx) {
                    desktop.on_window_closed(Box::new(|_record| {}));
                }
            }
        }));

        backend.destroy(first);
        let call_ctx = ctx.clone();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let desktop = Desktop::of(&call_ctx).expect("the harness installs the real Desktop");
            desktop.on_window_event(&call_ctx, first, WinEvent::Destroyed);
            let _ = done_tx.send(());
        });
        done_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("a listener registering another listener must not deadlock the closed-window notification");
        assert_eq!(crate::desktop::lock(&desktop.closed_listeners).len(), 2, "the listener registered during notification must still land");
    }
}
