---
phase: 5
title: "Integration and verification"
status: completed
priority: P1
effort: "3h"
dependencies: [2, 3, 4]
---

# Phase 5: Integration and verification

## Goal
Move the e2e fixtures and docs to the Gemma catalog, run every gate, and check both features on this Linux machine against the real installer and agent.

## Files to Create / Modify
- Modify: `e2e/onboarding.e2e.ts`: the fake Ollama now lists or pulls `hf.co/google/gemma-4-E2B-it-qat-q4_0-gguf` and Continue asserts the `ollama/hf.co/…:latest` id.
- Modify: `e2e/sidecar-fixture.ts`, only if its catalog must reflect `hf.co` tags.
- Modify: `CHANGELOG.md` (Unreleased): Gemma-only suggestions with sai-welcome sizing, and install progress.
- Modify: `README.md`: the welcome-screen paragraph names the Gemma models.

## Tasks & Steps
1. Update the e2e fixtures and spec. Run `bunx playwright test e2e/onboarding.e2e.ts e2e/desktop.e2e.ts`. Use the file path: the bare `onboarding` filter matches every spec when the path contains the word.
2. Run the full gates: `bunx vitest run`, `bun run check:types`, `bunx biome check <touched files>`, `bun run build`.
3. **Manual check on this machine.** It runs Linux, has `pkexec`, and has no Ollama installed. It needs the user present for polkit.
   - Start `bun run dev` and track its PID.
   - On the welcome screen, press Install Ollama. Confirm the waiting text, then the stages, then a moving percentage, then the bar is gone and the row shows Ollama running.
   - Open Settings › Ollama during the install and confirm it shows the same progress.
4. **Agent check.** Pull E2B from the welcome screen, then press Continue. Confirm:
   - the agent accepts `set_model("ollama", "hf.co/google/gemma-4-E2B-it-qat-q4_0-gguf:latest")`;
   - the default role is set;
   - one chat turn gets a reply;
   - one tool call works. If a tool call fails, record it as a blocker for the user: the agent's Ollama tool support for GGUF imports is the open risk.
5. Stop the dev process and any Electron processes you started.

## Done when
Every acceptance criterion in `plan.md` is checked against tests and, for criteria 1 and 7, against the running app.

## Risks
- **Tool calling with `hf.co` GGUF imports**: Ollama takes the chat template from the GGUF metadata. If Gemma 4 QAT tool calls don't work through the agent, stop and ask the user whether to switch to Ollama library tags. Don't switch silently.
