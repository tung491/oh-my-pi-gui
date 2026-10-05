# A clean Ubuntu 24.04 for installing the Tauri Sai ATLAS .deb and running
# e2e-tauri/packaged-smoke.e2e.ts against it on a headless Wayland compositor.
# scripts/tauri-deb-smoke.sh builds and runs it; the .deb and the GUI repo are
# mounted at run time.

# tauri-driver, built here at the version the host harness was set up with, so
# the image needs nothing from the host's ~/.cargo.
FROM ubuntu:24.04 AS driver
ENV DEBIAN_FRONTEND=noninteractive
ARG TAURI_DRIVER_VERSION=2.1.0
RUN apt-get update \
	&& apt-get install -y --no-install-recommends build-essential ca-certificates curl \
	&& rm -rf /var/lib/apt/lists/*
RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
		| sh -s -- -y --no-modify-path --profile minimal --default-toolchain stable
RUN /root/.cargo/bin/cargo install tauri-driver --version "$TAURI_DRIVER_VERSION" --locked --root /out

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# The .deb's Depends (dpkg-deb -f <deb> Depends) are preinstalled so the run
# needs no package index; apt still checks them when it installs the .deb.
# The rest is what the harness and e2e-tauri/outside.ts run: WebKitWebDriver
# (webkit2gtk-driver), a session bus (dbus), the accessibility bus the window
# list is read from (at-spi2-core), gdbus (libglib2.0-bin), pgrep (procps),
# ss (iproute2), and weston for a Wayland display, so the WAYLAND_DEBUG trace
# records the app id as it would on an Ubuntu desktop. The audio probe
# (OMP_E2E_FAKE_MIC=1) adds a desktop's audio stack: PipeWire, WirePlumber and
# pipewire-pulse, pactl (pulseaudio-utils), and gst-launch-1.0 (gstreamer1.0-tools)
# to feed fake-mic.sh's tone.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates fonts-dejavu-core \
		libwebkit2gtk-4.1-0 libayatana-appindicator3-1 gstreamer1.0-pipewire gstreamer1.0-plugins-good \
		bubblewrap xdg-dbus-proxy desktop-file-utils xdg-utils libgtk-3-0t64 \
		webkit2gtk-driver dbus at-spi2-core libglib2.0-bin procps iproute2 weston \
		pipewire pipewire-pulse wireplumber pulseaudio-utils gstreamer1.0-tools \
	&& rm -rf /var/lib/apt/lists/*

# Ubuntu's nodejs is older than WebdriverIO supports.
COPY --from=node:24-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=driver /out/bin/tauri-driver /usr/local/bin/tauri-driver
COPY entrypoint.sh /usr/local/bin/tauri-deb-smoke
COPY fake-mic.sh /usr/local/bin/fake-mic

# wdio.conf.ts looks for tauri-driver in CARGO_HOME_BIN.
ENV CARGO_HOME_BIN=/usr/local/bin
ENTRYPOINT ["/usr/local/bin/tauri-deb-smoke"]
