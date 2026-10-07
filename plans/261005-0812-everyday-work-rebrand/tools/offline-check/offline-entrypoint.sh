#!/usr/bin/env bash
# Container entrypoint of the offline check (offline-check.sh starts it with
# --network none, so the container has only a loopback interface).
#
# Root stage: installs the mounted .deb the way `sudo apt install` does (every
# dependency is already in the image, so no download), starts the one allowed
# route out (127.0.0.1:11434 -> /relay/ollama.sock, which the relay container
# bridges to the host's Ollama), proves that nothing else is reachable, writes
# the job inputs (including a large .xls for the LibreOffice timeout check) and
# hands over to the host user's uid. Session stage (--session, inside a private
# session bus): starts a headless weston, runs offline.conf.ts, then copies the
# evidence to /out.
#
# Mounts: /repo (GUI worktree: node_modules, e2e-tauri helpers), /tools (this
# directory, read-only), /out (evidence), /relay (the Ollama socket),
# /tmp/sai-atlas.deb. Env: HOST_UID, HOST_GID, OFFLINE_ACTION_TIMEOUT_MS,
# OFFLINE_LANG (vi = the Vietnamese pass: the GUI settings file is seeded with
# `language: vi`, the inputs are Vietnamese and the large .xls is not made).
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
	[[ -S $XDG_RUNTIME_DIR/wayland-1 ]] || { cat "$XDG_RUNTIME_DIR/weston.log" >&2; exit 1; }

	work=$(mktemp -d /tmp/offline-work-XXXXXX)
	cp /tools/offline.conf.ts /tools/offline.e2e.ts /tools/offline-vi.e2e.ts /tools/offline-helpers.ts /tools/offline-app-launcher.sh "$work/"
	ln -s /repo/node_modules "$work/node_modules"
	ln -s /repo "$work/repo"
	mkdir -p /out/screens
	export OFFLINE_WORK=$work OFFLINE_OUT=/out

	status=0
	(
		cd /repo
		WAYLAND_DISPLAY=wayland-1 XDG_SESSION_TYPE=wayland \
			node node_modules/@wdio/cli/bin/wdio.js run "$work/offline.conf.ts"
	) || status=$?

	state=/out/container-state
	mkdir -p "$state"
	{
		echo "## ~/Documents (find)"
		find "$HOME/Documents" -type f -printf '%TY-%Tm-%Td %TT %10s %p\n' 2>/dev/null | sort
		echo "## ls ~/Documents/Sai ATLAS (end of run)"
		ls -la "$HOME/Documents/Sai ATLAS" 2>&1 || true
	} >"$state/listing.txt"
	# The Verify grep, over every session of the run.
	{
		echo "\$ grep -rlE '\"name\": ?\"bash\"' ~/.omp/agent/sessions"
		grep -rlE '"name": ?"bash"' "$HOME/.omp/agent/sessions" && echo "(exit 0: MATCHES)" || echo "(exit $?: no match)"
	} >/out/bash-grep.txt
	cp -r "$HOME/.omp/agent/sessions" "$state/sessions" 2>/dev/null || true
	cp -r "$HOME/.config/@oh-my-pi/omp-gui/logs" "$state/gui-logs" 2>/dev/null || true
	rm -rf "$work"
	exit "$status"
fi

apt-get install -y --no-install-recommends /tmp/sai-atlas.deb >/out/apt-install.log 2>&1

# The only route out: Ollama on the host, through the relay socket.
[[ -S /relay/ollama.sock ]] || { echo "no relay socket at /relay/ollama.sock" >&2; exit 1; }
socat TCP-LISTEN:11434,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/relay/ollama.sock &
for _ in $(seq 50); do (exec 3<>/dev/tcp/127.0.0.1/11434) 2>/dev/null && break; sleep 0.1; done

# Evidence that the container is offline except for that route.
{
	echo "## ip -o link"
	ip -o link
	echo "## ip route"
	ip route 2>&1 || true
	echo "## outbound probes (timeout 5 s each)"
	for target in 1.1.1.1/443 8.8.8.8/53 140.82.112.3/443; do
		if timeout 5 bash -c "exec 3<>/dev/tcp/${target%/*}/${target#*/}" 2>/dev/null; then
			echo "$target: CONNECTED"
		else
			echo "$target: refused/unreachable"
		fi
	done
	echo "## getent hosts github.com"
	getent hosts github.com || echo "(no answer)"
	echo "## Ollama via 127.0.0.1:11434"
	node -e 'fetch("http://127.0.0.1:11434/api/tags").then(r=>r.json()).then(j=>console.log(j.models.map(m=>m.name).join("\n")))' 2>&1
} >/out/network.txt

