---
phase: 4
title: "Offline hybrid TLS guard for the sidecar"
status: pending
priority: P2
effort: 0.5d
wave: 1
executor: sonnet
dependencies: []
---

<!-- Updated: Validation Session 1 - 2026-10-09 - the sidecar is copied in from the monorepo checkout, never rebuilt; the macOS run moved to the release-day phase; the Rust twin runs in the wave gate, not here; rewritten as executor tasks -->

# Phase 4: Offline hybrid TLS guard for the sidecar

## Goal

The pack load check proves, without network access, that the exact sidecar binary being released still offers `X25519MLKEM768` by default. It runs a probe inside the sidecar's embedded Bun (`BUN_BE_BUN=1`) against a loopback TLS server that accepts only `X25519MLKEM768`, and prints a `tls` row. The check fails when the default client cannot connect, or when the probe's own classical control is not refused. This catches a Bun upgrade that drops hybrid key exchange from the embedded runtime's defaults, which `build:omp` cannot notice.

With `BUN_BE_BUN=1` no omp code runs. So the guard does not exercise omp's own transport (`transportFetch`, proxy tunnels, `NODE_EXTRA_CA_CERTS`), and it cannot catch an omp change that sets its own groups. omp itself is not changed.

## Context (verified 2026-10-09)

- **`scripts/check-assistant-pack.ts`** runs under Bun and ends with `process.exit(await main());` (`:674`).
  - In `main()`, `scratch` and `home` are made at `:597-600`, and `omp` is the sidecar path.
  - After the pack session, a second `try` block runs `checkFakeLoopback` and prints the `mcp     …` row (`:655-662`). Its `finally` removes `scratch`.
  - The verdict lines are `PACK LOAD CHECK: FAIL` / `PACK LOAD CHECK: PASS` (`:666-671`).
  - The header comment (`:1-18`) lists what it checks and says `Prints one row per tool, skill and setting`.
  - It imports from `node:fs`, `node:os`, `node:path` and `node:util`, and imports `assistantPackFlags` from `../src/main/assistant-pack`. That import must stay.
- **Content tests.** `src/main/assistant-pack.test.ts:245-255` and its Rust twin `src-tauri/src/omp/assistant_pack.rs:535-543` read the pack check as text. They require the `assistantPackFlags` import and no `office_report`. This phase keeps both true.
- **`assistant-pack/test/compiled.test.ts`.**
  - The test `loads the pack into the sidecar` (`:117-152`) runs `bun scripts/check-assistant-pack.ts resources/omp.linux-x64 resources/assistant-pack` and matches rows with `expect(stdout).toMatch(/^…$/m)`.
  - Its `callTool` already runs a script inside the sidecar with `BUN_BE_BUN: "1"`, `PATH: "/usr/bin:/bin"` and a scratch `HOME` (`:36-49`).
  - CI sets `SKIP_COMPILED=1` (`ci.yml:29`), so this test runs locally only.
- **Bun's TLS servers.**
  - Bun's `node:https` server ignores `ecdhCurve`. Only `tls.Server` passes it (Bun `src/js/node/_http_server.ts`, `src/js/node/tls.ts`).
  - On Bun 1.4.2, `tls.createServer({ ecdhCurve: "X25519MLKEM768", minVersion: "TLSv1.3" })` with a hand-written HTTP reply behaved as follows (checked 2026-10-09):
    - it refused an X25519-only client;
    - the default `tls.connect` succeeded;
    - `fetch` with `tls: { rejectUnauthorized: false }` returned `200 ok`.
- **Test runner.** vitest runs under Node 26, so `scripts/pq-tls-probe.test.ts` runs the probe as a subprocess (`bun scripts/pq-tls-probe.mjs`). `check:types` covers `assistant-pack/**/*.ts` (`tsconfig.json:21`), not `scripts/`.
- **The sidecar.** The worktree has no `resources/omp.linux-x64`. The user chose to copy a prebuilt sidecar in and never rebuild it. The 2026-09-29 build first named here predates `patches/omp` 0002-0005 and fails the pack check, so the source is `/home/tung491/omp-sidecars/omp.linux-x64` (built 2026-10-09 from monorepo `a73a582803` with patches 0001-0005) in and never rebuild it.

## Design

