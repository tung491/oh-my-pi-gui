//! Save/open dialogs with per-window folder memory, ported from the
//! `system:save-dialog` / `system:open-dialog` handlers in `ipc.ts:829-859`.
//! Electron 43+ dialogs open in Downloads and the OS no longer remembers the
//! last folder, so [`DialogMemory`] keeps the last folder each window used.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::ctx::AppCtx;
use crate::ports::{FileFilter, OpenDialogOptions, SaveDialogOptions, WindowId};

use super::dialog_memory::{dialog_dir_of, dialog_start_path};

/// Per-window last-used dialog folder. A window's entry is cleared when it
/// closes (`ServicesPort::on_window_closed`, wired in `services::init`), so a
/// closed window's folder never leaks into a reused `WindowId`.
#[derive(Default)]
pub struct DialogMemory {
    last_dirs: Mutex<HashMap<WindowId, PathBuf>>,
}

impl DialogMemory {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<WindowId, PathBuf>> {
        self.last_dirs.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn start_path(&self, win_id: WindowId, requested: Option<&str>) -> Option<PathBuf> {
        let last_dir = self.lock().get(&win_id).cloned();
        dialog_start_path(last_dir.as_deref(), requested)
    }

    pub fn remember_file(&self, win_id: WindowId, selected_path: &std::path::Path) {
        self.lock().insert(win_id, dialog_dir_of(selected_path));
    }

    pub fn remember_dir(&self, win_id: WindowId, dir: PathBuf) {
        self.lock().insert(win_id, dir);
    }

    pub fn forget(&self, win_id: WindowId) {
        self.lock().remove(&win_id);
    }
}

/// `system:save-dialog(defaultPath, filters)`: defaults to `session.html`
/// when no path is requested, and the window's last folder otherwise.
pub async fn save_dialog(
    ctx: &Arc<AppCtx>,
    memory: &DialogMemory,
    win_id: WindowId,
    default_path: Option<&str>,
    filters: Option<Vec<FileFilter>>,
) -> Option<PathBuf> {
    let requested = default_path.filter(|path| !path.is_empty()).unwrap_or("session.html");
    let start = memory.start_path(win_id, Some(requested));
    let filters = filters.unwrap_or_else(|| vec![FileFilter { name: "HTML".into(), extensions: vec!["html".into()] }]);
    let options = SaveDialogOptions { title: None, default_path: start, filters, parent: Some(win_id) };
    let result = ctx.host.save_dialog(options).await;
    if let Some(path) = &result {
        memory.remember_file(win_id, path);
    }
    result
}

/// `system:open-dialog(filters, options)`: `options.directory` switches
/// between a directory picker (creation allowed) and a multi-file picker.
pub async fn open_dialog(
    ctx: &Arc<AppCtx>,
    memory: &DialogMemory,
    win_id: WindowId,
    filters: Option<Vec<FileFilter>>,
    directory: bool,
) -> Option<Vec<PathBuf>> {
    let start = memory.start_path(win_id, None);
    let options = OpenDialogOptions {
        title: None,
        default_path: start,
        filters: filters.unwrap_or_default(),
        directory,
        multiple: !directory,
        can_create_directories: directory,
        parent: Some(win_id),
    };
    let result = ctx.host.open_dialog(options).await;
    if let Some(paths) = &result {
        if let Some(first) = paths.first() {
            if directory {
                memory.remember_dir(win_id, first.clone());
            } else {
                memory.remember_file(win_id, first);
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remembers_a_folder_per_window_and_forgets_it_on_close() {
        let memory = DialogMemory::new();
        assert_eq!(memory.start_path(WindowId(1), Some("session.html")), Some(PathBuf::from("session.html")));
        memory.remember_file(WindowId(1), std::path::Path::new("/home/me/exports/session.html"));
        assert_eq!(memory.start_path(WindowId(1), Some("session.html")), Some(PathBuf::from("/home/me/exports/session.html")));
        // A different window never sees another window's folder.
        assert_eq!(memory.start_path(WindowId(2), Some("session.html")), Some(PathBuf::from("session.html")));
        memory.forget(WindowId(1));
        assert_eq!(memory.start_path(WindowId(1), Some("session.html")), Some(PathBuf::from("session.html")));
    }

    #[test]
    fn a_directory_pick_remembers_the_directory_itself() {
        let memory = DialogMemory::new();
        memory.remember_dir(WindowId(1), PathBuf::from("/home/me/projects"));
        assert_eq!(memory.start_path(WindowId(1), None), Some(PathBuf::from("/home/me/projects")));
    }
}
