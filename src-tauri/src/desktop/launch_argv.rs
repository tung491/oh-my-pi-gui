//! What a launch asked for, decoded from the arguments of a cold start or of
//! a refused second instance. Ported from `src/main/launch-argv.ts`.

use crate::ports::SUPERVISOR_ARGV;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum LaunchRequest {
    Url(String),
    QuickEntry,
    Path(String),
    Focus,
}

/// Opens the quick-entry bar instead of raising a window.
pub(crate) const QUICK_ENTRY_FLAG: &str = "--quick-entry";

/// A deep link wins over everything, then the quick-entry flag; otherwise the
/// first argument naming a real directory is the workspace to open, and
/// anything left means "just raise the app". Flags are skipped so the shell's
/// own switches never look like a path. The supervisor argv and everything
/// after it belong to a re-exec of this binary and are never a launch request.
pub(crate) fn parse_launch_argv(argv: &[String], protocol: &str, directory_exists: impl Fn(&str) -> bool) -> LaunchRequest {
    let end = argv.iter().position(|arg| arg == SUPERVISOR_ARGV).unwrap_or(argv.len());
    let argv = &argv[..end];
    let prefix = format!("{protocol}://");
    if let Some(url) = argv.iter().find(|arg| arg.starts_with(&prefix)) {
        return LaunchRequest::Url(url.clone());
    }
    if argv.iter().any(|arg| arg == QUICK_ENTRY_FLAG) {
        return LaunchRequest::QuickEntry;
    }
    for arg in argv {
        if arg.starts_with('-') {
            continue;
        }
        if directory_exists(arg) {
            return LaunchRequest::Path(arg.clone());
        }
    }
    LaunchRequest::Focus
}

/// The user's part of an argv: the executable comes first, and a dev launch
/// (`electron .` in the Electron days) also carried the app directory.
pub(crate) fn launch_arguments(argv: &[String], default_app: bool) -> Vec<String> {
    argv.iter().skip(if default_app { 2 } else { 1 }).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exists(path: &str) -> bool {
        matches!(path, "/workspace/app" | "/Applications/omp.app")
    }

    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn prefers_the_deep_link_over_a_directory_in_the_same_argv() {
        assert_eq!(
            parse_launch_argv(&argv(&["/Applications/omp.app", "omp://session/abc", "/workspace/app"]), "omp", exists),
            LaunchRequest::Url("omp://session/abc".into())
        );
    }

    #[test]
    fn opens_the_first_argument_naming_a_real_directory() {
        assert_eq!(
            parse_launch_argv(&argv(&["electron-bin", "/workspace/app", "/nope"]), "omp", exists),
            LaunchRequest::Path("/workspace/app".into())
        );
    }

    #[test]
    fn skips_electron_s_own_switches_instead_of_treating_them_as_paths() {
        assert_eq!(
            parse_launch_argv(&argv(&["--class=App", "--no-sandbox", "/workspace/app"]), "omp", exists),
            LaunchRequest::Path("/workspace/app".into())
        );
        assert_eq!(parse_launch_argv(&argv(&["--flag", "./relative", "/missing"]), "omp", exists), LaunchRequest::Focus);
    }

    #[test]
    fn only_asks_for_focus_when_nothing_names_a_link_or_a_workspace() {
        assert_eq!(parse_launch_argv(&argv(&["/tmp/not-a-directory"]), "omp", |_| false), LaunchRequest::Focus);
    }

    #[test]
    fn opens_quick_entry_for_the_quick_entry_flag() {
        assert_eq!(parse_launch_argv(&argv(&["--quick-entry"]), "omp", exists), LaunchRequest::QuickEntry);
    }

    #[test]
    fn prefers_quick_entry_over_a_directory_in_the_same_argv() {
        assert_eq!(parse_launch_argv(&argv(&["/workspace/app", "--quick-entry"]), "omp", exists), LaunchRequest::QuickEntry);
    }

    #[test]
    fn still_prefers_a_deep_link_over_quick_entry() {
        assert_eq!(
            parse_launch_argv(&argv(&["--quick-entry", "omp://new"]), "omp", exists),
            LaunchRequest::Url("omp://new".into())
        );
    }

    #[test]
    fn ignores_the_supervisor_argv() {
        let supervised = argv(&[SUPERVISOR_ARGV, "/workspace/app", "omp://new", "--quick-entry"]);
        assert_eq!(parse_launch_argv(&supervised, "omp", exists), LaunchRequest::Focus);
        let trailing = argv(&["/workspace/app", SUPERVISOR_ARGV, "omp://new"]);
        assert_eq!(parse_launch_argv(&trailing, "omp", exists), LaunchRequest::Path("/workspace/app".into()));
        assert_eq!(parse_launch_argv(&argv(&[SUPERVISOR_ARGV]), "omp", |_| true), LaunchRequest::Focus);
    }

    #[test]
    fn drops_only_the_executable_in_a_packaged_launch() {
        assert_eq!(launch_arguments(&argv(&["/opt/omp/omp-gui", "omp://new"]), false), argv(&["omp://new"]));
    }

    #[test]
    fn drops_the_executable_and_the_app_directory_in_a_dev_launch() {
        assert_eq!(launch_arguments(&argv(&["/electron", ".", "/workspace/app"]), true), argv(&["/workspace/app"]));
    }

    #[test]
    fn finds_a_cold_start_workspace_or_link_behind_chromium_switches() {
        assert_eq!(
            parse_launch_argv(&launch_arguments(&argv(&["/opt/omp/omp-gui", "--no-sandbox", "/workspace/app"]), false), "omp", exists),
            LaunchRequest::Path("/workspace/app".into())
        );
        assert_eq!(
            parse_launch_argv(&launch_arguments(&argv(&["/opt/omp/omp-gui", "omp://session/abc"]), false), "omp", exists),
            LaunchRequest::Url("omp://session/abc".into())
        );
    }
}
