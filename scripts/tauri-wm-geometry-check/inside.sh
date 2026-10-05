#!/usr/bin/env bash
# Installs the mounted .deb as root, the way a user's `sudo apt install` does,
# then checks the main window's saved geometry as the host user.
#
# The second stage (--session, inside the user's own session bus) starts Xvfb
# and openbox and launches the app six times: three times from a fresh profile
# and three times from a profile whose window-state.json holds {1300x850 at
# 40,30}. Each launch waits for openbox to frame the window and for the app to
# save the corrected footprint, closes the window and waits for the app to exit.
# Then:
#   - every launch: the saved outer bounds equal the client window plus
#     openbox's _NET_FRAME_EXTENTS (the footprint the app measured is the frame
#     the window manager drew);
#   - seeded: every launch saves exactly the seed (no drift by one frame per launch);
#   - fresh: every launch saves 1400x900, the same bounds each time.
# Every measurement goes to /out/geometry.txt; the exit status is the verdict.
set -uo pipefail

if [[ ${1:-} != --session ]]; then
	set -e
	if ! apt-get install -y --no-install-recommends /tmp/sai-atlas.deb >/tmp/install.log 2>&1; then
		echo "The .deb did not install:" >&2
		cat /tmp/install.log >&2
		exit 1
	fi

	uid=${HOST_UID:?HOST_UID is not set}
	gid=${HOST_GID:?HOST_GID is not set}
	user=$(getent passwd "$uid" | cut -d: -f1 || true)
	if [[ -z $user ]]; then
		getent group "$gid" >/dev/null || groupadd -g "$gid" check
		useradd -m -u "$uid" -g "$gid" check
		user=check
	fi
	home=$(getent passwd "$user" | cut -d: -f6)
	runtime=/run/user/$uid
	install -d -m 0700 -o "$uid" -g "$gid" "$runtime"

	exec setpriv --reuid="$uid" --regid="$gid" --init-groups \
		env HOME="$home" USER="$user" XDG_RUNTIME_DIR="$runtime" \
		dbus-run-session -- "$0" --session
fi

out=/out
report=$out/geometry.txt
: >"$report"
failed=0

note() { echo "$*" >>"$report"; }
fail() {
	note "FAIL: $*"
	failed=1
}

# Poll every 0.2 s until the command succeeds or the deadline (seconds) passes.
wait_for() {
	local deadline=$((SECONDS + $1))
	shift
	until "$@"; do
		((SECONDS < deadline)) || return 1
		sleep 0.2
	done
}

