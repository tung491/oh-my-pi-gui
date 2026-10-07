---
title: Gemma catalog and Linux install progress implementation
date: 2026-10-02
summary: "Shipped Gemma-only sizing and live pkexec install progress; review caught a root-process timeout leak; found Ollama's 4096-token default context breaks agent chat on default installs"
---

# Gemma catalog and Linux install progress implementation

# Gemma catalog and Linux install progress implementation

**Date**: 2026-10-02 12:45 (Asia/Seoul)
**Severity**: High (default-install chat is broken; predates this branch)
**Component**: `src/shared/ollama-catalog.ts`, `src/main/ollama/remedy.ts`, `src/main/ollama/install-progress.ts`, onboarding UI
**Status**: Implemented, uncommitted (branch `feat/gemma-catalog-install-progress`). Context-length issue open.

## What Happened
- Executed `plans/261002-1201-gemma-catalog-install-progress/`.
- Model suggestions are now Gemma-only, using a port of sai-welcome's sizing rules: three Gemma 4 QAT GGUF `hf.co/...` rows, a tight-fit fallback when nothing fits comfortably, and the `:latest` tag rule.
- Linux "Install Ollama" now streams real progress. `install-progress.ts` parses installer output into frames, `remedy.ts` has a streaming spawn seam, and frames are broadcast to every window. `InstallProgressBar` renders them.
- Two existing breaks on main got fixed on the way: `vi.ts` was out of parity with `en.ts` (59 keys missing, 220 stale), and `desktop.e2e.ts` still searched with a Chinese query after the zh locale was removed.

## The Brutal Truth
The feature works, but it doesn't matter yet: on a default Ollama install, chat fails with any model. We spent the session polishing the installer path that leads users straight into an HTTP 400. Main also had two red tests nobody had noticed, which says our "green" gates from the last merge only covered what we happened to run.

## Technical Details
- **Review bug (real):** once polkit authorizes, `pkexec` runs as root, so the timeout's `SIGTERM` fails with `EPERM`. The run resolved early anyway, kept emitting frames after `done`, and released the install gate, so a second root installer could start. Fix: settle only on the real `exit`, and drop any output after the run has settled.
- **Live-test bug:** a window that didn't start the install stayed `absent` after it finished. A `done` frame now re-reads Ollama status in every window.
- **Context-length finding:** Ollama 0.35 defaults to a 4096-token context on a 16 GiB GPU. The agent's first request is about 6.8k tokens. The agent talks to Ollama's OpenAI-compatible endpoint, which can't send `num_ctx`, so the result is `exceed_context_size_error` (HTTP 400). With `OLLAMA_CONTEXT_LENGTH=16384` set on the server, Gemma E2B tool calls work end to end through the agent.

## Decisions
- Broadcast progress to all windows rather than only the one that started the install. Settings and the welcome screen can both be open, and a second window showing a stale state was the exact bug the live test found.
- Treat process exit as the only completion signal. A timer can't be trusted to kill a root child we don't own.
- Context-length fix was **not** chosen here. Options are setting `OLLAMA_CONTEXT_LENGTH` on the service we install, a per-model Modelfile with `num_ctx`, or switching to the native `/api/chat`. Each has a different blast radius, so the user decides.

## Lessons Learned
- When you escalate a child process, assume you can't signal it anymore. Design cancellation around exit, not kill.
- Test cross-window state with two windows open, not one.
- Do an end-to-end chat on a fresh default install before calling onboarding done. Unit tests and the e2e fixture never touch the server's real defaults.
- `pkill -f <pattern>` also kills the invoking shell when the pattern appears in that shell's own command line. It killed our own session shell once. Use `pgrep -f` first and exclude `$$`, or match on the PID.

## Next Steps
- User: pick the context-length fix (owner: user, before this branch merges).
- Gates already green (vitest 1869/1869, check:types, biome, build, onboarding + desktop e2e 22/22); commit to the GUI repo once the user approves.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
