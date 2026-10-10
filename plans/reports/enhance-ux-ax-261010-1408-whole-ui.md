# UX/AX review: Sai ATLAS (app + public site) — 2026-10-10

## Verdict

The app is calm, branded and readable; its weak spots are developer-grade noise
(a `$0.0000` cost chip for a local-only product, unlabeled telemetry), a few
clipped or truncated labels, and empty space reserved inside every user
message. The public site tells a good story but is close to invisible to
crawlers and answer engines (no robots, sitemap, canonical, Open Graph,
JSON-LD, llms.txt or Markdown twin), hides its content until JavaScript runs,
and its primary "Download" button currently lands on GitHub's
"There aren't any releases here" page. After three rounds every proposal except
P3 (publishing a release, an owner action) is done and verified; the DONE
contract holds with the exceptions listed under it.

## Scope and environment

- Mode: `--loop 3`, focus "whole UI UX": the Tauri renderer (every main
  surface) and the public site `site/`.
- Commit at start: `a46bfdf` (main).
- App capture: the real renderer served by Vite (`tmp/ux-harness/`, gitignored)
  with a scripted stand-in for the Tauri core and sidecar built on
  `scripts/showcase-data.ts`, rendered in headless Chromium. The shell is
  WebKitGTK, so font rasterisation can differ slightly; layout and copy are the
  same code. No Rust toolchain existed at the start; it was installed during
  the review on request (Rust 1.99, `cargo tauri` 2.12.1, `tauri-driver`,
  Xvfb, WebKitWebDriver).
- App viewports: 1440×900, 1024×768 and 800×600. The main window's minimum is
  800×600 (`src-tauri/src/desktop/window_bounds.rs:6`), so phone widths are not
  reachable and are not judged. Site viewports: 1440×900, 768×1024, 375×812.
- Site: `site/` served locally on port 5198; production origin
  `https://tung491.github.io/sai-atlas/` (the old `oh-my-pi-gui` URL is 404,
  the repo redirects to `tung491/sai-atlas`).
- Could not run: a real sidecar/model (not needed for UI), a structured-data
  validator and social-card debuggers (no network accounts), real Safari.

## Baseline evidence

Evidence folder: `enhance-ux-ax-261010-1408-whole-ui/round-1/baseline/`.

| State | 1440×900 | 1024×768 | 800×600 |
|---|---|---|---|
| Chat with a finished Word report | `desktop-chat-report.png` | `laptop-chat-report.png` | `minwin-chat-report.png` |
| New task (empty state) | `desktop-chat-empty.png` | `laptop-chat-empty.png` | `minwin-chat-empty.png` |
| First-run onboarding (no Ollama) | `desktop-onboarding.png` | `laptop-onboarding.png` | `minwin-onboarding.png` |
| Settings overview | `desktop-settings.png` | — | `minwin-settings.png` |
| Ollama window | `desktop-ollama.png` | — | — |
| Light theme, Vietnamese | `desktop-chat-report-light.png`, `desktop-chat-vi.png` | — | — |

Site: `site/1440x900.png`, `site/768x1024.png`, `site/375x812.png`
(render-check report `site/render-report.json`).

Discovery scan (`check-discovery-surfaces.mjs http://127.0.0.1:5198/
--site-origin https://tung491.github.io/sai-atlas/`): 3 errors (no
`robots.txt`, no `sitemap.xml`, no `og:image`), 9 warnings (no `llms.txt`,
`llms-full.txt`, canonical, `og:title`/`og:description`/`og:url`,
`twitter:card`, JSON-LD, Markdown twin), 2 info (no Markdown alternate link,
no content negotiation).

## Scores

| Area | Score 0–3 | Evidence |
|---|---|---|
| First impression | 2 | App empty state states the job and offers four starters (`desktop-chat-empty.png`); site headline is clear but the download CTA leads to an empty releases page. |
| Brand recall | 2 | Logo, navy canvas and blue accent are consistent across app windows; the site uses a teal/green accent the app never uses (`site/1440x900.png` vs `desktop-chat-report.png`). |
| Content punch | 2 | Plain, outcome-led copy ("Turn my notes into a Word report"); settings overview mixes Title Case action labels ("Resend Last Message") with sentence case. |
| Clarity and hierarchy | 1 | Title bar shows five unlabeled developer metrics including `$0.0000` for a local-only product; at 800 px the task title collapses to "Sep…" (`minwin-chat-report.png`). |
| Storytelling (site) | 2 | Word → Excel → PowerPoint → computer help → privacy → install reads as chapters; proof is real screenshots, but they are stale (`office_report` label, no Preview button). |
| Knowledge and trust | 1 | Privacy story is strong; the primary download link is broken for every visitor (no published release); repo links use the old name. |
| Motion | 2 | App uses 90–280 ms tokens and honours reduced motion; site hero takes 1 s to fade in and `.reveal` content is `opacity: 0` until a script runs (`site/index.html:163`, `:329`). |
| Responsive | 2 | No overflow at any app size; settings nav labels truncate ("EXTENSIONS & RESOUR…", `desktop-settings.png`); site hero badge breaks into three ragged columns at 375 px (`site/375x812.png`). |
| Accessibility | 1 | Settings search placeholder runs under the `Ctrl+K` chip (`desktop-settings.png`); site fine print is 3.81:1 (render-check). |
| Performance feel | 2 | WebP screenshots, inline CSS, no third-party scripts; hero text is invisible for up to 1 s by animation. |

