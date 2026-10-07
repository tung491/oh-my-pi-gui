# Phase 4 — Onboarding screen

Parallel with phases 2, 3 and 5.

## File ownership

Rewrites `src/renderer/components/dialogs/FirstRunOnboardingDialog.tsx` and its `.test.tsx`. Keep the export name, because `App.tsx:776` mounts it.
Creates `src/renderer/components/onboarding/{MachineFacts,ModelCard}.tsx` (+ ModelCard test) and `welcome-screen.css` (it uses only the existing `--omp-*` tokens). It renders phase 1's `OllamaRow` and `PullBar` without editing them, and wires their callbacks to `window.omp.ollama`.

## Requirements

1. **When it opens**: on sidecar `ready`, if pref `welcome.completed` is not set **and** the agent has no usable `ollama` model (`hasUsableModelProvider` narrowed to `isAllowedProvider`). It also opens whenever `useUiStore().welcomeOpen` is true (phase 1 action; Settings → Ollama → "Run setup again" in phase 5 sets it).
2. **Layout** (full-window modal, 960 px max): header (atlas icon, title, subtitle) → `MachineFacts` strip → `OllamaRow` → three `ModelCard`s in a grid (1 column below 720 px) → footer with "Set up later" (left) and the "Continue to the assistant" primary button (right).
3. **Loading**: render skeletons straight away (three fact labels and three card shells of the final size, with no reflow), then call `ollama.status()` and `ollama.modelScreen()` in parallel. Status renders first.
4. **OllamaRow wiring**: `onRemedy` → `ollama.runRemedy(id)` then re-render with the returned status. A cancelled pkexec leaves the row as it was. `onCheckAgain` re-runs both fetches.
5. **ModelCard**: tier badges, tag, params, a `dl` with Download / Needs / Runs in / Speed, and the install state (installed badge with pop animation / not downloaded / unknown). Buttons: "Use this model" (installed) or "Download" + hidden "Cancel". `PullBar` subscribes to `onPullProgress`, filters by `tag`, and shows striped indeterminate → percent → done (the card flips to installed and re-fetches status). While one pull runs, the other Download buttons are disabled.
6. **Pick**: "Use this model" marks the card as picked and calls `ollama.warm(tag)`. Continue is enabled when a card is picked, and otherwise defaults to installed-current → installed-recommended → first installed (sai-welcome's `app.js` rule).
7. **Continue**: `tabRpc.setModel("ollama", tag)` plus `set_model_role` `default`, then write the pref `welcome.completed = <iso date>`, then close. If setModel fails, show an inline error and stay open. Do not write the pref first (sai-welcome's marker-before-handoff ordering bug).
8. **Set up later**: closes for this session only (no pref written), like the current `dismissed` ref.
9. Respect `prefers-reduced-motion`. All text goes through `useT()` and is rendered as text nodes only.

## Validation

- `bunx vitest run src/renderer/components/dialogs/FirstRunOnboardingDialog.test.tsx src/renderer/components/onboarding`. The harness injects `window.omp.ollama` with a scripted fake (status sequence, progress events). Cases: ok + installed → Continue enabled and setModel called; absent on linux → install button calls `runRemedy("linux-install")`; darwin → no command block; pull progress → percent text updates then the card becomes installed; setModel rejects → pref not written.
- `bun run check:types`.