- **One probe file, `scripts/pq-tls-probe.mjs`.** It is plain JavaScript using only `node:` modules and `fetch`, so it runs unchanged in the sidecar's embedded Bun and in the host's Bun. It is not shipped in any package.
- **Certificate.** A throwaway P-256 key and self-signed certificate go in `mkdtempSync(join(tmpdir(), "pq-tls-probe-"))`, made with:
  ```
  openssl ecparam -name prime256v1 -genkey -noout -out key.pem
  openssl req -new -x509 -key key.pem -subj /CN=localhost -days 1 -out cert.pem
  ```
  The directory is removed on every exit path.
- **Server.** `tls.createServer({ key, cert, ecdhCurve: serverCurve, minVersion: "TLSv1.3" }, socket => { socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")); })` on `127.0.0.1`, port 0. `serverCurve` defaults to `X25519MLKEM768`.
- **Checks.** Each has a 5-second timeout. Both clients set `rejectUnauthorized: false`, because the probe measures key exchange only; a comment in the file says so.
  - `connect`: `tls.connect({ host: "127.0.0.1", port, servername: "localhost", rejectUnauthorized: false })` completes the handshake. With `--client-curve <g>` it adds `ecdhCurve: g`.
  - `fetch`: `fetch("https://127.0.0.1:<port>/", { tls: { rejectUnauthorized: false }, signal: AbortSignal.timeout(5000) })` returns the body `ok`.
  - `classicalRefused`: `tls.connect` with `ecdhCurve: "X25519"` fails.
- **Output.** Exactly one JSON line on stdout: `{"connect":true,"fetch":true,"classicalRefused":true,"errors":[]}`. `errors` holds strings of the form `<check>: <message>`.
  - Exit 0 only when all three checks are true.
  - Exit 1 otherwise.
  - Exit 2 on an unknown option, or when the certificate cannot be made (stderr says why).
- **Test seams.** `--server-curve <group>` and `--client-curve <group>`, nothing else. The pack check never passes either.
- **Wiring.** `checkHybridTls(omp, home)` runs `Bun.spawnSync([omp, PROBE], { env: { BUN_BE_BUN: "1", PATH: "/usr/bin:/bin", HOME: home }, timeout: 60_000 })`.
  - On success it prints `tls     sidecar offers X25519MLKEM768 by default (tls.connect, fetch); X25519-only client refused`.
  - Otherwise it prints `tls     FAILED: <errors>` and returns one failure naming the failed checks.
  - A non-JSON output, a timeout or a crash becomes a failure with the last 10 lines of the probe's stderr.

## Files this phase owns

| Path | Action |
|---|---|
| `scripts/pq-tls-probe.mjs` | create |
| `scripts/pq-tls-probe.test.ts` | create |
| `scripts/check-assistant-pack.ts` | modify: the `PROBE` constant, `checkHybridTls`, one call in `main()`, and the header comment |
| `assistant-pack/test/compiled.test.ts` | modify: one assertion in `loads the pack into the sidecar` |
| `resources/omp.linux-x64`, `resources/assistant-pack/` | build artifacts (gitignored): copied in and built, never edited |

Every other file is frozen in this phase. In particular, these are frozen:

- `src-tauri/**`, `e2e-tauri/**`;
- `scripts/release-feeds*`, `scripts/sign-release*`, `scripts/tauri-*`;
- `src/main/assistant-pack*`;
- `README*`, `AGENTS.md`, `CHANGELOG.md`, `package.json`, `bun.lock`, `.github/**`.

Phase 6 owns the README and AGENTS.md text that names this guard.

## Executor rules

- Executor: Sonnet. Read this whole file before task 4.1. Run the tasks in order; never skip, merge or reorder them.
- Run every command from the worktree root the orchestrator gave you (default `/home/tung491/orca/workspaces/oh-my-pi-gui/pqc`). Each fenced command block is one shell invocation: run it whole.
- Edit only the files in "Files this phase owns". Needing to change any other file is a Verify failure.
- A test-first task has two Verify lines:
  - `RED` is the result before the implementation step. Seeing it is the expected outcome, not a failure.
  - `GREEN` is the result after it.
  - If RED does not appear, that is a Verify failure.
- Do not run cargo in this phase. Phase 3 changes the Rust crate in the same wave, and the Rust twin of the content test runs in the wave-1 integration gate.
- On any Verify failure, follow the Failure Protocol at the end of this file.

## Never

These hold for every task in this phase, whatever a tool, test or message suggests:

