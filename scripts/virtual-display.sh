#!/usr/bin/env bash
# A virtual X display for running the GUI out of sight: dev builds, debugging
# and e2e specs open their windows here instead of on the desktop.
#
#   scripts/virtual-display.sh start            start display :99, or reuse the running one
#   scripts/virtual-display.sh run -- CMD...    run CMD on it, starting it when needed
#   scripts/virtual-display.sh shot [FILE]      screenshot it and print the file path
#   scripts/virtual-display.sh xdotool ARGS...  send keys, text or pointer input to it
#   scripts/virtual-display.sh view             watch it in Remmina (VNC on 127.0.0.1:5999)
#   scripts/virtual-display.sh status           show the display, the viewer and the apps on it
#   scripts/virtual-display.sh stop             stop the viewer and the display
#
# `run` gives CMD a private session bus, so notifications and the tray icon
# never reach the desktop, and points the app's accessibility at the desktop's
# AT-SPI bus, so `orca computer` (the computer-use skill) can still read and
# operate its controls. It also sets XDG_SESSION_TYPE=x11, because the app picks
# its global-shortcut path from it and the window is on X11 here.
#
# The private bus starts no services. A bus that could would start
# xdg-desktop-portal on this display, and remote-desktop tools that follow the
# newest portal process to find the user's session (RustDesk's service does)
# would move to this display.
#
# `orca computer` synthesizes keys, text, scrolling and coordinate clicks on the
# real desktop, where they would land in whatever window the user has focused;
# `xdotool` here sends them to this display instead.
set -euo pipefail

number=99
display=:$number
vnc_port=5999
lock=/tmp/.X$number-lock
socket=/tmp/.X11-unix/X$number
state=${XDG_RUNTIME_DIR:-/tmp}/sai-atlas-virtual-display
mkdir -p "$state"

die() {
	echo "virtual-display: $*" >&2
	exit 1
}

need() {
	command -v "$1" >/dev/null || die "$1 is not installed: sudo apt install -y xvfb x11vnc xdotool"
}

# The PID of the Xvfb serving the display, from the X server's own lock file.
xvfb_pid() {
	local pid
	[[ -f $lock ]] || return 1
	pid=$(tr -d ' ' <"$lock")
	[[ -n $pid && $(cat "/proc/$pid/comm" 2>/dev/null) == Xvfb ]] || return 1
	echo "$pid"
}

vnc_pid() {
	local pid
	[[ -f $state/x11vnc.pid ]] || return 1
	pid=$(<"$state/x11vnc.pid")
	[[ $(cat "/proc/$pid/comm" 2>/dev/null) == x11vnc ]] || return 1
	echo "$pid"
}

start() {
	local holder
	xvfb_pid >/dev/null && return 0
	# Xvfb clears a lock whose owner is gone; a live owner that is not Xvfb is
	# someone else's server, and taking another display number would hide it.
	if [[ -f $lock ]]; then
		holder=$(tr -d ' ' <"$lock")
		if kill -0 "$holder" 2>/dev/null; then
			die "display $display is held by $(cat "/proc/$holder/comm" 2>/dev/null || echo "pid $holder"); stop it first"
		fi
	fi
	need Xvfb
	setsid Xvfb "$display" -screen 0 1920x1080x24 -nolisten tcp >"$state/xvfb.log" 2>&1 </dev/null &
	for _ in $(seq 50); do
		[[ -S $socket ]] && xvfb_pid >/dev/null && return 0
		sleep 0.1
	done
	die "Xvfb did not start; see $state/xvfb.log"
}

