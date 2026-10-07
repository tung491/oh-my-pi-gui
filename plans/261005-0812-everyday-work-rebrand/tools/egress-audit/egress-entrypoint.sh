#!/usr/bin/env bash
# Container entrypoint of the egress audit (egress-audit.sh starts it).
#
# Root stage: installs the mounted .deb the way `sudo apt install` does, seeds
# the realistic power-user home (Task 9.6 step 2) and hands over to the host
# user's uid. Session stage (--session, inside a private session bus): starts a
# headless weston, runs the WebDriver run (egress.conf.ts) whose launcher wraps
# the app in strace, then copies the container-side evidence to /out.
#
# Mounts: /repo (GUI worktree: node_modules, e2e-tauri helpers), /tools (this
# directory, read-only), /out (the evidence directory), /tmp/sai-atlas.deb.
# Env: HOST_UID, HOST_GID, EGRESS_DRY_RUN (1 = stop at the first-run screen),
# EGRESS_ACTION_TIMEOUT_MS, EGRESS_MODEL.
set -euo pipefail

if [[ ${1:-} == --session ]]; then
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

	# The spec and config import @wdio/* and the worktree's e2e helpers; Node's
	# ESM resolver finds them through two links beside the copied files.
	work=$(mktemp -d /tmp/egress-work-XXXXXX)
	cp /tools/egress.conf.ts /tools/egress.e2e.ts /tools/egress-app-launcher.sh "$work/"
	ln -s /repo/node_modules "$work/node_modules"
	ln -s /repo "$work/repo"
	mkdir -p /out/screens /out/ps
	export EGRESS_WORK=$work EGRESS_OUT=/out

	status=0
	(
		cd /repo
		WAYLAND_DISPLAY=wayland-1 XDG_SESSION_TYPE=wayland \
			node node_modules/@wdio/cli/bin/wdio.js run "$work/egress.conf.ts"
	) || status=$?

	# Evidence that lives only in the container's home: what the jobs saved,
	# which tripwires fired, the session files and the app's own log.
	state=/out/container-state
	mkdir -p "$state"
	{
		echo "## ~/Documents (find)"
		find "$HOME/Documents" -type f -printf '%TY-%Tm-%Td %TT %10s %p\n' 2>/dev/null | sort
		echo "## tripwires fired (~/.egress-tripwires)"
		ls -la "$HOME/.egress-tripwires" 2>/dev/null || echo "(none)"
		cat "$HOME"/.egress-tripwires/* 2>/dev/null || true
		echo "## ~/.omp/agent (find)"
		find "$HOME/.omp/agent" -maxdepth 3 -printf '%y %p\n' 2>/dev/null | sort
	} >"$state/listing.txt"
	cp -r "$HOME/.omp/agent/sessions" "$state/sessions" 2>/dev/null || true
	cp -r "$HOME/.config/@oh-my-pi/omp-gui/logs" "$state/gui-logs" 2>/dev/null || true
	cp "$XDG_RUNTIME_DIR/weston.log" "$state/weston.log" 2>/dev/null || true
	rm -rf "$work"
	exit "$status"
fi

apt-get install -y --no-install-recommends /tmp/sai-atlas.deb

uid=${HOST_UID:?HOST_UID is not set}
gid=${HOST_GID:?HOST_GID is not set}
user=$(getent passwd "$uid" | cut -d: -f1 || true)
if [[ -z $user ]]; then
	getent group "$gid" >/dev/null || groupadd -g "$gid" egress
	useradd -m -u "$uid" -g "$gid" egress
	user=egress
fi
home=$(getent passwd "$user" | cut -d: -f6)
install -d -m 0755 -o "$uid" -g "$gid" "$home"

# The seeded power-user setup. None of it may have any effect on a pack session;
# the MCP server and the extension leave a marker and try one connection to a
# TEST-NET-1 address (RFC 5737, never routed) if anything ever starts them, so
# a load shows up both in ~/.egress-tripwires and as a connect() row.
agent=$home/.omp/agent
mkdir -p "$agent/extensions" "$home/.egress-tripwires" "$home/Documents/egress-inputs"
cat >"$agent/config.yml" <<'YAML'
tools:
  approval:
    write: allow
YAML
cat >"$agent/mcp-notes-server.sh" <<'SH'
#!/bin/bash
# A stdio MCP server a power user added. Tripwire: records that it started and
# tries one connection to 192.0.2.12:9.
echo "mcp notes server started pid $$ at $(date +%s.%N)" >>"$HOME/.egress-tripwires/mcp-server"
(exec 3<>/dev/tcp/192.0.2.12/9) 2>/dev/null &
exec cat >/dev/null
SH
chmod 0755 "$agent/mcp-notes-server.sh"
cat >"$agent/mcp.json" <<JSON
{
  "mcpServers": {
    "notes": {
      "type": "stdio",
      "command": "$agent/mcp-notes-server.sh",
      "args": []
    }
  }
}
JSON
cat >"$agent/extensions/egress-tripwire.ts" <<'TS'
// A user extension. Tripwire: records that it loaded and tries one connection
// to 192.0.2.11:9.
import { appendFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export default function () {
	appendFileSync(join(homedir(), ".egress-tripwires", "extension"), `extension loaded pid ${process.pid} at ${Date.now() / 1000}\n`);
	const socket = connect({ host: "192.0.2.11", port: 9 });
	socket.on("error", () => socket.destroy());
	socket.setTimeout(2_000, () => socket.destroy());
}
TS
# Made-up provider keys, never real ones.
cat >"$home/.env" <<'ENV'
ANTHROPIC_API_KEY=sk-ant-egress-audit-made-up-0000000000000000
OPENAI_API_KEY=sk-egress-audit-made-up-0000000000000000
ENV
chmod 0600 "$home/.env"

# Inputs for the three file jobs and the URL request.
inputs=$home/Documents/egress-inputs
cat >"$inputs/meeting-notes.md" <<'MD'
# Team meeting, 3 October

- Sales rose 12% in September, mostly from the northern stores.
- The new delivery partner cut average delivery time from 4 days to 2.
- Two staff members finish onboarding next week.
- Risk: the printer contract ends in November and has not been renewed.
- Next steps: Lan drafts the renewal options; Minh prepares the Q4 sales targets.
MD
cat >"$inputs/store-sales.csv" <<'CSV'
Store, Month ,Sales,Returns
North,2026-07, 1200 ,15
north ,2026-08,1350,
North,2026-09,1500,22
South,2026-07,980,9
South,2026-08,,12
South,2026-09,1100,10
South,2026-09,1100,10
CSV
cat >"$inputs/project-update.md" <<'MD'
# Office move project update

## Where we are
The new office lease is signed and the floor plan is final.

## What is next
- Network cabling is installed in the week of 20 October.
- Furniture arrives on 27 October.
- Staff move on 3 November.

## Risks
The cabling contractor has one week of slack; a delay moves the staff move date.
MD
cat >"$inputs/supplier-note.txt" <<'TXT'
Note from our paper supplier, 1 October:

Prices for A4 copy paper go up by 6% from 1 November. Orders placed before
25 October keep the current price. The full price list is at
https://example.com/supplier/price-list-2026.pdf and the order form is at
https://example.org/orders/new
TXT
chown -R "$uid:$gid" "$home"

# Wayland sockets live in XDG_RUNTIME_DIR, which must be the user's own and 0700.
runtime=/run/user/$uid
install -d -m 0700 -o "$uid" -g "$gid" "$runtime"

exec setpriv --reuid="$uid" --regid="$gid" --init-groups \
	env HOME="$home" USER="$user" XDG_RUNTIME_DIR="$runtime" \
	EGRESS_DRY_RUN="${EGRESS_DRY_RUN:-0}" EGRESS_ACTION_TIMEOUT_MS="${EGRESS_ACTION_TIMEOUT_MS:-}" EGRESS_MODEL="${EGRESS_MODEL:-}" \
	CARGO_HOME_BIN="$CARGO_HOME_BIN" PATH="$PATH" \
	dbus-run-session -- "$0" --session
