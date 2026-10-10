# GUI Development Rules

This file governs the **Sai ATLAS GUI sub-repository**. Read it before any edit here — the directory layout (a repo nested inside the omp monorepo) is unusual and getting it wrong breaks builds or leaks commits into the wrong remote.

## Repository Identity

- **This repo is the real product repo:** [`tung491/oh-my-pi-gui`](https://github.com/tung491/oh-my-pi-gui). It owns all GUI code, commits, tags, and GitHub Releases, and is the publishing repo: the Tauri updater (its compiled-in feed base in `src-tauri/src/updater/feed.rs`) and the 0.9.x Electron updater installed on Linux read releases from it. [`nornzach/oh-my-pi-gui`](https://github.com/nornzach/oh-my-pi-gui) is the upstream GUI repo this fork tracks.
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
- `appId` is `vn.io.vif.saiatlas` (`APP_ID` in `src/shared/product.ts`). Never change it; `scripts/tauri-packaging-config.test.ts` and `src-tauri/src/product.rs` guard it.
- The profile path is pinned to `<appData>/@oh-my-pi/omp-gui` by `src-tauri/src/paths.rs` (`PROFILE_DIR_SEGMENTS`). Never add `productName` to `package.json` or rename its `name`, or a future change could move everyone's settings.
- Brand art comes from the VIF Brand Design System artifact (`<Logo brand="atlas">`) and the brand canvas: the in-app files in `src/renderer/public/brand/`, and `resources/icon-source.svg` / `resources/tray-source.svg` for the OS icons, which `bun run gen:icons` rebuilds (including `src/shared/tray-mark.ts`).

### Upstream sync (pulling new omp features)

Always the script (it re-provisions what a plain merge misses), from anywhere:

```bash
bash packages/gui/scripts/sync-upstream.sh   # run from the GUI repo; it cds to the monorepo root
# fetch upstream → incoming list → merge upstream/main → bun install →
# gen:stats → build:omp → GUI build + tests
```

- Conflicts: resolve, commit the merge, re-run with `SKIP_MERGE=1`.
- A sync touches monorepo files only until step 4; the sidecar rebuild (`build:omp`, step 5) and the GUI build and tests (step 6) close the loop. Push monorepo results from the monorepo root (fork), GUI results from here.
- **Every release starts with a sync** (README → Release process step 1) so the packages' sidecar carries current upstream.

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

The GUI runs the agent as a **bundled sidecar** (`resources/omp`, a compiled `Bun.build --compile` binary of `packages/coding-agent`) inside the Tauri shell (Rust core in `src-tauri/`, system WebKitGTK). Linux is the only target; macOS and Windows are not built. Rules that keep packaging sane:

- `resources/omp` and `resources/omp.*` are **gitignored build artifacts** (~120 MB each). Never commit them; never hand-edit them.
- Build the host sidecar with `bun run build:omp` (`resources/omp`, for development) and the release sidecar with `bun run build:omp:linux` (`resources/omp.linux-x64`). The script auto-stages the matching `pi_natives` addon — including replacing stale addons whose version sentinel doesn't match — downloads it from npm when missing, and restores the natives directory afterwards. It requires the monorepo neighbors and fails with setup instructions when they're absent.
- Agent changes the GUI depends on but no fork carries live in `patches/omp/*.patch` (made with `git format-patch` at the monorepo root). `build:omp` applies each one to the monorepo before compiling and reverts it afterwards, skips a patch the checkout already contains, and fails with rebase steps when an upstream sync makes one stop applying. Today those are `0001-ollama-native-api-num-ctx.patch`, which the sidecar's `PI_OLLAMA_API=ollama-chat` (`src-tauri/src/omp/manager.rs`) relies on, `0002-no-context-files-flag.patch`, which the assistant pack's spawn flag `--no-context-files` (`src-tauri/src/omp/assistant_pack.rs` (`pack_flags`)) relies on, and `0003-model-policy-local-only.patch`, which adds the `modelPolicy` setting: only the listed providers, and under `localOnly` only models on a literal loopback endpoint and no Ollama cloud model; a malformed value allows no model. The pack pins `modelPolicy.providers: [ollama]` and `modelPolicy.localOnly: true` in `assistant-pack/config.yml`, and a sidecar built without this patch ignores both keys, so sessions are no longer limited to local models; `bun scripts/check-assistant-pack.ts <sidecar>` fails on such a sidecar. A fourth, `0004-mcp-enabled-setting.patch`, adds the `mcp.enabled` setting: off, a session starts no MCP server from the user's `~/.omp/agent/mcp.json`, the folder's config or any other source, and refuses connection tests. Without it a `--tools` allowlist still leaves MCP on, so the user's own servers start in every pack session. The pack pins `mcp.enabled: false`, and the pack check fails on a sidecar that does not know the key or that starts a planted user or project server. A fifth, `0005-ollama-per-model-context-limits.patch`, adds the `ollama.contextLimits` setting: a map from an exact Ollama model id (as `/api/tags` names it, so canonicalise bare tags to `:latest` before writing) to the largest context window, applied after `modelOverrides` to every `ollama` model on `ollama-chat` and sent as its `num_ctx`; entries that are not positive integers up to 2^24 are ignored. A change applies live, without a restart, including an edit to a watched `--config` file, which is how the GUI's overlay `<userData>/ollama-context-limits.yml` reaches running sidecars. Without the patch the key is ignored and every model keeps the global `OLLAMA_CONTEXT_LENGTH` cap. Only a sidecar on the implicit provider uses `ollama-chat`: a `models.yml` `ollama` entry (even one holding only `modelOverrides`) turns the implicit provider off, and its models speak `openai-responses`, which sends no `num_ctx`.
- Per-model context limits reach the sidecar through `<userData>/ollama-context-limits.yml` (`ollama.contextLimits`), which the Tauri core (`src-tauri/src/ollama/context_fit_scheduler.rs`) rewrites from the core-owned `ollamaContextFit` pref, which the renderer cannot write through `prefs:set`. Each value is `min(user cap, measured maximum, the user's own OLLAMA_CONTEXT_LENGTH)`. Every sidecar spawn passes the file with a second `--config` after the pack's `config.yml` and creates it when missing (`ollama:\n  contextLimits: {}`). Change limits through the Ollama window or that pref, never by editing the file.
- A packaged GUI never consults a system-installed `omp`. `paths::resolve_bundled_omp` (`src-tauri/src/paths.rs`) only accepts the bundled binary; missing binary = actionable error, not a fallback.

### Linux (Tauri) packaging

- Config: `src-tauri/tauri.conf.json` plus `src-tauri/tauri.linux.conf.json` (targets, deb `depends`/`recommends`, desktop template, AppImage `bundleMediaFramework`). `src-tauri/linux/sidecar.conf.json` adds the sidecar resource and is passed only by the package script, so a plain `cargo build`/`cargo test` never needs the sidecar binary.
- Sidecar: `bun run build:omp:linux` → `resources/omp.linux-x64`; `scripts/stage-tauri-sidecar.ts <rust triple>` copies it to `src-tauri/binaries/omp-<triple>` (gitignored). On Linux it is a bundle resource at `/usr/lib/Sai ATLAS/omp` (deb) or `$APPDIR/usr/lib/Sai ATLAS/omp` (AppImage), never on `PATH`.
- `bun run package:linux` runs `bash scripts/tauri-linux-build.sh`: Docker builds `scripts/tauri-linux-build/Dockerfile` (`ubuntu:24.04`) and runs `package:tauri:linux` inside it, writing to `src-tauri/target-linux-2404/` (the target dir argument or `SAI_ATLAS_LINUX_TARGET` changes it). Do not run `package:tauri:linux` on a newer host: `src-tauri/linux/glibc-floor.ts` refuses any bundled ELF above Ubuntu 24.04's glibc, by design.
- `src-tauri/linux/finalize-deb.ts` renames the desktop entry to the app id, adds the `/opt/Sai ATLAS/sai-atlas` compat symlink the 0.9.x Electron updater relaunches, and asserts the finished package's exact `Depends` and `Recommends`, no `Pre-Depends` and no maintainer scripts. The released Electron updater runs `dpkg -i` and then `apt-get install -f -y`, which removes the package when a hard dependency cannot be installed, so `Depends` holds only what the app cannot start without. When tauri-cli changes what it appends, edit `DEB_DEPENDS`/`DEB_RECOMMENDS` (with `tauri.linux.conf.json`), never the assertion.
- `src-tauri/linux/finalize-appimage.ts` points the bundled WebKit back at the host's `bwrap` and `xdg-dbus-proxy` (the sandbox is always on and AppArmor lets only the host's `/usr/bin/bwrap` create user namespaces) and refuses an AppImage whose GStreamer plugins differ from `BUNDLED_GSTREAMER_PLUGINS`, or that lacks the libpulse client or bundles libpipewire. The build image stages the same plugin list; change both together.
- Updates: the Rust updater (`src-tauri/src/updater/`) reads the same `latest-linux.yml` as electron-updater and installs a deb with one `pkexec apt-get install -y --no-remove -- <deb>`, never `dpkg -i` plus `-f`. Its feed base is compiled in: `SAI_ATLAS_UPDATE_BASE`, when set at build time, replaces the GitHub release URL (`feed.rs`), so release builds run with it unset. The finalize scripts change the bundles' size and hash, so `bun scripts/release-feeds.ts` writes the feeds after them.

