//! `omp://` deep links, the second-instance handoff and launch paths, ported
//! from `src/main/deep-link.ts`. Links that arrive before any window exists are
//! buffered and replayed after setup; once a window exists the bridge keeps
//! every undelivered link per window and replays it when the page attaches.

use std::path::Path;
use std::sync::Mutex;

use serde_json::{json, Value};

use super::launch_argv::{launch_arguments, parse_launch_argv, LaunchRequest};
use super::{lock, Desktop};
use crate::bridge::DEEP_LINK_CHANNEL;
use crate::ctx::AppCtx;
use crate::runtime_log;

pub(crate) const DEEP_LINK_PROTOCOL: &str = "omp";

/// Links and files that reached the module before `init` finished.
#[derive(Default)]
pub(crate) struct PendingLinks {
    ready: Mutex<bool>,
    urls: Mutex<Vec<String>>,
    files: Mutex<Vec<String>>,
}

impl PendingLinks {
    /// Buffer a URL until setup, or report that it can be handled now.
    fn offer_url(&self, url: String) -> bool {
        if *lock(&self.ready) {
            return true;
        }
        lock(&self.urls).push(url);
        false
    }

    fn offer_file(&self, path: String) -> bool {
        if *lock(&self.ready) {
            return true;
        }
        lock(&self.files).push(path);
        false
    }

    fn take(&self) -> (Vec<String>, Vec<String>) {
        *lock(&self.ready) = true;
        (std::mem::take(&mut *lock(&self.urls)), std::mem::take(&mut *lock(&self.files)))
    }
}

/// The renderer payload for a link: `omp://new` → `new-session`,
/// `omp://session/<id>` → `switch-session`; anything else is ignored.
pub(crate) fn deep_link_payload(url: &str) -> Option<Value> {
    let parsed = tauri::Url::parse(url).ok()?;
    if parsed.scheme() != DEEP_LINK_PROTOCOL {
        return None;
    }
    // The first segment of a scheme:// URL is the host: omp://new → host "new",
    // omp://session/<id> → host "session" + path "/<id>".
    match parsed.host_str()?.to_lowercase().as_str() {
        "new" => Some(json!({ "action": "new-session" })),
        "session" => {
            let session_id = parsed.path().trim_matches('/');
            (!session_id.is_empty()).then(|| json!({ "action": "switch-session", "sessionId": session_id }))
        }
        _ => None,
    }
}

impl Desktop {
    /// A URL from the OS or a second instance, buffered before setup.
    pub(crate) fn open_url(&self, ctx: &AppCtx, url: String) {
        if self.links.offer_url(url.clone()) {
            self.handle_deep_link(ctx, &url);
        }
    }

    /// A file or folder from the OS (`open -a` on macOS), buffered before setup.
    pub(crate) fn open_file(&self, ctx: &AppCtx, path: String) {
        if self.links.offer_file(path.clone()) {
            self.handle_open_path(ctx, &path);
        }
    }

    /// Setup finished: replay what arrived early, in order.
    pub(crate) fn replay_pending_links(&self, ctx: &AppCtx) {
        let (urls, files) = self.links.take();
        for url in urls {
            self.handle_deep_link(ctx, &url);
        }
        for path in files {
            self.handle_open_path(ctx, &path);
        }
    }

    /// Focus the main window (or open one) and hand the link to its renderer.
    pub(crate) fn handle_deep_link(&self, ctx: &AppCtx, url: &str) {
        let Some(payload) = deep_link_payload(url) else {
            runtime_log::note("unknown", format!("ignored deep link {url}"), json!({ "url": url }));
            return;
        };
        let Some(win_id) = self.windows.main_window().or_else(|| self.spawn_window_in(ctx, None, None, None)) else { return };
        self.backend.focus(win_id);
        runtime_log::note("unknown", format!("deep link {url} delivered to window {win_id}"), json!({ "url": url, "winId": win_id.0 }));
        ctx.bridge.emit_to_window(win_id, DEEP_LINK_CHANNEL, payload);
    }

    /// Bring the window already showing this workspace forward, or open it in
    /// a new one. Relative paths resolve against the launcher's cwd, which is
    /// never the workspace the user pointed at, so they are refused.
    pub(crate) fn handle_open_path(&self, ctx: &AppCtx, path: &str) {
        if !Path::new(path).is_absolute() {
            return;
        }
        let target = normalize_path(path);
        if let Some(record) = self.windows.records().into_iter().find(|record| record.cwd == target) {
            self.backend.focus(record.id);
            return;
        }
        self.spawn_window_in(ctx, Some(target), None, None);
    }

