# A clean Ubuntu 24.04 for installing a Sai ATLAS .deb and running
# e2e/packaged-smoke.e2e.ts against it on a virtual display. scripts/deb-smoke.sh
# builds and runs it; the .deb and the GUI repo are mounted at run time.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# The .deb's Depends (dpkg-deb -f <deb> Depends) are preinstalled so the run
# needs no package index; apt still checks them when it installs the .deb.
# libasound2t64 stands in for the desktop: the app links libasound.so.2, but
# electron-builder's default Depends leaves it out, and every Ubuntu desktop
# already has it.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates dbus fonts-dejavu-core xauth xvfb \
		libatspi2.0-0t64 libgtk-3-0t64 libnotify4 libnss3 libsecret-1-0 libuuid1 libxss1 libxtst6 xdg-utils \
		libasound2t64 \
	&& rm -rf /var/lib/apt/lists/*

# Ubuntu's nodejs is older than Playwright supports.
COPY --from=node:24-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY entrypoint.sh /usr/local/bin/deb-smoke

ENTRYPOINT ["/usr/local/bin/deb-smoke"]
