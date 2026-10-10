# UX and AX review checklist

Use this for any change that touches what people see in the app
(`src/renderer/`) or on the public site (`site/`). `docs/DESIGN.md` holds the
direction this checklist checks against.

## Evidence that goes with a UI change

- Screenshots of every changed surface, before and after. App: 1440×900,
  1024×768 and 800×600 (the window minimum). Site: 1440×900, 768×1024 and
  375×812.
- App captures run out of sight: `scripts/virtual-display.sh run -- …` for
  the Tauri build (see `AGENTS.md` → Running the GUI Out of Sight).
- Both locales when copy changed, and both themes when colour changed.

## UX checks

| Area | Pass when |
|---|---|
| First impression | A newcomer can tell what to do next within five seconds; one primary action per view. |
| Clarity | No developer-only figures or jargon in the main window; numbers carry a label or tooltip. |
| Copy | Sentence case, outcome first, English and Vietnamese keys added together, singular forms for counts of one. |
| Responsive | No horizontal overflow, clipped text or overlapping controls at the three sizes; the task title stays readable at 800 px. |
| Motion | Uses the motion tokens; nothing over 300 ms for UI transitions; reduced motion removes non-essential movement. |
| Accessibility | Keyboard reachable with a visible focus ring; icon buttons have an accessible name; text contrast at least 4.5:1. |
| Trust | Commands that run as administrator are shown before they run; nothing leaves the machine without the user asking. |

## AX checks for the public site

Run against a local server of `site/`:

```bash
node .claude/skills/ak-enhance-ux-ax/scripts/check-discovery-surfaces.mjs \
  http://127.0.0.1:<port>/ --site-origin https://tung491.github.io/sai-atlas/
```

- Exit code 0. Accepted warnings: GitHub Pages cannot send `X-Robots-Tag` or
  `Vary` headers, and there is no long-form docs content for `llms-full.txt`.
- When the page's content changes, update `site/index.md` (the Markdown twin),
  `site/llms.txt` and the JSON-LD in `site/index.html` in the same commit, and
  bump `lastmod` in `site/sitemap.xml`.
- When the headline changes, regenerate `site/assets/og-card.png`
  (1200×630) under a new file name so social caches refresh.
- Every section is readable with JavaScript turned off.
- The primary download link resolves to a published release.
