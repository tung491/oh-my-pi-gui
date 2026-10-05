#!/usr/bin/env bash
# Starts the audio stack of an Ubuntu desktop (PipeWire, WirePlumber,
# pipewire-pulse) inside the current session bus and gives it a fake
# microphone, for e2e-tauri/fake-mic.probe.ts. Run it as the session's user,
# under dbus-run-session, with XDG_RUNTIME_DIR set (mode 0700). It returns once
# the PulseAudio socket is up, leaving the daemons and the tone running;
# their PIDs are in $XDG_RUNTIME_DIR/fake-mic.pids.
#
# Devices: `fake-out`, a null sink (the Audio/Sink the AudioContext destination
# opens), and `fake-mic`, a pipe source (an ordinary Audio/Source that reads
# s16le PCM from a FIFO on its own clock) fed a 440 Hz tone by gst-launch-1.0.
# Both become the defaults. Not a null sink's `.monitor` (WebKit drops sources
# with device.class=monitor), and not a virtual source or loopback fed through
# the graph: under PipeWire 1.6 (Ubuntu 26.04) those stay suspended in a
# container and carry no signal. Needs pipewire, pipewire-pulse, wireplumber,
# pulseaudio-utils (pactl), gstreamer1.0-tools and gstreamer1.0-plugins-base.
set -euo pipefail

: "${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR must be set}"
: "${DBUS_SESSION_BUS_ADDRESS:?run under dbus-run-session}"
log=${FAKE_MIC_LOG_DIR:-$XDG_RUNTIME_DIR}
pids=$XDG_RUNTIME_DIR/fake-mic.pids
: >"$pids"

start() {
	local name=$1
	shift
	"$@" >"$log/$name.log" 2>&1 &
	echo "$! $name" >>"$pids"
}

start pipewire pipewire
start wireplumber wireplumber
start pipewire-pulse pipewire-pulse

for _ in $(seq 100); do
	[[ -S $XDG_RUNTIME_DIR/pulse/native ]] && pactl info >/dev/null 2>&1 && break
	sleep 0.1
done
if ! pactl info >/dev/null 2>&1; then
	echo "fake-mic: the PulseAudio socket never came up" >&2
	tail -n 20 "$log"/pipewire*.log "$log"/wireplumber.log >&2 || true
	exit 1
fi

fifo=$XDG_RUNTIME_DIR/fake-mic.fifo
rm -f "$fifo"
mkfifo "$fifo"
pactl load-module module-null-sink sink_name=fake-out >/dev/null
pactl load-module module-pipe-source source_name=fake-mic file="$fifo" format=s16le rate=48000 channels=1 >/dev/null
pactl set-default-sink fake-out
pactl set-default-source fake-mic
# Unbuffered, so the source reads the tone as it is produced rather than silence.
start tone gst-launch-1.0 audiotestsrc is-live=true wave=sine freq=440 \
	! audio/x-raw,format=S16LE,rate=48000,channels=1 ! filesink buffer-mode=unbuffered location="$fifo"
# The source must carry the tone before any app records it.
level=$(timeout 10 gst-launch-1.0 -m pulsesrc device=fake-mic num-buffers=30 ! level interval=100000000 ! fakesink 2>&1 |
	grep -oE 'rms=\(GValueArray\)< -?[0-9.]+' | tail -n 1 | grep -oE -- '-?[0-9.]+$' || true)
if [[ -z $level ]] || awk -v db="$level" 'BEGIN { exit !(db < -40) }'; then
	echo "fake-mic: no tone at fake-mic (rms ${level:-none} dB)" >&2
	exit 1
fi
echo "fake-mic level: ${level} dB rms"

pactl info | grep -E '^(Server Name|Server Version|Default Sink|Default Source):'
pactl list sources short