## Build, Test, Release

- Check: `bun run check:types` (tsc) and `bunx biome check .` — keep touched files clean even if legacy diagnostics remain.
- Rust (`src-tauri/`, with `~/.cargo/bin` first on `PATH`, see `scripts/rust-pins.env`): `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` and `cargo test --manifest-path src-tauri/Cargo.toml --all-features` must pass, as must the API snapshots (`bash scripts/check-module.sh snapshots`).
- Test: `bunx vitest run` (full suite must stay green); Tauri e2e (`e2e-tauri/`): `bun run test:e2e` (alias `test:e2e:tauri`).
- Build: `bun run build` (Vite → `out/renderer-tauri`, plus the startup chunk check). Linux x64 (Docker): `bun run build:omp:linux`, then `bun run package:linux` (AppImage + .deb under `src-tauri/target-linux-2404/x86_64-unknown-linux-gnu/release/bundle/`).
- Release flow: bump `version` in `package.json` and `src-tauri/Cargo.toml` (`scripts/tauri-packaging-config.test.ts` fails when they differ; commit the `Cargo.lock` line the Tauri build rewrites), write the CHANGELOG section, update README install links, commit, tag `vX.Y.Z`, push `main` + tag to `origin`. For Linux, build with `bun run package:linux` and `SAI_ATLAS_UPDATE_BASE` unset, run `bash scripts/tauri-deb-smoke.sh <deb>` (it installs the .deb in a clean Ubuntu 24.04 container and runs `e2e-tauri/packaged-smoke.e2e.ts` there, sandbox check included), `OMP_E2E_FAKE_MIC=1 bash scripts/tauri-deb-smoke.sh <deb>` (microphone and playback probe) and `bash scripts/tauri-wm-geometry-check.sh <deb>`, then `bun scripts/release-feeds.ts` to write `dist-release/` with a `latest-linux.yml` listing both packages. Create the GitHub Release as a draft and publish only after every asset is uploaded: a partial asset set breaks both updaters' `latest/download` fetch. The release body carries the README's "Migrating from 0.9.16 on Linux" lines verbatim.
- CI: `.github/workflows/ci.yml` runs three jobs on ubuntu-latest: `linux` (check:types, vitest, build), `assistant-pack` (pack tests, the build script and the LibreOffice visual check) and `tauri-linux` (Tauri renderer build, clippy, `cargo test`, API snapshots).
- Every release's packages embed the sidecar compiled from the monorepo — record the monorepo commit in the release notes if it isn't upstream `main`.
- **The public site is `site/`** (`site/index.html` + `site/assets/`). Pages is configured as `build_type=workflow`, so `.github/workflows/pages.yml` is the only publisher: a push to `main` touching `site/**` deploys it. Its version string and download links are read from the GitHub releases API at page load, so a release needs **no site edit**; the values in the HTML are only the no-JS fallback.