## Proposals

### P1 — Discovery surfaces for the public site (Must)
- Evidence: discovery scan errors and warnings above.
- Change: add `robots.txt` (allow all, absolute `Sitemap:`), `sitemap.xml`,
  self-referencing canonical, Open Graph and X card tags with a 1200×630 PNG
  card, JSON-LD (`WebSite` + `SoftwareApplication`), `llms.txt`, an `index.md`
  Markdown twin advertised with `rel="alternate"`, and a favicon.
- Files: `site/index.html`, `site/robots.txt`, `site/sitemap.xml`,
  `site/llms.txt`, `site/index.md`, `site/assets/og-card.png`,
  `site/assets/favicon.svg`.
- Acceptance: the scan exits 0 with no errors; remaining warnings are listed
  with reasons; the OG image is 1200×630.

### P2 — Site text contrast (Must)
- Evidence: render-check `low-contrast` 3.81:1 on `.hero-fine`, footer and
  meta text.
- Change: raise the muted text token to at least 4.5:1 on the page background.
- Files: `site/index.html`.
- Acceptance: render-check reports no `low-contrast` finding.

### P3 — Primary download CTA leads to an empty releases page (Must, owner)
- Evidence: `curl https://api.github.com/repos/tung491/sai-atlas/releases`
  returns `[]`; `/releases/latest` redirects to "There aren't any releases here".
- Change: publish a GitHub release with the `.deb` and AppImage (release flow
  in `AGENTS.md`). Publishing is outward-facing, so it is not done by this
  review.
- Acceptance: `/releases/latest` returns 302 to a tag page.

### P4 — Settings search placeholder hidden under the shortcut chip (Must)
- Evidence: `desktop-settings.png`, `minwin-settings.png` ("…managed resour"
  runs into `Ctrl+K`).
- Change: reserve enough right padding for the chip.
- Files: `src/renderer/components/settings/SettingsWindow.tsx`.
- Acceptance: at 1440 and 800 the placeholder ends before the chip.

### P5 — Drop the zero cost chip from the title bar (Should)
- Evidence: `$0.0000` in every capture; the assistant pack pins
  `modelPolicy.localOnly`, so cost is always zero.
- Change: render the cost segment only when the cost is above zero.
- Files: `src/renderer/components/layout/TitleBar.tsx`.
- Acceptance: no `$0.0000` in the title bar; the task title gets more room at
  800 px; a cost above zero still shows.

### P6 — Empty band reserved inside every user message (Should)
- Evidence: `desktop-chat-report.png` (the "You" bubble is ~50 px taller than
  its text); the hidden copy/branch row keeps its space.
- Change: float the copy/branch toolbar over the bubble's bottom edge instead
  of reserving a row.
- Files: `src/renderer/styles/components.css`.
- Acceptance: the bubble ends 14 px under its last line; the toolbar still
  appears on hover and keyboard focus.

### P7 — Settings navigation group labels truncated (Should)
- Evidence: "EXTENSIONS & RESOUR…", "SYSTEM & ADVA…" (`minwin-settings.png`).
- Change: let the group label wrap.
- Files: `src/renderer/components/settings/SettingsWindow.tsx`.
- Acceptance: full labels visible at 1440 and 800.

### P8 — "Ollama is running (1 models)" (Should)
- Evidence: `desktop-ollama.png`.
- Change: a singular message for one model, in both locales.
- Files: `OllamaRow.tsx`, `locales/en.ts`, `locales/vi.ts`.
- Acceptance: one model reads "(1 model)"; the locale key test stays green.

### P9 — Site content invisible without JavaScript; slow hero entrance (Should)
- Evidence: `.reveal { opacity: 0 }` and `.rise` 1 s (`site/index.html:163`,
  `:329`).
- Change: hide `.reveal` only when a `js` class is on `<html>`; shorten the
  hero entrance to ≤ 600 ms.