uid=${HOST_UID:?HOST_UID is not set}
gid=${HOST_GID:?HOST_GID is not set}
user=$(getent passwd "$uid" | cut -d: -f1 || true)
if [[ -z $user ]]; then
	getent group "$gid" >/dev/null || groupadd -g "$gid" offline
	useradd -m -u "$uid" -g "$gid" offline
	user=offline
fi
home=$(getent passwd "$user" | cut -d: -f6)
install -d -m 0755 -o "$uid" -g "$gid" "$home"

# Inputs outside Documents/Sai ATLAS, so that folder holds only what the jobs saved.
inputs=$home/Inputs
mkdir -p "$inputs" "$home/Documents"
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
if [[ ${OFFLINE_LANG:-} == vi ]]; then
	# The language the user picked, in the GUI settings file the app reads at startup
	# (`<appData>/@oh-my-pi/omp-gui/prefs.json`, key `language`).
	install -d -m 0755 "$home/.config/@oh-my-pi/omp-gui"
	printf '{"language":"vi"}\n' >"$home/.config/@oh-my-pi/omp-gui/prefs.json"
	cat >"$inputs/ghi-chu-cuoc-hop.md" <<'MD'
# Họp nhóm ngày 3 tháng 10

- Doanh số tháng 9 tăng 12%, chủ yếu nhờ các cửa hàng miền Bắc.
- Đối tác giao hàng mới rút thời gian giao trung bình từ 4 ngày xuống 2 ngày.
- Hai nhân viên mới hoàn tất đào tạo vào tuần sau.
- Rủi ro: hợp đồng máy in hết hạn vào tháng 11 và chưa được gia hạn.
- Việc tiếp theo: chị Lan soạn các phương án gia hạn; anh Minh chuẩn bị chỉ tiêu doanh số quý 4.
MD
	cat >"$inputs/doanh-so-cua-hang.csv" <<'CSV'
Cửa hàng;Tháng ;Doanh số;Hàng trả lại
Hà Nội;2026-07; 1.200,5 ;15
hà nội ;2026-08;1.350,0;
Hà Nội;2026-09;1.500,25;22
Đà Nẵng;2026-07;980,75;9
Đà Nẵng;2026-08;;12
Đà Nẵng;2026-09;1.100,0;10
Đà Nẵng;2026-09;1.100,0;10
CSV
	cat >"$inputs/cap-nhat-du-an.md" <<'MD'
# Cập nhật dự án chuyển văn phòng

## Tình hình hiện tại
Hợp đồng thuê văn phòng mới đã ký và mặt bằng đã chốt.

## Việc tiếp theo
- Lắp đặt cáp mạng trong tuần 20 tháng 10.
- Nội thất được giao ngày 27 tháng 10.
- Nhân viên chuyển sang văn phòng mới ngày 3 tháng 11.

## Rủi ro
Nhà thầu cáp mạng chỉ còn một tuần dự phòng; nếu chậm, ngày chuyển văn phòng sẽ lùi lại.
MD
fi
# A large legacy .xls (60 000 rows), so its conversion runs long enough to be stopped mid-way.
if [[ ${OFFLINE_LANG:-} != vi ]]; then
big=$(mktemp -d /tmp/big-xls-XXXXXX)
awk 'BEGIN { print "Store,Month,Product,Sales,Returns,Notes"; for (i = 1; i <= 60000; i++) printf "Store %d,2026-%02d,Item %d,%d,%d,row %d note\n", i % 37, (i % 12) + 1, i % 501, (i * 7) % 5000, i % 13, i }' >"$big/yearly-sales.csv"
soffice --headless "-env:UserInstallation=file://$big/profile" --convert-to xls --outdir "$big" "$big/yearly-sales.csv" >/out/xls-make.log 2>&1
mv "$big/yearly-sales.xls" "$inputs/yearly-sales.xls"
rm -rf "$big"
fi
chown -R "$uid:$gid" "$home"

runtime=/run/user/$uid
install -d -m 0700 -o "$uid" -g "$gid" "$runtime"

exec setpriv --reuid="$uid" --regid="$gid" --init-groups \
	env HOME="$home" USER="$user" XDG_RUNTIME_DIR="$runtime" \
	OFFLINE_ACTION_TIMEOUT_MS="${OFFLINE_ACTION_TIMEOUT_MS:-}" OFFLINE_LANG="${OFFLINE_LANG:-}" \
	CARGO_HOME_BIN="$CARGO_HOME_BIN" PATH="$PATH" \
	dbus-run-session -- "$0" --session