## Running the GUI Out of Sight (Linux)

Agents launch the GUI on a virtual display by default, so its windows, notifications and tray icon never reach the user's monitors. Use the real display only when the user asks, or when the task needs what the virtual display lacks: Wayland-native behaviour (portal global shortcuts, compositor placement, fractional scaling), the real tray or notifications, real audio, or performance numbers (no GPU there).

- `scripts/virtual-display.sh run -- <cmd>` runs `<cmd>` on display `:99`, started on first use and reused after, with a private session bus. It needs `sudo apt install xvfb x11vnc xdotool` once.
  - e2e: `scripts/virtual-display.sh run -- bun run test:e2e` (Tauri).
  - dev (Tauri): `scripts/virtual-display.sh run -- bun run dev -- --user-data-dir=$(mktemp -d)`; the script refuses to start without a throwaway profile and on a busy dev port.
- Look: `scripts/virtual-display.sh shot <file.png>`, then read the image. The user can watch live with `scripts/virtual-display.sh view` (Remmina).
- Drive it with the computer-use skill: `orca computer list-apps` lists the app under its executable name (`sai-atlas` for a Tauri dev build); target it as `pid:<pid>`. `orca computer` reaches it over the desktop's accessibility bus, but its synthetic input goes to the **real** desktop, into whatever window the user has focused. On a virtual-display app use only `list-apps`, `list-windows`, `get-app-state --no-screenshot`, `click --element-index` and `perform-secondary-action`. A `click` result with `"path": "synthetic"` means the element had no accessibility action and a real click hit the desktop: stop and tell the user. Never use `type-text`, `press-key`, `hotkey`, `paste-text`, `scroll`, `drag` or coordinate clicks there. Text fields reject `set-value`; focus one with `click --element-index`, then send text and keys with `scripts/virtual-display.sh xdotool …`.
- When the task ends, close the app and run `scripts/virtual-display.sh stop`; `status` lists what still runs on the display.
- Packaged `.deb` checks run in a container instead: `bash scripts/tauri-deb-smoke.sh [path/to.deb]` installs it in a clean Ubuntu 24.04 and runs `e2e-tauri/packaged-smoke.e2e.ts` there, so the user's own install, `omp://` handler and crash reporter are never touched.