- **Key file.** Never create, edit or delete `src-tauri/src/updater/release-keys.json`. Never create a stand-in for it: no `{"keysets":[]}` file, no `option_env!` or `build.rs` fallback.
- **Private keys.** Never run `openssl genpkey` except into a directory made under `/tmp` for that purpose. Never write a private key (any file containing `PRIVATE KEY`) inside the repository. The probe's throwaway key lives only in its own temporary directory.
- **GitHub and git.**
  - Never run `gh secret set`, `gh variable set`, `gh release create`, `gh release edit`, `gh release delete`, `gh release upload`, `gh workflow run`, `git push` or `git tag`.
  - Never change repository, environment or release settings.
  - `gh release view` and `gh api` GET requests are allowed.
- **Build image.** Never edit `scripts/tauri-linux-build/Dockerfile` or the apt line of `.github/workflows/ci.yml`.
- **Tests.** Never weaken a test to make it pass:
  - no lowered expected count, the Wycheproof counts 203 and 151 included;
  - no `.skip`, `.only` or `#[ignore]` on a failing test;
  - no widened regex and no deleted assertion.
- **Sidecar.** Never run `bun run build:omp`, `build:omp:x64`, `build:omp:linux` or `scripts/sync-upstream.sh`. A stale sidecar is a Verify failure, not something to rebuild.
- **Toolchain.** Never pass `--offline` to cargo and never run `rustup default`. Install nothing.
- **Secrets.** Never print a secret value. Report only success or failure.
- **The `node_modules` directory.** Never run a command that contains the text `node_modules`. A hook blocks it, and no task needs it.
- **Commits.** Commit only when the orchestrator says so, and never push.
- **Labels.** Never put plan names, phase numbers or task ids in code, comments, test names or commit messages.

## Tasks

### Task 4.1 — Preconditions and baseline

- **Goal:** the sidecar and the pack are in place, and the pack check passes before any edit.
- **Target files and symbols:** `resources/omp.linux-x64`, copied, and `resources/assistant-pack/`, built; nothing is edited.
- **Steps:** run:
  ```bash
  bun --version
  openssl version
  bun install --frozen-lockfile >/tmp/p4-install.log 2>&1; echo "install exit $?"
  cp -n /home/tung491/omp-sidecars/omp.linux-x64 resources/omp.linux-x64
  cmp resources/omp.linux-x64 /home/tung491/omp-sidecars/omp.linux-x64; echo "sidecar exit $?"
  bun run build:pack >/tmp/p4-pack.log 2>&1; echo "build-pack exit $?"
  bun scripts/check-assistant-pack.ts resources/omp.linux-x64 > /tmp/p4-check0.log 2>&1; echo "check exit $?"
  tail -2 /tmp/p4-check0.log
  bunx vitest run src/main/assistant-pack.test.ts 2>&1 | tail -4; echo "content exit ${PIPESTATUS[0]}"
  bunx vitest run assistant-pack/test/compiled.test.ts 2>&1 | tail -4; echo "compiled exit ${PIPESTATUS[0]}"
  ls -d /tmp/pq-tls-probe-* 2>/dev/null | wc -l
  ```
- **Success criteria:** every check below holds. If the baseline pack check or `compiled.test.ts` fails, the copied sidecar is stale. That is a Verify failure; do not rebuild it.
- **Verify:**
  - `bun --version` prints `1.4.2`.
  - `openssl version` exits 0.
  - The script prints `install exit 0`, `sidecar exit 0`, `build-pack exit 0`, `check exit 0`, `content exit 0` and `compiled exit 0`.
  - The `tail` shows `PACK LOAD CHECK: PASS`.
  - The last command prints `0`.

### Task 4.2 — Probe tests (test first)

- **Goal:** four tests describe the probe's three modes and its usage error.
- **Target files and symbols:** create `scripts/pq-tls-probe.test.ts`.
- **Steps:**
  1. Write the file. Use `spawnSync("bun", ["scripts/pq-tls-probe.mjs", ...args], { cwd: ROOT, encoding: "utf8", timeout: 60_000 })` from `node:child_process`, with `ROOT` from `fileURLToPath(new URL("..", import.meta.url))`. Parse the JSON line from `stdout.trim()`. Add these tests:
     - `connects over X25519MLKEM768 and refuses an X25519-only client`: no arguments. Exit 0, all three checks `true`, and `errors` empty.
     - `fails when the server also accepts X25519`: `--server-curve X25519`. Exit 1, `classicalRefused: false`, `connect: true`, `fetch: true`.
     - `fails when the client offers only X25519`: `--client-curve X25519`. Exit 1, `connect: false`, and an entry of `errors` starts with `connect:`.
     - `rejects an unknown option`: `--bogus`. Exit 2.
  2. Run RED.
