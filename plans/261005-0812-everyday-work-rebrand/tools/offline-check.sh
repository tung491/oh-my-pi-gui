#!/usr/bin/env bash
# Offline check of the installed Sai ATLAS .deb: one file of each kind through
# the three starter cards with no network except the host's Ollama, a typed
# "run ls" that must run no shell, and the LibreOffice timeout survival check.
#
#   bash offline-check.sh [--deb PATH] [--out DIR] [--lang vi]
#
# --lang vi runs the Vietnamese pass (offline-check/offline-vi.e2e.ts) instead of
# the default English check: the app is set to Vietnamese through its settings file.
#
# Network: the app container runs with --network none (only `lo`). A relay
# container on host networking listens on a Unix socket in a shared temp dir
# and connects each client to the host's 127.0.0.1:11434 and nowhere else; the
# app container's own socat turns its 127.0.0.1:11434 into that socket. No
# host firewall rule or host process is involved, and both containers are
# removed on exit.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tools=$here/offline-check
worktree=${OFFLINE_WORKTREE:-/home/tung491/WORK/worktrees/rebrand-integration}
smoke_image=sai-atlas-tauri-deb-smoke
image=sai-atlas-offline-check
container=sai-atlas-offline-check
relay=sai-atlas-offline-relay

die() { echo "offline-check: $*" >&2; exit 1; }
deb=""
out=""
lang=""
while [[ $# -gt 0 ]]; do
	case $1 in
	--deb) deb=${2:?}; shift ;;
	--out) out=${2:?}; shift ;;
	--lang) lang=${2:?}; [[ $lang == vi || $lang == en ]] || die "--lang takes vi or en"; shift ;;
	*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
	shift
done

[[ -n $deb ]] || deb=$(ls -t "$worktree"/src-tauri/target-linux-2404/x86_64-unknown-linux-gnu/release/bundle/deb/*.deb | head -n 1)
[[ -f $deb ]] || die "no .deb"
deb=$(realpath "$deb")
out=${out:-$(mktemp -d /tmp/offline-check-XXXXXX)}
mkdir -p "$out"
curl -fsS --max-time 5 http://127.0.0.1:11434/api/tags >/dev/null || die "the host's Ollama does not answer"
for name in "$container" "$relay"; do
	docker ps -a --format '{{.Names}}' | grep -qx "$name" && die "a container named $name exists"
done

docker build -q -t "$smoke_image" "$worktree/scripts/tauri-deb-smoke" >/dev/null
docker build -q -t "$image" "$tools" >/dev/null

sock_dir=$(mktemp -d /tmp/offline-relay-XXXXXX)
chmod 0777 "$sock_dir"
cleanup() {
	docker rm -f "$container" "$relay" >/dev/null 2>&1 || true
	rm -rf "$sock_dir"
}
trap cleanup EXIT INT TERM

docker run -d --rm --name "$relay" --network host --entrypoint socat \
	-v "$sock_dir:/relay" "$image" \
	UNIX-LISTEN:/relay/ollama.sock,fork,mode=0666 TCP:127.0.0.1:11434 >/dev/null
for _ in $(seq 50); do [[ -S $sock_dir/ollama.sock ]] && break; sleep 0.1; done
[[ -S $sock_dir/ollama.sock ]] || die "the relay did not start"

{
	echo "started: $(date --iso-8601=seconds)"
	echo "deb: $deb"
	echo "language: ${lang:-en (default)}"
	echo "deb sha256: $(sha256sum "$deb" | cut -d' ' -f1)"
	echo "image: $(docker image inspect -f '{{.Id}}' "$image")"
} >"$out/run-info.txt"

status=0
docker run --rm --init --name "$container" \
	--network none \
	--security-opt seccomp=unconfined \
	--security-opt apparmor=unconfined \
	--security-opt systempaths=unconfined \
	--ulimit core=1 \
	-e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" -e OFFLINE_ACTION_TIMEOUT_MS -e OFFLINE_LANG="$([[ $lang == vi ]] && echo vi)" \
	-v "$worktree:/repo" \
	-v "$deb:/tmp/sai-atlas.deb:ro" \
	-v "$tools:/tools:ro" \
	-v "$sock_dir:/relay" \
	-v "$out:/out" \
	"$image" || status=$?

echo "finished: $(date --iso-8601=seconds) (exit $status)" >>"$out/run-info.txt"
echo "Evidence in $out"
exit "$status"
