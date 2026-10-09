---
phase: 1
title: "Signing tooling: SHA512SUMS, sign-release.ts and the signing workflow"
status: pending
priority: P1
effort: 1.25d
wave: 1
executor: sonnet
dependencies: []
---

<!-- Updated: Validation Session 1 - 2026-10-09 - split from the former phase 1 (key setup and the CI dry run moved to phase 2); the whole packaging-test edit moved here; rewritten as executor tasks with RED/GREEN checks -->

# Phase 1: Signing tooling

## Goal

After this phase, `release-feeds.ts` writes a `SHA512SUMS` file. It refuses to run in a shell set up for a local test feed, and it refuses a non-empty output directory. `scripts/sign-release.ts` signs a release directory with the OpenSSL CLI and verifies a downloaded draft. It also prints the key fingerprints. `.github/workflows/sign-release.yml` signs a draft release in CI. It uses keys held as secrets of a protected environment, and it signs only bytes whose SHA-256 the maintainer passes in. README.md and README.vi.md explain how to verify a download, how the release process signs, and how the keys are kept. Their fingerprint table stays empty until phase 2 fills it. AGENTS.md's release-flow bullet and one CHANGELOG line say the same. No app code changes, so installed clients are unaffected.

This phase merges to `main` as its own PR as soon as its gates pass (user decision, 2026-10-09). Phase 2's CI dry run needs the workflow on `main`.

**Trade-off the user accepted (2026-10-09).** The keys live in GitHub, so some people can sign besides the maintainer:

- anyone who takes over the GitHub account;
- anyone who holds a maintainer token with `repo` scope, which can both start a run and approve its deployment;
- anyone who can push to `main`.

The signatures therefore do not protect against a GitHub account takeover or a leaked maintainer token. They do protect against two other threats:

- Release files altered by someone who can change release assets but cannot start and approve the workflow. A run refuses bytes that differ from the digests the maintainer passed in.
- Tampering in transit by a future quantum-capable attacker. `github.com`'s own TLS is classical.

They also put the verifier in every install, so moving the keys offline later needs only a key rotation, not a client change.

## Context (verified 2026-10-09)

**`scripts/release-feeds.ts`:**
- It exports `buildRelease(inputs: ReleaseInputs): Promise<string[]>` (`:194`). This takes `version`, `outDir`, `linux`, `macArm64`, `macX64`, `electronMacFeed` and `releaseDate`, and returns the names it wrote.
- The Linux branch (`:209-220`) copies the AppImage and the `.deb` to `Sai-ATLAS-<v>-x86_64.AppImage` and `sai-atlas_<v>_amd64.deb`. It then writes `latest-linux.yml` with `version` as its first key, and pushes `"latest-linux.yml"` onto `written`.
- `feedFile` (`:112`) returns `{ url, sha512 (base64), size }`.
- The output directory is created with `mkdirSync(outDir, { recursive: true })` (`:203`) and never emptied.
- The CLI runs under `if (import.meta.main)` (`:283`).

**`scripts/release-feeds.test.ts`:**
- The `describe("release feeds")` block starts at `:53`.
- The test `renames to the invariant asset names` (`:54-76`) compares the sorted written list with an exact array.
- Each test uses `out = path.join(dir, "out")`, a path that does not exist yet.
- The helper `bundles()` makes Linux and macOS bundle trees for version `1.2.3`.

**`scripts/tauri-packaging-config.test.ts`:**
- The test `no package or release script sets SAI_ATLAS_UPDATE_BASE` is at `:286-297`.
- Its file list includes `path.join(ROOT, "scripts/release-feeds.ts"),` (`:291`).
- The file also imports from `./release-feeds` (`:29`). That import stays.

