#!/bin/sh
# WebDriver hands the app arguments but no environment: WebKitWebDriver starts
# whatever `tauri:options.application` names with `tauri:options.args` plus
# `--automation`, in the driver's own environment. So the harness points
# `application` here. The first argument names a file of KEY='value' lines that
# e2e-tauri/session.ts wrote for this one launch; it is sourced and exported,
# then the real binary replaces this shell (exec keeps the PID the driver owns).
# Every other argument passes through untouched.
set -eu
env_file=$1
shift
set -a
. "$env_file"
set +a
case " $* " in
	*" --user-data-dir="*) ;;
	*)
		echo "launch-app.sh: refusing to start without --user-data-dir; tests never touch the real profile" >&2
		exit 64
		;;
esac
# Optional, per launch: a working directory (a launch that ignores its argv
# lands there), and a file that takes the app's stdout and stderr.
if [ -n "${OMP_E2E_APP_CWD:-}" ]; then
	cd "$OMP_E2E_APP_CWD"
fi
binary=${OMP_E2E_APP_BINARY:?the launch env must name the app binary}
if [ -n "${OMP_E2E_APP_LOG:-}" ]; then
	exec "$binary" "$@" >>"$OMP_E2E_APP_LOG" 2>&1
fi
exec "$binary" "$@"