- Files: `site/index.html`.
- Acceptance: with JavaScript off every section is visible; hero animation
  ≤ 600 ms; reduced motion still disables both.

### P10 — Site hero badge breaks into three columns on phones (Should)
- Evidence: `site/375x812.png`.
- Change: let the badge wrap as one text run and centre it.
- Files: `site/index.html`.
- Acceptance: at 375 px the badge reads as at most two centred lines.

### P11 — Site links use the old repository name (Should)
- Evidence: ten `github.com/tung491/oh-my-pi-gui` links and the releases API
  URL in `site/index.html`.
- Change: point them at `tung491/sai-atlas` (the old name only works through
  GitHub's redirect).
- Acceptance: `grep oh-my-pi-gui site/` finds nothing.

### P12 — Sidebar "collapse navigation" bar reads like an empty field (Could)
- Evidence: bordered full-width bar under Settings (`desktop-chat-report.png`).
- Change: drop the border, keep hover fill, label and title.
- Files: `src/renderer/components/layout/Sidebar.tsx`.
- Acceptance: no border at rest; hover and focus still visible.

### P14 — Command palette opens on developer and cloud-only commands (Should, round 2)
- Evidence: `round-2/baseline/desktop-commands.png`: groups were ordered by
  their alphabetically first command, so "Model" (Advisor, Fast Mode, Prewalk)
  came first; after reordering, the unconfirmed "Clear Context" became the
  default Enter target.
- Change: fixed group order (session, view, workspace, context, model, …) and
  New Session, New Tab, Resume, Rename lead the Session group.
- Files: `src/renderer/lib/command-registry.ts`, `command-registry-inventory.test.ts`.
- Acceptance: palette opens on "New Session"; two tests cover the order.

### P15 — Disabled "Get started" gives no reason (Should, round 2)
- Evidence: `round-1/baseline/desktop-onboarding.png`.
- Change: the footer says "Download a model above to get started." while no
  model is available (English and Vietnamese).
- Files: `FirstRunOnboardingDialog.tsx`, `locales/en.ts`, `locales/vi.ts`.
- Acceptance: `round-2/after/minwin-onboarding.png`.

### P16 — Site headline orphan and small footer targets on phones (Could, rounds 2–3)
- Evidence: "AI" alone on a line at 375 px; render-check flagged 9 links under 44 px.
- Change: a non-breaking space keeps "local AI" together; footer links get a
  44 px row under 600 px.
- Acceptance: `round-3/after/site/hero-375-crop.png`; small-target warnings 9 → 3
  (logo links and one inline text link, all ≥ 24 px).

### P17 — Every palette command has the same slash icon (Could, round 3)
- Change: one icon per command group.
- Files: `src/renderer/components/dialogs/CommandPalette.tsx`.
- Acceptance: `round-3/after/desktop-commands.png`.

### P18 — Stale product screenshots on the site and README (Should, round 3)
- Evidence: site and README images showed the old `office_report` label and no
  Preview button.
- Change: re-ran `capture:showcase` against a real Tauri debug build on the
  virtual display (needed `bun run build:pack` first) and rebuilt the three
  site WebP files from the new English captures.
- Files: `docs/screenshots/{en,vi}/*.png`, `site/assets/0[1-3]-*.webp`.
- Acceptance: six captures pass the script's own privacy and error checks.

### P13 — Project guidance files (Should)
- Change: `docs/DESIGN.md` (tokens, motion, voice), `docs/REVIEW.md` (UX/AX
  checklist), and an `AGENTS.md` pointer. They live in `docs/` because this
  repository keeps Markdown in `docs/` and `plans/`.
- Acceptance: files exist; `AGENTS.md` links them; prior content unchanged.

## DONE contract

1. P1, P2, P4–P11 and P13 meet their acceptance checks; P3 is recorded as an
   owner action; P12 is done or skipped with a reason.
2. The discovery scan exits 0 against the local site with
   `--site-origin https://tung491.github.io/sai-atlas/`; remaining warnings are
   listed with reasons.
3. Screenshots of every changed surface at the three viewports show no
   overflow, clipping, overlap or broken image, and the vision review finds no
   High issue.
4. No rubric area regresses; every area below 2 reaches 2 or is an unresolved
   question.
5. Changed interactive elements work by keyboard, and reduced motion removes
   non-essential motion on the site.
6. `bun run check:types`, `bunx biome check` on touched files,
   `node scripts/lint-surfaces.mjs` and `bunx vitest run` pass, or failures are
   shown as pre-existing.
7. `docs/DESIGN.md`, `docs/REVIEW.md` and `AGENTS.md` reflect the direction.
8. The Vite dev server, the static site server and any browsers started by the
   review are stopped.

## Round log

| Round | Proposals done | Checks passing | Regressions fixed | Notes |
|---|---|---|---|---|
| 1 | P1, P2, P4–P13 | Scan exit 0; render-check: no contrast or overflow; types, biome, surface lint, focused tests | None | Site work by a delegate, reviewed. Scan must target the site served under `/sai-atlas/`. |
| 2 | P14, P15, P16 (footer) | Full suite 2101 passed; one stale test assertion updated to the new singular wording | Reordering made "Clear Context" the default Enter; fixed by leading with safe commands | `bun install` with bun 1.3.14 rewrote `bun.lock`; restored. |
| 3 | P16 (headline), P17, P18 | Full suite, `bun run build` with chunk check, real-app showcase 6/6 | `text-wrap: balance` did not balance across the `<br>`; replaced with a non-breaking space | Real WebKitGTK captures confirm round-1 changes in the actual app. |

### Scores after round 3

| Area | Before | After | Evidence |
|---|---|---|---|
| First impression | 2 | 2 | Unchanged strengths; CTA still blocked on P3. |
| Brand recall | 2 | 2 | OG card and favicon now carry the brand; site/app accent split remains a question. |
| Content punch | 2 | 2 | Onboarding explains the disabled step; Title Case command labels remain. |
| Clarity and hierarchy | 1 | 2 | No zero cost chip; task title readable at 800 px; palette opens on everyday actions. |
| Storytelling (site) | 2 | 2 | Screenshots now match the shipped app. |
| Knowledge and trust | 1 | 1 | Download still lands on an empty releases page (P3, owner). |
| Motion | 2 | 2 | Site content visible without JS; hero entrance 0.6 s. |
| Responsive | 2 | 2 | Nav labels wrap; badge and headline fixed at 375 px. |
| Accessibility | 1 | 2 | Search no longer under the chip; site contrast ≥ 4.5:1; larger phone targets. |
| Performance feel | 2 | 2 | Smaller WebP files; hero shows sooner. |

### DONE contract status

1. Done for every Must/Should except P3 (owner action: publish a release).
2. Scan exits 0 against the site served at `/sai-atlas/`. Accepted warnings:
   no `llms-full.txt` (no long-form docs), no `X-Robots-Tag` on `index.md` and
   `llms.txt` (GitHub Pages cannot set headers).
3. Captures in `round-1/after`, `round-2/after`, `round-3/after` and
   `docs/screenshots/` show no High issue.
4. Knowledge and trust stays at 1 because of P3 (unresolved question 1).
5. The user-message toolbar also appears on keyboard focus
   (`round-1/after/desktop-chat-hover.png`); site reduced motion still overrides
   the entrance and reveal animations.
6. `check:types`, biome on touched files, `lint-surfaces`, `bun run build` and
   vitest pass. Only `assistant-pack/test/compiled.test.ts` fails, because no
   sidecar binary (`resources/omp.linux-x64`) is built on this machine. Running
   plain `bunx vitest run` also collects test files from the gitignored
   `.claude/` and `.agentkit/` folders, which fail to load; neither is related
   to these changes.
7. `docs/DESIGN.md` and `docs/REVIEW.md` are new; `AGENTS.md` gained one line.
8. The Vite harness, static server, virtual display, browsers and drivers are
   stopped. The browser harness stays in the gitignored `tmp/ux-harness/` for
   re-checks.

## Unresolved questions

1. Publish a release? `tung491/sai-atlas` has no published release, so the
   site's download buttons and the in-app updater feed (404 in the runtime log)
   point at nothing. This is the biggest remaining trust gap.
2. `robots.txt` only works at the host root. The site is a project page under
   `tung491.github.io/sai-atlas/`, so crawlers read
   `tung491.github.io/robots.txt` from a `tung491.github.io` repository, which
   does not exist. Create that repository, or submit the sitemap in Search
   Console?
3. Should the first-run screen collapse the seven-line root install command
   behind "Show the exact command"? The code shows it verbatim on purpose as
   consent, so it was left as is.
4. Should the palette hide cloud-only commands (Fast Mode's "priority service
   tier", Prewalk, Advisor) when the session is local-only? They were kept,
   because the command inventory test treats the kept set as a product choice.
5. Should command labels move to sentence case ("Switch model") to match
   `docs/DESIGN.md`? It touches about 60 strings in both locales.
6. Should the site's teal accent align with the app's blue?
7. Tool check lines such as "1 sheet, 236 rows kept…" come from the agent in
   English even in a Vietnamese session (`round-1/baseline/desktop-chat-vi.png`).
   This is agent-side (monorepo) work.
