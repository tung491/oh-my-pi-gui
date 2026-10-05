//! Keeps the AppImage's GStreamer registry out of the user's shared one.
//!
//! The AppImage carries its own small GStreamer plugin set in
//! `usr/lib/gstreamer-1.0` (built against the bundled GStreamer core), and its
//! AppRun points GStreamer at that directory alone. GStreamer drops registry
//! entries for plugins a scan did not see, so with the default registry every
//! launch would rewrite the user's `~/.cache/gstreamer-1.0/registry.<arch>.bin`
//! down to the bundle's plugins, and every host GStreamer app would rebuild it
//! on its next start. The AppImage's mount path also changes per launch.
//!
//! So an AppImage run points `GST_REGISTRY` at a file under the app's own cache
//! directory. The unsuffixed name is the one WebKit binds read-write into the
//! web-process sandbox (GStreamer reads it when `GST_REGISTRY_1_0` is unset),
//! and WebKit binds the directory only when it exists, so it is created first.
//! A .deb has no `$APPDIR` and keeps GStreamer's defaults, as does a user who
//! set either variable.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::{paths, product, runtime_log};

/// The bundled plugin directory, relative to the AppDir.
const BUNDLED_PLUGINS: &str = "usr/lib/gstreamer-1.0";
/// The variable WebKit binds into the sandbox and GStreamer reads.
const REGISTRY_VAR: &str = "GST_REGISTRY";
/// Takes precedence over `GST_REGISTRY` in GStreamer; a user who set it keeps it.
const VERSIONED_REGISTRY_VAR: &str = "GST_REGISTRY_1_0";

/// What this launch does with the GStreamer registry.
#[derive(Debug, PartialEq, Eq)]
enum RegistryPlan {
    /// Not an AppImage, a registry the user chose, or no cache directory: change nothing.
    Keep,
    /// An AppImage without its plugin directory; a broken build, worth a log line.
    PluginsMissing(PathBuf),
    /// Use this registry file; its directory must exist first.
    Use(PathBuf),
}

/// Decide the registry for a launch. `appdir` is `$APPDIR`, `registry_set`
/// whether the user set either registry variable, `cache_dir` the OS cache
/// directory, and `is_dir` tells whether a path is a directory.
fn registry_plan(appdir: Option<&OsStr>, registry_set: bool, cache_dir: Option<&Path>, is_dir: impl Fn(&Path) -> bool) -> RegistryPlan {
    let Some(appdir) = appdir.filter(|dir| !dir.is_empty()) else {
        return RegistryPlan::Keep;
    };
    if registry_set {
        return RegistryPlan::Keep;
    }
    let plugins = Path::new(appdir).join(BUNDLED_PLUGINS);
    if !is_dir(&plugins) {
        return RegistryPlan::PluginsMissing(plugins);
    }
    match cache_dir {
        Some(cache) => RegistryPlan::Use(registry_file(cache)),
        None => RegistryPlan::Keep,
    }
}

/// `<cache>/<app id>/gstreamer-1.0/registry.<arch>.bin`, named like GStreamer's own.
fn registry_file(cache_dir: &Path) -> PathBuf {
    cache_dir.join(product::APP_ID).join("gstreamer-1.0").join(format!("registry.{}.bin", std::env::consts::ARCH))
}

fn is_set(name: &str) -> bool {
    std::env::var_os(name).is_some_and(|value| !value.is_empty())
}

/// A runtime-log line from before `run()` installs the log; skipped when no
/// profile directory is known, which `run()` then reports itself.
fn note(message: String, details: serde_json::Value) {
    if paths::resolve_user_data_dir().is_ok() {
        runtime_log::RuntimeLog::new(paths::runtime_log_path(), env!("CARGO_PKG_VERSION")).note("unknown", message, details);
    }
}

