#!/usr/bin/env bash
# Installs a Sai ATLAS .deb into a clean Ubuntu 24.04 container and runs
# e2e/packaged-smoke.e2e.ts against it there, so the host's own install, its
# omp:// handler and its screen stay untouched.
#
#   bash scripts/deb-smoke.sh                       # newest dist/sai-atlas_*_amd64.deb
#   bash scripts/deb-smoke.sh path/to/sai-atlas.deb
#   bash scripts/deb-smoke.sh path/to/sai-atlas.deb -g "boots sandboxed"   # extra Playwright args
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
name=sai-atlas-deb-smoke

if [[ $# -gt 0 && $1 == *.deb ]]; then
	deb=$(realpath "$1")
	shift
else
	deb=$(ls -t "$root"/dist/sai-atlas_*_amd64.deb 2>/dev/null | head -n 1)
fi
if [[ -z $deb || ! -f $deb ]]; then
	echo "No .deb found. Build one with: bun run package:linux -- --publish never" >&2
	exit 1
fi
echo "Smoke-testing $deb" >&2

docker build -q -t "$name" "$root/scripts/deb-smoke" >/dev/null
# A run killed before --rm could clean up leaves its container holding the name.
docker rm -f "$name" >/dev/null 2>&1 || true

# Docker's default seccomp profile blocks user namespaces, which Chromium's
# sandbox needs; without it the spec's sandbox check would fail, or pass only
# because of Docker's own filter. --init forwards Ctrl-C to the test run.
#
# Chromium's GPU process traps without a GPU and the app carries on in
# software, but the kernel still hands the crash to the host's apport, which
# reports it as a crash of the host's own /opt/Sai ATLAS install: a desktop
# popup and ~500 MB core per process. A core limit of exactly 1 makes the
# kernel drop the dump before calling apport (its recursion guard); 0 would not.
exec docker run --rm --init --name "$name" \
	--security-opt seccomp=unconfined \
	--ulimit core=1 \
	-e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
	-v "$root:/repo" \
	-v "$deb:/tmp/sai-atlas.deb:ro" \
	"$name" "$@"
