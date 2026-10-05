# A clean Ubuntu 24.04 for installing the Tauri Sai ATLAS .deb and checking its
# main window's geometry under openbox, a reparenting X11 window manager that
# frames the window and publishes the frame as _NET_FRAME_EXTENTS.
# scripts/tauri-wm-geometry-check.sh builds and runs it; the .deb is mounted at
# run time.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# The .deb's Depends (dpkg-deb -f <deb> Depends) are preinstalled so the run
# needs no package index; apt still checks them when it installs the .deb.
# The rest is the check itself: an X server (xvfb) and window manager
# (openbox), a session bus (dbus), and the X clients that find, measure and
# close the window (xdotool, x11-utils for xwininfo/xprop/xdpyinfo, wmctrl),
# plus jq for the saved state.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates fonts-dejavu-core \
		libwebkit2gtk-4.1-0 libayatana-appindicator3-1 gstreamer1.0-pipewire gstreamer1.0-plugins-good \
		bubblewrap xdg-dbus-proxy desktop-file-utils xdg-utils libgtk-3-0t64 \
		xvfb openbox dbus xdotool x11-utils wmctrl jq \
	&& rm -rf /var/lib/apt/lists/*

COPY inside.sh /usr/local/bin/tauri-wm-geometry-check
ENTRYPOINT ["/usr/local/bin/tauri-wm-geometry-check"]