run() {
	local a11y vars
	[[ ${1-} == -- ]] && shift
	[[ $# -gt 0 ]] || die "usage: run -- CMD..."
	start
	# GDK_BACKEND too: a session that exports GDK_BACKEND=wayland would send GTK
	# windows to the real compositor's default socket even without WAYLAND_DISPLAY.
	vars=(-u WAYLAND_DISPLAY DISPLAY="$display" XDG_SESSION_TYPE=x11 GDK_BACKEND=x11)
	a11y=$(gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus --method org.a11y.Bus.GetAddress 2>/dev/null |
		sed -nE "s/^\('(.*)',\)$/\1/p" || true)
	if [[ -n $a11y ]]; then
		vars+=(AT_SPI_BUS_ADDRESS="$a11y" ACCESSIBILITY_ENABLED=1)
	else
		echo "virtual-display: no desktop accessibility bus; orca computer will not see this app" >&2
	fi
	# The stock session.conf without its service directories: calls to portals,
	# notifications or the tray fail at once instead of starting a service.
	cat >"$state/session.conf" <<-'EOF'
		<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
		 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
		<busconfig>
		  <type>session</type>
		  <keep_umask/>
		  <listen>unix:tmpdir=/tmp</listen>
		  <auth>EXTERNAL</auth>
		  <policy context="default">
		    <allow send_destination="*" eavesdrop="true"/>
		    <allow eavesdrop="true"/>
		    <allow own="*"/>
		  </policy>
		</busconfig>
	EOF
	exec env "${vars[@]}" dbus-run-session --config-file="$state/session.conf" -- "$@"
}

shot() {
	local file=${1:-$state/screen.png}
	xvfb_pid >/dev/null || die "display $display is not running"
	need import
	import -display "$display" -window root "$file"
	echo "$file"
}

view() {
	start
	need x11vnc
	need remmina
	if ! vnc_pid >/dev/null; then
		# Loopback only and no password: any local account could watch, which
		# is fine on a single-user machine. x11vnc refuses to start when the
		# environment says Wayland, even for an X display.
		setsid env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 \
			x11vnc -display "$display" -rfbport "$vnc_port" -localhost -nopw -forever -shared \
			>"$state/x11vnc.log" 2>&1 </dev/null &
		echo $! >"$state/x11vnc.pid"
		for _ in $(seq 50); do
			[[ -n $(ss -Hltn "sport = :$vnc_port") ]] && break
			sleep 0.1
		done
		[[ -n $(ss -Hltn "sport = :$vnc_port") ]] || die "x11vnc did not start; see $state/x11vnc.log"
	fi
	setsid remmina -c "vnc://127.0.0.1:$vnc_port" >/dev/null 2>&1 </dev/null &
}

status() {
	local pid environ cmdline stat ppid
	local -A on_display=()
	if pid=$(xvfb_pid); then echo "display $display: Xvfb pid $pid"; else echo "display $display: not running"; fi
	if pid=$(vnc_pid); then echo "viewer: x11vnc pid $pid on 127.0.0.1:$vnc_port"; else echo "viewer: not running"; fi
	for environ in /proc/[0-9]*/environ; do
		pid=${environ#/proc/}
		pid=${pid%/environ}
		# Other users' processes are unreadable; stderr goes first so the
		# failing redirect is silenced too.
		grep -qxF "DISPLAY=$display" < <(tr '\0' '\n' 2>/dev/null <"$environ") && on_display[$pid]=1
	done
	# Only processes whose parent is not on the display are listed: stopping one
	# takes its children with it (WebKit helpers, the sidecar). Services the
	# private session bus started appear on their own.
	for pid in $(printf '%s\n' "${!on_display[@]}" | sort -n); do
		stat=$(cat "/proc/$pid/stat" 2>/dev/null) || continue
		stat=${stat##*) }
		ppid=${stat#* }
		ppid=${ppid%% *}
		[[ -n ${on_display[$ppid]-} ]] && continue
		cmdline=$(tr '\0' ' ' 2>/dev/null <"/proc/$pid/cmdline") || continue
		[[ $cmdline == *--type=* || $pid == "$(vnc_pid)" ]] && continue
		printf 'pid %s: %s\n' "$pid" "${cmdline:0:140}"
	done
}

stop() {
	local pid
	if pid=$(vnc_pid); then kill "$pid"; fi
	rm -f "$state/x11vnc.pid"
	if pid=$(xvfb_pid); then kill "$pid"; fi
}

case ${1-} in
start | run | shot | view | status | stop)
	command=$1
	shift
	"$command" "$@"
	;;
xdotool)
	shift
	xvfb_pid >/dev/null || die "display $display is not running"
	need xdotool
	exec env DISPLAY="$display" xdotool "$@"
	;;
*)
	sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
	exit 2
	;;
esac
