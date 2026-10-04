#!/usr/bin/env bash
# Installs the mounted .deb as root, the way a user's `sudo apt install` does,
# then runs the packaged smoke spec as the host user so the test output written
# into the mounted repo stays theirs. Extra arguments go to Playwright.
set -euo pipefail

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

cd /repo
exec setpriv --reuid="$uid" --regid="$gid" --init-groups \
	env HOME="$home" USER="$user" OMP_GUI_TEST_APP="/opt/Sai ATLAS/sai-atlas" \
	xvfb-run -a -s "-screen 0 1600x1000x24" \
	dbus-run-session -- \
	node node_modules/@playwright/test/cli.js test e2e/packaged-smoke.e2e.ts "$@"
