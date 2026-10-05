//! Where a file dialog starts, ported from `dialog-memory.ts`. Electron 43+
//! dialogs open in Downloads and the OS no longer remembers the last folder,
//! so the main process keeps the last folder each window used and starts the
//! next dialog there.

use std::path::{Path, PathBuf};

/// The `default_path` to hand a dialog: an absolute request wins; a bare file
/// name (or no request) lands in the window's last folder; with no last
/// folder the request passes through, and `None` means the OS default.
pub fn dialog_start_path(last_dir: Option<&Path>, requested: Option<&str>) -> Option<PathBuf> {
    if let Some(requested) = requested {
        if Path::new(requested).is_absolute() {
            return Some(PathBuf::from(requested));
        }
    }
    let Some(last_dir) = last_dir else { return requested.map(PathBuf::from) };
    match requested {
        Some(requested) => Some(last_dir.join(requested)),
        None => Some(last_dir.to_path_buf()),
    }
}

/// The folder to remember after a dialog picked `selected_path` (a file).
pub fn dialog_dir_of(selected_path: &Path) -> PathBuf {
    selected_path.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from(""))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn last() -> PathBuf {
        PathBuf::from("/home/me/exports")
    }

    #[test]
    fn keeps_an_absolute_request_as_it_is() {
        let requested = PathBuf::from("/tmp/report.html");
        let requested = requested.to_str().unwrap();
        assert_eq!(dialog_start_path(Some(&last()), Some(requested)), Some(PathBuf::from(requested)));
        assert_eq!(dialog_start_path(None, Some(requested)), Some(PathBuf::from(requested)));
    }

    #[test]
    fn puts_a_bare_file_name_in_the_last_folder_used() {
        assert_eq!(dialog_start_path(Some(&last()), Some("session.html")), Some(last().join("session.html")));
    }

    #[test]
    fn opens_in_the_last_folder_when_nothing_is_requested() {
        assert_eq!(dialog_start_path(Some(&last()), None), Some(last()));
    }

    #[test]
    fn leaves_the_os_default_before_any_folder_was_used() {
        assert_eq!(dialog_start_path(None, Some("session.html")), Some(PathBuf::from("session.html")));
        assert_eq!(dialog_start_path(None, None), None);
    }

    #[test]
    fn remembers_the_folder_that_holds_the_picked_file() {
        assert_eq!(dialog_dir_of(&last().join("session.html")), last());
    }
}
