#!/usr/bin/env bash
# Installs a Tauri Sai ATLAS .deb into a clean Ubuntu 24.04 container and runs
# e2e-tauri/packaged-smoke.e2e.ts against it there (wdio.packaged.conf.ts), so
# the host's own install, its omp:// handler and its screen stay untouched.
#
#   bash scripts/tauri-deb-smoke.sh                  # the .deb scripts/tauri-linux-build.sh built
#   bash scripts/tauri-deb-smoke.sh path/to/sai-atlas.deb
#   bash scripts/tauri-deb-smoke.sh path/to/sai-atlas.deb --mochaOpts.grep "boots sandboxed"   # extra wdio args
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
name=sai-atlas-tauri-deb-smoke

if [[ $# -gt 0 && $1 == *.deb ]]; then
	deb=$(realpath "$1")
	shift
else
	target=${SAI_ATLAS_LINUX_TARGET:-$root/src-tauri/target-linux-2404}
	deb=$(ls -t "$target"/x86_64-unknown-linux-gnu/release/bundle/deb/*.deb 2>/dev/null | head -n 1 || true)
fi
if [[ -z $deb || ! -f $deb ]]; then
	echo "No .deb found. Build one with: bash scripts/tauri-linux-build.sh" >&2
	exit 1
fi
if [[ ! -d $root/node_modules/@wdio/cli ]]; then
	echo "WebdriverIO is not installed in $root. Run: bun install" >&2
	exit 1
fi
echo "Smoke-testing $deb" >&2

docker build -q -t "$name" "$root/scripts/tauri-deb-smoke" >/dev/null
# A run killed before --rm could clean up leaves its container holding the name.
docker rm -f "$name" >/dev/null 2>&1 || true

# WebKit runs every web process in a bubblewrap sandbox, which Docker's
# defaults break three ways: its seccomp profile blocks the user namespace, its
# AppArmor profile refuses bwrap's mount propagation change ("Failed to make /
# slave"), and its masked /proc paths refuse the sandbox's own proc mount. Each
# opt-out below lifts exactly one of them; no capability is added and no host
# device is exposed (--privileged would hand WebKit the host's GPU nodes). A
# run without them fails inside WebKit, not in the spec. --init forwards Ctrl-C
# to the test run.
#
# A crash inside the container still goes to the host's core_pattern, so the
# host's apport would report it as a crash of the host's own install. A core
# limit of exactly 1 makes the kernel drop the dump before calling apport (its
# recursion guard); 0 would not.
exec docker run --rm --init --name "$name" \
	--security-opt seccomp=unconfined \
	--security-opt apparmor=unconfined \
	--security-opt systempaths=unconfined \
	--ulimit core=1 \
	-e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
	-v "$root:/repo" \
	-v "$deb:/tmp/sai-atlas.deb:ro" \
	"$name" "$@"
