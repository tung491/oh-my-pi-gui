# Phase 4 — Onboarding screen: implementation report

Status: completed (not committed).

## Files
- `src/renderer/components/dialogs/FirstRunOnboardingDialog.tsx` (rewritten; export name kept, plus `hasUsableModelProvider` narrowed to `isAllowedProvider`, `defaultPick`, `WELCOME_COMPLETED_PREF`)
- `src/renderer/components/dialogs/FirstRunOnboardingDialog.test.tsx` (rewritten, 22 tests)
- `src/renderer/components/onboarding/MachineFacts.tsx` (new; also exports `formatGigabytes`)
- `src/renderer/components/onboarding/ModelCard.tsx` (new; `ModelCard` + `ModelCardSkeleton`)
- `src/renderer/components/onboarding/ModelCard.test.tsx` (new, 12 tests covering ModelCard and MachineFacts)
- `src/renderer/components/onboarding/welcome-screen.css` (new; `--omp-*` tokens only)

## Behaviour
- Opens once per launch on sidecar `ready` when the `welcome.completed` pref is unset and no usable Ollama model exists, and whenever `welcomeOpen` is true. It does not cover a dialog that is already open.
- Shows skeletons right away. `status()` and `modelScreen()` start in parallel and each one renders as soon as it lands.
- Remedy outcomes: `applied` renders the returned status and re-reads the model screen. `cancelled` changes nothing. `unavailable` keeps the command and adds the `remedyUnavailable` hint. `failed` shows `remedyFailed` inline.
- Pull: the progress subscription lives for the component's lifetime, so a pull resumes showing progress after the screen reopens. Only one pull runs at a time. Cancel drops the local frame and ignores any late frames for that tag. An error or busy frame stays on the card as a notice. Done marks the card installed and re-fetches both.
- Continue runs `setModel("ollama", tag)`, then `setModelRole("default", "ollama/<tag>")`, then writes the pref with an ISO date, then calls `closeWelcome()`. A failure in either RPC shows `welcome.error.setModel` inline, keeps the screen open and writes no pref.
- Set up later, Escape and the backdrop close for this session only and call `closeWelcome()`, so "Run setup again" can reopen the screen.

## Gates
- `bunx vitest run src/renderer/components/dialogs/FirstRunOnboardingDialog.test.tsx src/renderer/components/onboarding`: 47/47 pass.
- `bun run check:types`: clean.
- `bunx biome check <owned files>`: clean.

## Deviations / notes for phase 6
- MachineFacts shows two facts (Memory, Graphics), not three. No catalog-date key or data exists, and AC1 names only Memory and Graphics.
- The Download button is disabled when `installed === null`, because Ollama did not answer and a pull could not start.
- A failure to write the pref after a successful handoff is logged and does not block closing. The usable-model gate keeps the screen closed on the next launch anyway.
- `scripts/capture-showcase.ts:114-120` still drives the old wizard (`onboarding.wizard.*`, `onboarding.later`). Phase 6 needs to update it along with the now-unused `onboarding.*` locale keys.
- No new locale keys were needed.
