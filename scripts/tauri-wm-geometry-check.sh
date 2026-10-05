#!/usr/bin/env bash
# Installs a Tauri Sai ATLAS .deb into a clean Ubuntu 24.04 container and checks
# its main window's saved geometry under openbox, a reparenting X11 window
# manager: three launches from a fresh profile and three from a saved
# {1300x850 at 40,30} must each save exactly the frame openbox drew, and no
# launch may drift from the one before. The WM-less virtual display the e2e
# specs run on draws no frame, so only this check sees the decoration.
#
# A Linux release-checklist step next to tauri-deb-smoke.sh, and the check for
# any change to the window-size correction (src-tauri/src/desktop/windows.rs,
# window_bounds.rs). CI does not run it: it needs Docker and a built .deb.
#
#   bash scripts/tauri-wm-geometry-check.sh                  # the .deb scripts/tauri-linux-build.sh built
#   bash scripts/tauri-wm-geometry-check.sh path/to/sai-atlas.deb [results-dir]
#
# Results (geometry.txt with every measurement, the app's output and runtime
# logs, the saved states) go to test-results/wm-geometry-check unless a results
# directory is given; on failure geometry.txt is printed and the exit status is
# non-zero.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
name=sai-atlas-tauri-wm-geometry-check

if [[ $# -gt 0 && $1 == *.deb ]]; then
	deb=$(realpath "$1")
	shift
else
	target=${SAI_ATLAS_LINUX_TARGET:-$root/src-tauri/target-linux-2404}
	deb=$(ls -t "$target"/x86_64-unknown-linux-gnu/release/bundle/deb/*.deb 2>/dev/null | head -n 1 || true)
fi
if [[ -z $deb || ! -f $deb ]]; then
	echo "No .deb found. Build one with: bash scripts/tauri-linux-build.sh" >&2
	exit 1
fi
out=${1:-$root/test-results/wm-geometry-check}
# Created here so the results stay the host user's; only this check's files are cleared.
mkdir -p "$out"
out=$(realpath "$out")
rm -f "$out"/geometry.txt "$out"/*-app.log "$out"/*-state-*.json "$out"/*-runtime.jsonl "$out"/xvfb.log "$out"/openbox.log
echo "Checking the window geometry of $deb under openbox" >&2

docker build -q -t "$name" "$root/scripts/tauri-wm-geometry-check" >/dev/null

# WebKit runs every web process in a bubblewrap sandbox, which Docker's
# defaults break three ways: its seccomp profile blocks the user namespace, its
# AppArmor profile refuses bwrap's mount propagation change ("Failed to make /
# slave"), and its masked /proc paths refuse the sandbox's own proc mount. Each
# opt-out below lifts exactly one of them; no capability is added and no host
# device is exposed. --init forwards Ctrl-C to the check.
#
# A crash inside the container still goes to the host's core_pattern, so the
# host's apport would report it as a crash of the host's own install. A core
# limit of exactly 1 makes the kernel drop the dump before calling apport (its
# recursion guard); 0 would not.
#
# The container name carries this run's PID, so concurrent runs never collide
# and no run removes another's container.
status=0
docker run --rm --init --name "$name-$$" \
	--security-opt seccomp=unconfined \
	--security-opt apparmor=unconfined \
	--security-opt systempaths=unconfined \
	--ulimit core=1 \
	-e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
	-v "$deb:/tmp/sai-atlas.deb:ro" \
	-v "$out:/out" \
	"$name" || status=$?

if ((status != 0)); then
	echo "Window geometry check FAILED for $deb:" >&2
	cat "$out/geometry.txt" >&2 2>/dev/null || echo "(no geometry.txt; see the output above)" >&2
	exit "$status"
fi
echo "Window geometry check passed for $deb; measurements in $out/geometry.txt" >&2
