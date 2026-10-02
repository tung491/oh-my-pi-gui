//! App lifecycle and close ordering, ported from `src/main/index.ts`
//! (`window-all-closed`, `activate`, the closed-window subscribers) so a
//! multi-window session restores in full and no hidden process stays behind.

use std::sync::Arc;

use serde_json::json;

use super::windows::WinEvent;
use super::{Desktop, Platform};
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
                self.shortcut_release_window(win_id);
                if self.keep_last_window_on_close(win_id) {
                    // macOS: the last window hides instead of closing, so the app stays in the dock.
                    self.backend.hide(win_id);
                    return true;
                }
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

    fn keep_last_window_on_close(&self, win_id: WindowId) -> bool {
        self.backend.platform() == Platform::Darwin && !self.is_quitting_latched() && self.windows.ids() == vec![win_id]
    }

    /// A window is gone: notify the subscribers while its record still exists,
    /// drop the record, then let the bridge forget it. Then the prompts it held
    /// go back to the bar, its tray and progress snapshots leave the aggregate,
    /// the saved session is rewritten (unless quitting), and on Linux and
    /// Windows the last window takes the app with it.
    fn on_window_destroyed(&self, ctx: &Arc<AppCtx>, win_id: WindowId) {
        if let Some(record) = self.windows.record(win_id) {
            for listener in super::lock(&self.closed_listeners).iter() {
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
        if self.backend.platform() != Platform::Darwin && self.windows.count() == 0 && !self.is_quitting_latched() {
            self.quick_entry.destroy_window(self);
            self.request_quit_in(ctx);
        }
    }

    /// macOS dock click: show a hidden window or open one.
    pub(crate) fn on_reopen_in(&self, ctx: &AppCtx, has_visible_windows: bool) {
        if has_visible_windows {
            return;
        }
        match self.windows.main_window() {
            Some(id) => self.backend.focus(id),
            None => {
                self.spawn_window_in(ctx, None, None, None);
            }
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
    use crate::ports::{Caller, PersistedTabLayout, WindowRecord};
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
        let Harness { ctx, desktop, fakes, backend } = harness(Platform::Linux);
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

    #[test]
    fn closing_the_last_window_quits_on_linux() {
        let Harness { ctx, desktop, fakes, backend } = harness(Platform::Linux);
        let id = desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        desktop.quick_entry.show(&ctx, &desktop);
        assert!(backend.exists(WindowId::QUICK_ENTRY));
        backend.destroy(id);
        desktop.on_window_event(&ctx, id, WinEvent::Destroyed);
        assert!(!backend.exists(WindowId::QUICK_ENTRY), "the hidden bar must not keep the process alive");
        assert_eq!(fakes.host.exit_codes.lock().unwrap().clone(), vec![0]);
        assert!(desktop.is_quitting());

        // macOS keeps running: the last window hides on close instead.
        let Harness { ctx, desktop, fakes, backend } = harness(Platform::Darwin);
        let id = desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        assert!(desktop.on_window_event(&ctx, id, WinEvent::CloseRequested));
        assert!(!backend.is_visible(id));
        assert!(fakes.host.exit_codes.lock().unwrap().is_empty());
        desktop.on_reopen(false);
        assert!(backend.is_visible(id));
    }

    #[test]
    fn closing_a_window_notifies_subscribers_before_the_record_and_the_bridge_entry_go() {
        let Harness { ctx, desktop, backend, .. } = harness(Platform::Linux);
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
}