/// Point an AppImage's GStreamer registry at the app's own cache directory.
/// Does nothing outside an AppImage. Changes the environment, so it must run
/// while this is the only thread, before GTK, GStreamer or WebKit initialize.
pub fn isolate_registry() {
    let appdir = std::env::var_os("APPDIR");
    let registry_set = is_set(REGISTRY_VAR) || is_set(VERSIONED_REGISTRY_VAR);
    let cache_dir = dirs::cache_dir();
    match registry_plan(appdir.as_deref(), registry_set, cache_dir.as_deref(), Path::is_dir) {
        RegistryPlan::Keep => {}
        RegistryPlan::PluginsMissing(plugins) => note(
            format!("the AppImage has no GStreamer plugins at {}; audio capture and playback will not work", plugins.display()),
            json!({ "path": plugins.display().to_string() }),
        ),
        RegistryPlan::Use(registry) => {
            let created = registry.parent().map(std::fs::create_dir_all).unwrap_or(Ok(()));
            match created {
                Ok(()) => std::env::set_var(REGISTRY_VAR, &registry),
                Err(error) => note(
                    format!("could not create the GStreamer registry directory for {}: {error}", registry.display()),
                    json!({ "path": registry.display().to_string() }),
                ),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const APPDIR: &str = "/tmp/.mount_SaiATLabc123";
    const CACHE: &str = "/home/user/.cache";

    fn plan(appdir: Option<&str>, registry_set: bool, cache: Option<&str>, dirs: &[&str]) -> RegistryPlan {
        registry_plan(appdir.map(OsStr::new), registry_set, cache.map(Path::new), |path| dirs.iter().any(|dir| path == Path::new(dir)))
    }

    #[test]
    fn an_appimage_with_bundled_plugins_uses_the_apps_own_registry() {
        let expected = PathBuf::from(format!("{CACHE}/vn.io.vif.saiatlas/gstreamer-1.0/registry.{}.bin", std::env::consts::ARCH));
        assert_eq!(plan(Some(APPDIR), false, Some(CACHE), &["/tmp/.mount_SaiATLabc123/usr/lib/gstreamer-1.0"]), RegistryPlan::Use(expected));
    }

    #[test]
    fn the_registry_never_lands_in_gstreamers_shared_cache_directory() {
        let RegistryPlan::Use(registry) = plan(Some(APPDIR), false, Some(CACHE), &["/tmp/.mount_SaiATLabc123/usr/lib/gstreamer-1.0"]) else {
            panic!("expected a registry");
        };
        assert!(!registry.starts_with(format!("{CACHE}/gstreamer-1.0")));
        assert_eq!(registry.parent().and_then(Path::parent), Some(Path::new(CACHE).join(product::APP_ID).as_path()));
    }

    #[test]
    fn an_appimage_without_plugins_changes_nothing_but_reports_the_directory() {
        assert_eq!(plan(Some(APPDIR), false, Some(CACHE), &[]), RegistryPlan::PluginsMissing(PathBuf::from("/tmp/.mount_SaiATLabc123/usr/lib/gstreamer-1.0")));
    }

    #[test]
    fn a_registry_the_user_chose_is_kept() {
        assert_eq!(plan(Some(APPDIR), true, Some(CACHE), &["/tmp/.mount_SaiATLabc123/usr/lib/gstreamer-1.0"]), RegistryPlan::Keep);
    }

    #[test]
    fn does_nothing_outside_an_appimage() {
        let dirs = ["/usr/lib/gstreamer-1.0"];
        assert_eq!(plan(None, false, Some(CACHE), &dirs), RegistryPlan::Keep);
        assert_eq!(plan(Some(""), false, Some(CACHE), &dirs), RegistryPlan::Keep);
    }

    #[test]
    fn keeps_the_default_when_no_cache_directory_is_known() {
        assert_eq!(plan(Some(APPDIR), false, None, &["/tmp/.mount_SaiATLabc123/usr/lib/gstreamer-1.0"]), RegistryPlan::Keep);
    }
}