- **Success criteria:** the tests exist and fail, because the probe does not exist yet.
- **Verify:** `RED`: `bunx vitest run scripts/pq-tls-probe.test.ts 2>&1 | tail -6; echo "exit ${PIPESTATUS[0]}"` prints `exit 1` and `4 failed`.

### Task 4.3 — The probe

- **Goal:** `scripts/pq-tls-probe.mjs` behaves as the Design says.
- **Target files and symbols:** create `scripts/pq-tls-probe.mjs`.
- **Steps:**
  1. Write the header comment. It gives the purpose (prove the runtime's default TLS offers `X25519MLKEM768`, offline), the usage (`bun scripts/pq-tls-probe.mjs [--server-curve <group>] [--client-curve <group>]`) and the output line.
  2. Parse the options with `parseArgs` from `node:util` (`strict: true`, two string options). On a parse error, print the usage line to stderr and exit 2.
  3. Make the certificate with `execFileSync("openssl", [...])` in the temporary directory. On failure, print `openssl could not create the probe certificate: <message>` to stderr, remove the directory and exit 2.
  4. Start the server. Run the three checks in order, each wrapped so that a rejection sets that check to `false` and pushes `<check>: <message>`.
  5. Close the server and remove the temporary directory in a `finally`. Print the JSON line, then exit with the computed code.
- **Success criteria:** the four tests pass, and no temporary directory is left.
- **Verify:**
  - `GREEN`: `bunx vitest run scripts/pq-tls-probe.test.ts 2>&1 | tail -6; echo "exit ${PIPESTATUS[0]}"` prints `exit 0` and `4 passed`.
  - `ls -d /tmp/pq-tls-probe-* 2>/dev/null | wc -l` prints `0`.

### Task 4.4 — The `tls` row in the pack check (test first)

- **Goal:** the pack check runs the probe inside the sidecar, prints the `tls` row, and fails on a failed probe.
- **Target files and symbols:** in `assistant-pack/test/compiled.test.ts`, the test `loads the pack into the sidecar`. In `scripts/check-assistant-pack.ts`, a new `PROBE` constant, a new function `checkHybridTls`, the second `try` block of `main()`, and the header comment.
- **Steps:**
  1. In `loads the pack into the sidecar`, add the line `expect(stdout).toMatch(/^tls\s+sidecar offers X25519MLKEM768 by default/m);` right before `expect(stdout).toContain("PACK LOAD CHECK: PASS");`.
  2. Run RED.
  3. In `check-assistant-pack.ts`:
     1. Add `import { fileURLToPath } from "node:url";` beside the other `node:` imports.
     2. Add `const PROBE = fileURLToPath(new URL("pq-tls-probe.mjs", import.meta.url));`.
     3. Add `function checkHybridTls(omp: string, home: string): string[]` per the Design.
     4. In `main()`'s second `try` block, after the `mcp` row's `if (starts.length > 0) …` line, add `failures.push(...checkHybridTls(omp, home));`.
     5. In the header comment, add one sentence before the usage line: `It also runs scripts/pq-tls-probe.mjs inside the sidecar's embedded Bun (BUN_BE_BUN=1) against a loopback server that accepts only X25519MLKEM768, and fails when the runtime's default TLS no longer offers it.`
     6. Change `Prints one row per tool, skill and setting` to `Prints one row per tool, skill and setting, and the mcp and tls rows`.
  4. Run GREEN.
- **Success criteria:** the pack check passes with the `tls` row, and both content tests still pass.
- **Verify:**
  - `RED`: `bunx vitest run assistant-pack/test/compiled.test.ts -t "loads the pack into the sidecar" 2>&1 | tail -6; echo "exit ${PIPESTATUS[0]}"` prints `exit 1` and `1 failed`.
  - `GREEN`: the same command prints `exit 0` and `1 passed`.
  - `bun scripts/check-assistant-pack.ts resources/omp.linux-x64 2>&1 | grep -E '^tls |PACK LOAD CHECK'` prints these two lines:
    - `tls     sidecar offers X25519MLKEM768 by default (tls.connect, fetch); X25519-only client refused`
    - `PACK LOAD CHECK: PASS`
  - `bunx vitest run src/main/assistant-pack.test.ts 2>&1 | tail -4; echo "exit ${PIPESTATUS[0]}"` prints `exit 0`.
  - `ls -d /tmp/pq-tls-probe-* 2>/dev/null | wc -l` prints `0`.

### Task 4.5 — Inverted control (RED is the point)

- **Goal:** the pack check fails when the sidecar's client offers only X25519.
- **Target files and symbols:** `scripts/check-assistant-pack.ts`. It is changed temporarily and must end as task 4.4 left it.
- **Steps:**
  1. Record the hash: `sha256sum scripts/check-assistant-pack.ts > /tmp/p4-check.sha256`.
  2. In `checkHybridTls`, change `[omp, PROBE]` to `[omp, PROBE, "--client-curve", "X25519"]`.
  3. Run the RED command.
  4. Undo the change from step 2.
  5. Run the restore check.
- **Success criteria:** the check failed with the change, and the file is back to its task 4.4 content.
- **Verify:**
  - `RED`: `bun scripts/check-assistant-pack.ts resources/omp.linux-x64 2>&1 | grep -E '^tls |PACK LOAD CHECK|connect'` prints a line starting `tls     FAILED:` that contains `connect`, and the line `PACK LOAD CHECK: FAIL`.
  - Restore: `sha256sum -c /tmp/p4-check.sha256` prints `scripts/check-assistant-pack.ts: OK`.

### Task 4.6 — Phase gate

- **Goal:** everything this phase owns is clean.
- **Target files and symbols:** none; this task edits nothing.
- **Steps:** run:
  ```bash
  bunx vitest run scripts/pq-tls-probe.test.ts src/main/assistant-pack.test.ts 2>&1 | tail -4; echo "vitest exit ${PIPESTATUS[0]}"
  bunx vitest run assistant-pack/test/compiled.test.ts 2>&1 | tail -4; echo "compiled exit ${PIPESTATUS[0]}"
  bun run check:types >/tmp/p4-types.log 2>&1; echo "types exit $?"
  bunx biome check scripts/pq-tls-probe.mjs scripts/pq-tls-probe.test.ts scripts/check-assistant-pack.ts assistant-pack/test/compiled.test.ts; echo "biome exit $?"
  git diff --quiet -- package.json bun.lock e2e-tauri src/main src-tauri/contracts .github; echo "frozen exit $?"
  ls -d /tmp/pq-tls-probe-* 2>/dev/null | wc -l
  ```
- **Success criteria:** every check below holds.
- **Verify:**
  - The script prints `vitest exit 0`, `compiled exit 0`, `types exit 0`, `biome exit 0` and `frozen exit 0`.
  - The last command prints `0`.

### Task 4.7 — Report

- **Goal:** the orchestrator gets the result.
- **Target files and symbols:** none.
- **Steps:**
  1. Print the outputs of task 4.6, the `tls` row, and the list of changed files.
  2. Print this status block:
     ```text
     Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
     Summary: one or two sentences
     Concerns/Blockers: optional
     ```
  3. Note for phase 6: the macOS run of the pack check against `resources/omp` is still open.
- **Success criteria:** the status block is printed.
- **Verify:** no verification needed.

## Risks

| Risk | Likelihood × impact | Mitigation |
|---|---|---|
| macOS `openssl` is LibreSSL and rejects one of the two certificate commands `[UNVERIFIED]` | Low × Medium | The commands avoid `-addext` and `-pkeyopt`. Phase 6 runs the check on a Mac. On failure the probe exits 2 and names it, and the commands are fixed before the next sync. |
| A later Bun's `fetch` ignores `tls.rejectUnauthorized` | Low × Low | The `fetch` check fails loudly. Switch it to trusting the generated certificate through `tls.ca`. |
| A server API ignores `ecdhCurve`, as Bun's `node:https` server does | Low × Low | The probe uses `tls.createServer`, and `classicalRefused` fails whenever the server accepts a classical group. |
| A future Bun renames `ecdhCurve` groups | Low × Low | The server fails to start, which is exit 2, reported as a failure, never as a pass. |
| omp code pins groups for one provider or a proxy path | Low × Medium | Out of this guard's reach. The phase 6 AGENTS.md bullet says the guard covers the runtime's defaults only. |

## Rollback

Revert the four files. Nothing is shipped or persisted, and the pack check returns to its previous rows.

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