display_up() { xdpyinfo >/dev/null 2>&1; }
wm_up() { xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id'; }
exited() { ! kill -0 "$1" 2>/dev/null; }
newer() { [[ -n $(find "$1" -newer "$2" 2>/dev/null) ]]; }

export DISPLAY=:1 GDK_BACKEND=x11
Xvfb :1 -screen 0 1600x1000x24 -nolisten tcp >"$out/xvfb.log" 2>&1 &
xvfb=$!
wm=""
trap 'kill $wm $xvfb 2>/dev/null' EXIT
wait_for 20 display_up || {
	note "FAIL: Xvfb did not start (see xvfb.log)"
	exit 1
}
openbox >"$out/openbox.log" 2>&1 &
wm=$!
wait_for 20 wm_up || {
	note "FAIL: openbox did not start (see openbox.log)"
	exit 1
}

# The app's main window, once openbox has framed it.
main_window() {
	local id width
	for id in $(xdotool search --onlyvisible --pid "$1" --name 'Sai ATLAS' 2>/dev/null); do
		width=$(xwininfo -id "$id" 2>/dev/null | awk '/^ *Width:/ { print $2 }')
		((${width:-0} > 400)) || continue
		xprop -id "$id" _NET_FRAME_EXTENTS 2>/dev/null | grep -q ' = ' || continue
		echo "$id"
		return 0
	done
	return 1
}

# "x y width height" of the client window, and "left right top bottom" of its frame.
client_geometry() {
	xwininfo -id "$1" | awk '
		/Absolute upper-left X:/ { x = $4 }
		/Absolute upper-left Y:/ { y = $4 }
		/^ *Width:/ { w = $2 }
		/^ *Height:/ { h = $2 }
		END { print x, y, w, h }'
}
frame_extents() { xprop -id "$1" _NET_FRAME_EXTENTS | sed -n 's/.* = //p' | tr -d ','; }

# "x y width height" as window-state.json saved them; a missing or non-numeric field reads "missing".
saved_bounds() {
	jq -r '.windowState | [.x, .y, .width, .height]
		| map(if type == "number" then (. + 0 | tostring) else "missing" end) | join(" ")' "$1" 2>/dev/null || echo "unreadable"
}

stop_app() {
	exited "$1" && return 0
	kill "$1" 2>/dev/null
	wait_for 10 exited "$1" || kill -9 "$1" 2>/dev/null
}

# Launch, measure, close; sets $saved to the bounds the launch saved ("" when it failed).
saved=""
cycle() {
	local case=$1 n=$2
	local profile=$HOME/profile-$case
	local state=$profile/config/@oh-my-pi/omp-gui/window-state.json
	local marker=$profile/launch-marker
	saved=""
	mkdir -p "$profile"
	touch "$marker"

	XDG_CONFIG_HOME=$profile/config XDG_DATA_HOME=$profile/data XDG_CACHE_HOME=$profile/cache \
		PI_CODING_AGENT_DIR=$profile/agent PI_CONFIG_DIR=profile-$case/pi \
		/usr/bin/sai-atlas >>"$out/$case-app.log" 2>&1 &
	local pid=$! win="" deadline=$((SECONDS + 90))
	until win=$(main_window "$pid"); do
		if exited "$pid" || ((SECONDS >= deadline)); then
			fail "$case launch $n: no framed main window (pid $pid; see $case-app.log)"
			stop_app "$pid"
			return
		fi
		sleep 0.2
	done

	# The corrected footprint is saved 500 ms after the window's correcting
	# configure: a write newer than this launch means the correction is done.
	if ! wait_for 60 newer "$state" "$marker"; then
		fail "$case launch $n: window-state.json was never written"
		stop_app "$pid"
		return
	fi
	local geometry extents previous="" x y width height left right top bottom
	deadline=$((SECONDS + 15))
	while :; do
		geometry=$(client_geometry "$win")
		extents=$(frame_extents "$win")
		[[ "$geometry $extents" == "$previous" ]] && break
		if ((SECONDS >= deadline)); then
			fail "$case launch $n: the window kept changing ($geometry, frame $extents)"
			break
		fi
		previous="$geometry $extents"
		sleep 0.5
	done

	wmctrl -i -c "$win"
	if ! wait_for 30 exited "$pid"; then
		fail "$case launch $n: still running 30 s after its window was closed"
		stop_app "$pid"
	fi
	wait "$pid" 2>/dev/null

	read -r x y width height <<<"$geometry"
	read -r left right top bottom <<<"$extents"
	local outer="$((x - left)) $((y - top)) $((width + left + right)) $((height + top + bottom))"
	saved=$(saved_bounds "$state")
	cp "$state" "$out/$case-state-$n.json" 2>/dev/null
	# The app's own log, appended to by every launch of the profile: it notes
	# what each window's first size measurement found and who applied it.
	cp "$profile/config/@oh-my-pi/omp-gui/logs/gui-runtime.jsonl" "$out/$case-runtime.jsonl" 2>/dev/null
	note "$case launch $n: client $geometry, frame $extents (left right top bottom), outer $outer, saved $saved"
	[[ $saved == "$outer" ]] || fail "$case launch $n: saved $saved is not the client plus its frame, $outer"
}

note "fresh profile: three launches"
fresh_first=""
for n in 1 2 3; do
	cycle fresh "$n"
	read -r _ _ width height <<<"$saved"
	[[ "${width:-} ${height:-}" == "1400 900" ]] || fail "fresh launch $n: saved ${width:-?}x${height:-?}, expected 1400x900"
	if [[ $n == 1 ]]; then
		fresh_first=$saved
	elif [[ $saved != "$fresh_first" ]]; then
		fail "fresh launch $n: saved $saved, launch 1 saved $fresh_first"
	fi
done

seed='{"windowState":{"width":1300,"height":850,"x":40,"y":30,"isMaximized":false}}'
mkdir -p "$HOME/profile-seeded/config/@oh-my-pi/omp-gui"
echo "$seed" >"$HOME/profile-seeded/config/@oh-my-pi/omp-gui/window-state.json"
note "seeded profile: three launches from $seed"
for n in 1 2 3; do
	cycle seeded "$n"
	[[ $saved == "40 30 1300 850" ]] || fail "seeded launch $n: saved ${saved:-nothing}, expected the seed 40 30 1300 850"
done

if ((failed)); then
	note "RESULT: FAIL"
	exit 1
fi
note "RESULT: PASS"
