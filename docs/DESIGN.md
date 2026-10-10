# Sai ATLAS design

Sai ATLAS is a calm, private assistant for everyday office work on SAI OS: it
writes the report, tidies the spreadsheet, makes the slides and helps when the
computer misbehaves, all on the user's own machine.

Read this before UI work in `src/renderer/` or `site/`. The tokens below are
defined in code; this file explains them and does not replace them.

## Audience and voice

- The audience is office workers, not developers. Lead with the outcome
  ("Your report is ready"), name files and folders the way the user sees them,
  and keep jargon (tokens, cache, providers, endpoints) behind Settings or a
  tooltip.
- Plain sentences, sentence case for labels and buttons, a verb plus an object
  for actions ("Open in folder", "Download model").
- Every user-visible string exists in English and Vietnamese
  (`src/renderer/locales/en.ts`, `vi.ts`). When a count can be one, give it a
  singular key rather than "(1 models)".
- Local-only is the promise: never show figures that only make sense for paid
  cloud models (a cost of zero is hidden, not printed as `$0.0000`).

## Brand

- The product name is always "Sai ATLAS"; the logo comes from
  `<SaiAtlasLogo>` and `src/renderer/public/brand/` (see `AGENTS.md` →
  Product identity).
- Signature: a deep navy canvas with one blue accent, Poppins for display
  text, Inter for UI text, JetBrains Mono for paths, figures and shortcuts.
- The public site (`site/`) uses a teal accent on near-black; aligning it with
  the app's blue is an open brand decision, so do not change either alone.

## Tokens (source of truth in code)

| Kind | Where | Notes |
|---|---|---|
| Colour | `src/renderer/styles/theme-dark.css`, `theme-light.css` | `--omp-accent` (#7db9ff dark, #1b5fcc light), `--omp-bg-primary` canvas, `--omp-bg-elevated` floating surfaces, `--omp-text` / `--omp-text-secondary` / `--omp-dim`, semantic `--omp-success` / `--omp-warning`. |
| Type scale | `src/renderer/styles/global.css` (`--text-omp-xxs` … `--text-omp-xl`) | Scales with the user's font size; never write `text-[Npx]` below 16 px (`scripts/lint-surfaces.mjs`). |
| Families | `--font-display`, the default sans, `--font-mono` | Display for headings, mono only for machine values. |
| Motion | `--omp-motion-fast` 120 ms, `--omp-motion-med` 180 ms, `--omp-motion-slow` 280 ms; `--omp-ease`, `--omp-ease-enter` | Interaction transitions use `fast` or `med` (linted); animate opacity and transform only; reduced motion removes non-essential movement. |
| Surfaces | SURFACE POLICY in `global.css` | Content is transparent on the canvas; only chrome, overlays, states and semantic fills paint. |
| Shadow | `--omp-shadow-sm` | Floating toolbars and bubbles only. |

## Layout

- The main window is never narrower than 800×600
  (`src-tauri/src/desktop/window_bounds.rs`). Check 1440×900, 1024×768 and
  800×600; at 800 the task title must stay readable before any metric does.
- Hover-only controls must not reserve empty space: float them (see the user
  message toolbar in `components.css`) and also show them on keyboard focus
  and on devices without hover.
- Labels wrap rather than truncate when the text is the only way to know what
  a control does (settings navigation groups).

## Do and don't

- Do show the real file the assistant made, with Preview, Open and Show in
  folder next to it.
- Do keep one primary action per view; secondary actions are outlined or text.
- Don't add new `max-h-*` preview sizes; use the tiers in
  `src/renderer/lib/preview.ts`.
- Don't render model text outside `MarkdownRenderer`.
- Don't add a figure, badge or colour without a user question it answers.
