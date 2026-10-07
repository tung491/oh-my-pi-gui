#!/usr/bin/env bash
# Checks, on a SAI OS (Ubuntu GNOME) machine, every command the Sai ATLAS
# assistant pack runs for computer help.
#
# Part 1 changes nothing: each setting is written back with the value it
# already has, and the read-only diagnose commands run.
# Part 2 flips each setting for a few seconds, asks whether you saw it change,
# then restores it, and opens each GNOME Settings page and asks whether the
# right one appeared. Every setting goes back to its original value when the
# script ends, also on Ctrl-C.
#
# Usage: bash sai-os-check.sh            Part 1 and Part 2   -> ~/sai-os-check.txt
#        bash sai-os-check.sh --auto     Part 1 only         -> ~/sai-os-check.txt
#        bash sai-os-check.sh --recheck  Do Not Disturb and the Sound and Printers
#                                        pages only          -> ~/sai-os-recheck.txt
# Paste the results file back.
set -u

MODE=${1:-}
case $MODE in
	"" | --auto) OUT="$HOME/sai-os-check.txt" ;;
	--recheck) OUT="$HOME/sai-os-recheck.txt" ;;
	*) echo "usage: bash sai-os-check.sh [--auto|--recheck]" >&2; exit 2 ;;
esac
: >"$OUT"

SINK=@DEFAULT_AUDIO_SINK@
PANELS="network wifi bluetooth display sound printers power keyboard notifications background"
KEYS=("org.gnome.desktop.interface color-scheme"
	"org.gnome.settings-daemon.plugins.color night-light-enabled"
	"org.gnome.desktop.notifications show-banners"
	"org.gnome.desktop.interface text-scaling-factor")
# Night light only tints the screen inside its schedule, so Part 2 opens a window around now.
SCHEDULE_KEYS=("org.gnome.settings-daemon.plugins.color night-light-schedule-automatic"
	"org.gnome.settings-daemon.plugins.color night-light-schedule-from"
	"org.gnome.settings-daemon.plugins.color night-light-schedule-to")
# Settings runs as one process whose name is longer than pgrep's 15-character limit.
SETTINGS_PROC='^(/usr/bin/)?gnome-control-center( |$)'

log() { printf '%s\n' "$*" | tee -a "$OUT"; }

run() { # label, argv...
	local label=$1; shift
	local out rc
	out=$(timeout 10 "$@" 2>&1); rc=$?
	if [ $rc -eq 0 ]; then
		log "OK    $label: $*"
	else
		log "FAIL  $label: $* (exit $rc: $(printf '%s' "$out" | head -n 2 | tr '\n' ' '))"
	fi
	return $rc
}

# A check whose exit 1 only means "nothing found" (pgrep with no match).
run_found() { # label, argv...
	local label=$1; shift
	local rc
	timeout 10 "$@" >/dev/null 2>&1; rc=$?
	case $rc in
		0) log "OK    $label: $* (found)" ;;
		1) log "OK    $label: $* (not found, exit 1)" ;;
		*) log "FAIL  $label: $* (exit $rc)" ;;
	esac
}

ask() { # question -> logs YES or NO
	local a=""
	read -r -p "$1 [y/n] " a </dev/tty || a=""
	case $a in y | Y) log "YES   $1" ;; *) log "NO    $1" ;; esac
}

# Prints the current volume as wpctl reports it ("0.34"), or nothing.
current_volume() {
	wpctl get-volume "$SINK" 2>/dev/null | awk '/^Volume:/ {print $2}'
}

# ---------------------------------------------------------------- Part 1

