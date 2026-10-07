# The egress-audit container: the deb smoke image (scripts/tauri-deb-smoke,
# a clean Ubuntu 24.04 with the .deb's Depends and Recommends, weston,
# WebKitWebDriver and tauri-driver) plus strace, which records every connect()
# the app and its children make. egress-audit.sh builds the smoke image first
# with the same command scripts/tauri-deb-smoke.sh uses. The harness files are
# mounted at /tools at run time, so editing them needs no rebuild.
FROM sai-atlas-tauri-deb-smoke:latest
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
	&& apt-get install -y --no-install-recommends strace \
	&& rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/tools/egress-entrypoint.sh"]
