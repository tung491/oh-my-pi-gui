# GUI Development Rules

This file governs the **Sai ATLAS GUI sub-repository**. Read it before any edit here — the directory layout (a repo nested inside the omp monorepo) is unusual and getting it wrong breaks builds or leaks commits into the wrong remote.

## Repository Identity

- **This repo is the real product repo:** [`tung491/oh-my-pi-gui`](https://github.com/tung491/oh-my-pi-gui). It owns all GUI code, commits, tags, and GitHub Releases; the in-app updater and every `electron-builder*.yml` `publish` block read releases from it. [`nornzach/oh-my-pi-gui`](https://github.com/nornzach/oh-my-pi-gui) is the upstream GUI repo this fork tracks.
- **Remote layout:** `origin` = `tung491/oh-my-pi-gui` (push here). The surrounding monorepo's remotes are NOT this repo's remotes — never `git push` from inside `packages/gui/` expecting monorepo changes to go anywhere, and never push anything to `can1357`.

### The three repos — never confuse them

| Repo | Role | Push? | Pull/sync from? |
|---|---|---|---|
| [`tung491/oh-my-pi-gui`](https://github.com/tung491/oh-my-pi-gui) | **This repo** — GUI product, releases (`nornzach/oh-my-pi-gui` is the upstream GUI repo it tracks). | ✅ all GUI work | only own commits |
| [`nornzach/oh-my-pi`](https://github.com/nornzach/oh-my-pi) | **Monorepo fork** (`origin` of the enclosing checkout) — agent source; the only sidecar build source, and the monorepo the README's build-from-source flow clones. | ✅ (from the monorepo root, not from here) | only own commits |
| [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi) | **Upstream** (`upstream` of the enclosing checkout) — where new omp features come from. | ❌ **NEVER** | ✅ `scripts/sync-upstream.sh` |

- **All GUI work commits to this repo and pushes to `origin/main`.** Never commit GUI paths into the enclosing monorepo's git — from its perspective this directory is an intentionally untracked, self-contained checkout.
- Agent-side work (RPC commands, session logic, `packages/agent|coding-agent|ai|…`) belongs to the **monorepo**, commits at the monorepo root, and pushes to `nornzach/oh-my-pi` (fork) — it does not exist in this repo's history even though the files sit above this directory.

### Product identity

- The product is **Sai ATLAS**, the AI assistant for SAI OS — always both words, never the second one alone. The name lives in `PRODUCT_NAME` (`src/shared/product.ts`) and the `brand.name` locale key.
- The agent stays **omp**: the sidecar, the `omp` CLI, `~/.omp`, `omp://` links and the `--omp-*`/`omp-*` code names are not renamed.
- `appId` is `vn.io.vif.saiatlas` (`APP_ID` in `src/shared/product.ts`), and every Windows config pins `nsis.guid` to the old app id's GUID so the installer upgrades an existing omp install in place. Never change either; `packaging-config.test.ts` guards both.
- The profile path is pinned to `<appData>/@oh-my-pi/omp-gui` by `src/main/pin-user-data.ts`. Never add `productName` to `package.json` or rename its `name`, or a future change could move everyone's settings.
- Brand art comes from the VIF Brand Design System artifact (`<Logo brand="atlas">`) and the brand canvas: the in-app files in `src/renderer/public/brand/`, and `resources/icon-source.svg` / `resources/tray-source.svg` for the OS icons, which `bun run gen:icons` rebuilds (including `src/main/tray-mark.ts`).

### Upstream sync (pulling new omp features)

Always the script (it re-provisions what a plain merge misses), from anywhere:

```bash
bash packages/gui/scripts/sync-upstream.sh   # run from the GUI repo; it cds to the monorepo root
# fetch upstream → incoming list → merge upstream/main → bun install →
# pi_natives re-provision on version bump → gen:stats → build:omp → GUI build + tests
```

- Conflicts: resolve, commit the merge, re-run with `SKIP_MERGE=1`.
- A sync touches monorepo files only until step 6; the sidecar rebuild (`build:omp`) and GUI build/tests close the loop. Push monorepo results from the monorepo root (fork), GUI results from here.
- **Every release starts with a sync** (README → Release process step 1) so the DMG's sidecar carries current upstream.

## Nested Checkout Layout

This repo lives at `packages/gui/` inside a clone of the omp monorepo:

```
oh-my-pi/                    ← monorepo (upstream sync + sidecar source)
├── packages/coding-agent/   ← agent source compiled into the sidecar
├── packages/natives/        ← native addon compiled into the sidecar
└── packages/gui/            ← THIS repo (own .git, tags, releases)
    ├── .git/                ← GUI repo — do not confuse with monorepo .git
    ├── src/                 ← GUI code (commits land here)
    └── resources/omp*       ← sidecar binaries (gitignored, built locally)
```

- The monorepo exists for **upstream feature sync and building the sidecar**; the GUI repo is **the only commit/release target**.
- `git status` / `git log` / `git push` run inside `packages/gui/` act on the GUI repo. Anything outside `packages/gui/` acts on the monorepo.
- Do not move this directory out of the monorepo: `scripts/build-bundled-omp.ts` resolves `../../coding-agent` relative to it. If you clone standalone, building the sidecar requires the monorepo next to it (see README → Build from source).

## Sidecar & Packaging Rules

The GUI runs the agent as a **bundled sidecar** (`resources/omp`, a compiled `Bun.build --compile` binary of `packages/coding-agent`). Rules that keep packaging sane:

- `resources/omp` and `resources/omp.*` are **gitignored build artifacts** (~120 MB each). Never commit them; never hand-edit them.
- Build the arm64 sidecar with `bun run build:omp`; cross-build Intel with `bun run build:omp:x64` (outputs `resources/omp.x64`). The script auto-stages the matching `pi_natives` addon — including replacing stale addons whose version sentinel doesn't match — downloads it from npm when missing, and restores the natives directory afterwards. It requires the monorepo neighbors and fails with setup instructions when they're absent.
- Agent changes the GUI depends on but no fork carries live in `patches/omp/*.patch` (made with `git format-patch` at the monorepo root). `build:omp` applies each one to the monorepo before compiling and reverts it afterwards, skips a patch the checkout already contains, and fails with rebase steps when an upstream sync makes one stop applying. Today that is `0001-ollama-native-api-num-ctx.patch`, which the sidecar's `PI_OLLAMA_API=ollama-chat` (`src/main/sidecar.ts`) relies on.
- The sidecar embeds the `pi_natives` native addon. After syncing the monorepo with upstream (version bump), re-provision natives **before** `build:omp` — `scripts/sync-upstream.sh` automates this.
- Packaging reads the sidecar via `extraResources` (`electron-builder.yml` → `resources/omp` for arm64, `electron-builder.x64.yml` → `resources/omp.x64` for Intel). Building x64 from the default config ships the wrong-arch sidecar — always package Intel with `bun run package:mac:x64` (the x64 config), never plain `package:mac`.
- Linux x64: `bun run build:omp:linux` → `resources/omp.linux-x64`; `electron-builder.linux.yml` bundles it as `omp`. Package with `bun run package:linux` only; the default config would ship the macOS `resources/omp`.
- A packaged GUI never consults a system-installed `omp`. `src/main/index.ts` (`resolveBundledOmp`) only accepts the bundled binary; missing binary = actionable error, not a fallback.

## Build, Test, Release

- Check: `bun run check:types` (tsc) and `bunx biome check .` — keep touched files clean even if legacy diagnostics remain.
- Test: `bunx vitest run` (full suite must stay green).
- Build: `bun run build` (electron-vite → `out/`), then `bun run package:mac:arm64 -- --publish never` (arm64) or `bun run package:mac:x64 -- --publish never` (Intel). Linux x64 (on a Linux x64 host): `bun run build:omp:linux`, then `bun run package:linux -- --publish never` (AppImage + .deb + `latest-linux.yml`).
- Release flow: bump `version` in `package.json`, write the CHANGELOG section, update README install links, commit, tag `vX.Y.Z`, push `main` + tag to `origin`, build both DMGs, smoke-test each mounted `Sai ATLAS.app` (sidecar `ready`, `get_settings` RPC, one settings toggle), then publish the GitHub Release with both `Sai-ATLAS-` DMGs, the `omp-<version>-arm64.dmg` / `omp-<version>.dmg` bridge copies (byte-identical; every release until 1.0.0), both ZIPs (`Sai-ATLAS-<version>-arm64.zip`, `Sai-ATLAS-<version>.zip`) and a combined `latest-mac.yml` that lists every DMG — the built-in updater resolves the matching DMG from that file, so a release without it (or with only one architecture's entries) breaks update checks; that file must also carry `minimumSystemVersion: 22.0.0` (electron-builder never writes it, and without it macOS 12 installs download a build they cannot open), so run `bun run check:mac-update-floor <latest-mac.yml>` on it before publishing, and 0.9.x builds find their update only through the `omp-` names. Until 1.0.0, open every release body with the Mac migration steps from the README (quit omp, install Sai ATLAS, move `omp.app` to the Trash, re-pin, grant microphone and notification access again): the DMG installs beside `omp.app` rather than replacing it, and the 0.9.x update screen never shows release notes. For Linux, build the AppImage and .deb on Linux x64, run `e2e/packaged-smoke.e2e.ts` against the installed .deb, and publish `latest-linux.yml` with both packages.
- CI: `.github/workflows/ci.yml` runs check:types, vitest and build on ubuntu-latest.
- Every release's DMGs embed the sidecar compiled from the monorepo — record the monorepo commit in the release notes if it isn't upstream `main`.
- **The public site is `site/`** (`site/index.html` + `site/assets/`). Pages is configured as `build_type=workflow`, so `.github/workflows/pages.yml` is the only publisher: a push to `main` touching `site/**` deploys it. Its version string and DMG links are read from the GitHub releases API at page load, so a release needs **no site edit**; the values in the HTML are only the no-JS fallback.

## Code Conventions

- Follow the enclosing monorepo's `AGENTS.md` for TypeScript style (no `any`, no inline imports, `#private` fields, Bun APIs over Node where cleaner).
- i18n: every user-visible string goes through `useT()` with entries in **both** `src/renderer/locales/en.ts` and `vi.ts` (they must stay key-identical — `locales.test.ts` enforces it).
- Rendering model output: sanitize through `MarkdownRenderer` (rehype-sanitize schema in `src/renderer/lib/markdown.tsx`) — never `dangerouslySetInnerHTML` with raw model text.
- Tool-rendered text follows the monorepo's TUI sanitization rules (tabs, truncation, path shortening) via the helpers in `src/renderer/lib/format.ts`.
- Preview ceilings come from the tiers in `src/renderer/lib/preview.ts` (`PREVIEW_SCROLL_*` + line caps) — don't invent new `max-h-*` values in tool renderers. Captured subprocess output renders through `AnsiText` (`src/renderer/lib/ansi.tsx`), never raw (ANSI escapes would print literally).
- Tests use the linkedom harness pattern (see `src/renderer/components/chat/ThinkingBlock.test.tsx`); zustand stores are reset in `afterEach` via their `reset()`/setters — never `mock.module()`.

## Examples

### Everyday GUI change — commits land in the right repo

```bash
# cwd: packages/gui/ — every git command here acts on the GUI repo
bun run dev                              # HMR against resources/omp
# …edit src/renderer/…
bunx vitest run && bun run check:types
bunx biome check <touched files>         # whole-repo check has legacy diagnostics
git commit -am "Add X to the settings window"   # → nornzach/oh-my-pi-gui
git push origin main
```

The same edit one level up (`packages/coding-agent/…`) belongs to the **monorepo**: commit at the monorepo root (`packages/gui/../..`) and push to the `nornzach/oh-my-pi` fork — never from here.

### Upstream sync with a merge conflict

```bash
bash packages/gui/scripts/sync-upstream.sh
# merge stops: CONFLICT in packages/coding-agent/src/…
# resolve the markers, then from the MONOREPO ROOT (git there = fork):
git add -A && git commit
SKIP_MERGE=1 bash packages/gui/scripts/sync-upstream.sh   # resumes after the merge step
git push origin main                       # monorepo root → nornzach/oh-my-pi
# GUI-side changes (if any) commit and push separately from packages/gui/
```

### Adding a user-visible string (i18n)

```ts
// src/renderer/locales/en.ts
"settings.proxy.enabled": "Proxy enabled",
// src/renderer/locales/vi.ts — identical key, translated value
"settings.proxy.enabled": "Đã bật proxy",
```

```tsx
// component
import { useT } from "../../lib/i18n";

const t = useT();
<span>{t("settings.proxy.enabled")}</span>
// interpolation: t("input.thinking", { level }) fills "Thinking: {level} — click to change"
```

Add the key to both locale files in the same commit — `locales.test.ts` fails the suite if the key sets diverge.

### Rendering model or tool text

```tsx
import { MarkdownRenderer } from "../../lib/markdown";

<MarkdownRenderer content={modelText} />
```

Never `dangerouslySetInnerHTML` with model output, and never build a second markdown path — extend the sanitize schema in `src/renderer/lib/markdown.tsx` if a construct is missing.

### Writing a component test (linkedom harness)

Follow `ThinkingBlock.test.tsx`: set up linkedom globals once, mount through `I18nProvider`, and reset stores in `afterEach`:

```tsx
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settings";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

let container: Element;
let root: Root;

async function mount(element: ReactElement): Promise<void> {
	// linkedom's types don't match React's — cast as in ThinkingBlock.test.tsx
	container = document.createElement("div") as unknown as Element;
	document.body.appendChild(container as never);
	root = createRoot(container);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	useSettingsStore.getState().reset();   // setters/reset() — never mock.module()
});
```