part1_settings() {
	log "== Part 1: settings keys (written back unchanged)"
	local spec schema key cur
	for spec in "${KEYS[@]}"; do
		read -r schema key <<<"$spec"
		if cur=$(gsettings get "$schema" "$key" 2>&1); then
			run "set $schema $key (unchanged $cur)" gsettings set "$schema" "$key" "$cur"
		else
			log "FAIL  get $schema $key: $cur"
		fi
	done

	# wpctl prints "Volume: 0.34" and appends " [MUTED]" when muted. The pack sets "<n>%",
	# so that form is used whenever the current level is a whole percent.
	local volline vol pct
	volline=$(wpctl get-volume "$SINK" 2>&1)
	vol=$(printf '%s' "$volline" | awk '/^Volume:/ {print $2}')
	if [ -z "$vol" ]; then
		log "FAIL  wpctl get-volume $SINK: $volline"
		return
	fi
	pct=$(awk -v v="$vol" 'BEGIN { p = v * 100; r = sprintf("%.0f", p); if (p - r < 0.001 && r - p < 0.001) print r }')
	if [ -n "$pct" ]; then
		run "volume (unchanged ${pct}%)" wpctl set-volume "$SINK" "${pct}%"
	else
		run "volume (unchanged $vol, not a whole percent)" wpctl set-volume "$SINK" "$vol"
	fi
	log "INFO  muted: $(case $volline in *MUTED*) echo yes ;; *) echo no ;; esac)"
}

part1_diagnose() {
	log "== Part 1: read-only diagnose commands"
	run "Connection" nmcli -t -f STATE,CONNECTIVITY general
	run "Wi-Fi radio" nmcli -t -f WIFI radio
	run "Devices" nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device
	run "Default output" wpctl inspect "$SINK"
	log "INFO  default output: $(wpctl inspect "$SINK" 2>/dev/null | grep -m 1 'node.description' | sed 's/^[ *]*//')"
	run "Volume and mute" wpctl get-volume "$SINK"
	run "Printers" lpstat -p -d
	run "Waiting print jobs" lpstat -o
	run "Home disk" df -h --output=target,size,avail,pcent /home
	run "System disk" df -h --output=target,size,avail,pcent /
	run "Running time" uptime
	run "Memory" free -h
	run "Busiest programs" ps -eo comm,%cpu,%mem --sort=-%cpu
	run "Bluetooth radio" rfkill list bluetooth
	run "Bluetooth adapter" bluetoothctl show
	run "Screens (XWayland view on Wayland)" xrandr --listmonitors
	run "Input method" im-config -m
	run_found "IBus running" pgrep -l -x ibus-daemon
	run_found "Fcitx running" pgrep -l -x fcitx5
	run "Batteries" upower -e
	run "Updates" apt list --upgradable
	run "Network status" nmcli -t -f STATE general
}

part1_launchers() {
	log "== Part 1: launchers, Settings pages and apps"
	local tool panel id listed monitor=""
	for tool in gio gnome-control-center wpctl gsettings; do
		if command -v "$tool" >/dev/null; then log "OK    $tool installed"; else log "FAIL  $tool missing"; fi
	done
	listed=$(gnome-control-center --list 2>/dev/null | sed 's/^[[:space:]]*//')
	for panel in $PANELS; do
		if printf '%s\n' "$listed" | grep -qx "$panel"; then
			log "OK    Settings page $panel listed"
		else
			log "FAIL  Settings page $panel not in gnome-control-center --list"
		fi
	done
	for id in net.nokyan.Resources gnome-system-monitor; do
		if [ -f "/usr/share/applications/$id.desktop" ]; then monitor=$id; break; fi
	done
	if [ -n "$monitor" ]; then
		log "OK    system monitor $monitor.desktop"
	else
		log "FAIL  no system monitor (net.nokyan.Resources or gnome-system-monitor)"
	fi
	if [ -f /usr/share/applications/update-manager.desktop ]; then
		log "OK    app update-manager.desktop"
	else
		log "FAIL  app update-manager.desktop missing"
	fi
}

# ---------------------------------------------------------------- Part 2

declare -A ORIGINAL
ORIGINAL_VOLUME=""

save_settings() {
	local spec
	for spec in "${KEYS[@]}" "${SCHEDULE_KEYS[@]}"; do
		ORIGINAL[$spec]=$(gsettings get $spec)
	done
	ORIGINAL_VOLUME=$(current_volume)
}

restore_settings() {
	local spec
	for spec in "${KEYS[@]}" "${SCHEDULE_KEYS[@]}"; do
		gsettings set $spec "${ORIGINAL[$spec]}"
	done
	if [ -n "$ORIGINAL_VOLUME" ]; then wpctl set-volume "$SINK" "$ORIGINAL_VOLUME"; fi
}

flip() { # label schema key on-value
	local label=$1 schema=$2 key=$3 on=$4
	gsettings set "$schema" "$key" "$on" && sleep 4
	ask "$label: did the screen change?"
	gsettings set "$schema" "$key" "${ORIGINAL[$schema $key]}"
}

