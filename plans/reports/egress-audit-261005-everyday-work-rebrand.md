# Egress audit — everyday-work rebrand

**Verdict: pass.** In the recorded run of the final build, every connection the app and the host Ollama made was either to this computer, a DNS lookup, or the GitHub update check. Nothing left the computer during a conversation, the planted cloud keys were never used, and both ways of choosing a cloud model were refused.

The first run (2026-10-07 09:45) found two destinations that were not allowed. Both causes were proven and fixed, and the second run (10:52–10:56) shows the app's one gone. Ollama's own fetch is fixed for installs the app sets up, but it was outside this run's window, so the trace cannot show whether it happened (see Findings).

## What was run

| | |
|---|---|
| Build | `Sai ATLAS_0.9.16_amd64.deb` from integration commit `f45e3f4`, sha256 `f3d9cf06…a447566`. Built with `SAI_ATLAS_UPDATE_BASE` unset. |
| Sidecar | omp 18.4.8 with patches 0002–0004 (no context files, local models only, MCP off), sha256 `573cf751…`. |
| Where | A clean Ubuntu 24.04 container on host networking, with a seeded power-user home: `~/.omp/agent` config, an `mcp.json`, a user extension and a `~/.env` holding made-up Anthropic and OpenAI keys. |
| Model | `ollama/hf.co/google/gemma-4-E2B-it-qat-q4_0-gguf:latest`, the one "Get started" picked. |
| App trace | `strace -f -e trace=connect,sendto,sendmsg` on the app and everything it started. |
| Ollama trace | The user's `sudo strace` of the host `ollama.service` (MainPID 4345), 10:51–12:28. |
| Evidence | `plans/reports/egress-261007/`: `egress-rows.md`/`.tsv` (227 network rows), `timeline.tsv`, raw traces, screenshots, process snapshots, container state. The first run is kept in `egress-261006/`. |

## Result per action (second run)

| Action | App, not loopback | Ollama, not loopback | Verdict |
|---|---|---|---|
| Launch and "Get started" | DNS; `github.com:443`; `objects/raw/release-assets.githubusercontent.com:443` | none | Allowed (automatic update check at launch) |
| Word report | none | none | Allowed |
| Spreadsheet cleanup | none | none | Allowed |
| Slide deck | none | none | Allowed |
| Help desk card and question | none | none | Allowed |
| Read a document that contains a URL | none | none | Allowed; the URL was not fetched |
| Ask for a web search | none | none | Allowed; no search was made |
| Type `/model anthropic/…` | none | none | Allowed; no turn started, model unchanged |
| Type `/login` | none | none | Allowed; no turn started |
| Settings › Updates › Check | DNS; `github.com:443`; `*.githubusercontent.com:443` | none | Allowed (update check) |
| Pull a cloud tag (`gpt-oss:120b-cloud`) | none | none | Refused by the app ("Download disabled") |
| Select a cloud tag (typed `/model` and the `set_model` RPC) | none | none | Refused by the agent ("Model not found"); the session never changed model |

No OTLP endpoint appeared, and nothing reached `registry.npmjs.org`. All 206 of Ollama's rows are loopback: the app calling Ollama, and Ollama calling its own runner.

The "Select a cloud tag" step is marked `error` in `timeline.tsv` because the harness did not expect the refusal to come back as a WebDriver script error. The refusal is shown by the error text, by the saved sessions (every model entry is the E2B model, apart from the starting model "Get started" replaced), and by the step having no off-computer rows. The harness now records such a rejection as a refusal.

## Findings from the first run, and their fixes

| Process → destination | Caused by | Fix | Re-checked |
|---|---|---|---|
| app → `registry.npmjs.org:443` | Settings › Updates also asked npm for the newest omp version (`get_omp_update`), which an app that bundles its own assistant never uses. | Removed: the Updates page now checks only Sai ATLAS's own GitHub release feed, and an update installs the whole app, assistant included. | Gone in the second run. |
| Ollama → `ollama.com:443` (00:46:13Z) | Ollama's own background job, not the app. Ollama 0.35 fetches model recommendations from ollama.com at start and about every 4 hours (`model_recommendations.go` in its journal). | The `.deb` ships a systemd drop-in with `OLLAMA_NO_CLOUD=1` (`/usr/lib/systemd/system/ollama.service.d/sai-atlas.conf`), which any Ollama service picks up after the next reboot or a `systemctl daemon-reload` (the package runs no install script), and the app's Linux "start Ollama" and "install Ollama" steps write the same drop-in to `/etc/systemd/system/ollama.service.d/` and restart Ollama at once. Downloads still work, from the model CDN only. | Not seen in the second window. The host's own Ollama was set up before this change and still runs with `OLLAMA_NO_CLOUD:false`, so the fetch only fell outside the 10:51–12:28 window; it was not prevented. |

## Scope and limits

- The app trace sees connections the app and its children make. Services the app reaches over D-Bus (the desktop portal, notifications, the accessibility bus) make their own connections, which are outside this trace. The app's D-Bus endpoints are listed in `egress-rows.md`.
- Only the host Ollama's process was traced, from 10:51 to 12:28. At 12:28:27 `ollama.service` was stopped cleanly and started again by something outside this audit, alongside a new drop-in `migrator.conf`. The trace ended with the old process, and the new one (PID 972455) was not traced.
- The run used the E2B model. The model doesn't change which destinations the app contacts.

## Unresolved questions

- None. An Ollama that Sai ATLAS did not set up (this laptop's included) gets the setting from the `.deb`'s drop-in after the next reboot or a `systemctl daemon-reload` (decided 2026-10-07). An AppImage install gets it only through the welcome screen's start or install step.