    /// A refused second instance handed over its argv: a link, the quick-entry
    /// flag, a workspace path, or just "raise the app".
    pub(crate) fn on_second_instance_in(&self, ctx: &AppCtx, argv: Vec<String>) {
        let args = launch_arguments(&argv, false);
        let request = parse_launch_argv(&args, DEEP_LINK_PROTOCOL, |path| self.backend.directory_exists(path));
        runtime_log::note("unknown", format!("second instance: {request:?}"), json!({ "argv": argv }));
        match request {
            LaunchRequest::Url(url) => self.handle_deep_link(ctx, &url),
            LaunchRequest::QuickEntry => self.quick_entry.show_when_settled(ctx, self),
            LaunchRequest::Path(path) => self.handle_open_path(ctx, &path),
            LaunchRequest::Focus => {
                if let Some(id) = self.windows.target_window() {
                    self.backend.focus(id);
                }
            }
        }
    }
}

/// Drop `.` segments and trailing slashes without touching the filesystem.
fn normalize_path(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    if parts.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", parts.join("/"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::Envelope;
    use crate::desktop::testing::{attach_recording_sink, harness, DesktopPort as _, Harness};
    use crate::desktop::Platform;
    use crate::ports::WindowId;

    #[test]
    fn maps_links_to_renderer_actions() {
        assert_eq!(deep_link_payload("omp://new"), Some(json!({ "action": "new-session" })));
        assert_eq!(deep_link_payload("omp://NEW"), Some(json!({ "action": "new-session" })));
        assert_eq!(deep_link_payload("omp://session/abc/"), Some(json!({ "action": "switch-session", "sessionId": "abc" })));
        assert_eq!(deep_link_payload("omp://session/"), None);
        assert_eq!(deep_link_payload("omp://other"), None);
        assert_eq!(deep_link_payload("https://example.com/new"), None);
        assert_eq!(deep_link_payload("not a url"), None);
        assert_eq!(normalize_path("/w/./alpha/"), "/w/alpha");
        assert_eq!(normalize_path("/w/beta/../alpha"), "/w/alpha");
    }

    #[test]
    fn a_second_instance_with_a_link_focuses_and_delivers_it() {
        let Harness { ctx, desktop, backend, .. } = harness(Platform::Linux);
        let id = desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        let sink = attach_recording_sink(&ctx, id);
        backend.log.clear();
        desktop.on_second_instance(vec!["/opt/sai-atlas".into(), "omp://session/abc".into()], Some("/tmp".into()));
        assert!(backend.log.calls().contains(&format!("focus({id})")));
        let sent: Vec<Envelope> = sink.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].channel, DEEP_LINK_CHANNEL);
        assert_eq!(sent[0].payload, json!({ "action": "switch-session", "sessionId": "abc" }));
    }

    #[test]
    fn a_second_instance_with_a_path_raises_its_window_or_opens_one() {
        let Harness { ctx: _ctx, desktop, backend, .. } = harness(Platform::Linux);
        let id = desktop.spawn_window(Some("/w/alpha".into()), None, None).unwrap();
        backend.log.clear();
        desktop.on_second_instance(vec!["sai-atlas".into(), "/w/alpha".into()], None);
        assert!(backend.log.calls().contains(&format!("focus({id})")));
        assert_eq!(desktop.records().len(), 1);
        desktop.on_second_instance(vec!["sai-atlas".into(), "/w/beta".into()], None);
        assert_eq!(desktop.records().len(), 2);
        assert_eq!(desktop.record(WindowId(2)).map(|r| r.cwd), Some("/w/beta".into()));
        // A bare launch only raises the app; a relative path is refused.
        backend.log.clear();
        desktop.on_second_instance(vec!["sai-atlas".into(), "./relative".into()], None);
        assert_eq!(desktop.records().len(), 2);
        assert!(backend.log.calls().iter().any(|call| call.starts_with("focus(")));
    }

    #[test]
    fn links_before_setup_are_replayed_after_it() {
        let Harness { ctx, desktop, .. } = harness(Platform::Linux);
        desktop.open_url(&ctx, "omp://new".into());
        assert!(desktop.records().is_empty(), "nothing opens before setup");
        desktop.replay_pending_links(&ctx);
        assert_eq!(desktop.records().len(), 1);
        let id = desktop.main_window().unwrap();
        let sink = attach_recording_sink(&ctx, id);
        // The bridge replayed the link on attach.
        assert!(sink.sent().iter().any(|envelope| envelope.channel == DEEP_LINK_CHANNEL));
        // After setup, links go straight through.
        desktop.open_url(&ctx, "omp://session/x".into());
        assert_eq!(sink.sent().len(), 2);
    }
}