## Code Conventions

- Follow the enclosing monorepo's `AGENTS.md` for TypeScript style (no `any`, no inline imports, `#private` fields, Bun APIs over Node where cleaner).
- i18n: every user-visible string goes through `useT()` with entries in **both** `src/renderer/locales/en.ts` and `vi.ts` (they must stay key-identical — `locales.test.ts` enforces it).
- Rendering model output: sanitize through `MarkdownRenderer` (rehype-sanitize schema in `src/renderer/lib/markdown.tsx`) — never `dangerouslySetInnerHTML` with raw model text.
- Tool-rendered text follows the monorepo's TUI sanitization rules (tabs, truncation, path shortening) via the helpers in `src/renderer/lib/format.ts`.
- Preview ceilings come from the tiers in `src/renderer/lib/preview.ts` (`PREVIEW_SCROLL_*` + line caps) — don't invent new `max-h-*` values in tool renderers. Captured subprocess output renders through `AnsiText` (`src/renderer/lib/ansi.tsx`), never raw (ANSI escapes would print literally).
- Tests use the linkedom harness pattern (see `src/renderer/components/chat/ThinkingBlock.test.tsx`); zustand stores are reset in `afterEach` via their `reset()`/setters — never `mock.module()`.
- UI and site work: read `docs/DESIGN.md` first and verify with `docs/REVIEW.md` — screenshots at 1440×900, 1024×768 and 800×600 for the app (the window minimum) and 1440/768/375 for `site/`. When the site's content or routes change, keep its discovery files in step (`site/index.md`, `site/llms.txt`, `site/sitemap.xml`, the JSON-LD and the OG card).

## Examples

### Everyday GUI change — commits land in the right repo

```bash
# cwd: packages/gui/ — every git command here acts on the GUI repo
bun run dev -- --user-data-dir=$(mktemp -d)   # HMR against resources/omp
# …edit src/renderer/…
bunx vitest run && bun run check:types
bunx biome check <touched files>         # whole-repo check has legacy diagnostics
git commit -am "Add X to the settings window"   # → tung491/oh-my-pi-gui
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