step_dark_mode() {
	if [ "${ORIGINAL[org.gnome.desktop.interface color-scheme]}" = "'prefer-dark'" ]; then
		flip "Dark mode off (default)" org.gnome.desktop.interface color-scheme default
	else
		flip "Dark mode on (prefer-dark)" org.gnome.desktop.interface color-scheme prefer-dark
	fi
}

step_night_light() {
	local now spec
	now=$(date +%-H)
	gsettings set org.gnome.settings-daemon.plugins.color night-light-schedule-automatic false
	gsettings set org.gnome.settings-daemon.plugins.color night-light-schedule-from "$(((now + 23) % 24)).0"
	gsettings set org.gnome.settings-daemon.plugins.color night-light-schedule-to "$(((now + 2) % 24)).0"
	flip "Night light on (the screen should turn warmer within a few seconds)" \
		org.gnome.settings-daemon.plugins.color night-light-enabled true
	for spec in "${SCHEDULE_KEYS[@]}"; do gsettings set $spec "${ORIGINAL[$spec]}"; done
}

step_text_size() {
	flip "Text size 1.5" org.gnome.desktop.interface text-scaling-factor 1.5
}

step_do_not_disturb() {
	# GNOME Shell reads show-banners when a notification arrives, and the new value
	# reaches the Shell separately from notify-send, so give it time to arrive first.
	gsettings set org.gnome.desktop.notifications show-banners false && sleep 2
	notify-send "Sai ATLAS check" "If you can see this, Do Not Disturb did not work" 2>/dev/null
	sleep 4
	ask "Do Not Disturb: did NO popup appear at the top of the screen in the last few seconds?"
	gsettings set org.gnome.desktop.notifications show-banners \
		"${ORIGINAL[org.gnome.desktop.notifications show-banners]}"
}

step_volume() {
	if [ -z "$ORIGINAL_VOLUME" ]; then
		log "FAIL  volume step skipped: wpctl get-volume $SINK gave no level"
		return
	fi
	wpctl set-volume "$SINK" 20% && sleep 3
	ask "Volume 20%: open the system menu at the top right; is the volume slider at about a fifth?"
	wpctl set-volume "$SINK" "$ORIGINAL_VOLUME"
}

step_settings_pages() { # panels...
	local panel was_running=no
	pgrep -f "$SETTINGS_PROC" >/dev/null && was_running=yes
	for panel in "$@"; do
		# Settings runs as one window; each call switches it to the named page. Some pages
		# take a few seconds to appear (Printers asks the print service first).
		gnome-control-center "$panel" >/dev/null 2>&1 &
		sleep 6
		ask "gnome-control-center $panel: is \"$panel\" the page shown now (its title at the top of Settings)?"
	done
	# Close Settings only when this script opened it.
	if [ "$was_running" = no ]; then pkill -f "$SETTINGS_PROC"; fi
}

# ---------------------------------------------------------------- Main

log "== System"
log "$(grep -E '^PRETTY_NAME=' /etc/os-release) desktop=${XDG_CURRENT_DESKTOP:-?} session=${XDG_SESSION_TYPE:-?} $(gnome-shell --version 2>/dev/null || echo 'gnome-shell missing')"

if [ "$MODE" != --recheck ]; then
	part1_settings
	part1_diagnose
	part1_launchers
fi
if [ "$MODE" = --auto ]; then
	log "== Done (auto). Results: $OUT"
	exit 0
fi

# Part 2 asks questions; without a terminal it would change settings nobody watches.
if ! { : </dev/tty; } 2>/dev/null; then
	log "== Part 2 skipped: no terminal to answer on. Results: $OUT"
	exit 1
fi

log "== Part 2: watch the screen"
save_settings
trap restore_settings EXIT
trap 'exit 130' INT TERM

if [ "$MODE" = --recheck ]; then
	step_do_not_disturb
	step_settings_pages sound printers
else
	step_dark_mode
	step_night_light
	step_text_size
	step_do_not_disturb
	step_volume
	# PANELS is a space-separated list, split on purpose.
	step_settings_pages $PANELS
fi
log "== Done. Results: $OUT"