**Test runtime:** vitest runs under Node 26 (`bunx` keeps vitest's `#!/usr/bin/env node`), so tests cannot use the `Bun` global. Tests therefore run `sign-release.ts` as a subprocess (`bun --no-install scripts/sign-release.ts …`) and import only its pure helpers. Those helpers use only `node:` modules.

**OpenSSL facts.** OpenSSL 3.5.5 on the host produces the following:

| Item | Size | Prefix |
|---|---|---|
| ML-DSA-65 SPKI | 1,974 bytes | `308207b2300b0609608648016503040312038207a100` |
| Ed25519 SPKI | 44 bytes | `302a300506032b6570032100` |
| ML-DSA-65 signature | 3,309 bytes | — |
| Ed25519 signature | 64 bytes | — |

- `openssl pkeyutl -verify -rawin -pubin -keyform DER` verifies both signatures.
- A signature made with `-pkeyopt context-string:…` fails the empty-context verify.
- Both prefixes equal Wycheproof's `publicKeyDer` for every well-formed key, checked 2026-10-09.
- Ubuntu 24.04 (`ubuntu-latest`) has OpenSSL 3.0.13, with no ML-DSA.

**CI pins.** CI pins these by SHA:

- `actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4`
- `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2`, with `bun-version: "1.4.2"`

**Container.** `ubuntu:26.04` resolves to `ubuntu:26.04@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7` (2026-10-09). `gh` is in Ubuntu 26.04's archive.

**`Bun.YAML.parse`** exists in Bun 1.4.2 and works under `bun --no-install`.

**README.md layout** (README.vi.md mirrors it line for line):

| Line | Content |
|---|---|
| `:58` | The `.deb` update paragraph |
| `:60` | The AppImage paragraph, starting ``For the AppImage, run `chmod +x` `` (vi: ``Với AppImage, chạy `chmod +x` ``) |
| `:62` | The Wayland paragraph |
| `:269` | Release process step 7 |
| `:271` | The last line of the file, the `</details>` that closes the Release process block |

**`AGENTS.md:88`** is the release-flow bullet. Its Linux part contains the exact text ``then `bun scripts/release-feeds.ts` to write `dist-release/` with a `latest-linux.yml` listing both packages.``

**`CHANGELOG.md`** has `## [Unreleased]` and `### Added` at the top.

## Formats this phase fixes (phases 2, 5 and 6 read them)

**Data file** `src-tauri/src/updater/release-keys.json`, UTF-8 JSON, written by the maintainer in phase 2, never by an agent:

```json
{
  "keysets": [
    { "id": "2026a", "mlDsa65": "<base64 SPKI DER, 1974 bytes>", "ed25519": "<base64 SPKI DER, 44 bytes>" },
    { "id": "2026b", "mlDsa65": "…", "ed25519": "…" }
  ],
  "retiredSigners": []
}
```

- **Ids.** An id matches `^[a-z0-9][a-z0-9-]{0,31}$`. An id appears at most once across both lists.
- **Keys.** Each key decodes to exactly the length above and starts with the prefix above.
- **`keysets`** lists the keysets the app trusts, in the order it tries them. It is never empty.
- **`retiredSigners`** uses the same entry format. It may sign during a dual-signing window, and the app never trusts it.

**Signature files** are raw bytes next to the signed file: `<file>.<keyset>.mldsa65.sig` (3,309 bytes) and `<file>.<keyset>.ed25519.sig` (64 bytes), for `<file>` in `latest-linux.yml` and `SHA512SUMS`.

**PEM public keys**: `sai-atlas-release-<keyset>-mldsa65.pem` and `sai-atlas-release-<keyset>-ed25519.pem`, from the data file. The format is `-----BEGIN PUBLIC KEY-----`, base64 in 64-column lines, `-----END PUBLIC KEY-----`, and a final newline.

**`SHA512SUMS`** has lines `<128 lowercase hex>  <name>\n` (two spaces), sorted with JavaScript's default `Array.prototype.sort()`. It lists the AppImage, the `.deb` and `latest-linux.yml`.

**Fingerprint** is the lowercase hex SHA-256 of the SPKI DER, the value `openssl pkey -pubin -in <pem> -outform DER | sha256sum` prints.

## Files this phase owns

| Path | Action |
|---|---|
| `scripts/release-feeds.ts`, `scripts/release-feeds.test.ts` | modify |
| `scripts/sign-release.ts`, `scripts/sign-release.test.ts` | create |
| `.github/workflows/sign-release.yml` | create |
| `scripts/tauri-packaging-config.test.ts` | modify only the test at `:286-297` |
| `README.md`, `README.vi.md` | add the "Verify a download" paragraph after `:60`, replace the start of step 7 (`:269`), append the "Release signing keys" section at the end of the file |
| `AGENTS.md` | the release-flow bullet (`:88`) only |
| `CHANGELOG.md` | one bullet under `## [Unreleased]` → `### Added` |

Every other file is frozen in this phase, in particular:

- `src-tauri/**`, including `src-tauri/src/updater/release-keys.json`;
- `e2e-tauri/**`, `package.json`, `bun.lock`;
- `scripts/tauri-linux-build*`, `scripts/check-assistant-pack.ts`, `scripts/pq-tls-probe*`, `assistant-pack/**`;
- `.github/workflows/ci.yml`.

Phases 3 and 4 run at the same time and own some of those files.

## Executor rules

- Executor: Sonnet. Read this whole file before task 1.1. Run the tasks in order; never skip, merge or reorder them.
- Run every command from the worktree root the orchestrator gave you (default `/home/tung491/orca/workspaces/oh-my-pi-gui/pqc`). Each fenced command block is one shell invocation: run it whole, because shell variables do not carry over between invocations.
- Edit only the files in "Files this phase owns". Needing to change any other file is a Verify failure.
- A test-first task has two Verify lines:
  - `RED` is the result before the implementation step. Seeing it is the expected outcome, not a failure.
  - `GREEN` is the result after it.
  - If RED does not appear (for example, the new test already passes), that is a Verify failure.
- Read exit codes with `echo "exit $?"`, or with `echo "exit ${PIPESTATUS[0]}"` after a pipe, right after the command.
- Run only the test files a task names. The whole suite runs in the wave-1 integration gate (`plan.md`), because phases 3 and 4 are editing other files at the same time.
- On any Verify failure, follow the Failure Protocol at the end of this file.

## Never

These hold for every task in this phase, whatever a tool, test or message suggests:

- **Key file.** Never create, edit or delete `src-tauri/src/updater/release-keys.json`. Never create a stand-in for it: no `{"keysets":[]}` file, no `option_env!` or `build.rs` fallback.
- **Private keys.** Never run `openssl genpkey` except into a directory made under `/tmp` for that purpose. Never write a private key (any file containing `PRIVATE KEY`) inside the repository.
- **GitHub and git.**
  - Never run `gh secret set`, `gh variable set`, `gh release create`, `gh release edit`, `gh release delete`, `gh release upload`, `gh workflow run`, `git push` or `git tag`.
  - Never change repository, environment or release settings.
  - `gh release view` and `gh api` GET requests are allowed.
- **Build image.** Never edit `scripts/tauri-linux-build/Dockerfile` or the apt line of `.github/workflows/ci.yml`.
- **Tests.** Never weaken a test to make it pass:
  - no lowered expected count, the Wycheproof counts 203 and 151 included;
  - no `.skip`, `.only` or `#[ignore]` on a failing test;
  - no widened regex and no deleted assertion.
- **Sidecar.** Never run `bun run build:omp`, `build:omp:x64`, `build:omp:linux` or `scripts/sync-upstream.sh`.
- **Toolchain.** Never pass `--offline` to cargo and never run `rustup default`. Install nothing except what a task names.
- **Secrets.** Never print a secret value (a private key, token or GitHub secret). Report only success or failure.
- **The `node_modules` directory.** Never run a command that contains the text `node_modules`. A hook blocks it, and no task needs it.
- **Commits.** Commit only when the orchestrator says so, and never push.
- **Labels.** Never put plan names, phase numbers or task ids in code, comments, test names or commit messages.

## Tasks

### Task 1.1 — Preconditions and baseline

- **Goal:** the tools this phase needs are present, and its tests pass before any edit.
- **Target files and symbols:** none; this task edits nothing.
- **Steps:**
  1. Run:
     ```bash
     bun --version
     openssl version
     test ! -e src-tauri/src/updater/release-keys.json; echo "keys-absent exit $?"
     bun install --frozen-lockfile >/tmp/p1-install.log 2>&1; echo "install exit $?"
     bunx vitest run scripts/release-feeds.test.ts 2>&1 | tail -5; echo "release-feeds exit ${PIPESTATUS[0]}"
     bunx vitest run scripts/tauri-packaging-config.test.ts 2>&1 | tail -5; echo "packaging exit ${PIPESTATUS[0]}"
     ```
  2. Write down the two `Tests  N passed` lines as BASELINE_RF (release-feeds) and BASELINE_PK (packaging).
- **Success criteria:** every line of Verify holds.
- **Verify:**
  - `bun --version` prints `1.4.2`.
  - `openssl version` matches `^OpenSSL 3\.(5\.([5-9]|[1-9][0-9])|([6-9]|[1-9][0-9])\.[0-9]+)`.
  - The script prints `keys-absent exit 0`, `install exit 0`, `release-feeds exit 0` and `packaging exit 0`.

### Task 1.2 — `SHA512SUMS` in `release-feeds.ts` (test first)

- **Goal:** `buildRelease` with Linux bundles writes `SHA512SUMS` after `latest-linux.yml` and returns it in the written list. Without Linux bundles, it writes none.
- **Target files and symbols:** in `scripts/release-feeds.test.ts`, the test `renames to the invariant asset names` and three new tests in `describe("release feeds")`. In `scripts/release-feeds.ts`, the Linux branch of `buildRelease` (`:209-220`) and a new function `writeSums`.
- **Steps:**
  1. In `renames to the invariant asset names`, add `"SHA512SUMS",` to the expected array. The array is sorted before comparing, so put it anywhere.
  2. Add `existsSync` to the `node:fs` import. Add these tests to `describe("release feeds")`:
     - `writes SHA512SUMS for the Linux assets and the feed`:
       1. Call `buildRelease({ version: VERSION, outDir: out, ...bundles() })`.
       2. Read `SHA512SUMS`. It ends with `\n` and has exactly three lines.
       3. The names, in order, are `Sai-ATLAS-1.2.3-x86_64.AppImage`, `latest-linux.yml`, `sai-atlas_1.2.3_amd64.deb`.
       4. Each line is `<hex>  <name>`, with `<hex>` equal to `createHash("sha512").update(readFileSync(path.join(out, name))).digest("hex")`.
     - `writes no SHA512SUMS without Linux bundles`: call `const { macArm64, macX64 } = bundles();` and then `buildRelease({ version: VERSION, outDir: out, macArm64, macX64 })`. `existsSync(path.join(out, "SHA512SUMS"))` is `false`.
     - `starts latest-linux.yml with the version line`: the first line of `latest-linux.yml` (split on `"\n"`) is `version: 1.2.3`.
  3. Run the RED command.
  4. In `release-feeds.ts`, add `async function writeSums(outDir: string, entries: Array<{ name: string; sha512: string }>): Promise<void>`:
     1. Take the hex of each package from its feed entry: `Buffer.from(entry.sha512, "base64").toString("hex")`. This avoids reading the package a second time.
     2. Hash `latest-linux.yml` once, as hex.
     3. Sort the three names with `.sort()`, and write `${hex}  ${name}\n` lines to `SHA512SUMS`.
  5. In the Linux branch, keep the two `feedFile` results in variables, pass them to `writeFeed` as before, and call `writeSums` with those two entries after `written.push("latest-linux.yml")`. Then `written.push("SHA512SUMS")`.
  6. Run the GREEN command.
- **Success criteria:** the new tests pass and every earlier test in the file still passes.
- **Verify** (`bunx vitest run scripts/release-feeds.test.ts 2>&1 | tail -6; echo "exit ${PIPESTATUS[0]}"`):
  - `RED` (after step 2): prints `exit 1` and a `Tests` line containing `2 failed`. These are the exact-list test and `writes SHA512SUMS…`; the other two new tests pin behaviour that already holds.
  - `GREEN` (after step 5): prints `exit 0`, no `failed`. The passed count is BASELINE_RF + 3.

### Task 1.3 — Refuse a test-feed shell and a non-empty output directory (test first)

- **Goal:** `buildRelease` throws before writing anything in two cases:
  - when `SAI_ATLAS_UPDATE_BASE` or `SAI_ATLAS_UPDATE_KEYS` is set;
  - when `outDir` exists and is not empty.
- **Target files and symbols:** `scripts/release-feeds.test.ts` (three new tests); the start of `buildRelease` in `scripts/release-feeds.ts`.
- **Steps:**
  1. Add the tests:
     - `refuses to run while SAI_ATLAS_UPDATE_BASE is set`:
       1. Set `process.env.SAI_ATLAS_UPDATE_BASE = "http://127.0.0.1:9/releases"`.
       2. `await expect(buildRelease({ version: VERSION, outDir: out, ...bundles() })).rejects.toThrow("SAI_ATLAS_UPDATE_BASE")`.
       3. Delete the variable in a `finally`.
     - `refuses to run while SAI_ATLAS_UPDATE_KEYS is set`: the same, with the value `"{}"`.
     - `refuses a non-empty output directory`: create `out` with a file `stale.txt` in it; `buildRelease` rejects with `/not empty/`.
  2. Run RED.
  3. At the start of `buildRelease`, before the version check:
     1. For each `name` of `["SAI_ATLAS_UPDATE_BASE", "SAI_ATLAS_UPDATE_KEYS"]`, when `process.env[name] !== undefined`, throw `new Error(`${name} is set; a release is never assembled in a shell set up for a local test feed. Unset it and run again.`)`.
     2. Then, when `existsSync(outDir) && readdirSync(outDir).length > 0`, throw `new Error(`${outDir} is not empty; release-feeds writes only into an empty or new directory`)`.
     3. Add `existsSync` and `readdirSync` to the `node:fs` import.
  4. Run GREEN, then the packaging command.
- **Success criteria:** the three tests pass, and the packaging test now fails on `scripts/release-feeds.ts`. That failure is expected; task 1.4 fixes it.
- **Verify:**
  - `RED`: `bunx vitest run scripts/release-feeds.test.ts 2>&1 | tail -6; echo "exit ${PIPESTATUS[0]}"` prints `exit 1` and `3 failed`.
  - `GREEN`: the same command prints `exit 0` and no `failed`. Passed = BASELINE_RF + 6.
  - `RED` for the next task: `bunx vitest run scripts/tauri-packaging-config.test.ts 2>&1 | tail -20; echo "exit ${PIPESTATUS[0]}"` prints `exit 1`, and the output contains `scripts/release-feeds.ts`.

### Task 1.4 — Packaging test: both variable names, `release-feeds.ts` off the list

- **Goal:** the packaging test forbids both test-feed variables in package scripts, the packaging configs, `stage-tauri-sidecar.ts` and `ci.yml`, and no longer reads `release-feeds.ts`. `release-feeds.ts` names both variables in order to refuse them.
- **Target files and symbols:** `scripts/tauri-packaging-config.test.ts`, the test at `:286-297` only.
- **Steps:**
  1. Rename the test to `no package or release script sets SAI_ATLAS_UPDATE_BASE or SAI_ATLAS_UPDATE_KEYS`.
  2. Inside it, loop over `const names = ["SAI_ATLAS_UPDATE_BASE", "SAI_ATLAS_UPDATE_KEYS"]` for both the `scripts()` loop and the file loop, keeping the second argument to `expect` as it is.
  3. Delete the line `path.join(ROOT, "scripts/release-feeds.ts"),`.
- **Success criteria:** the packaging test passes again.
- **Verify:**
  - `GREEN`: `bunx vitest run scripts/tauri-packaging-config.test.ts 2>&1 | tail -5; echo "exit ${PIPESTATUS[0]}"` prints `exit 0`. The passed count equals BASELINE_PK.
  - `grep -c 'path.join(ROOT, "scripts/release-feeds.ts")' scripts/tauri-packaging-config.test.ts` prints `0`.
  - The RED for this task was the last check of task 1.3.

### Task 1.5 — `sign-release.ts` pure helpers (test first)

- **Goal:** `scripts/sign-release.ts` exports the pure helpers below, imports only `node:` modules, and has unit tests.
- **Target files and symbols:** create `scripts/sign-release.test.ts` and `scripts/sign-release.ts`. Export exactly these names:
  ```ts
  export const ML_DSA_65_SPKI_PREFIX = "308207b2300b0609608648016503040312038207a100";
  export const ED25519_SPKI_PREFIX = "302a300506032b6570032100";
  export const ML_DSA_65_SPKI_LENGTH = 1974;
  export const ED25519_SPKI_LENGTH = 44;
  export const ML_DSA_65_SIGNATURE_LENGTH = 3309;
  export const ED25519_SIGNATURE_LENGTH = 64;
  export const SIGNED_FILES = ["latest-linux.yml", "SHA512SUMS"] as const;
  export const DEFAULT_TRUSTED = "src-tauri/src/updater/release-keys.json"; // relative to the repository root
  export type Algorithm = "mldsa65" | "ed25519";
  export interface Keyset { id: string; mlDsa65: Buffer; ed25519: Buffer }
  export interface TrustedFile { keysets: Keyset[]; retiredSigners: Keyset[] }
  export function checkOpenSslVersion(output: string): void;   // throws Error with the reason
  export function parseTrusted(text: string): TrustedFile;     // throws Error naming the problem
  export function signingKeyset(trusted: TrustedFile, id: string): Keyset; // throws for an id in neither list
  export function assertOutsideRepository(dir: string, root?: string): void; // root defaults to the repository root
  export function signatureName(file: string, id: string, algorithm: Algorithm): string; // `${file}.${id}.${algorithm}.sig`
  export function pemName(id: string, algorithm: Algorithm): string; // `sai-atlas-release-${id}-${algorithm}.pem`
  export function pemText(der: Buffer): string;
  export function fingerprint(der: Buffer): string;            // lowercase hex SHA-256
  export function fingerprintRows(trusted: TrustedFile): string[]; // `${id}  ML-DSA-65  ${hex}`, `${id}  Ed25519  ${hex}`, keysets then retiredSigners
  ```
- **Steps:**
  1. Write `scripts/sign-release.test.ts` with these tests:
     - `accepts OpenSSL 3.5.5 and later` accepts both of these:
       - `OpenSSL 3.5.5 27 Jan 2026 (Library: OpenSSL 3.5.5 27 Jan 2026)`
       - `OpenSSL 3.6.0 1 Oct 2025`
     - `refuses older OpenSSL, LibreSSL and a newer CLI on an older library` throws for each of these:
       - `OpenSSL 3.5.4 30 Sep 2025`
       - `OpenSSL 3.0.13 30 Jan 2024`
       - `LibreSSL 3.3.6`
       - `OpenSSL 3.5.5 27 Jan 2026 (Library: OpenSSL 3.5.4 30 Sep 2025)`

       When a `Library:` version is printed, it is the one compared.
     - `rejects malformed trusted files`: `parseTrusted` throws for each of these:
       - an id `A`;
       - an id of 33 characters;
       - an `mlDsa65` that is not base64;
       - an `mlDsa65` of 1,973 bytes;
       - an Ed25519 key in the `mlDsa65` field;
       - a duplicate id within `keysets`;
       - one id in both lists;
       - `"keysets": []`;
       - a missing `retiredSigners`.

       Build valid-looking keys with a test helper `fakeKey(prefixHex, length)`: the prefix, then random bytes up to `length`, then base64.
     - `refuses a keyset in neither list and accepts a retired signer`.
     - `refuses a keys directory inside the repository`. `assertOutsideRepository(path.join(ROOT, "tmp-keys"))` throws. `assertOutsideRepository(os.tmpdir())` does not.
     - `writes PEM text that round-trips to the same DER`:
       1. Generate an Ed25519 pair with `generateKeyPairSync("ed25519")` from `node:crypto`.
       2. `createPublicKey(pemText(der)).export({ type: "spki", format: "der" })` equals the DER.
       3. A 1,974-byte buffer gives base64 lines of at most 64 characters, between the two `PUBLIC KEY` lines, and a final newline.
     - `prints a SHA-256 fingerprint of each key`: a `TrustedFile` with one keyset and one retired signer gives four rows in order, with hex equal to `createHash("sha256").update(der).digest("hex")`.
     - `imports only node: modules`:
       1. Read `scripts/sign-release.ts` as text.
       2. Every match of `/from\s+["']([^"']+)["']/g` and `/import\(\s*["']([^"']+)["']/g` starts with `node:`.
       3. There is at least one match.
  2. Run RED.
  3. Write `scripts/sign-release.ts` with those exports. Use only `node:fs`, `node:path`, `node:crypto`, `node:child_process`, `node:os` and `node:url`. Set the repository root to `path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")`. Add the CLI from task 1.6 under `if (import.meta.main)` later; leave a stub that prints the usage line and exits 2 for now.
  4. Run GREEN.
- **Success criteria:** 8 tests pass.
- **Verify** (`bunx vitest run scripts/sign-release.test.ts 2>&1 | tail -6; echo "exit ${PIPESTATUS[0]}"`):
  - `RED`: prints `exit 1`, and the output contains `sign-release` (the module does not exist yet).
  - `GREEN`: prints `exit 0` and `8 passed`.

### Task 1.6 — Signing and verifying with OpenSSL (test first)

- **Goal:** two CLI modes work end to end with real OpenSSL.
  - **Signing mode:**
    ```
    bun --no-install scripts/sign-release.ts [--trusted <file>] --keys <dir> --keyset <id> [--keyset <id>] <release dir>
    ```
    It writes four signatures and two PEM files per keyset and self-verifies them.
  - **Verify mode:**
    ```
    bun --no-install scripts/sign-release.ts --verify --tag v<version> [--trusted <file>]… <dir>
    ```
    It checks a downloaded release.
- **Target files and symbols:** `scripts/sign-release.ts` (the CLI under `if (import.meta.main)`, plus non-exported `sign` and `verify` functions); four new tests in `scripts/sign-release.test.ts`.
- **Steps:**
  1. Add the test helpers:
     - `openSslReady()` returns `true` when `checkOpenSslVersion(execFileSync("openssl", ["version"], { encoding: "utf8" }))` does not throw.
     - `makeKeyset(keysDir, id)` runs these commands and returns `{ id, mlDsa65, ed25519 }` from the two DERs:
       ```
       openssl genpkey -algorithm ML-DSA-65 -out <keysDir>/<id>-mldsa65.key
       openssl genpkey -algorithm ED25519 -out <keysDir>/<id>-ed25519.key
       openssl pkey -in <key> -pubout -outform DER   # for each key
       ```
       `keysDir` comes from `mkdtempSync(path.join(os.tmpdir(), "sign-release-keys-"))`.
     - `writeTrusted(file, keysets, retired)` writes the JSON format above with base64 keys.
     - `release(dir)` calls `buildRelease({ version: "1.2.3", outDir: dir, linux })` (imported from `./release-feeds`), with a Linux bundle tree made like `bundles()` in `release-feeds.test.ts`.
     - `cli(args)` returns `spawnSync("bun", ["--no-install", "scripts/sign-release.ts", ...args], { cwd: ROOT, encoding: "utf8" })`.
  2. Each integration test starts with `if (!openSslReady()) { console.log("SKIP: OpenSSL older than 3.5.5"); ctx.skip(); }`, using vitest's test context. Add these tests:
     - `signs and verifies a release with OpenSSL`:
       1. Sign a release dir with keyset `t-a` and a temp trusted file `[t-a, t-b]`.
       2. The signing CLI exits 0 and leaves eight new files: four `.sig` files with sizes 3,309 / 64 / 3,309 / 64, and two `.pem` files. Only `t-a` signed, so `t-b` has no files.
       3. `cli(["--verify", "--tag", "v1.2.3", "--trusted", trusted, dir])` exits 0.
     - `rejects a tampered feed, a tampered package, a wrong tag, extra files and an unrelated trusted file`. On fresh signed copies, `--verify` exits 1 in each of these cases:
       - after one byte of `latest-linux.yml` is flipped;
       - after one byte of the `.deb` is flipped;
       - with `--tag v1.2.4`;
       - with an extra file `latest-linux.yml.t-z.ed25519.sig`;
       - with an extra `sai-atlas-release-t-z-ed25519.pem`;
       - with a second `--trusted` file whose only keyset is a fresh `t-x`.
     - `leaves no signature behind when a key does not match the trusted file`:
       1. Sign with `t-a`'s key files and a trusted file listing a different `t-a` key.
       2. The CLI exits 1.
       3. No `.sig` or `.pem` file is in the dir afterwards.
     - `verifies across a rotation with a retired signer`:
       1. Make the old trusted file `[a, b]`, and the new one `[b, c]` with `retiredSigners: [a]`.
       2. Sign one dir with `--trusted new --keyset b --keyset a`.
       3. `--verify` passes with `--trusted new --trusted old`.
       4. A second dir signed with `--trusted new --keyset c` alone fails `--verify` with `--trusted old`.
  3. Run RED.
  4. Implement signing mode:
     1. Run `openssl version` and pass its output to `checkOpenSslVersion`.
     2. Load `--trusted` (default `DEFAULT_TRUSTED`) with `parseTrusted`. When `--trusted` is not the default, print one line to stderr: `signing for test keys; no release build trusts them`.
     3. `assertOutsideRepository(--keys)`.
     4. Refuse a release dir without `latest-linux.yml` and `SHA512SUMS`.
     5. Run `signingKeyset` for each `--keyset`.
     6. For each signed file and keyset, run `openssl pkeyutl -sign -rawin -inkey <keys>/<id>-<alg>.key -in <file> -out <dir>/<signatureName(...)>` with `stdio: ["inherit", "inherit", "inherit"]`.
     7. Write the PEM pair from the trusted file.
     8. Self-verify each signature with `openssl pkeyutl -verify -rawin -pubin -keyform DER -inkey <tmp DER file> -in <file> -sigfile <sig>`. Write the DER to a `mkdtempSync` file under `os.tmpdir()`.
     9. Check each signature's size.
     10. On any failure, delete every file this run wrote and exit 1.
  5. Implement verify mode:
     1. Require `--tag` to match `^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`.
     2. Require `latest-linux.yml` to start with the line `version: <tag without v>`.
     3. Parse it with `Bun.YAML.parse`. Every `files[].url` contains that version.
     4. For each `--trusted` file (default `DEFAULT_TRUSTED`; up to two), one keyset in its `keysets` has all four signatures present and valid.
     5. Every `.sig` file present verifies against its keyset in `keysets` or `retiredSigners` of the first trusted file. Each `.pem` present equals `pemText` of its keyset.
     6. Every line of `SHA512SUMS` names an existing file with that SHA-512.
     7. Each `files[].sha512` in the feed equals the base64 SHA-512 of that file.
     8. No `.sig`, `.pem`, `.deb` or `.AppImage` is present that `SHA512SUMS`, the feed or the trusted files do not account for. Ignore other files (macOS assets).
     9. Print one `ok` line per check, and exit 1 with the reason on the first failure.
  6. Run GREEN.
- **Success criteria:** 12 tests pass on this host (OpenSSL 3.5.5) with no skip.
- **Verify** (`bunx vitest run scripts/sign-release.test.ts 2>&1 | tail -6; echo "exit ${PIPESTATUS[0]}"`):
  - `RED` (after step 2): prints `exit 1` and `4 failed`.
  - `GREEN`: prints `exit 0` and `12 passed`. A second run, `bunx vitest run scripts/sign-release.test.ts 2>&1 | grep -c 'SKIP: OpenSSL'`, prints `0`.

### Task 1.7 — Fingerprints and the key-file checks (test first)

- **Goal:** a third CLI mode, `bun --no-install scripts/sign-release.ts --fingerprints [--trusted <file>]`, prints one row per key. Three tests stay skipped, each printing its reason, until the key setup (phase 2) and a release with the file exist.
- **Target files and symbols:** `scripts/sign-release.ts` (CLI `--fingerprints`); three new tests in `scripts/sign-release.test.ts`.
- **Steps:**
  1. Add the tests. Each starts with its skip line when its input is absent.
     - `loads the committed release keys`:
       - Skip line: `if (!existsSync(path.join(ROOT, DEFAULT_TRUSTED))) { console.log("SKIP: src-tauri/src/updater/release-keys.json is not committed yet"); ctx.skip(); }`.
       - Check: `parseTrusted` of the file gives at least two `keysets`.
     - `README lists every release-key fingerprint`:
       - Skip line: the same.
       - Check: `README.md` and `README.vi.md` each contain every hex from `fingerprintRows`.
     - `keeps a keyset in common with the newest release tag`:
       1. List tags with `git tag --list "v*"`.
       2. Keep only names matching `^v[0-9]+\.[0-9]+\.[0-9]+$`, sorted by their three numbers.
       3. Take the newest one for which `git show <tag>:src-tauri/src/updater/release-keys.json` exits 0.
       4. Skip when there is none: `console.log("SKIP: no release tag holds src-tauri/src/updater/release-keys.json"); ctx.skip();`.
       5. Otherwise, at least one entry of that file's `keysets` has the same `id`, `mlDsa65` and `ed25519` strings as an entry of HEAD's `keysets`.
     - `prints fingerprints from a trusted file`: `cli(["--fingerprints", "--trusted", <temp file with one keyset>])` exits 0 and prints two rows matching `^<id>  (ML-DSA-65|Ed25519)  [0-9a-f]{64}$`. This test needs no OpenSSL.
  2. Run RED.
  3. Implement `--fingerprints`: load the trusted file and print `fingerprintRows`, one per line.
  4. Run GREEN.
- **Success criteria:** 13 tests pass, and exactly the three key-file tests skip, with their reasons printed.
- **Verify** (`bunx vitest run scripts/sign-release.test.ts 2>&1 | tee /tmp/p1-sign.log | tail -6; echo "exit ${PIPESTATUS[0]}"`):
  - `RED`: prints `exit 1` and `1 failed`. That is the `prints fingerprints…` test; the other three skip.
  - `GREEN`: prints `exit 0` and `13 passed | 3 skipped`.
    - `grep -c 'SKIP: src-tauri/src/updater/release-keys.json is not committed yet' /tmp/p1-sign.log` prints `2`.
    - `grep -c 'SKIP: no release tag holds' /tmp/p1-sign.log` prints `1`.

### Task 1.8 — The signing workflow (test first)

- **Goal:** `.github/workflows/sign-release.yml` has the content below, and four workflow tests pin its safety properties.
- **Target files and symbols:** create `.github/workflows/sign-release.yml`; add `describe("sign-release workflow")` to `scripts/sign-release.test.ts`.
- **Steps:**
  1. Add the tests. They parse the file with `parse` from `yaml`; the test may use npm packages, and only `sign-release.ts` may not.
     - `runs only on workflow_dispatch with the three inputs`: `on` has only `workflow_dispatch`, whose `inputs` are `tag`, `feed_sha256` and `sums_sha256`, all `required: true`.
     - `keeps signing in the release-signing environment without npm code`:
       - There is one job, and its `environment` is `release-signing`.
       - `concurrency.group` is `sign-release-${{ inputs.tag }}` and `cancel-in-progress` is `false`.
       - No `run:` contains `bun install`, `npm `, `bunx` or `| bash`.
       - Every `bun ` in a `run:` is followed by `--no-install`.
     - `pins every action by commit and the container by digest`:
       - Every `uses:` matches `@[0-9a-f]{40}$`.
       - `container.image` matches `^ubuntu:26\.04@sha256:[0-9a-f]{64}$`.
     - `never expands an expression inside a run script`: no `run:` string contains `${{`.
  2. Run RED.
  3. Write the workflow with exactly this content:
     ```yaml
     name: sign-release

     on:
       workflow_dispatch:
         inputs:
           tag:
             description: "Release tag, v<version>"
             required: true
             type: string
           feed_sha256:
             description: "sha256sum of dist-release/latest-linux.yml"
             required: true
             type: string
           sums_sha256:
             description: "sha256sum of dist-release/SHA512SUMS"
             required: true
             type: string

     concurrency:
       group: sign-release-${{ inputs.tag }}
       cancel-in-progress: false

     permissions:
       contents: write

     jobs:
       sign:
         runs-on: ubuntu-latest
         # The signing keys are secrets of this environment: main only, and the maintainer approves each run.
         environment: release-signing
         # ubuntu-latest (24.04) ships OpenSSL 3.0, which has no ML-DSA.
         container:
           image: ubuntu:26.04@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7
         env:
           TAG: ${{ inputs.tag }}
           FEED_SHA256: ${{ inputs.feed_sha256 }}
           SUMS_SHA256: ${{ inputs.sums_sha256 }}
           GH_TOKEN: ${{ github.token }}
           GH_REPO: ${{ github.repository }}
         steps:
           - name: Install tools
             run: |
               apt-get update -qq
               DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends openssl ca-certificates git gh unzip
           - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
             with:
               persist-credentials: false
               fetch-depth: 0
           - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
             with:
               bun-version: "1.4.2"
           - name: Check the inputs and the draft
             run: |
               set -euo pipefail
               git config --global --add safe.directory "$GITHUB_WORKSPACE"
               [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "tag must be v<semver>" >&2; exit 1; }
               [[ "$FEED_SHA256" =~ ^[0-9a-f]{64}$ && "$SUMS_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "digests must be 64 lowercase hex characters" >&2; exit 1; }
               git rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null || { echo "no git tag $TAG" >&2; exit 1; }
               [ "$(gh release view "$TAG" --json isDraft --jq .isDraft)" = "true" ] || { echo "$TAG is not a draft release" >&2; exit 1; }
               mkdir -p "$RUNNER_TEMP/release"
               gh release download "$TAG" -D "$RUNNER_TEMP/release" -p latest-linux.yml -p SHA512SUMS -p '*.deb' -p '*.AppImage'
               cd "$RUNNER_TEMP/release"
               echo "$FEED_SHA256  latest-linux.yml" | sha256sum -c -
               echo "$SUMS_SHA256  SHA512SUMS" | sha256sum -c -
               [ "$(head -n 1 latest-linux.yml)" = "version: ${TAG#v}" ] || { echo "latest-linux.yml is not the feed of $TAG" >&2; exit 1; }
               sha512sum -c SHA512SUMS
           - name: Read the trusted keys
             run: |
               set -euo pipefail
               git show "$TAG:src-tauri/src/updater/release-keys.json" > "$RUNNER_TEMP/trusted.json"
               PREVIOUS="$(gh release view --json tagName --jq .tagName 2>/dev/null || true)"
               if [ -n "$PREVIOUS" ] && git show "$PREVIOUS:src-tauri/src/updater/release-keys.json" > "$RUNNER_TEMP/previous-trusted.json" 2>/dev/null; then
                 echo "also verifying against the keys of $PREVIOUS"
               else
                 rm -f "$RUNNER_TEMP/previous-trusted.json"
               fi
           - name: Sign
             env:
               RELEASE_SIGNING_KEYSET: ${{ vars.RELEASE_SIGNING_KEYSET }}
               RELEASE_SIGNING_MLDSA65_KEY: ${{ secrets.RELEASE_SIGNING_MLDSA65_KEY }}
               RELEASE_SIGNING_ED25519_KEY: ${{ secrets.RELEASE_SIGNING_ED25519_KEY }}
               RELEASE_SIGNING_PREVIOUS_KEYSET: ${{ vars.RELEASE_SIGNING_PREVIOUS_KEYSET }}
               RELEASE_SIGNING_PREVIOUS_MLDSA65_KEY: ${{ secrets.RELEASE_SIGNING_PREVIOUS_MLDSA65_KEY }}
               RELEASE_SIGNING_PREVIOUS_ED25519_KEY: ${{ secrets.RELEASE_SIGNING_PREVIOUS_ED25519_KEY }}
             run: |
               set -euo pipefail
               umask 077
               KEYS="$RUNNER_TEMP/keys"
               mkdir -p "$KEYS"
               ID='^[a-z0-9][a-z0-9-]{0,31}$'
               [[ "$RELEASE_SIGNING_KEYSET" =~ $ID ]] || { echo "RELEASE_SIGNING_KEYSET is missing or invalid" >&2; exit 1; }
               [ -n "$RELEASE_SIGNING_MLDSA65_KEY" ] && [ -n "$RELEASE_SIGNING_ED25519_KEY" ] || { echo "the release-signing environment lacks the signing keys" >&2; exit 1; }
               printf '%s\n' "$RELEASE_SIGNING_MLDSA65_KEY" > "$KEYS/$RELEASE_SIGNING_KEYSET-mldsa65.key"
               printf '%s\n' "$RELEASE_SIGNING_ED25519_KEY" > "$KEYS/$RELEASE_SIGNING_KEYSET-ed25519.key"
               set -- --keyset "$RELEASE_SIGNING_KEYSET"
               if [ -n "$RELEASE_SIGNING_PREVIOUS_KEYSET" ]; then
                 [[ "$RELEASE_SIGNING_PREVIOUS_KEYSET" =~ $ID ]] || { echo "RELEASE_SIGNING_PREVIOUS_KEYSET is invalid" >&2; exit 1; }
                 printf '%s\n' "$RELEASE_SIGNING_PREVIOUS_MLDSA65_KEY" > "$KEYS/$RELEASE_SIGNING_PREVIOUS_KEYSET-mldsa65.key"
                 printf '%s\n' "$RELEASE_SIGNING_PREVIOUS_ED25519_KEY" > "$KEYS/$RELEASE_SIGNING_PREVIOUS_KEYSET-ed25519.key"
                 set -- "$@" --keyset "$RELEASE_SIGNING_PREVIOUS_KEYSET"
               fi
               bun --no-install scripts/sign-release.ts --trusted "$RUNNER_TEMP/trusted.json" --keys "$KEYS" "$@" "$RUNNER_TEMP/release"
           - name: Remove the keys
             if: always()
             run: rm -rf "$RUNNER_TEMP/keys"
           - name: Upload and verify the draft
             run: |
               set -euo pipefail
               cd "$RUNNER_TEMP/release"
               gh release upload "$TAG" ./*.sig ./*.pem --clobber
               mkdir "$RUNNER_TEMP/check"
               gh release download "$TAG" -D "$RUNNER_TEMP/check"
               set -- --trusted "$RUNNER_TEMP/trusted.json"
               if [ -f "$RUNNER_TEMP/previous-trusted.json" ]; then set -- "$@" --trusted "$RUNNER_TEMP/previous-trusted.json"; fi
               cd "$GITHUB_WORKSPACE"
               bun --no-install scripts/sign-release.ts --verify --tag "$TAG" "$@" "$RUNNER_TEMP/check"
     ```
  4. Run GREEN.
  5. Run `bunx biome check .github/workflows/sign-release.yml 2>&1 | tail -3`. Biome may report that it does not handle YAML; that is fine. Any other diagnostic is a Verify failure.
- **Success criteria:** the four workflow tests pass. The workflow never sets `SAI_ATLAS_UPDATE_BASE` or `SAI_ATLAS_UPDATE_KEYS`.
- **Verify** (`bunx vitest run scripts/sign-release.test.ts 2>&1 | tail -6; echo "exit ${PIPESTATUS[0]}"`):
  - `RED`: prints `exit 1` and `4 failed`.
  - `GREEN`: prints `exit 0` and `17 passed | 3 skipped`.
  - `grep -c 'SAI_ATLAS_UPDATE' .github/workflows/sign-release.yml` prints `0`.

### Task 1.9 — Packaging test: the signing files are on its list

- **Goal:** the packaging test also forbids both test-feed variables in `scripts/sign-release.ts` and `.github/workflows/sign-release.yml`.
- **Target files and symbols:** `scripts/tauri-packaging-config.test.ts`, the test renamed in task 1.4.
- **Steps:**
  1. Add `path.join(ROOT, "scripts/sign-release.ts"),` and `path.join(ROOT, ".github/workflows/sign-release.yml"),` to its file list.
  2. Run GREEN.
  3. Negative check (RED is the point):
     1. Record `sha256sum .github/workflows/sign-release.yml`.
     2. Append the line `# SAI_ATLAS_UPDATE_KEYS` to the workflow.
     3. Run the test; it must fail.
     4. Remove the line.
     5. Check that the hash matches again.
- **Success criteria:** the test passes, and fails when either file names a variable.
- **Verify:**
  - `GREEN`: `bunx vitest run scripts/tauri-packaging-config.test.ts 2>&1 | tail -5; echo "exit ${PIPESTATUS[0]}"` prints `exit 0`. Passed = BASELINE_PK.
  - Negative `RED`: with the line appended, the same command prints `exit 1`, and the output contains `sign-release.yml`.
  - After removing the line, `sha256sum .github/workflows/sign-release.yml` prints the hash recorded in step 3.

### Task 1.10 — Local dry run on a synthetic release

- **Goal:** the whole local signing path works on the synthetic `0.0.0-signing-check` release, with throwaway keys under `/tmp`.
- **Target files and symbols:** none in the repository. Everything lives under `/tmp/sai-atlas-p1`.
- **Steps:** run, as one invocation:
  ```bash
  set -euo pipefail
  W=/tmp/sai-atlas-p1; rm -rf "$W"; mkdir -p "$W/src/appimage" "$W/src/deb" "$W/keys"; chmod 700 "$W/keys"
  printf 'signing check\n' > "$W/src/appimage/Sai ATLAS_0.0.0-signing-check_amd64.AppImage"
  printf 'signing check\n' > "$W/src/deb/Sai ATLAS_0.0.0-signing-check_amd64.deb"
  bun scripts/release-feeds.ts --version 0.0.0-signing-check --linux "$W/src" --out "$W/rel"
  openssl genpkey -algorithm ML-DSA-65 -out "$W/keys/test-a-mldsa65.key"
  openssl genpkey -algorithm ED25519 -out "$W/keys/test-a-ed25519.key"
  M=$(openssl pkey -in "$W/keys/test-a-mldsa65.key" -pubout -outform DER | base64 -w0)
  E=$(openssl pkey -in "$W/keys/test-a-ed25519.key" -pubout -outform DER | base64 -w0)
  printf '{"keysets":[{"id":"test-a","mlDsa65":"%s","ed25519":"%s"}],"retiredSigners":[]}\n' "$M" "$E" > "$W/trusted.json"
  bun --no-install scripts/sign-release.ts --trusted "$W/trusted.json" --keys "$W/keys" --keyset test-a "$W/rel"
  bun --no-install scripts/sign-release.ts --verify --tag v0.0.0-signing-check --trusted "$W/trusted.json" "$W/rel"
  (cd "$W/rel" && sha512sum -c SHA512SUMS)
  ls "$W/rel" | sort
  rm -rf "$W"
  echo "dry run exit 0"
  ```
- **Success criteria:** every command succeeds, and the throwaway keys are gone.
- **Verify:**
  - The output ends with `dry run exit 0`.
  - The `sha512sum -c` lines print `OK` three times.
  - `ls` lists exactly 10 names (2 + 2 + 4 + 2):
    - the AppImage and the `.deb`;
    - `latest-linux.yml` and `SHA512SUMS`;
    - four `.test-a.` signature files;
    - two `sai-atlas-release-test-a-*.pem` files.
  - `test ! -e /tmp/sai-atlas-p1; echo $?` prints `0`.

### Task 1.11 — Docs (test-first does not apply to prose; grep checks)

- **Goal:** README.md, README.vi.md, AGENTS.md and CHANGELOG.md describe what this phase ships, with the exact text below.
- **Target files and symbols:** the README places listed in "Files this phase owns"; the `- Release flow:` bullet in AGENTS.md; `CHANGELOG.md` `## [Unreleased]` → `### Added`.
- **Steps:**
  1. **README.md**: insert after the paragraph that starts ``For the AppImage, run `chmod +x` `` and before the paragraph that starts `Sai ATLAS runs natively on Wayland`. Leave one blank line around it.

     ~~~markdown
     <a id="en-verify"></a>
     **Verify a download (Linux).** Each Linux release carries `SHA512SUMS`, which lists the SHA-512 of the AppImage, the `.deb` and `latest-linux.yml`, and two signatures over it from the release keyset `2026a`: ML-DSA-65 (`SHA512SUMS.2026a.mldsa65.sig`) and Ed25519 (`SHA512SUMS.2026a.ed25519.sig`). Download the package, `SHA512SUMS`, those two `.sig` files and the public keys `sai-atlas-release-2026a-mldsa65.pem` and `sai-atlas-release-2026a-ed25519.pem` from the release into one directory, then run:

     ```bash
     openssl pkey -pubin -in sai-atlas-release-2026a-mldsa65.pem -outform DER | sha256sum
     openssl pkey -pubin -in sai-atlas-release-2026a-ed25519.pem -outform DER | sha256sum
     openssl pkeyutl -verify -rawin -pubin -inkey sai-atlas-release-2026a-mldsa65.pem -in SHA512SUMS -sigfile SHA512SUMS.2026a.mldsa65.sig
     openssl pkeyutl -verify -rawin -pubin -inkey sai-atlas-release-2026a-ed25519.pem -in SHA512SUMS -sigfile SHA512SUMS.2026a.ed25519.sig
     sha512sum -c --ignore-missing SHA512SUMS
     ```

     The first two lines must print the fingerprints in this table, the two `pkeyutl` lines must print `Signature Verified Successfully`, and the last line must print `OK` for the package you downloaded.

     | Keyset | Algorithm | SHA-256 fingerprint of the public key |
     |---|---|---|
     | 2026a | ML-DSA-65 | — |
     | 2026a | Ed25519 | — |
     | 2026b | ML-DSA-65 | — |
     | 2026b | Ed25519 | — |

     `2026b` is the next keyset; releases are signed with it only after a key rotation ([Release signing keys](#en-signing-keys)). The ML-DSA-65 line needs OpenSSL 3.5 or later, which Ubuntu 26.04 and Debian 13 ship. Ubuntu 24.04's OpenSSL 3.0 cannot load the key, so there only the Ed25519 line works, and it gives classical assurance only. These fingerprints are published here and in each release's notes, both on GitHub. The check catches a package that was changed in transit or on a mirror. It does not catch a takeover of the GitHub repository or a leaked maintainer token, because whoever controls them can sign a release and change this README.
     ~~~

  2. **README.vi.md**: insert at the matching place, after the paragraph that starts ``Với AppImage, chạy `chmod +x` `` and before the paragraph that starts `Sai ATLAS chạy trực tiếp trên Wayland`:

     ~~~markdown
     <a id="vi-verify"></a>
     **Xác minh tệp tải về (Linux).** Mỗi bản phát hành cho Linux kèm tệp `SHA512SUMS`, liệt kê mã SHA-512 của AppImage, gói `.deb` và `latest-linux.yml`, cùng hai chữ ký trên tệp đó bằng bộ khóa phát hành `2026a`: ML-DSA-65 (`SHA512SUMS.2026a.mldsa65.sig`) và Ed25519 (`SHA512SUMS.2026a.ed25519.sig`). Tải gói cài đặt, `SHA512SUMS`, hai tệp `.sig` đó và hai khóa công khai `sai-atlas-release-2026a-mldsa65.pem`, `sai-atlas-release-2026a-ed25519.pem` từ trang bản phát hành vào cùng một thư mục, rồi chạy:

     ```bash
     openssl pkey -pubin -in sai-atlas-release-2026a-mldsa65.pem -outform DER | sha256sum
     openssl pkey -pubin -in sai-atlas-release-2026a-ed25519.pem -outform DER | sha256sum
     openssl pkeyutl -verify -rawin -pubin -inkey sai-atlas-release-2026a-mldsa65.pem -in SHA512SUMS -sigfile SHA512SUMS.2026a.mldsa65.sig
     openssl pkeyutl -verify -rawin -pubin -inkey sai-atlas-release-2026a-ed25519.pem -in SHA512SUMS -sigfile SHA512SUMS.2026a.ed25519.sig
     sha512sum -c --ignore-missing SHA512SUMS
     ```

     Hai dòng đầu phải in ra đúng dấu vân tay trong bảng dưới, hai dòng `pkeyutl` phải in `Signature Verified Successfully`, và dòng cuối phải in `OK` cho gói bạn đã tải.

     | Bộ khóa | Thuật toán | Dấu vân tay SHA-256 của khóa công khai |
     |---|---|---|
     | 2026a | ML-DSA-65 | — |
     | 2026a | Ed25519 | — |
     | 2026b | ML-DSA-65 | — |
     | 2026b | Ed25519 | — |

     `2026b` là bộ khóa kế tiếp; bản phát hành chỉ được ký bằng nó sau một lần thay khóa ([Khóa ký bản phát hành](#vi-signing-keys)). Dòng ML-DSA-65 cần OpenSSL 3.5 trở lên, có sẵn trên Ubuntu 26.04 và Debian 13. OpenSSL 3.0 của Ubuntu 24.04 không đọc được khóa này, nên trên đó chỉ chạy được dòng Ed25519, và dòng này chỉ cho mức bảo đảm cổ điển. Các dấu vân tay này được công bố ở đây và trong ghi chú của mỗi bản phát hành, cả hai đều trên GitHub. Bước kiểm tra này phát hiện được gói bị thay đổi trên đường truyền hoặc trên máy chủ nhân bản (mirror). Nó không phát hiện được việc kho GitHub bị chiếm quyền hay token của người bảo trì bị lộ, vì ai nắm được chúng đều có thể ký một bản phát hành và sửa README này.
     ~~~

  3. **README.md step 7**: replace this exact text:

     > ``Run `bun scripts/release-feeds.ts --version <version> --linux <bundle-dir> --electron-mac-feed <dir>/latest-mac.yml`: it copies the Linux bundles into `dist-release/` under their published names, writes `latest-linux.yml` for both packages, and copies the Electron feed with the files it lists. Create the GitHub Release as a draft, upload every asset, then publish; a release missing an asset breaks update checks.``

     with:

     > ``In a shell where `SAI_ATLAS_UPDATE_BASE` and `SAI_ATLAS_UPDATE_KEYS` are unset, and with `dist-release/` absent or empty (the script refuses either variable and a non-empty directory), run `bun scripts/release-feeds.ts --version <version> --linux <bundle-dir> --electron-mac-feed <dir>/latest-mac.yml`: it copies the Linux bundles into `dist-release/` under their published names, writes `latest-linux.yml` for both packages and `SHA512SUMS` for the Linux files, and copies the Electron feed with the files it lists. Create the GitHub Release as a draft and upload everything in `dist-release/` together with the other assets below. Then sign it: run `gh workflow run sign-release.yml -f tag=v<version> -f feed_sha256=<sha256sum of dist-release/latest-linux.yml> -f sums_sha256=<sha256sum of dist-release/SHA512SUMS>`, approve the `release-signing` run, and wait for it to pass. The run refuses a draft whose feed or `SHA512SUMS` differs from those digests, signs both files with ML-DSA-65 and Ed25519, uploads the `.sig` and `.pem` files, and verifies the draft again. Upload nothing and do not re-run `release-feeds.ts` after it. Before publishing, download the draft into an empty directory (`gh release download v<version> -D <dir>`), `cmp` its AppImage, `.deb`, `latest-linux.yml` and `SHA512SUMS` with the copies in `dist-release/`, run `bun scripts/sign-release.ts --verify --tag v<version> <dir>`, and paste the output of `bun scripts/sign-release.ts --fingerprints` into the release notes. Publish only when all of that passes; a release missing an asset breaks update checks.``

  4. **README.vi.md step 7**: replace this exact text:

     > ``Chạy `bun scripts/release-feeds.ts --version <version> --linux <bundle-dir> --electron-mac-feed <dir>/latest-mac.yml`: script chép các gói Linux vào `dist-release/` dưới tên phát hành, ghi `latest-linux.yml` cho cả hai gói, và chép nguồn cập nhật Electron cùng các tệp nó liệt kê. Tạo GitHub Release ở dạng nháp, tải lên mọi tệp, rồi mới phát hành; một bản phát hành thiếu tệp sẽ làm hỏng việc kiểm tra cập nhật.``

     with:

     > ``Trong một shell không đặt `SAI_ATLAS_UPDATE_BASE` và `SAI_ATLAS_UPDATE_KEYS`, và khi `dist-release/` chưa có hoặc đang trống (script từ chối nếu một trong hai biến được đặt hoặc thư mục không trống), chạy `bun scripts/release-feeds.ts --version <version> --linux <bundle-dir> --electron-mac-feed <dir>/latest-mac.yml`: script chép các gói Linux vào `dist-release/` dưới tên phát hành, ghi `latest-linux.yml` cho cả hai gói và `SHA512SUMS` cho các tệp Linux, và chép nguồn cập nhật Electron cùng các tệp nó liệt kê. Tạo GitHub Release ở dạng nháp và tải lên mọi tệp trong `dist-release/` cùng các tệp khác nêu dưới đây. Sau đó ký: chạy `gh workflow run sign-release.yml -f tag=v<version> -f feed_sha256=<sha256sum của dist-release/latest-linux.yml> -f sums_sha256=<sha256sum của dist-release/SHA512SUMS>`, phê duyệt lần chạy `release-signing`, và chờ nó thành công. Lần chạy này từ chối bản nháp có nguồn cập nhật hoặc `SHA512SUMS` khác với hai mã băm đó, ký cả hai tệp bằng ML-DSA-65 và Ed25519, tải lên các tệp `.sig` và `.pem`, rồi xác minh lại bản nháp. Sau bước này không tải lên gì thêm và không chạy lại `release-feeds.ts`. Trước khi phát hành, tải bản nháp về một thư mục trống (`gh release download v<version> -D <thư-mục>`), dùng `cmp` so AppImage, `.deb`, `latest-linux.yml` và `SHA512SUMS` của nó với các bản trong `dist-release/`, chạy `bun scripts/sign-release.ts --verify --tag v<version> <thư-mục>`, và dán kết quả của `bun scripts/sign-release.ts --fingerprints` vào ghi chú phát hành. Chỉ phát hành khi mọi bước trên đều đạt; một bản phát hành thiếu tệp sẽ làm hỏng việc kiểm tra cập nhật.``

  5. **README.md end of file**: after the last line (`</details>`), append one blank line and then:

     ~~~markdown
     <a id="en-signing-keys"></a>
     ### Release signing keys (maintainers)

     <details>
     <summary><b>Where the keys live, and how to set up, rotate, revoke and recover them</b></summary>

     Each keyset is one ML-DSA-65 key and one Ed25519 key. `src-tauri/src/updater/release-keys.json` lists their public keys: `keysets` holds the keysets installs trust, in the order they try them (the current signer, then the next one), and `retiredSigners` holds a keyset that may still sign during a dual-signing window but that no install trusts. `bun scripts/sign-release.ts --fingerprints` prints the fingerprints for [Verify a download](#en-verify) and the release notes.

     **Where the keys live.** The current keyset's private keys are the secrets `RELEASE_SIGNING_MLDSA65_KEY` and `RELEASE_SIGNING_ED25519_KEY` of the GitHub environment `release-signing`, and its id is that environment's variable `RELEASE_SIGNING_KEYSET`. The environment allows only `main`, needs the maintainer's approval for each run, and only `.github/workflows/sign-release.yml` uses it. One backup of every keyset's private keys is kept outside GitHub, in a place the maintainer controls, such as a password manager entry or an encrypted USB drive. GitHub secrets cannot be read back, so that backup is the only copy that can be restored. Private keys are never in the repository. Someone who controls the GitHub account, or holds a maintainer token with `repo` scope, can start and approve a signing run.

     **Set up (once).** With OpenSSL 3.5.5 or later and `umask 077`, in a temporary directory outside the repository:

     ```bash
     for k in 2026a 2026b; do
       openssl genpkey -algorithm ML-DSA-65 -out "$k-mldsa65.key"
       openssl genpkey -algorithm ED25519 -out "$k-ed25519.key"
       openssl pkey -in "$k-mldsa65.key" -pubout -outform DER | base64 -w0; echo
       openssl pkey -in "$k-ed25519.key" -pubout -outform DER | base64 -w0; echo
     done
     ```

     Put the printed public keys into `release-keys.json` (`2026a` first, then `2026b`, and `"retiredSigners": []`). Create the `release-signing` environment with `main` as its only deployment branch and the maintainer as a required reviewer, then store the `2026a` keys: `gh secret set RELEASE_SIGNING_MLDSA65_KEY --env release-signing < 2026a-mldsa65.key`, the same for `RELEASE_SIGNING_ED25519_KEY` with `2026a-ed25519.key`, and `gh variable set RELEASE_SIGNING_KEYSET --env release-signing --body 2026a`. Turn on immutable releases (Settings → General → Releases). Back up all four private keys, run the restore check below for both keysets, then delete the temporary directory.

     **Restore check (at setup and once a year).** Copy one keyset's two private keys from the backup into a new temporary directory outside the repository, sign a copy of a synthetic `0.0.0-signing-check` release with `bun scripts/sign-release.ts --keys <dir> --keyset <id> <release copy>`, and run `bun scripts/sign-release.ts --verify --tag v0.0.0-signing-check <release copy>`. Do it for every keyset in the backup; each must pass. Then delete both directories.

     **Planned rotation.** Move the next keyset to the front of `keysets`, add a newly generated next keyset after it, drop the old signer from `keysets`, and replace the two secrets and `RELEASE_SIGNING_KEYSET` with the new signer's. At the first rotation, from `2026a` to `2026b`, nothing else is needed: every install trusts both and verifies `2026b` alone. From the second rotation on, also move the old signer to `retiredSigners` and keep its keys as the environment's `RELEASE_SIGNING_PREVIOUS_MLDSA65_KEY`, `RELEASE_SIGNING_PREVIOUS_ED25519_KEY` and `RELEASE_SIGNING_PREVIOUS_KEYSET` for 12 months, so installs two rotations behind, which trust the old signer but not the new one, still verify; then remove it from both places. During those 12 months the environment holds both keysets that installs one rotation behind trust, so a takeover then leaves those installs no keyset to recover with. The signing workflow refuses a release that installs of the newest published release could not verify.

     **Revocation.** Publish a release whose `release-keys.json` no longer lists the keyset. Installs that take that release reject the keyset from then on. There is no online revocation list.

     **Compromise** (a leaked secret or token, or a GitHub account takeover). First revoke GitHub tokens and sessions and lock the environment. Sign the next release with the uncompromised keyset only, drop the compromised one from `release-keys.json`, add a new next keyset, and tell users in the release notes. Until an install takes that release, whoever holds the compromised key and can serve release assets can still offer it a "newer" version.

     **Loss.** If the environment's secrets are deleted, restore them from the backup. If the backup of one keyset is lost, promote the other. If both keysets are lost, installs that verify stop offering updates and need a manual reinstall of the next version.

     Never sign a test feed with a release key. The only feed signed with release keys outside a release is the synthetic `0.0.0-signing-check` feed of the restore check and the CI dry run, which is never newer than any install.

     </details>
     ~~~

  6. **README.vi.md end of file**: append the same way:

     ~~~markdown
     <a id="vi-signing-keys"></a>
     ### Khóa ký bản phát hành (dành cho người bảo trì)

     <details>
     <summary><b>Khóa nằm ở đâu, và cách tạo, thay, thu hồi, khôi phục</b></summary>

     Mỗi bộ khóa gồm một khóa ML-DSA-65 và một khóa Ed25519. Tệp `src-tauri/src/updater/release-keys.json` liệt kê khóa công khai của chúng: `keysets` chứa các bộ khóa mà bản cài tin cậy, theo thứ tự chúng được thử (bộ đang ký, rồi bộ kế tiếp), còn `retiredSigners` chứa bộ khóa vẫn có thể ký trong thời gian ký kép nhưng không bản cài nào tin cậy. Lệnh `bun scripts/sign-release.ts --fingerprints` in ra các dấu vân tay cho mục [Xác minh tệp tải về](#vi-verify) và ghi chú phát hành.

     **Khóa nằm ở đâu.** Khóa bí mật của bộ khóa hiện tại là hai secret `RELEASE_SIGNING_MLDSA65_KEY` và `RELEASE_SIGNING_ED25519_KEY` của môi trường GitHub `release-signing`, còn mã của bộ khóa là biến `RELEASE_SIGNING_KEYSET` của môi trường đó. Môi trường chỉ cho phép nhánh `main`, mỗi lần chạy cần người bảo trì phê duyệt, và chỉ `.github/workflows/sign-release.yml` dùng nó. Một bản sao lưu khóa bí mật của mọi bộ khóa được giữ ngoài GitHub, ở nơi người bảo trì kiểm soát, chẳng hạn một mục trong trình quản lý mật khẩu hoặc một USB được mã hóa. Secret trên GitHub không đọc lại được, nên bản sao lưu đó là bản duy nhất có thể khôi phục. Khóa bí mật không bao giờ nằm trong kho mã. Ai kiểm soát tài khoản GitHub, hoặc giữ token của người bảo trì có quyền `repo`, đều có thể khởi chạy và phê duyệt một lần ký.

     **Tạo khóa (một lần).** Với OpenSSL 3.5.5 trở lên và `umask 077`, trong một thư mục tạm nằm ngoài kho mã:

     ```bash
     for k in 2026a 2026b; do
       openssl genpkey -algorithm ML-DSA-65 -out "$k-mldsa65.key"
       openssl genpkey -algorithm ED25519 -out "$k-ed25519.key"
       openssl pkey -in "$k-mldsa65.key" -pubout -outform DER | base64 -w0; echo
       openssl pkey -in "$k-ed25519.key" -pubout -outform DER | base64 -w0; echo
     done
     ```

     Đưa các khóa công khai vừa in vào `release-keys.json` (`2026a` trước, rồi `2026b`, và `"retiredSigners": []`). Tạo môi trường `release-signing` với `main` là nhánh triển khai duy nhất và người bảo trì là người phê duyệt bắt buộc, rồi lưu khóa `2026a`: `gh secret set RELEASE_SIGNING_MLDSA65_KEY --env release-signing < 2026a-mldsa65.key`, làm tương tự cho `RELEASE_SIGNING_ED25519_KEY` với `2026a-ed25519.key`, và `gh variable set RELEASE_SIGNING_KEYSET --env release-signing --body 2026a`. Bật bản phát hành bất biến (Settings → General → Releases). Sao lưu cả bốn khóa bí mật, chạy bước kiểm tra khôi phục dưới đây cho cả hai bộ khóa, rồi xóa thư mục tạm.

     **Kiểm tra khôi phục (khi tạo khóa và mỗi năm một lần).** Chép hai khóa bí mật của một bộ khóa từ bản sao lưu vào một thư mục tạm mới nằm ngoài kho mã, ký một bản sao của bản phát hành giả `0.0.0-signing-check` bằng `bun scripts/sign-release.ts --keys <thư-mục> --keyset <mã> <bản-sao>`, rồi chạy `bun scripts/sign-release.ts --verify --tag v0.0.0-signing-check <bản-sao>`. Làm vậy với mọi bộ khóa trong bản sao lưu; bộ nào cũng phải đạt. Sau đó xóa cả hai thư mục.

     **Thay khóa theo kế hoạch.** Đưa bộ khóa kế tiếp lên đầu `keysets`, thêm một bộ kế tiếp mới tạo ngay sau nó, bỏ bộ ký cũ khỏi `keysets`, và thay hai secret cùng biến `RELEASE_SIGNING_KEYSET` bằng của bộ ký mới. Ở lần thay đầu tiên, từ `2026a` sang `2026b`, không cần làm gì thêm: mọi bản cài đều tin cả hai bộ và xác minh được chỉ với `2026b`. Từ lần thay thứ hai trở đi, chuyển thêm bộ ký cũ vào `retiredSigners` và giữ khóa của nó làm `RELEASE_SIGNING_PREVIOUS_MLDSA65_KEY`, `RELEASE_SIGNING_PREVIOUS_ED25519_KEY` và `RELEASE_SIGNING_PREVIOUS_KEYSET` của môi trường trong 12 tháng, để các bản cài chậm hai lần thay khóa, vốn tin bộ ký cũ nhưng chưa tin bộ mới, vẫn xác minh được; hết thời hạn thì gỡ nó khỏi cả hai nơi. Trong 12 tháng đó môi trường giữ cả hai bộ khóa mà các bản cài chậm một lần thay khóa tin cậy, nên nếu tài khoản bị chiếm quyền lúc ấy thì các bản cài đó không còn bộ khóa nào để khôi phục. Quy trình ký từ chối một bản phát hành mà các bản cài của bản phát hành mới nhất đã công bố không xác minh được.

     **Thu hồi.** Phát hành một bản có `release-keys.json` không còn liệt kê bộ khóa đó. Bản cài nào nhận bản phát hành ấy sẽ từ chối bộ khóa đó từ đó về sau. Không có danh sách thu hồi trực tuyến.

     **Khi khóa bị lộ** (secret hoặc token bị lộ, hay tài khoản GitHub bị chiếm quyền). Trước hết thu hồi token và phiên đăng nhập GitHub, rồi khóa môi trường lại. Ký bản phát hành tiếp theo chỉ bằng bộ khóa chưa bị lộ, bỏ bộ bị lộ khỏi `release-keys.json`, thêm một bộ kế tiếp mới, và báo cho người dùng trong ghi chú phát hành. Cho đến khi một bản cài nhận bản phát hành đó, ai giữ khóa bị lộ và phục vụ được tệp phát hành vẫn có thể đề xuất cho nó một phiên bản "mới hơn".

     **Khi mất khóa.** Nếu secret của môi trường bị xóa, khôi phục chúng từ bản sao lưu. Nếu mất bản sao lưu của một bộ khóa, đưa bộ còn lại lên làm bộ ký. Nếu mất cả hai bộ khóa, các bản cài có xác minh sẽ không còn đề xuất cập nhật và cần tự cài lại phiên bản tiếp theo.

     Không bao giờ ký một nguồn cập nhật thử nghiệm bằng khóa phát hành. Nguồn cập nhật duy nhất được ký bằng khóa phát hành ngoài một bản phát hành là nguồn giả `0.0.0-signing-check` của bước kiểm tra khôi phục và lần chạy thử trên CI, vốn không bao giờ mới hơn bất kỳ bản cài nào.

     </details>
     ~~~

  7. **AGENTS.md**: in the `- Release flow:` bullet, replace the exact text ``then `bun scripts/release-feeds.ts` to write `dist-release/` with a `latest-linux.yml` listing both packages.`` with:

     > ``then, with `SAI_ATLAS_UPDATE_BASE` and `SAI_ATLAS_UPDATE_KEYS` unset, `bun scripts/release-feeds.ts` into an empty `dist-release/` (it refuses either variable and a non-empty directory), which writes a `latest-linux.yml` listing both packages and a `SHA512SUMS`. Upload everything in it to the draft, run `gh workflow run sign-release.yml -f tag=v<version> -f feed_sha256=<sha256sum of dist-release/latest-linux.yml> -f sums_sha256=<sha256sum of dist-release/SHA512SUMS>` and approve the `release-signing` run: it signs only bytes whose digests you pass, uploads ML-DSA-65 and Ed25519 signatures with the public keys, and verifies the draft. Upload nothing after it; before publishing, download the draft, `cmp` it with `dist-release/` and run `bun scripts/sign-release.ts --verify --tag v<version>` on it. The signing keys live only in the `release-signing` environment and one backup outside GitHub (README → Release signing keys); never sign a test feed with a release key.``

  8. **CHANGELOG.md**: add this line as the last bullet of the first `### Added` under `## [Unreleased]`:

     ~~~markdown
     - **Signed Linux releases**: each Linux release now carries `SHA512SUMS` with ML-DSA-65 and Ed25519 signatures and the public keys, so a downloaded package can be checked with OpenSSL (README → Verify a download).
     ~~~

  9. Run the Verify commands.
- **Success criteria:** the inserted text is exactly as given, and the checks below pass.
- **Verify:**
  - Command:
    ```bash
    for f in README.md README.vi.md; do grep -c 'id="en-verify"\|id="vi-verify"' $f; grep -c 'id="en-signing-keys"\|id="vi-signing-keys"' $f; grep -c 'gh workflow run sign-release.yml' $f; done
    ```
    Pass: prints `1` six times, three per file. Step 7 is the only mention of `gh workflow run` in each README.
  - `grep -c 'gh workflow run sign-release.yml' AGENTS.md` prints `1`.
  - `grep -c 'Signed Linux releases' CHANGELOG.md` prints `1`.
  - Forbidden phrases: the following command prints nothing.
    ```bash
    git grep -n -i -E "quantum-safe|quantum safe|quantum-proof|quantum-resistant|post-quantum secure|FIPS-validated|FIPS 140|kháng lượng tử|an toàn trước máy tính lượng tử|chữ ký số" -- README.md README.vi.md AGENTS.md CHANGELOG.md
    ```
  - `bunx vitest run scripts/sign-release.test.ts 2>&1 | tail -4; echo "exit ${PIPESTATUS[0]}"` still prints `exit 0` and `17 passed | 3 skipped`.

### Task 1.12 — Phase gate

- **Goal:** everything this phase owns is clean.
- **Target files and symbols:** none; this task edits nothing.
- **Steps:** run:
  ```bash
  bunx vitest run scripts/release-feeds.test.ts scripts/sign-release.test.ts scripts/tauri-packaging-config.test.ts 2>&1 | tail -5; echo "vitest exit ${PIPESTATUS[0]}"
  bunx biome check scripts/release-feeds.ts scripts/release-feeds.test.ts scripts/sign-release.ts scripts/sign-release.test.ts scripts/tauri-packaging-config.test.ts; echo "biome exit $?"
  git diff --quiet -- package.json bun.lock e2e-tauri scripts/tauri-linux-build.sh scripts/tauri-linux-build src-tauri/linux .github/workflows/ci.yml; echo "frozen exit $?"
  grep -rl "PRIVATE KEY" scripts .github README.md README.vi.md AGENTS.md; echo "private-key exit $?"
  test ! -e src-tauri/src/updater/release-keys.json; echo "keys-absent exit $?"
  ```
- **Success criteria:** every check below holds.
- **Verify:** the script prints all of these:
  - `vitest exit 0`
  - `biome exit 0`
  - `frozen exit 0`: no file that every wave-1 phase leaves frozen has changed.
  - `private-key exit 1`: no file holds a private key.
  - `keys-absent exit 0`

### Task 1.13 — kongming review (compensates for a Sonnet executor on a security-critical phase)

- **Goal:** an independent review of the signing tooling before the PR.
- **Target files and symbols:** none; this task edits nothing unless kongming names a fix inside this phase's files.
- **Steps:**
  1. Spawn the `kongming` subagent. Pass it:
     - this file's path;
     - `git diff` plus the full text of every new file this phase created;
     - the outputs of tasks 1.10 and 1.12;
     - these questions:
       1. Can any step of the `sign` job run npm package code or a downloaded script?
       2. Can a key or secret reach the job log or the uploaded assets?
       3. Does `--verify` fail in every case listed in task 1.6, and could a draft pass it with a file the maintainer did not build?
       4. Do the README and AGENTS texts claim anything the code does not do?
       5. Does any file outside "Files this phase owns" change?

     Ask it to end its reply with exactly one line, `REVIEW: PASS` or `REVIEW: BLOCK <numbered list>`.
  2. On `REVIEW: BLOCK`, apply only fixes inside this phase's files, re-run task 1.12, and spawn kongming again with the new diff. A fix that needs another file is a Verify failure.
- **Success criteria:** kongming's last line is `REVIEW: PASS`.
- **Verify:** the last line of kongming's reply equals `REVIEW: PASS`. If kongming cannot be spawned, STOP and report to the user (Failure Protocol).

### Task 1.14 — Report

- **Goal:** the orchestrator gets the result.
- **Target files and symbols:** none.
- **Steps:**
  1. Print the outputs of task 1.12.
  2. Print the list of changed files.
  3. Print this status block:
     ```text
     Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
     Summary: one or two sentences
     Concerns/Blockers: optional
     ```
- **Success criteria:** the status block is printed.
- **Verify:** no verification needed.

## Risks

| Risk | Likelihood × impact | Mitigation |
|---|---|---|
| A GitHub account takeover or a leaked maintainer token can sign releases | Accepted | Accepted by the user on 2026-10-09. The environment's branch rule and required approval narrow who can start a run, but not someone who controls the account or holds a `repo`-scope token, which can approve the run's deployment. README says so. |
| Someone swaps the draft's files before the approved run | Low × Critical | The run refuses bytes whose SHA-256 differs from the inputs, a feed whose version is not the tag, and packages that fail `sha512sum -c`. |
| Code in the keyed job reads the keys | Low × Critical | No npm code: no `bun install`, `bun --no-install`, `node:` modules and `Bun.YAML` only, enforced by the workflow tests and `imports only node: modules`. Actions are SHA-pinned and the container is digest-pinned. |
| A secret leaks into a log | Low × High | Keys are written from `env` with `printf '%s\n'`, never echoed, with no `set -x`. GitHub masks registered secrets as a second layer. |
| The container lacks a tool, or `setup-bun` misbehaves inside it | Medium × Low | Phase 2's CI dry run shows it. The fallback is the `ubuntu-26.04` runner without a container. |
| CI's `linux` job skips the integration tests (OpenSSL 3.0) | Medium × Low | The gate is this host's run (task 1.6 requires no skip) and phase 2's CI dry run. |
| Extra release assets confuse old clients | Low | Electron and Tauri updaters read only the feed and the package they select (`src-tauri/src/updater/feed.rs:154-170`). |

## Rollback

Revert this phase's commits. No client reads the new assets yet, so nothing breaks. After phase 5 has shipped in a release, signing can no longer be rolled back.

## Failure Protocol
If any Verify step does not meet its stated pass condition, STOP this phase.
Do not improvise a fix, retry blindly, or reason around the failure.
Spawn the `kongming` subagent for next-step counsel and pass:
- the phase and task id,
- what you attempted (the steps you ran),
- the exact command and its full output,
- the pass condition it failed to meet.
Apply kongming's guidance, then re-run the Verify step.
If `kongming` cannot be spawned in this environment, STOP and report the same
failure evidence to the user. Never continue by self-reasoning.
