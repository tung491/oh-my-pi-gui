# The offline-check container: the deb smoke image (scripts/tauri-deb-smoke,
# a clean Ubuntu 24.04 with the .deb's Depends and Recommends, weston,
# WebKitWebDriver and tauri-driver) plus LibreOffice Calc (headless), which the
# spreadsheet clean-up runs for .xls input, and socat, which carries the one
# allowed connection (host Ollama) over a Unix socket into a container that has
# no network. The harness files are mounted at /tools at run time.
FROM sai-atlas-tauri-deb-smoke:latest
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
	&& apt-get install -y --no-install-recommends libreoffice-calc-nogui socat \
	&& rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/tools/offline-entrypoint.sh"]
