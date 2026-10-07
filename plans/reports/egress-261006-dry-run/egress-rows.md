# Egress rows (2026-10-06T14:30:12.103Z)

Traces: egress-app.txt (present), egress-ollama.txt (missing). Actions in timeline.tsv: dry-run-first-run-screen.

| first (UTC) | source | process | destination | name | action | count | results | suggested |
|---|---|---|---|---|---|---|---|---|
| 2026-10-06T14:28:09.588Z | app | 139 /usr/bin/sai-atlas (parent 134) / thread 139<sai-atlas> | 127.0.0.1:47027 | loopback | dry-run-first-run-screen | 1 | -1 EINPROGRESS | allowed |
| 2026-10-06T14:28:09.751Z | app | 329 /usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebProcess 4 36 (parent 328) / thread 329<WebKitWebProces> | 127.0.0.1:47027 | loopback | dry-run-first-run-screen | 1 | -1 EINPROGRESS | allowed |
| 2026-10-06T14:28:11.522Z | app | 353 /usr/lib/Sai ATLAS/omp --mode rpc-ui --no-auto-resume --no-extensions --no-rules (parent 333) / thread 473<HTTP Client> | 127.0.0.1:11434 | Ollama on loopback | dry-run-first-run-screen | 4 | -1 EINPROGRESS | allowed |
| 2026-10-06T14:28:11.639Z | app | 477 /bin/bash /home/ubuntu/.omp/agent/mcp-notes-server.sh (parent 475) / thread 477<mcp-notes-serve> | 192.0.2.12:9 | TEST-NET-1 tripwire (a seeded MCP server or extension ran) | dry-run-first-run-screen | 1 | ? | NOT ALLOWED |
| 2026-10-06T14:28:12.591Z | app | (exited before a ps snapshot) / thread 331<tokio-rt-worker> | 172.17.0.1:53 | DNS resolver (a name lookup) | dry-run-first-run-screen | 2 | 0 | check: a name lookup (see the next connect of this thread) |
| 2026-10-06T14:28:12.593Z | app | 139 /usr/bin/sai-atlas (parent 134) / thread 202<tokio-rt-worker> | 20.200.245.247:443 | github.com | dry-run-first-run-screen | 1 | -1 EINPROGRESS | NOT ALLOWED (unless the auditor names it as an allowed host) |
| 2026-10-06T14:28:13.170Z | app | (exited before a ps snapshot) / thread 331<tokio-rt-worker> | 185.199.109.133:0 | objects.githubusercontent.com, raw.githubusercontent.com, release-assets.githubusercontent.com [port-0 address-sorting probe after a name lookup; no packet sent] | dry-run-first-run-screen | 1 | 0 | check: the process looked this name up (no packet to it); see its DNS row |
| 2026-10-06T14:28:13.170Z | app | (exited before a ps snapshot) / thread 331<tokio-rt-worker> | 185.199.108.133:0 | objects.githubusercontent.com, raw.githubusercontent.com, release-assets.githubusercontent.com [port-0 address-sorting probe after a name lookup; no packet sent] | dry-run-first-run-screen | 1 | 0 | check: the process looked this name up (no packet to it); see its DNS row |
| 2026-10-06T14:28:13.171Z | app | (exited before a ps snapshot) / thread 331<tokio-rt-worker> | 185.199.111.133:0 | objects.githubusercontent.com, raw.githubusercontent.com, release-assets.githubusercontent.com [port-0 address-sorting probe after a name lookup; no packet sent] | dry-run-first-run-screen | 1 | 0 | check: the process looked this name up (no packet to it); see its DNS row |
| 2026-10-06T14:28:13.171Z | app | (exited before a ps snapshot) / thread 331<tokio-rt-worker> | 185.199.110.133:0 | objects.githubusercontent.com, raw.githubusercontent.com, release-assets.githubusercontent.com [port-0 address-sorting probe after a name lookup; no packet sent] | dry-run-first-run-screen | 1 | 0 | check: the process looked this name up (no packet to it); see its DNS row |
| 2026-10-06T14:28:13.172Z | app | 139 /usr/bin/sai-atlas (parent 134) / thread 202<tokio-rt-worker> | 185.199.109.133:443 | objects.githubusercontent.com, raw.githubusercontent.com, release-assets.githubusercontent.com | dry-run-first-run-screen | 1 | -1 EINPROGRESS | NOT ALLOWED (unless the auditor names it as an allowed host) |
| 2026-10-06T14:28:26.944Z | app | 139 /usr/bin/sai-atlas (parent 134) / thread 193<tokio-rt-worker> | 127.0.0.1:11434 | Ollama on loopback | dry-run-first-run-screen | 2 | -1 EINPROGRESS | allowed |
| 2026-10-06T14:28:27.625Z | app | 139 /usr/bin/sai-atlas (parent 134) / thread 198<tokio-rt-worker> | 127.0.0.1:11434 | Ollama on loopback | dry-run-first-run-screen | 2 | -1 EINPROGRESS | allowed |
| 2026-10-06T14:28:27.630Z | app | 139 /usr/bin/sai-atlas (parent 134) / thread 202<tokio-rt-worker> | 127.0.0.1:11434 | Ollama on loopback | dry-run-first-run-screen | 2 | -1 EINPROGRESS | allowed |
| 2026-10-06T14:28:27.642Z | app | 139 /usr/bin/sai-atlas (parent 134) / thread 186<tokio-rt-worker> | 127.0.0.1:11434 | Ollama on loopback | dry-run-first-run-screen | 1 | -1 EINPROGRESS | allowed |

## Per action: loopback rows and rows that leave this computer

- dry-run-first-run-screen: 7 loopback, 8 other

## Local IPC (AF_UNIX), not egress

- app WebKitNetworkPr -> "/run/dbus/system_bus_socket": 2
- app WebKitWebProces -> "/run/dbus/system_bus_socket": 1
- app WebKitWebProces -> "/run/user/1000/webkitgtk/bus": 4
- app mcp-notes-serve -> "/var/run/nscd/socket": 2
- app pool -> "/run/dbus/system_bus_socket": 2
- app pool -> "/run/user/1000/at-spi/bus": 1
- app pool -> "/run/user/1000/webkitgtk/at-spi-bus": 1
- app pool -> "/tmp/dbus-mLC227Cc98": 4
- app pool-vn.io.vif. -> "/tmp/dbus-mLC227Cc98": 1
- app sai-atlas -> "/run/dbus/system_bus_socket": 2
- app sai-atlas -> "/run/user/1000/at-spi/bus": 1
- app sai-atlas -> "/run/user/1000/wayland-1": 2
- app sai-atlas -> "/tmp/dbus-mLC227Cc98": 3
- app tokio-rt-worker -> "/tmp/dbus-mLC227Cc98": 2
- app tokio-rt-worker -> "/var/run/nscd/socket": 2
