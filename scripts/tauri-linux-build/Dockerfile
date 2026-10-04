# Ubuntu 24.04 build environment for the Tauri Linux bundles (AppImage + .deb).
# linuxdeploy copies the build host's GTK, GLib and WebKit libraries into the
# AppImage, so building here keeps every bundled ELF at Ubuntu 24.04's glibc
# (2.39), the floor src-tauri/linux/glibc-floor.ts enforces. scripts/tauri-linux-build.sh
# builds and runs it; the repo, a target dir and ~/.cache/tauri are mounted at
# run time. Rebuild with --no-cache to pick up a new stable Rust.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Tauri's Linux build deps, plus what bundling and the finalize scripts run:
# linuxdeploy's GTK plugin (dpkg-architecture from build-essential's dpkg-dev,
# file, patchelf), unsquashfs, objdump and dpkg-deb. unzip is for bun's installer.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		build-essential curl ca-certificates git pkg-config file patchelf unzip \
		libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev librsvg2-dev libgtk-3-dev \
		libayatana-appindicator3-dev libxdo-dev libssl-dev \
		squashfs-tools binutils dpkg \
	&& rm -rf /var/lib/apt/lists/*

# The build writes into the mounted repo, so it runs as the host user's uid/gid.
# The image's own "ubuntu" user holds uid 1000, the usual host uid.
ARG UID=1000
ARG GID=1000
RUN userdel --remove ubuntu 2>/dev/null; groupdel ubuntu 2>/dev/null; \
	groupadd --gid "$GID" builder \
	&& useradd --uid "$UID" --gid "$GID" --create-home --shell /bin/bash builder
USER builder
WORKDIR /home/builder

# Versions match the host toolchain: `bun --version`, `cargo tauri --version`, and
# src-tauri/rust-toolchain.toml's channel. scripts/rust-pins.env puts
# $HOME/.cargo/bin first on PATH, which is where rustup and cargo-tauri go here.
ARG BUN_VERSION=1.4.2
ARG RUST_TOOLCHAIN=stable
ARG TAURI_CLI_VERSION=2.12.1
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
		| sh -s -- -y --no-modify-path --profile minimal --default-toolchain "$RUST_TOOLCHAIN"
RUN curl -fsSL "https://github.com/tauri-apps/tauri/releases/download/tauri-cli-v${TAURI_CLI_VERSION}/cargo-tauri-x86_64-unknown-linux-gnu.tgz" \
		| tar -xz -C /home/builder/.cargo/bin cargo-tauri
# Mount points that must exist as builder's: a fresh named volume copies them,
# ownership included, so the cargo registry volume stays writable.
RUN mkdir -p /home/builder/.cargo/registry /home/builder/.cache/tauri

ENV PATH=/home/builder/.cargo/bin:/home/builder/.bun/bin:$PATH
