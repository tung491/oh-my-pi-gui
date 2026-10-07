#!/usr/bin/env bash
# Egress audit harness (everyday-work rebrand, Phase 9 Task 9.6).
#
# Installs the Sai ATLAS .deb in a clean Ubuntu 24.04 container (the deb smoke
# image plus strace), seeds a realistic power-user home (~/.omp/agent with
# config.yml, mcp.json and a user extension; ~/.env with made-up provider
# keys), points the app at the host's Ollama on loopback (host networking:
# the container's 127.0.0.1:11434 is the host's), runs the app under
# `strace -f -e trace=connect,sendto,sendmsg`, and drives every Task 9.6 step 3 action in
# order through WebDriver, stamping each action in timeline.tsv. Then it turns
# the trace into rows of (process, destination host:port, action).
#
#   bash egress-audit.sh --dry-run            # install, launch, stop at the first-run screen; nothing recorded
#   bash egress-audit.sh                      # the recorded session (needs the host Ollama trace running)
#   bash egress-audit.sh --report-only        # re-run the post-processing (after the Ollama trace stopped)
#
# Options: --deb PATH (default: the newest .deb of the worktree's Linux target),
# --out DIR (default: plans/reports/egress-261006; a dry run defaults to a
# fresh temp dir), --no-ollama-trace (record without the host Ollama trace).
# Env: EGRESS_WORKTREE (default /home/tung491/WORK/worktrees/rebrand-integration),
# EGRESS_ACTION_TIMEOUT_MS (per action, default 20 min), EGRESS_MODEL (an
# installed Ollama tag to run the jobs on instead of the one Get started picks,
# e.g. hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf:latest).
#
# Outputs in the evidence dir: egress-app.txt (raw trace), timeline.tsv,
# selected-model.txt, model-after.txt, dns-snapshot.tsv, run-info.txt,
# screens/*.png, ps/*.txt, container-state/ (saved files, tripwire markers,
# sessions, app logs), egress-rows.tsv and egress-rows.md. egress-ollama.txt is
# written by the user's own sudo strace of the host daemon.
#
# Network: tauri-driver and WebKitWebDriver listen on 127.0.0.1:4444 and :4445
# in the host's network namespace; a busy port is an error naming its owner.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tools=$here/egress-audit
worktree=${EGRESS_WORKTREE:-/home/tung491/WORK/worktrees/rebrand-integration}
default_out=/home/tung491/WORK/oh-my-pi-gui/plans/reports/egress-261006
smoke_image=sai-atlas-tauri-deb-smoke
image=sai-atlas-egress-audit
container=sai-atlas-egress-audit
ollama_url=http://127.0.0.1:11434

dry_run=0
report_only=0
need_ollama_trace=1
deb=""
out=""
while [[ $# -gt 0 ]]; do
	case $1 in
	--dry-run) dry_run=1 ;;
	--report-only) report_only=1 ;;
	--no-ollama-trace) need_ollama_trace=0 ;;
	--deb) deb=${2:?--deb needs a path}; shift ;;
	--out) out=${2:?--out needs a dir}; shift ;;
	-h | --help) sed -n '2,32p' "$0"; exit 0 ;;
	*) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
	esac
	shift
done

report() {
	command -v bun >/dev/null || { echo "bun is not on PATH; run: bun $tools/egress-report.ts $1" >&2; return 1; }
	bun "$tools/egress-report.ts" "$1"
}

if ((report_only)); then
	report "${out:-$default_out}"
	exit
fi

die() { echo "egress-audit: $*" >&2; exit 1; }

