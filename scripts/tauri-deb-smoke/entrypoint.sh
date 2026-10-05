#!/usr/bin/env bash
# Installs the mounted .deb as root, the way a user's `sudo apt install` does,
# then runs the packaged smoke spec as the host user so the test output written
# into the mounted repo stays theirs. Extra arguments go to `wdio run`.
#
# The second stage (--session, inside the user's own session bus) starts a
# headless weston and runs WebdriverIO against it. Headless weston has no seat,
# so GTK logs `gdk_seat_get_keyboard` criticals by the hundred; WebDriver
# delivers input inside WebKit and needs none.
#
# With OMP_E2E_FAKE_MIC=1 the session also starts the audio stack with a fake
# microphone (fake-mic.sh) and wdio.packaged.conf.ts runs the audio probe
# (e2e-tauri/fake-mic.probe.ts) instead of the smoke spec.
set -euo pipefail

if [[ ${1:-} == --session ]]; then
	shift
	weston --backend=headless --renderer=pixman --width=1600 --height=1000 \
		--socket=wayland-1 --idle-time=0 --log="$XDG_RUNTIME_DIR/weston.log" &
	compositor=$!
	trap 'kill "$compositor" 2>/dev/null || true' EXIT
	for _ in $(seq 100); do
		[[ -S $XDG_RUNTIME_DIR/wayland-1 ]] && break
		kill -0 "$compositor" 2>/dev/null || break
		sleep 0.1
	done
	if [[ ! -S $XDG_RUNTIME_DIR/wayland-1 ]]; then
		echo "weston did not start:" >&2
		cat "$XDG_RUNTIME_DIR/weston.log" >&2 || true
		exit 1
	fi
	if [[ ${OMP_E2E_FAKE_MIC:-} == 1 ]]; then
		fake-mic
	fi
	cd /repo
	# Not exec: the trap stops weston once the run ends.
	WAYLAND_DISPLAY=wayland-1 XDG_SESSION_TYPE=wayland OMP_GUI_TEST_APP=/usr/bin/sai-atlas \
		node node_modules/@wdio/cli/bin/wdio.js run wdio.packaged.conf.ts "$@"
	exit
fi

apt-get install -y --no-install-recommends /tmp/sai-atlas.deb

uid=${HOST_UID:?HOST_UID is not set}
gid=${HOST_GID:?HOST_GID is not set}
user=$(getent passwd "$uid" | cut -d: -f1 || true)
if [[ -z $user ]]; then
	getent group "$gid" >/dev/null || groupadd -g "$gid" smoke
	useradd -m -u "$uid" -g "$gid" smoke
	user=smoke
fi
home=$(getent passwd "$user" | cut -d: -f6)
# Wayland sockets live in XDG_RUNTIME_DIR, which must be the user's own and 0700.
runtime=/run/user/$uid
install -d -m 0700 -o "$uid" -g "$gid" "$runtime"

exec setpriv --reuid="$uid" --regid="$gid" --init-groups \
	env HOME="$home" USER="$user" XDG_RUNTIME_DIR="$runtime" \
	dbus-run-session -- "$0" --session "$@"
