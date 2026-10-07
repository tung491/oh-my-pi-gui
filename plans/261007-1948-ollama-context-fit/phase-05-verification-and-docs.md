---
phase: 5
title: "Real-machine verification and docs"
status: pending
depends_on: [4]
---

# Phase 5: Real-machine verification and docs

## Full gates

- `bunx vitest run`, `bun run check:types`, `bunx biome check <touched files>`
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`
- `cargo test --manifest-path src-tauri/Cargo.toml --all-features`
- `bun scripts/check-test-parity.ts`, `bash scripts/check-module.sh snapshots`, `bun e2e-tauri/check-twins.ts`
- The onboarding e2e suites: `scripts/virtual-display.sh run -- bun run test:e2e:tauri` (includes `e2e-tauri/onboarding.e2e.ts`), and `scripts/virtual-display.sh run -- bunx playwright test e2e/onboarding.e2e.ts`. Both fakes now answer `/api/show` and `/api/ps`, or the specs assert that measurement waits for the dialog.
- `bun run build:omp:linux`, then `bun scripts/check-assistant-pack.ts resources/omp.linux-x64`

## Live check on this machine (RTX 5080 16 GiB, 60 GiB RAM, Ollama 0.35)

Run the Tauri dev build on the virtual display with a throwaway profile:
`scripts/virtual-display.sh run -- bun run dev:tauri -- --user-data-dir=$(mktemp -d)`

1. On first start the scheduler measures both installed Gemma 4 models. Compare each logged probe's `size`/`size_vram` with the research table (E2B: 1.7 GiB at 16k, 2.4 GiB at 128k), and assert that `/api/ps` `context_length == num_ctx` on every probe.
2. Set E4B to 16k **while a session is idle and open**, then send one message without restarting. `curl -s localhost:11434/api/ps` must show `context_length: 16384`, and the sidecar must not have restarted (same PID).
3. Lower the cap below a long resumed session's usage. Check that the session is compacted, and observe whether Ollama truncates an oversized prompt.
4. Start a reply, then press Measure: the row must show "Waiting…" until the reply ends. Start a reply during a measurement: the run must be interrupted and re-queued.
5. Keep a second model loaded (with `keep_alive`) and press Measure again. The probe with the foreign runner must be discarded, not stored.
6. Edit the profile's prefs fingerprint to simulate new hardware, then restart: re-measurement runs on its own. Then edit it to `vramBytes: null`, and check that **no** re-measurement runs.
7. Open a second window with a streaming tab, and check that no measurement starts from the first window.
8. Pull a small model in the Ollama window, and check that it is measured right after the pull and listed under its `:latest` name.
9. Stop the app and run `scripts/virtual-display.sh stop`.

Not available here (record each as skipped if no machine is found): measuring on Apple Silicon with Electron (the `ram` pool), and on an AMD or a CPU-only machine (the pool comes from `size_vram`).

## Docs

- `AGENTS.md`: the patch 0005 sentence from phase 1, and one Sidecar-section line about the `<userData>/ollama-context-limits.yml` overlay, which is written from the `ollamaContextFit` pref and passed with `--config`.
- `README.md`: only if it documents `OLLAMA_CONTEXT_LENGTH` or the context behaviour.
- `CHANGELOG.md`: an entry under the next unreleased section.

## Done when

The plan's acceptance criteria 1–6 are checked off with evidence: test output, the `/api/ps` JSON, the sidecar PID before and after the change, and screenshots of the row states.