# --- Preflight -------------------------------------------------------------
command -v docker >/dev/null || die "docker is not installed"
[[ -d $worktree/node_modules/@wdio/cli ]] || die "WebdriverIO is not installed in $worktree; run: (cd $worktree && bun install)"
if [[ -z $deb ]]; then
	deb=$(ls -t "$worktree"/src-tauri/target-linux-2404/x86_64-unknown-linux-gnu/release/bundle/deb/*.deb 2>/dev/null | head -n 1 || true)
fi
[[ -n $deb && -f $deb ]] || die "no .deb found; build one with: (cd $worktree && bun run package:linux)"
deb=$(realpath "$deb")

tags=$(curl -fsS --max-time 5 "$ollama_url/api/tags") || die "the host's Ollama does not answer at $ollama_url"
grep -q '"name"' <<<"$tags" || die "the host's Ollama lists no model; the first-run screen needs an installed local model"

for port in 4444 4445; do
	owner=$(ss -ltnpH "sport = :$port" 2>/dev/null || true)
	[[ -z $owner ]] || die "port $port is in use; stop its owner instead of picking another port: $owner"
done
docker ps -a --format '{{.Names}}' | grep -qx "$container" && die "a container named $container exists; inspect it, then: docker rm -f $container"

if ((dry_run)); then
	out=${out:-$(mktemp -d /tmp/egress-dry-run-XXXXXX)}
else
	out=${out:-$default_out}
	if ((need_ollama_trace)); then
		# The daemon, not a `ollama runner` child (same process name) of a loaded model.
		ollama_pid=$(systemctl show -p MainPID --value ollama 2>/dev/null || true)
		[[ -n $ollama_pid && $ollama_pid != 0 ]] || ollama_pid=$(pgrep -o -x ollama || true)
		[[ -n $ollama_pid ]] || die "no ollama process on the host"
		pgrep -af strace | grep -Eq -- "-p ${ollama_pid}( |\$)" ||
			die "the host Ollama trace is not running (strace -p $ollama_pid); start it first, or pass --no-ollama-trace"
	fi
fi
mkdir -p "$out"
[[ -e $out/egress-app.txt ]] && die "$out already holds a recording; move it away or pass another --out"

# --- Images ----------------------------------------------------------------
docker build -q -t "$smoke_image" "$worktree/scripts/tauri-deb-smoke" >/dev/null
docker build -q -t "$image" "$tools" >/dev/null

# --- Evidence header and DNS snapshot ---------------------------------------
dns_hosts=(
	github.com api.github.com objects.githubusercontent.com release-assets.githubusercontent.com
	codeload.github.com raw.githubusercontent.com
	registry.ollama.ai ollama.com hf.co huggingface.co cdn-lfs.hf.co cdn-lfs.huggingface.co cas-bridge.xethub.hf.co
	registry.npmjs.org api.anthropic.com api.openai.com example.com example.org
	duckduckgo.com html.duckduckgo.com www.google.com api.search.brave.com api.exa.ai api.perplexity.ai s.jina.ai r.jina.ai
)
snapshot_dns() {
	for host in "${dns_hosts[@]}"; do
		# A name without a record makes getent exit 2; it simply adds no line.
		{ getent ahosts "$host" 2>/dev/null || true; } | awk -v h="$host" '{ print h "\t" $1 }' | sort -u
	done >>"$out/dns-snapshot.tsv"
}
{
	echo "started: $(date --iso-8601=seconds)"
	echo "dry run: $dry_run"
	echo "deb: $deb"
	echo "deb sha256: $(sha256sum "$deb" | cut -d' ' -f1)"
	echo "image: $image $(docker image inspect -f '{{.Id}}' "$image")"
	echo "host ollama: $ollama_url (systemd MainPID $(systemctl show -p MainPID --value ollama 2>/dev/null || echo none); ollama processes: $(pgrep -x ollama | tr '\n' ' '))"
	echo "host ollama models: $(grep -o '"name":"[^"]*"' <<<"$tags" | cut -d'"' -f4 | tr '\n' ' ')"
} >"$out/run-info.txt"
snapshot_dns

# --- The session -------------------------------------------------------------
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

# Same sandbox opt-outs and core limit as scripts/tauri-deb-smoke.sh (see its
# comments), plus host networking so the app reaches the host's Ollama on a
# literal loopback address, the only kind the local-only policy accepts.
status=0
docker run --rm --init --name "$container" \
	--network host \
	--security-opt seccomp=unconfined \
	--security-opt apparmor=unconfined \
	--security-opt systempaths=unconfined \
	--ulimit core=1 \
	-e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
	-e EGRESS_DRY_RUN="$dry_run" -e EGRESS_ACTION_TIMEOUT_MS -e EGRESS_MODEL \
	-v "$worktree:/repo" \
	-v "$deb:/tmp/sai-atlas.deb:ro" \
	-v "$tools:/tools:ro" \
	-v "$out:/out" \
	"$image" || status=$?

snapshot_dns
sort -u -o "$out/dns-snapshot.tsv" "$out/dns-snapshot.tsv"
echo "finished: $(date --iso-8601=seconds) (exit $status)" >>"$out/run-info.txt"

if ((dry_run)); then
	echo "Dry run evidence in $out (timeline.tsv, screens/, egress-app.txt from the launch only)."
else
	report "$out" || true
	echo "Recording in $out. Stop the host Ollama trace, then run: bash $0 --report-only --out $out"
fi
exit "$status"
