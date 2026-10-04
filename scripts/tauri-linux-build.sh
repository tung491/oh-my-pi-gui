#!/usr/bin/env bash
# Builds the Tauri Linux bundles (AppImage + .deb) inside an Ubuntu 24.04
# container, so the libraries linuxdeploy bundles need no newer glibc than
# 24.04's (the finalize scripts refuse anything above it).
#
#   bash scripts/tauri-linux-build.sh [target dir]
#
# The target dir (default src-tauri/target-linux-2404, or $SAI_ATLAS_LINUX_TARGET)
# is mounted over src-tauri/target, so the host's own cargo builds are untouched.
# CARGO_BUILD_JOBS (default 8) and SAI_ATLAS_UPDATE_BASE, when set, are passed in.
# ~/.cache/tauri (linuxdeploy, appimagetool) is shared with the host, and the
# cargo registry lives in the sai-atlas-cargo-registry volume.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
image=sai-atlas-linux-build
target=$(realpath -m "${1:-${SAI_ATLAS_LINUX_TARGET:-$root/src-tauri/target-linux-2404}}")
bundle=$target/x86_64-unknown-linux-gnu/release/bundle

docker build -q -t "$image" --build-arg UID="$(id -u)" --build-arg GID="$(id -g)" "$root/scripts/tauri-linux-build" >/dev/null

# Bind-mount sources and mount points that do not exist would be created as root.
mkdir -p "$target" "$root/src-tauri/target" "$HOME/.cache/tauri"
# Tauri keeps earlier bundles, and finalize-deb.ts needs exactly one .deb.
rm -rf "$bundle"

env_args=(-e CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-8}")
[[ -n ${SAI_ATLAS_UPDATE_BASE-} ]] && env_args+=(-e SAI_ATLAS_UPDATE_BASE)

docker run --rm --init \
	"${env_args[@]}" \
	-v "$root:$root" -w "$root" \
	-v "$target:$root/src-tauri/target" \
	-v "$HOME/.cache/tauri:/home/builder/.cache/tauri" \
	-v sai-atlas-cargo-registry:/home/builder/.cargo/registry \
	"$image" bun run package:tauri:linux

echo "Bundles: $bundle/appimage and $bundle/deb"
