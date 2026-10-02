//! The runtime-free application context. Handlers and cross-module calls only
//! ever see this struct, so every module can be unit-tested with the fakes in
//! `testing.rs`. Modules that need native APIs (windows, tray) receive the real
//! `AppHandle` in their constructor instead; it is never stored here.

use std::sync::Arc;

use crate::bridge::Bridge;
use crate::i18n::MainI18n;
use crate::ports::{DesktopPort, Host, OllamaPort, OmpPort, ServicesPort, TabsPort, UpdaterPort};
use crate::prefs::JsonStore;

pub struct AppCtx {
    /// OS services: dialogs, opener, clipboard, notifications, app version, exit.
    pub host: Arc<dyn Host>,
    /// Dispatch and outbound streams.
    pub bridge: Bridge,
    /// `prefs.json`.
    pub prefs: JsonStore,
    /// `window-state.json`.
    pub window_state: JsonStore,
    pub i18n: MainI18n,
    pub omp: Arc<dyn OmpPort>,
    pub tabs: Arc<dyn TabsPort>,
    pub desktop: Arc<dyn DesktopPort>,
    pub services: Arc<dyn ServicesPort>,
    pub ollama: Arc<dyn OllamaPort>,
    pub updater: Arc<dyn UpdaterPort>,
}

impl std::fmt::Debug for AppCtx {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppCtx").field("prefs", &self.prefs).field("window_state", &self.window_state).finish_non_exhaustive()
    }
}
