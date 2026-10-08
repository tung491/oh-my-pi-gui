# Verifier rubric: Tauri for macOS plan (score each 1-20)

Hard constraints (failing any one disqualifies a candidate):
- H1. Honors all six user decisions in the evidence packet (cutover then Electron removal; arm64 only; monorepo clone route; fresh installs only, no Mac handover test required; ships after 0.9.17; no Windows).
- H2. Every phase file carries the literal Failure Protocol block and every task has a mechanical Verify (exact command + expected result) or an explicit `no verification needed`.
- H3. Publishing, tagging and pushing need explicit user go-ahead; no step writes into the user's real profile or installs over the user's apps without a throwaway profile/backup.
- H4. No fabricated facts: file paths and symbols cited must exist in the repo (spot-checkable), or be clearly marked as files to create.

Scored criteria:
1. **Gap coverage** — closes every gap in the scout inventory (assistant pack in `Contents/Resources` + lookup, sidecar entitlements/hardened runtime, never-compiled macOS cfg code, supervisor kqueue/proc_listchildpids, proxy, GPU, WKWebView mic, quick-entry panel parity, `omp://` registration, single instance, ZIP artifact, feeds/floor, Show-in-Finder) or explicitly justifies a deferral.
2. **Sequencing and risk ordering** — de-risks early (toolchain, first compile, a bundle that launches and spawns the sidecar) before deep porting; dependencies correct; Electron removal gated on a live macOS release.
3. **TDD rigor** — red-then-green tasks with explicit red Verify, test matrix per phase, regression gates (clippy, cargo test, vitest, check:types, parity, snapshots), tests that would actually fail before the change.
4. **Executor-proofness** — a Sonnet-class model can run it without inventing: exact paths, symbols, commands, expected outputs; no "update the relevant file".
5. **macOS verification strategy** — a credible way to test the GUI on macOS without tauri-driver (e.g. e2e-hooks binary + RPC/probe, AppleScript/accessibility, packaged smoke script), plus a batched NEEDS-HUMAN sitting with exact steps.
6. **Release & removal correctness** — DMG + ZIP naming, `latest-mac.yml` arm64-only with `minimumSystemVersion`, bridge copy, `check:mac-update-floor`, AGENTS.md/README/CHANGELOG updates, Electron removal list complete (moving `sidecarOutName`, tray mark, CSP tests first) with a rollback path.
7. **Proportionality** — no scope beyond the request; effort estimates plausible; no redundant phases.

Return per candidate: H1-H4 pass/fail with evidence, scores for 1-7, total, ranking, winner (or reject-all), margin note, confidence.
