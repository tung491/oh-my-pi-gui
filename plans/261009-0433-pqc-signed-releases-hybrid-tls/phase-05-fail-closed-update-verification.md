---
phase: 5
title: "Fail-closed signature verification in the Rust updater"
status: pending
priority: P1
effort: 1.75d
wave: 2
executor: sonnet
dependencies: [1, 3]
---

<!-- Updated: Validation Session 1 - 2026-10-09 - renumbered from phase 2; starts after phases 1 and 3 and before the key setup, with fixture keys; only the last task embeds release-keys.json and waits for the maintainer; the Cargo, packaging-test, AGENTS.md and CHANGELOG parts moved to phases 3, 1 and 6; rewritten as executor tasks -->

# Phase 5: Fail-closed signature verification in the Rust updater

## Goal

The Tauri updater offers a newer release only after one trusted keyset's ML-DSA-65 **and** Ed25519 signatures verify over the exact `latest-linux.yml` bytes it downloaded. Before that it reads nothing from the feed but its version line, so `serde_yml` parses only signed bytes. A newer release with a missing, malformed or bad signature is never offered. The user sees `updates.notVerified` on a manual check, and the runtime log records why.

**Gate:** task 5.3, the OpenSSL fixture interop test, must pass before anything else is wired. If aws-lc-rs rejects OpenSSL 3.5.5's signatures or SPKI keys, the Failure Protocol applies. Tell kongming: "the planned fallback is the RustCrypto `ml-dsa` crate; the executor must not switch crates".

**Start early, embed last (user decision, 2026-10-09).** Tasks 5.1-5.10 use fixture keys only. Until task 5.11, `Config::detect()` trusts no keyset, so a build from the branch offers no update (fail closed), and the branch is never merged before task 5.12 passes. Task 5.11 embeds `src-tauri/src/updater/release-keys.json`, which only the maintainer creates (phase 2). If the file is absent, the phase stops there.

## Context (verified 2026-10-09)

**`run_check`** (`src-tauri/src/updater/mod.rs:289-312`) returns `Result<CheckOutcome, String>`. Today it runs these steps:

1. `feed::fetch_feed(&client, &feed::feed_url(&self.config.release_base))` under `FEED_TIMEOUT`.
2. `feed::is_newer(&feed.version, &current)?`.
3. `update_supported`.
4. `asset_target`.
5. `select_asset`.
6. `Available { version, notes, asset }`.

`check` maps an `Err(message)` by kind (`:247-287`): a manual check shows it in the banner, a startup check logs it and stays idle, and a periodic check keeps it out of the banner. `self.text(MainTextKey::…)` (`:226`) gives a localized message.

**`feed.rs`:**
- `fetch_feed` (`:102-110`) reads text and calls `Feed::parse` (`serde_yml`, `:85-89`). Its errors are `"{FEED_FILE} could not be fetched: {error}"` and `"{FEED_FILE} could not be fetched ({status})"`.
- `GITHUB_RELEASE_BASE` is a private const (`:14`).
- `release_base()` reads `option_env!("SAI_ATLAS_UPDATE_BASE")` (`:16-18`).
- `FEED_FILE` is `latest-linux.yml` on Linux and `latest-mac.yml` on macOS (`:21-27`).
- `download_url(base, version, name)` builds `<base>/download/v<version>/<name>` (`:35-37`).
- The test fixture `PUBLISHED` is at `:180`.

**`Config`** (`mod.rs:86-105`) is built by `Config::detect()` (`:107-128`). The tests build it in two places:
- the `harness` literal (`:892-905`);
- a second literal in `check_skips_a_release_the_os_cannot_run` (`:999`).

**`ReleaseServer`** (`:760-842`):
- It serves the feed for paths ending `/latest/download/<FEED_FILE>` from `server.feed`, and any other path by its last segment from `server.assets`.
- It answers 200, 206, 404 or 416, never a redirect.
- Twelve tests set `*server.feed.lock().unwrap() = Some(…)` (`:968`, `:983`, `:996`, `:1031`, `:1049`, `:1059`, `:1082`, `:1110`, `:1131`, `:1149`, `:1166`, `:1186`).
- Tests read the runtime log through `runtime_log::path()` (`:1328`).
- `runtime_log::note(source, message, details: serde_json::Value)` writes a line.

**i18n** (`src-tauri/src/i18n.rs`):
- `main_text!` lists `UpdatesNoResult` then `UpdatesOpenInstallerFailed` (`:122-123`).
- `const RUST_ONLY_KEYS: &[MainTextKey] = &[MainTextKey::MenuCheckForUpdates];` (`:213`).
- The test `mirrors_every_text_key_in_the_typescript_table` checks every other key against `src/main/i18n.ts`.

**aws-lc-rs 1.18.** Phase 3 added `aws-lc-rs = "1.18"`.
- Its stable `aws_lc_rs::signature` module has `ML_DSA_65`, `ML_DSA_65_SIGNING`, `PqdsaKeyPair`, `ED25519`, `Ed25519KeyPair` and `UnparsedPublicKey`.
- Its ML-DSA verifier passes no context, so only the empty context verifies.
- It accepts SPKI DER for both algorithms.
- Key pairs export SPKI DER through `KeyPair::public_key().as_der()`.

`base64 0.23`, `hex`, `sha2` and `serde_json` are direct dependencies.

**Wycheproof** at C2SP/wycheproof commit `12fd3aaf33eb5fa1f52e026912ee00c054f9d984`:

| File | Bytes | SHA-256 | Vectors |
|---|---|---|---|
| `testvectors_v1/mldsa_65_verify_test.json` | 1,664,194 | `49ac366d76115eab56b7116f10d06e288e6f23fe6cfb90b26bfb2d731a8d1e02` | 210, of which 203 have no or an empty `ctx` (77 valid, 126 invalid) |
| `testvectors_v1/ed25519_test.json` | 126,699 | `752d2ea7d7c6cf4736381b6cbacb61f8182b126ab7cd9b058f00c50084975536` | 151 (88 valid, 63 invalid) |

Field layout:
- ML-DSA groups carry `publicKey`, a hex string, and `publicKeyDer`.
- Ed25519 groups carry `publicKey.pk`, a hex string, and `publicKeyDer`.
- Tests carry `tcId`, `msg`, `sig`, `result` and `flags`, and ML-DSA tests may carry `ctx`.
- Prefixing a well-formed raw key with the SPKI prefix of phase 1 equals its `publicKeyDer` in every group: 21 ML-DSA groups and 78 Ed25519 groups. Four ML-DSA groups have a raw key of the wrong length.

**Smoke and build.**
- The packaged smoke test's update check is `e2e-tauri/packaged-smoke.e2e.ts:351-358`, with the regex `/latest-linux\.yml|"state":"(not-available|available)"/`.
- `scripts/tauri-linux-build.sh:31` passes `SAI_ATLAS_UPDATE_BASE` into the container when it is set.
- `bash scripts/tauri-deb-smoke.sh <deb> --mochaOpts.grep "<spec>"` runs one spec.

**Snapshots.** `updater.api.txt` lists only public items; `feed`, `state` and `install` are private modules. `updater.parity.json` maps only `src/main/updater-state.test.ts`. New Rust-only tests therefore need no TS twin.

## Design

**Order in `run_check`.** The new steps, in order:

1. `feed::fetch_feed_bytes(&client, &url)` reads at most 1 MiB (1,048,576 bytes), chunk by chunk. A longer body fails with `"{FEED_FILE} is larger than 1 MiB"`. HTTP errors keep today's messages.
2. `feed::version_line(&bytes)` reads the first line that starts at column 0 with `version:`. It strips spaces and one pair of matching `'` or `"` quotes, requires strict UTF-8, and validates the value with `semver`. It reads one scalar; it is not a YAML parser.
3. `is_newer(&version, &current)?`. When it is false, return `Ok(CheckOutcome::NotAvailable)` with no further request and no YAML parse.
4. `signature::fetch_and_verify(&client, &self.config.release_base, &version, feed::FEED_FILE, &bytes, &self.config.keysets)` tries each trusted keyset in order:
   - It fetches `download_url(base, version, &signature_name(FEED_FILE, &keyset.id, Algorithm::MlDsa65))` and the `Ed25519` one, each read to at most 4 KiB.
   - It fetches both files for a keyset before judging it. A 404 on either means this keyset did not sign, and the next one is tried.
   - Any other HTTP status or transport error returns `VerifyError::Transport(message)`, which the check reports like a feed fetch failure.
   - The first keyset whose two signatures both verify wins.
   - Otherwise it returns `VerifyError::Rejected(<strongest reason>)`, where `BadSignature` > `Malformed` > `Missing`.
5. `feed::parse_verified(&bytes, &version)` decodes, runs `Feed::parse`, and requires `feed.version == version`. A mismatch or a parse failure is `Rejection::Inconsistent`.
6. The existing `update_supported`, `asset_target` and `select_asset` steps run on that `Feed`.

The whole of steps 1-5 runs under `FEED_TIMEOUT`.

**Rejections** are `Missing`, `Malformed` (wrong length, or a body over 4 KiB), `BadSignature` and `Inconsistent`, displayed as `missing`, `malformed`, `bad signature` and `inconsistent`. On a rejection, `run_check` does two things:
- it calls `runtime_log::note("updater", format!("{} {version} was not verified: {reason}", feed::FEED_FILE), json!({ "version": version, "reason": reason }))`;
- it returns `Err(self.text(MainTextKey::UpdatesNotVerified))`.

**Why the release-pinned URL.** The signatures come from the release the feed names, the same path the package download uses. A `releases/latest` switch between requests therefore cannot cause a mismatch, and a forged version line only fetches another release's signatures, which fail.

**Keys.** `signature.rs` validates a keyset file exactly as `sign-release.ts` does:
- the id pattern;
- base64;
- lengths 1,974 and 44;
- the SPKI prefixes;
- `keysets` non-empty;
- unique ids across both lists.

`retiredSigners` are parsed and validated but never returned as trusted. A pure selector `select_keysets(release, base, test_keys)` picks the source:
- with no base, the release file;
- with a base and test keys, only the test keys;
- with a base and no test keys, no keyset.

`Config` gains `keysets: Vec<signature::Keyset>`. Tests pass their own keysets.

**macOS.** No release signs `latest-mac.yml`, so a Tauri macOS build from this code fails closed with `missing`. That stays out of scope.

## Files this phase owns

| Path | Action |
|---|---|
| `src-tauri/src/updater/signature.rs` | create |
| `src-tauri/src/updater/feed.rs` | modify: `fetch_feed_bytes`, `version_line`, `parse_verified`; `GITHUB_RELEASE_BASE` becomes `pub(crate)`; remove `fetch_feed` |
| `src-tauri/src/updater/mod.rs` | modify: everything but the client line phase 3 changed in `with_config` |
| `src-tauri/src/i18n.rs` | modify: one table row, `RUST_ONLY_KEYS` |
| `src-tauri/tests/fixtures/release-signature/**` | create |
| `scripts/tauri-linux-build.sh` | modify: pass `SAI_ATLAS_UPDATE_KEYS`, warn on each test-feed variable |
| `e2e-tauri/packaged-smoke.e2e.ts` | modify: the update-check regex and its comment only |
| `src-tauri/src/updater/release-keys.json` | read only, in task 5.11; never created or edited here |
| `resources/omp.linux-x64` | copied in by task 5.1 (gitignored build artifact) |

Every other file is frozen in this phase. In particular, these are frozen:

- `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`;
- `src-tauri/contracts/**`, `src-tauri/linux/**`, `src/**`;
- `scripts/` except `tauri-linux-build.sh`;
- `README*`, `AGENTS.md`, `CHANGELOG.md`, `package.json`, `bun.lock`, `.github/**`.

Needing a new crate is a Verify failure.

## Executor rules

- Executor: Sonnet. Read this whole file before task 5.1. Run the tasks in order; never skip, merge or reorder them.
- Run every command from the worktree root the orchestrator gave you (default `/home/tung491/orca/workspaces/oh-my-pi-gui/pqc`). Each fenced command block is one shell invocation: run it whole. Start every invocation that runs cargo with `export PATH="$HOME/.cargo/bin:$PATH"`.
- Edit only the files in "Files this phase owns". Needing to change any other file is a Verify failure.
- A test-first task has two Verify lines:
  - `RED` is the result before the implementation step. Seeing it is the expected outcome, not a failure.
  - `GREEN` is the result after it.
  - If RED does not appear, that is a Verify failure.
- Rust test filters are module paths: `cargo test --manifest-path src-tauri/Cargo.toml --all-features --lib updater::signature` runs `signature.rs`'s tests. Always pass `--lib` with a filter. The crate has five more test targets (the binary, three integration tests and the doc tests), and without `--lib` each prints its own `test result:` line after the library's.
- Every filtered Verify writes the run to a log and greps it, printing three things: the exit code; the count of compile errors (`error[E`); and the library's `test result:` line. A compile-error RED shows `exit 101`, a count of 1 or more, and no `test result:` line.
- On any Verify failure, follow the Failure Protocol at the end of this file.

## Never

These hold for every task in this phase, whatever a tool, test or message suggests:

- **Key file.** Never create, edit or delete `src-tauri/src/updater/release-keys.json`. Never create a stand-in for it: no `{"keysets":[]}` file, no `option_env!` or `build.rs` fallback, no `include_str!` of another file.
- **Private keys.** Never run `openssl genpkey` except into a directory made under `/tmp` for that purpose. Never write a private key (any file containing `PRIVATE KEY`) inside the repository. The fixture private keys are deleted in task 5.2.
- **GitHub and git.**
  - Never run `gh secret set`, `gh variable set`, `gh release create`, `gh release edit`, `gh release delete`, `gh release upload`, `gh workflow run`, `git push` or `git tag`.
  - Never change repository, environment or release settings.
  - `gh release view` and `gh api` GET requests are allowed.
- **Build image.** Never edit `scripts/tauri-linux-build/Dockerfile` or the apt line of `.github/workflows/ci.yml`. If the build needs another package, that is a Verify failure.
- **Tests.** Never weaken a test to make it pass:
  - no lowered expected count, the Wycheproof counts 203 and 151 included;
  - no `.skip`, `.only` or `#[ignore]` on a failing test (the two network tests of task 5.11 are ignored by design);
  - no widened regex and no deleted assertion.
- **Sidecar.** Never run `bun run build:omp`, `build:omp:x64`, `build:omp:linux` or `scripts/sync-upstream.sh`.
- **Toolchain.** Never pass `--offline` to cargo and never run `rustup default`. Install nothing except the two tools plan.md's Rust-tools decision allows (`cargo-public-api` 0.52.0 and `nightly-2026-10-01`), with phase 3 task 3.1's commands, and only when missing.
- **Secrets.** Never print a secret value. Report only success or failure.
- **The `node_modules` directory.** Never run a command that contains the text `node_modules`. A hook blocks it, and no task needs it.
- **Commits.** Commit only when the orchestrator says so, and never push.
- **Labels.** Never put plan names, phase numbers or task ids in code, comments, test names or commit messages.

## Tasks

### Task 5.1 — Preconditions and baseline

- **Goal:** phases 1 and 3 are present, the tools work, and the Rust gates pass before any edit.
- **Target files and symbols:** `resources/omp.linux-x64`, copied; nothing is edited.
- **Steps:** run:
  ```bash
  export PATH="$HOME/.cargo/bin:$PATH"
  which cargo
  test -f scripts/sign-release.ts; echo "phase1 exit $?"
  grep -q '^aws-lc-rs = "1.18"' src-tauri/Cargo.toml && test -f src-tauri/src/http_client.rs; echo "phase3 exit $?"
  git diff --quiet HEAD -- src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/http_client.rs scripts/sign-release.ts; echo "committed exit $?"
  openssl version
  cargo tauri --version
  cargo public-api --version
  bun install --frozen-lockfile >/tmp/p5-install.log 2>&1; echo "install exit $?"
  cp -n /home/tung491/omp-sidecars/omp.linux-x64 resources/omp.linux-x64; test -x resources/omp.linux-x64; echo "sidecar exit $?"
  cargo test --manifest-path src-tauri/Cargo.toml --all-features 2>&1 | grep '^test result:' | tee /tmp/p5-baseline.txt; echo "test exit ${PIPESTATUS[0]}"
  bash scripts/check-module.sh snapshots >/tmp/p5-snap0.log 2>&1; echo "snapshots exit $?"
  ```
  If `cargo tauri --version` does not start with `tauri-cli 2.`, print exactly `STOP_FOR_MAINTAINER: phase 5 task 5.1 needs the maintainer to install tauri-cli 2 (~/.cargo/bin/cargo install tauri-cli --version "^2" --locked); an agent must not perform it.` and end the phase with `Status: BLOCKED`.
- **Success criteria:** every check below holds. Save the first `test result:` line as BASELINE_LIB.
- **Verify:** the script prints all of these:
  - `which cargo` prints `/home/tung491/.cargo/bin/cargo`.
  - `phase1 exit 0`, `phase3 exit 0` and `committed exit 0`. Phases 1 and 3 must be committed in this checkout, because tasks 5.9 and 5.12 check that this phase leaves the manifest unchanged. If `committed exit 1`, end with `Status: NEEDS_CONTEXT` and ask the orchestrator to commit them.
  - `openssl version` matches `^OpenSSL 3\.(5\.([5-9]|[1-9][0-9])|([6-9]|[1-9][0-9])\.[0-9]+)`.
  - `cargo tauri --version` starts with `tauri-cli 2.`.
  - `cargo public-api --version` prints `cargo-public-api 0.52.0`.
  - `install exit 0`, `sidecar exit 0`, `test exit 0` and `snapshots exit 0`.

### Task 5.2 — Fixtures

- **Goal:** `src-tauri/tests/fixtures/release-signature/` holds the following, and no private key:
  - fixture keysets `fixture-a` and `fixture-b`;
  - an OpenSSL-signed feed and `SHA512SUMS`;
  - one context-signed ML-DSA signature;
  - the pinned Wycheproof files;
  - a README.
- **Target files and symbols:** these files in `src-tauri/tests/fixtures/release-signature/`:
  - `fixture-keys.json`;
  - `latest-linux.yml`, `SHA512SUMS`;
  - the eight `*.fixture-{a,b}.{mldsa65,ed25519}.sig` files;
  - `latest-linux.yml.context.mldsa65.sig`;
  - `wycheproof/mldsa_65_verify_test.json`, `wycheproof/ed25519_test.json`;
  - `README.md`.
- **Steps:** run, as one invocation:
  ```bash
  set -euo pipefail
  F=src-tauri/tests/fixtures/release-signature; W=/tmp/sai-atlas-fixtures; rm -rf "$W"; mkdir -p "$W/keys" "$W/src/appimage" "$W/src/deb" "$F/wycheproof"; chmod 700 "$W/keys"
  for k in fixture-a fixture-b; do
    openssl genpkey -algorithm ML-DSA-65 -out "$W/keys/$k-mldsa65.key"
    openssl genpkey -algorithm ED25519 -out "$W/keys/$k-ed25519.key"
  done
  pub() { openssl pkey -in "$1" -pubout -outform DER | base64 -w0; }
  printf '{\n  "keysets": [\n    { "id": "fixture-a", "mlDsa65": "%s", "ed25519": "%s" },\n    { "id": "fixture-b", "mlDsa65": "%s", "ed25519": "%s" }\n  ],\n  "retiredSigners": []\n}\n' \
    "$(pub "$W/keys/fixture-a-mldsa65.key")" "$(pub "$W/keys/fixture-a-ed25519.key")" "$(pub "$W/keys/fixture-b-mldsa65.key")" "$(pub "$W/keys/fixture-b-ed25519.key")" > "$F/fixture-keys.json"
  printf 'fixture appimage\n' > "$W/src/appimage/Sai ATLAS_0.9.99_amd64.AppImage"
  printf 'fixture deb\n' > "$W/src/deb/Sai ATLAS_0.9.99_amd64.deb"
  bun scripts/release-feeds.ts --version 0.9.99 --linux "$W/src" --out "$W/rel"
  bun --no-install scripts/sign-release.ts --trusted "$F/fixture-keys.json" --keys "$W/keys" --keyset fixture-a --keyset fixture-b "$W/rel"
  cp "$W/rel/latest-linux.yml" "$W/rel/SHA512SUMS" "$W"/rel/*.sig "$F/"
  openssl pkeyutl -sign -rawin -inkey "$W/keys/fixture-a-mldsa65.key" -pkeyopt context-string:sai-atlas -in "$F/latest-linux.yml" -out "$F/latest-linux.yml.context.mldsa65.sig"
  C=12fd3aaf33eb5fa1f52e026912ee00c054f9d984
  curl -fsSL "https://raw.githubusercontent.com/C2SP/wycheproof/$C/testvectors_v1/mldsa_65_verify_test.json" -o "$F/wycheproof/mldsa_65_verify_test.json"
  curl -fsSL "https://raw.githubusercontent.com/C2SP/wycheproof/$C/testvectors_v1/ed25519_test.json" -o "$F/wycheproof/ed25519_test.json"
  openssl version > "$W/openssl-version.txt"
  rm -rf "$W/keys"
  cat "$W/openssl-version.txt"; rm -rf "$W"
  ```
  Then write `$F/README.md` with these sections:
  1. What the directory is for.
  2. The commands above, with the key directory shown as `<temp dir>`.
  3. The OpenSSL version line the script printed.
  4. The Wycheproof commit and the two file names.
  5. This notice: `The wycheproof/ files are from https://github.com/C2SP/wycheproof (Apache License 2.0).`
  6. This exact line: `The private keys used here were generated in a temporary directory and deleted; nothing under this directory may ever hold a signing key.`
- **Success criteria:** the files exist with the expected sizes and digests, and no private key is anywhere.
- **Verify:**
  ```bash
  F=src-tauri/tests/fixtures/release-signature
  for f in "$F"/*.mldsa65.sig; do stat -c '%s %n' "$f"; done
  for f in "$F"/*.ed25519.sig; do stat -c '%s %n' "$f"; done
  ls "$F"/*.sig | wc -l
  sha256sum "$F/wycheproof/mldsa_65_verify_test.json" "$F/wycheproof/ed25519_test.json"
  grep -rl "PRIVATE KEY" src-tauri/tests/fixtures; echo "private-key exit $?"
  find src-tauri/tests/fixtures -name '*.key' | wc -l
  test ! -e /tmp/sai-atlas-fixtures; echo "temp exit $?"
  head -1 "$F/latest-linux.yml"
  ```
  Pass:
  - Every `.mldsa65.sig` is `3309` bytes, the context file included, and every `.ed25519.sig` is `64` bytes.
  - `ls … | wc -l` prints `9`.
  - The two SHA-256 values equal those in Context.
  - `private-key exit 1`, then `0` from `find`, then `temp exit 0`.
  - The last line prints `version: 0.9.99`.

### Task 5.3 — Interop gate: aws-lc-rs accepts OpenSSL's signatures (test first)

- **Goal:** aws-lc-rs verifies the OpenSSL-made fixture signatures through the fixture SPKI keys, and rejects a changed byte.
- **Target files and symbols:**
  - Create `src-tauri/src/updater/signature.rs` with `pub(crate) struct Keyset { pub(crate) id: String, ml_dsa_65: Vec<u8>, ed25519: Vec<u8> }`, `pub(crate) fn parse_keysets(json: &str) -> Result<Vec<Keyset>, String>` and `pub(crate) fn verify_pair(message: &[u8], keyset: &Keyset, ml_dsa_65_signature: &[u8], ed25519_signature: &[u8]) -> Result<(), Rejection>`.
  - Add `pub(crate) enum Rejection { Missing, Malformed, BadSignature, Inconsistent }`.
  - In `src-tauri/src/updater/mod.rs`, add `mod signature;` beside `mod feed;`.
- **Steps:**
  1. Write `signature.rs` with only a `#[cfg(test)] mod tests` holding a fixture loader and two tests. Then add `mod signature;` to `mod.rs`.
     - The loader is `fn fixture(name: &str) -> Vec<u8>`, reading `concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/release-signature/")` plus `name`.
     - `accepts_openssl_signatures_from_a_trusted_keyset`: `parse_keysets(<fixture-keys.json text>)` gives `fixture-a` first. For both `latest-linux.yml` and `SHA512SUMS`, `verify_pair` with `fixture-a`'s two signatures returns `Ok(())`, and so does `fixture-b` with its own.
     - `rejects_a_changed_byte`: flip the last byte of `latest-linux.yml`; `verify_pair` returns `Err(Rejection::BadSignature)`.
  2. Run RED.
  3. Implement:
     - `Keyset`, `Rejection` and a serde `KeysetFile { keysets: Vec<KeysetEntry>, retired_signers: Vec<KeysetEntry> }` with `#[serde(rename_all = "camelCase")]`.
     - `parse_keysets`, which decodes base64 with `base64::engine::general_purpose::STANDARD` and returns `keysets` only. Full validation comes in task 5.4.
     - `verify_pair`, which uses `aws_lc_rs::signature::UnparsedPublicKey::new(&aws_lc_rs::signature::ML_DSA_65, &keyset.ml_dsa_65).verify(message, ml_dsa_65_signature)` and the same with `&ED25519`. Both must pass; either failure is `BadSignature`.
  4. Run GREEN.
- **Success criteria:** both tests pass. This is the interop gate.
- **Verify** (`export PATH="$HOME/.cargo/bin:$PATH"; cargo test --manifest-path src-tauri/Cargo.toml --all-features --lib updater::signature > /tmp/p5-sig.log 2>&1; echo "exit $?"; grep -c 'error\[E' /tmp/p5-sig.log; grep '^test result:' /tmp/p5-sig.log`):
  - `RED` (after step 1): prints `exit 101`, then a count of 1 or more, and no `test result:` line. The items the tests call do not exist yet.
  - `GREEN`: prints `exit 0`, then `0`, then a line starting `test result: ok. 2 passed; 0 failed`.
  - **Interop gate:** if after step 3 the code compiles but `accepts_openssl_signatures_from_a_trusted_keyset` fails, that is an interop failure. Follow the Failure Protocol and tell kongming: "the planned fallback is the RustCrypto `ml-dsa` crate; the executor must not switch crates".

### Task 5.4 — Keyset validation, selection, names, lengths and Wycheproof (test first)

- **Goal:** `signature.rs` validates keyset files like `sign-release.ts`, selects the trusted source, names signature files, checks lengths, and passes the Wycheproof vectors.
- **Target files and symbols:** in `src-tauri/src/updater/signature.rs`, add these items:
  - `pub(crate) enum Algorithm { MlDsa65, Ed25519 }`, with `fn file_tag(self) -> &'static str` returning `"mldsa65"` or `"ed25519"`.
  - `pub(crate) fn signature_name(feed_file: &str, id: &str, algorithm: Algorithm) -> String`.
  - `pub(crate) fn select_keysets(release: &str, base: Option<&str>, test_keys: Option<&str>) -> Result<Vec<Keyset>, String>`.
  - Length constants `pub(crate) const ML_DSA_65_SIGNATURE_LEN: usize = 3309;` and `pub(crate) const ED25519_SIGNATURE_LEN: usize = 64;`. The test signer in task 5.7 reads the first one from `mod.rs`.
  - `ML_DSA_65_SPKI_LEN = 1974`, `ED25519_SPKI_LEN = 44`, and the two prefixes as `&[u8]`.
  - `impl Rejection { pub(crate) fn as_str(&self) -> &'static str }`.
- **Steps:**
  1. Add these tests:
     - `rejects_signatures_of_the_wrong_length`: a 3,308-byte ML-DSA signature, and a 65-byte Ed25519 signature, each give `Err(Rejection::Malformed)`.
     - `rejects_when_only_the_ml_dsa_signature_is_valid`: `fixture-a`'s ML-DSA signature over `latest-linux.yml` with its Ed25519 signature over `SHA512SUMS` gives `BadSignature`.
     - `rejects_when_only_the_ed25519_signature_is_valid`: the reverse pairing gives `BadSignature`.
     - `rejects_an_ml_dsa_signature_made_with_a_context`: `latest-linux.yml.context.mldsa65.sig` with the valid Ed25519 signature gives `BadSignature`.
     - `ignores_signatures_from_keysets_that_are_not_trusted`: `fixture-b`'s signatures checked against `fixture-a` give `BadSignature`.
     - `never_trusts_a_retired_signer`: `parse_keysets` of a JSON with `keysets: [fixture-b]` and `retiredSigners: [fixture-a]` returns only `fixture-b`.
     - `names_signatures_after_the_feed_file`:
       - `signature_name("latest-linux.yml", "2026a", Algorithm::MlDsa65)` is `latest-linux.yml.2026a.mldsa65.sig`.
       - `signature_name("latest-mac.yml", "2026a", Algorithm::Ed25519)` is `latest-mac.yml.2026a.ed25519.sig`.
     - `rejects_malformed_keyset_files`: `parse_keysets` errs for each of these:
       - the id `A`;
       - an id of 33 characters;
       - bad base64;
       - a 1,973-byte ML-DSA key;
       - an Ed25519 key in the `mlDsa65` field;
       - a duplicate id;
       - one id in both lists;
       - `"keysets": []`;
       - a missing `retiredSigners`.
     - `trusts_test_keysets_only_with_the_feed_base_override`:
       - `select_keysets(release, None, Some(test))` returns the release keysets.
       - `select_keysets(release, Some("http://127.0.0.1:9"), Some(test))` returns the test keysets.
       - `select_keysets(release, Some("http://127.0.0.1:9"), None)` returns an empty `Vec`.
       - Use `fixture-keys.json` as `release` and a one-keyset JSON as `test`.
     - `passes_the_wycheproof_ml_dsa_65_verify_vectors_without_a_context`:
       1. Read the ML-DSA Wycheproof file through `CARGO_MANIFEST_DIR`.
       2. For every group, build the key as `ML_DSA_65_SPKI_PREFIX ++ hex(publicKey)`. When `publicKey` is 3,904 hex characters, assert that equals `hex(publicKeyDer)`.
       3. For each test whose `ctx` is absent or empty, run `UnparsedPublicKey::new(&ML_DSA_65, &key).verify(msg, sig)`. `Ok` must match `result == "valid"`, and anything else must be `invalid`.
       4. Count the executed tests and `assert_eq!(executed, 203)`.
     - `passes_the_wycheproof_ed25519_vectors`: the same with `ED25519_SPKI_PREFIX ++ hex(publicKey.pk)` and every test, ending with `assert_eq!(executed, 151)`.
  2. Run RED.
  3. Implement the items above:
     - `verify_pair` checks the lengths first and returns `Malformed`.
     - `parse_keysets` validates both lists, checking id, base64, length, prefix, non-empty `keysets`, and unique ids across both lists. It returns `keysets` only.
     - `select_keysets` follows the Design.
  4. Run GREEN.
- **Success criteria:** every `updater::signature` test passes.
- **Verify** (`export PATH="$HOME/.cargo/bin:$PATH"; cargo test --manifest-path src-tauri/Cargo.toml --all-features --lib updater::signature > /tmp/p5-sig.log 2>&1; echo "exit $?"; grep -c 'error\[E' /tmp/p5-sig.log; grep '^test result:' /tmp/p5-sig.log`):
  - `RED` (after step 1): prints `exit 101`, then a count of 1 or more, and no `test result:` line.
  - `GREEN`: prints `exit 0`, then `0`, then a line starting `test result: ok. 13 passed; 0 failed`.

### Task 5.5 — Version line, feed cap and verified parse (test first)

- **Goal:** `feed.rs` reads the feed as capped bytes, reads its version line without a YAML parser, and parses only verified bytes.
- **Target files and symbols:** in `src-tauri/src/updater/feed.rs`, add these items:
  - `pub(crate) const FEED_LIMIT: usize = 1024 * 1024;`
  - `pub(crate) async fn fetch_feed_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String>`
  - `pub(crate) fn version_line(bytes: &[u8]) -> Result<String, String>`
  - `pub(crate) fn parse_verified(bytes: &[u8], version: &str) -> Result<Feed, String>`

  Also change `const GITHUB_RELEASE_BASE` to `pub(crate) const GITHUB_RELEASE_BASE`.
- **Steps:**
  1. Add these tests to `feed.rs`'s test module:
     - `reads_the_version_line_of_the_published_feed`: `version_line(PUBLISHED.as_bytes())` is `0.9.15`. A copy with `\r\n` line ends, and the forms `version: '0.9.15'` and `version: "0.9.15"`, give the same.
     - `rejects_a_feed_without_a_top_level_version_line`: `version_line` errs for each of these:
       - only an indented `  version: 0.9.15`;
       - no version line;
       - `version: not-semver`;
       - the bytes `[0xff, 0xfe]`.
     - `parses_verified_bytes_only_when_the_version_line_matches`:
       - `parse_verified(PUBLISHED.as_bytes(), "0.9.15")` is `Ok`.
       - `parse_verified(PUBLISHED.as_bytes(), "0.9.16")` is `Err`.
  2. Run RED.
  3. Implement the three functions per the Design. `fetch_feed_bytes` reads with `response.chunk().await` until the total exceeds `FEED_LIMIT`, then errs. Keep `fetch_feed` for now; task 5.7 removes it.
  4. Run GREEN.
- **Success criteria:** the three tests pass, and the existing `feed.rs` tests still pass.
- **Verify** (`export PATH="$HOME/.cargo/bin:$PATH"; cargo test --manifest-path src-tauri/Cargo.toml --all-features --lib updater::feed > /tmp/p5-feed.log 2>&1; echo "exit $?"; grep -c 'error\[E' /tmp/p5-feed.log; grep '^test result:' /tmp/p5-feed.log`):
  - `RED`: prints `exit 101`, then a count of 1 or more, and no `test result:` line.
  - `GREEN`: prints `exit 0`, then `0`, then a line starting `test result: ok.` that contains `0 failed`.

### Task 5.6 — The not-verified message (RED from the mirror test)

- **Goal:** `MainTextKey::UpdatesNotVerified` exists in en and vi as a Rust-only key.
- **Target files and symbols:** `src-tauri/src/i18n.rs`, the `main_text!` table and `RUST_ONLY_KEYS`.
- **Steps:**
  1. Between the `UpdatesNoResult` and `UpdatesOpenInstallerFailed` rows, add this row exactly:
     ```rust
     UpdatesNotVerified => "updates.notVerified", "This update could not be verified, so Sai ATLAS did not offer it. Someone other than the Sai ATLAS team may have changed it. Do not install it by hand unless it passes the check in README → Verify a download.", "Không xác minh được bản cập nhật này nên Sai ATLAS không đề xuất cài đặt. Có thể ai đó ngoài nhóm Sai ATLAS đã thay đổi nó. Đừng tự cài đặt trừ khi nó vượt qua bước kiểm tra trong README → Xác minh tệp tải về.";
     ```
  2. Run RED.
  3. Change `RUST_ONLY_KEYS` to `&[MainTextKey::MenuCheckForUpdates, MainTextKey::UpdatesNotVerified]`. `src/main/i18n.ts` stays unchanged.
  4. Run GREEN.
- **Success criteria:** the mirror test passes with the new Rust-only key.
- **Verify** (`export PATH="$HOME/.cargo/bin:$PATH"; cargo test --manifest-path src-tauri/Cargo.toml --all-features --lib mirrors_every_text_key_in_the_typescript_table > /tmp/p5-i18n.log 2>&1; echo "exit $?"; grep -c -F 'left == right' /tmp/p5-i18n.log; grep '^test result:' /tmp/p5-i18n.log`):
  - `RED` (after step 1): prints `exit 101`, then a count of 1 or more, then a line starting `test result: FAILED. 0 passed; 1 failed`. The test's first assertion compares the key counts, so the failure shows `left == right`, not the key's name.
  - `GREEN`: prints `exit 0`, then `0`, then a line starting `test result: ok. 1 passed; 0 failed`.

### Task 5.7 — Wire verification into the updater, with signed test servers (test first)

- **Goal:** `run_check` follows the Design. Every existing flow test passes against signed feeds, and the new flow tests prove fail-closed behaviour.
- **Target files and symbols:**
  - In `signature.rs`, add `pub(crate) enum VerifyError { Rejected(Rejection), Transport(String) }` and `pub(crate) async fn fetch_and_verify(client: &reqwest::Client, base: &str, version: &str, feed_file: &str, bytes: &[u8], keysets: &[Keyset]) -> Result<String, VerifyError>`, which returns the winning id.
  - In `mod.rs`: add `Config.keysets: Vec<signature::Keyset>`; set `keysets: Vec::new()` in `Config::detect()`, which task 5.11 replaces; add the field to both test literals; change `run_check`; and change the test module: a static test signer, `ReleaseServer::publish_signed`, the redirect mode and the new tests.
  - In `feed.rs`, delete `fetch_feed`.
- **Steps:**
  1. In `mod.rs`'s test module, add the test infrastructure:
     1. A `struct TestSigner { keyset: signature::Keyset, ml_dsa: aws_lc_rs::signature::PqdsaKeyPair, ed25519: aws_lc_rs::signature::Ed25519KeyPair }` in a `static SIGNER: std::sync::LazyLock<TestSigner>`.
     2. Generate it with `PqdsaKeyPair::generate(&ML_DSA_65_SIGNING)` and `Ed25519KeyPair::generate()`. Its keyset id is `test-a`, and its SPKI DER comes from `public_key().as_der()`. Use `expect` with reasons; tests may.
     3. `ReleaseServer::publish_signed(&self, feed: String)` stores the feed in `self.feed`. It also stores the assets `latest-linux.yml.test-a.mldsa65.sig` and `latest-linux.yml.test-a.ed25519.sig`, signed over the feed bytes, in `self.assets`. Use these call shapes (aws-lc-rs 1.18):
        - ML-DSA: `let mut sig = vec![0u8; signature::ML_DSA_65_SIGNATURE_LEN]; let n = SIGNER.ml_dsa.sign(feed.as_bytes(), &mut sig).expect("ml-dsa sign"); sig.truncate(n);`
        - Ed25519: `SIGNER.ed25519.sign(feed.as_bytes()).as_ref().to_vec()`
        - SPKI DER, for the keyset: `public_key().as_der().expect("der").as_ref().to_vec()` on each key pair, with `use aws_lc_rs::encoding::AsDer;` and `use aws_lc_rs::signature::KeyPair;`.
     4. A `redirect: Mutex<bool>` field on `ReleaseServer`, `false` by default. When it is `true`, `answer` replies `302` with `Location: /asset-host<path>` to every request whose path contains `/download/` and does not start with `/asset-host/`. Paths under `/asset-host/` are then answered as before, matched by the same suffix and last-segment rules.
     5. `Setup` and both `Config` test literals get `keysets: vec![SIGNER.keyset.clone()]`. `Keyset` derives `Clone`.
     6. Replace each of the twelve `*server.feed.lock().unwrap() = Some(` with `server.publish_signed(`.
  2. Add the new tests:
     - `check_reads_the_signatures_from_the_release_the_feed_names`: a manual check of a signed `0.9.16` feed is offered. The server's request paths include `/releases/download/v0.9.16/latest-linux.yml.test-a.mldsa65.sig` and `….ed25519.sig`.
     - `check_never_offers_a_newer_release_without_signatures`:
       1. Use version `0.9.90`, served unsigned through `*server.feed.lock().unwrap() = Some(…)` directly.
       2. A manual check returns `UpdateStatus::Error` whose `message` is the en `updates.notVerified` text and whose `show_in_banner` is not `Some(false)`.
       3. A periodic check gives `show_in_banner: Some(false)`.
       4. A startup check leaves the status idle.
       5. No download starts.
       6. The runtime log contains `latest-linux.yml 0.9.90 was not verified: missing`.
     - `check_never_offers_a_newer_release_with_a_bad_signature`: version `0.9.91`. Sign the feed with `publish_signed`, then serve a copy whose last byte is changed (the `version:` line stays intact) through `*server.feed.lock().unwrap() = Some(…)`. The manual check gives the not-verified error, and the log contains `0.9.91 was not verified: bad signature`.
     - `check_requests_no_signature_when_the_feed_is_not_newer`: a feed at the running version gives `NotAvailable` after exactly one request.
     - `check_tries_the_next_keyset_when_the_first_has_no_signatures`:
       1. Build a `Config` with `keysets: [other, SIGNER]`, where `other` is a second generated keyset `test-b`.
       2. The feed is signed only by `test-a` and is offered.
       3. The request paths include both of `test-b`'s signature names, which got 404s, before `test-a`'s.
     - `check_follows_the_asset_redirect`: with `redirect` on, a signed newer feed is offered, and the download passes its SHA-512 check. Reuse the steps of the existing download test.
     - `check_refuses_an_oversized_feed`: a feed of `FEED_LIMIT + 1` bytes gives an error message containing `larger than 1 MiB`.
     - `download_takes_the_hash_from_the_verified_feed`: after a signed check and a download, the active asset's SHA-512 equals the one in the signed feed.
  3. Run RED.
  4. Implement:
     1. `fetch_and_verify` per the Design. Read each signature body with a 4 KiB cap; a longer body is `Malformed`. Treat 404 as absent and anything else non-2xx as `Transport`. Build URLs with `feed::download_url`.
     2. Rewrite `run_check` per the Design, mapping `VerifyError::Transport(m)` to `Err(m)` and `Rejected(r)` to the log note plus `Err(self.text(MainTextKey::UpdatesNotVerified))`.
     3. Delete `feed::fetch_feed`.
  5. Run GREEN.
- **Success criteria:** every updater test passes: the existing ones unchanged in what they assert, and the eight new ones.
- **Verify** (`export PATH="$HOME/.cargo/bin:$PATH"; cargo test --manifest-path src-tauri/Cargo.toml --all-features --lib updater:: > /tmp/p5-updater.log 2>&1; echo "exit $?"; grep -c 'error\[E' /tmp/p5-updater.log; grep '^test result:' /tmp/p5-updater.log`):
  - `RED` (after step 2): prints `exit 101`, then a count of 1 or more, and no `test result:` line. The fields and functions do not exist yet.
  - `GREEN`: prints `exit 0`, then `0`, then a line starting `test result: ok.` that contains `0 failed`.
  - `grep -c 'fn fetch_feed(' src-tauri/src/updater/feed.rs` prints `0`.

### Task 5.8 — Build script warning and the tightened smoke check (no unit test; grep checks)

- **Goal:** a build that reads a test feed says so, and the deb smoke accepts only a real answer from GitHub.
- **Target files and symbols:** `scripts/tauri-linux-build.sh` (`:10` header comment, `:31` env passing); `e2e-tauri/packaged-smoke.e2e.ts`, the test `checks for updates against latest-linux.yml` (`:351-358`).
- **Steps:**
  1. In `tauri-linux-build.sh`:
     1. Replace header line 10, `# CARGO_BUILD_JOBS (default 8) and SAI_ATLAS_UPDATE_BASE, when set, are passed in.`, with these two lines:
        ```bash
        # CARGO_BUILD_JOBS (default 8), SAI_ATLAS_UPDATE_BASE and SAI_ATLAS_UPDATE_KEYS, when set, are passed in;
        # a bundle built with either test-feed variable must never be released, and the script warns.
        ```
     2. Replace line 31 with:
        ```bash
        for name in SAI_ATLAS_UPDATE_BASE SAI_ATLAS_UPDATE_KEYS; do
        	if [[ -n ${!name-} ]]; then
        		env_args+=(-e "$name")
        		echo "warning: passing $name into the build; this bundle reads a test feed and must never be released" >&2
        	fi
        done
        ```
  2. In `packaged-smoke.e2e.ts`, replace the regex with `/could not be fetched \(404\)|"state":"(not-available|available)"/`. Replace the two comment lines with: `// A 404 from GitHub (no release published yet) or a version verdict proves DNS, TLS and HTTP to the production feed all worked; any other error, such as a TLS failure or a test feed base, fails.`
- **Success criteria:** both files carry the change and parse.
- **Verify:**
  - `bash -n scripts/tauri-linux-build.sh; echo "exit $?"` prints `exit 0`.
  - `grep -c 'SAI_ATLAS_UPDATE_KEYS' scripts/tauri-linux-build.sh` prints `2`.
  - `grep -cF 'could not be fetched \(404\)' e2e-tauri/packaged-smoke.e2e.ts` prints `1`.
  - `bunx vitest run scripts/tauri-packaging-config.test.ts 2>&1 | tail -4; echo "exit ${PIPESTATUS[0]}"` prints `exit 0`.

### Task 5.9 — Interim gate (no clippy yet)

- **Goal:** everything but clippy passes before the release keys are embedded. Clippy runs in task 5.12: until task 5.11 wires `select_keysets` into `Config::detect()`, two functions are used only by tests, and clippy's `dead_code` warning is expected.
- **Target files and symbols:** none; this task edits nothing.
- **Steps:** run:
  ```bash
  export PATH="$HOME/.cargo/bin:$PATH"
  cargo test --manifest-path src-tauri/Cargo.toml --all-features >/tmp/p5-test.log 2>&1; echo "test exit $?"
  grep '^test result:' /tmp/p5-test.log | head -1
  bun scripts/check-test-parity.ts updater; echo "parity exit $?"
  bash scripts/check-module.sh snapshots >/tmp/p5-snap.log 2>&1; echo "snapshots exit $?"
  bun run check:types >/tmp/p5-types.log 2>&1; echo "types exit $?"
  bunx biome check e2e-tauri/packaged-smoke.e2e.ts; echo "biome exit $?"
  git diff --quiet -- src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/contracts src/main; echo "frozen exit $?"
  test ! -e src-tauri/src/updater/release-keys.json || echo "release keys present"
  ```
- **Success criteria:** every check below holds.
- **Verify:**
  - The script prints `test exit 0`, `parity exit 0`, `snapshots exit 0`, `types exit 0`, `biome exit 0` and `frozen exit 0`.
  - The first `test result:` line shows BASELINE_LIB + 24 passed: 13 signature tests, 3 feed tests and 8 flow tests.

### Task 5.10 — kongming review (compensates for a Sonnet executor on a security-critical phase)

- **Goal:** an independent review of the fail-closed path before the release keys are embedded.
- **Target files and symbols:** none; this task edits nothing unless kongming names a fix inside this phase's files.
- **Steps:**
  1. Spawn the `kongming` subagent. Pass it:
     - this file's path;
     - `git diff` and the full text of `signature.rs`;
     - the outputs of task 5.9;
     - these questions:
       1. Can any path offer a newer release, or parse unverified bytes with `serde_yml`, without both signatures of one trusted keyset?
       2. Can a 404, a redirect, a timeout or an oversized body turn into a pass?
       3. Can a `retiredSigners` keyset ever be trusted?
       4. Does any test's expectation encode wrong behaviour?
       5. Does any file outside "Files this phase owns" change?

     Ask it to end its reply with exactly one line, `REVIEW: PASS` or `REVIEW: BLOCK <numbered list>`.
  2. On `REVIEW: BLOCK`, apply only fixes inside this phase's files, re-run task 5.9, and spawn kongming again with the new diff.
- **Success criteria:** kongming's last line is `REVIEW: PASS`.
- **Verify:** the last line of kongming's reply equals `REVIEW: PASS`.

### Task 5.11 — Embed the release keys (needs phase 2)

- **Goal:** production builds trust the committed release keysets, two tests guard the file, and two ignored tests can check real releases.
- **Target files and symbols:**
  - In `signature.rs`, add these items:
    - `const RELEASE_KEYS: &str = include_str!("release-keys.json");`
    - `#[cfg(test)] pub(crate) fn release_keysets() -> Vec<Keyset>`, which is `parse_keysets(RELEASE_KEYS)` and panics with the error (tests may). Only tests call it, so without `#[cfg(test)]` clippy fails on dead code in task 5.12;
    - `pub(crate) fn trusted_keysets() -> Vec<Keyset>`, which is `select_keysets(RELEASE_KEYS, option_env!("SAI_ATLAS_UPDATE_BASE"), option_env!("SAI_ATLAS_UPDATE_KEYS"))`, logging and returning empty on `Err`;
    - tests `loads_the_release_keysets` and `release_keysets_exclude_the_fixture_keys`;
    - the ignored tests `verifies_a_downloaded_release_with_the_release_keys` and `verifies_a_published_release`.
  - In `mod.rs`, `Config::detect()` uses `keysets: signature::trusted_keysets()`.
- **Steps:**
  1. Run `test -f src-tauri/src/updater/release-keys.json; echo "exit $?"`. If it prints `exit 1`, print exactly `STOP_FOR_MAINTAINER: phase 5 task 5.11 needs the maintainer to finish phase 2 (commit src-tauri/src/updater/release-keys.json); an agent must not perform it.` and end the phase with `Status: BLOCKED`. Do not create the file or anything in its place.
  2. Add the tests:
     - `loads_the_release_keysets`: `parse_keysets(RELEASE_KEYS)` returns at least two keysets with unique ids.
     - `release_keysets_exclude_the_fixture_keys`: no release keyset's id or key equals a keyset in `fixture-keys.json`.
     - `verifies_a_downloaded_release_with_the_release_keys`:
       - It is marked `#[ignore = "needs SAI_ATLAS_SIGNED_RELEASE_DIR"]`.
       - It reads the directory from `std::env::var("SAI_ATLAS_SIGNED_RELEASE_DIR")`, and panics with `SAI_ATLAS_SIGNED_RELEASE_DIR is not set` when it is unset.
       - It reads `latest-linux.yml` and runs `feed::version_line`.
       - For `release_keysets()` in order, it reads the two signature files named by `signature_name` and takes the first keyset whose `verify_pair` passes.
       - It runs `feed::parse_verified` and asserts both succeed.
     - `verifies_a_published_release`:
       - It is marked `#[ignore = "network; needs SAI_ATLAS_PUBLISHED_VERSION"]` and runs on `#[tokio::test]`.
       - It reads the version from `SAI_ATLAS_PUBLISHED_VERSION`, and panics with `SAI_ATLAS_PUBLISHED_VERSION is not set` when it is unset.
       - It builds a client with `crate::http_client::build(crate::http_client::client_builder().connect_timeout(std::time::Duration::from_secs(20)))`.
       - It fetches `feed::download_url(feed::GITHUB_RELEASE_BASE, &version, feed::FEED_FILE)` with `feed::fetch_feed_bytes`.
       - It asserts the following:
         - `version_line` equals the version;
         - `fetch_and_verify(&client, feed::GITHUB_RELEASE_BASE, &version, feed::FEED_FILE, &bytes, &release_keysets())` is `Ok`;
         - `parse_verified` is `Ok`.
  3. Run RED.
  4. Implement the items above, and set `keysets: signature::trusted_keysets()` in `Config::detect()`.
  5. Run GREEN.
  6. If `test -d "$HOME/sai-atlas-signing-check"` succeeds (phase 2 kept the signed dry-run draft there), run the directory test on it:
     ```bash
     export PATH="$HOME/.cargo/bin:$PATH"; SAI_ATLAS_SIGNED_RELEASE_DIR="$HOME/sai-atlas-signing-check" cargo test --manifest-path src-tauri/Cargo.toml --all-features --lib verifies_a_downloaded_release_with_the_release_keys -- --ignored > /tmp/p5-dir.log 2>&1; echo "exit $?"; grep '^test result:' /tmp/p5-dir.log
     ```
     Otherwise, write `directory test: not run (no signed dry-run copy)` in the report.
- **Success criteria:** the two key-file tests pass, and both ignored tests compile. The directory test passes on the dry-run copy when it exists.
- **Verify:**
  - `RED` (after step 2): `export PATH="$HOME/.cargo/bin:$PATH"; cargo test --manifest-path src-tauri/Cargo.toml --all-features --lib updater::signature > /tmp/p5-sig.log 2>&1; echo "exit $?"; grep -c 'error\[E' /tmp/p5-sig.log; grep '^test result:' /tmp/p5-sig.log` prints `exit 101`, then a count of 1 or more, and no `test result:` line.
  - `GREEN`: the same command prints `exit 0`, then `0`, then a line starting `test result: ok. 15 passed; 0 failed; 2 ignored`.
  - The unset-variable check:
    ```bash
    export PATH="$HOME/.cargo/bin:$PATH"; env -u SAI_ATLAS_PUBLISHED_VERSION cargo test --manifest-path src-tauri/Cargo.toml --all-features --lib verifies_a_published_release -- --ignored > /tmp/p5-live.log 2>&1; echo "exit $?"; grep -c 'SAI_ATLAS_PUBLISHED_VERSION is not set' /tmp/p5-live.log
    ```
    Pass: prints `exit 101`, then a count of 1 or more.
  - Step 6, when run, prints `exit 0` and a line starting `test result: ok. 1 passed; 0 failed`.

### Task 5.12 — Final gate

- **Goal:** every gate passes with the release keys embedded.
- **Target files and symbols:** none; this task edits nothing.
- **Steps:** run:
  ```bash
  export PATH="$HOME/.cargo/bin:$PATH"
  cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings >/tmp/p5-clippy.log 2>&1; echo "clippy exit $?"
  cargo test --manifest-path src-tauri/Cargo.toml --all-features >/tmp/p5-test2.log 2>&1; echo "test exit $?"
  bun scripts/check-test-parity.ts updater; echo "parity exit $?"
  bash scripts/check-module.sh snapshots >/tmp/p5-snap2.log 2>&1; echo "snapshots exit $?"
  git diff --quiet -- src-tauri/contracts src-tauri/Cargo.toml src-tauri/Cargo.lock; echo "frozen exit $?"
  git status --porcelain -- src-tauri/src/updater/release-keys.json
  ```
- **Success criteria:** every check below holds.
- **Verify:**
  - The script prints `clippy exit 0`, `test exit 0`, `parity exit 0`, `snapshots exit 0` and `frozen exit 0`.
  - The last command prints nothing: the key file is committed and unchanged.

### Task 5.13 — Package and deb smoke, with a test-feed control

- **Goal:** the packages build. The deb smoke passes with the tightened check, and a deb built for an unreachable test feed fails that check.
- **Target files and symbols:** none; build outputs go under `src-tauri/target-linux-2404/` (gitignored).
- **Steps:**
  1. Control first (same target directory, so the release build that follows replaces it), in the background:
     ```bash
     SAI_ATLAS_UPDATE_BASE=http://127.0.0.1:9/releases bash -c 'bun run package:linux > /tmp/p5-package-control.log 2>&1; echo "package exit $?" >> /tmp/p5-package-control.log'
     ```
  2. When it finishes:
     ```bash
     tail -2 /tmp/p5-package-control.log; grep -c 'warning: passing SAI_ATLAS_UPDATE_BASE' /tmp/p5-package-control.log
     DEB=$(ls src-tauri/target-linux-2404/x86_64-unknown-linux-gnu/release/bundle/deb/*.deb)
     bash scripts/tauri-deb-smoke.sh "$DEB" --mochaOpts.grep "checks for updates against latest-linux.yml" > /tmp/p5-smoke-control.log 2>&1; echo "control smoke exit $?"
     ```
  3. The release build, in the background:
     ```bash
     env -u SAI_ATLAS_UPDATE_BASE -u SAI_ATLAS_UPDATE_KEYS bash -c 'start=$(date +%s); bun run package:linux > /tmp/p5-package.log 2>&1; code=$?; echo "package exit $code, $(( $(date +%s) - start ))s" >> /tmp/p5-package.log'
     ```
  4. When it finishes:
     ```bash
     tail -2 /tmp/p5-package.log
     DEB=$(ls src-tauri/target-linux-2404/x86_64-unknown-linux-gnu/release/bundle/deb/*.deb); stat -c '%s bytes' "$DEB"
     bash scripts/tauri-deb-smoke.sh "$DEB" > /tmp/p5-smoke.log 2>&1; echo "smoke exit $?"
     ```
- **Success criteria:** the control fails exactly at the update check, and the release build passes the whole smoke.
- **Verify:**
  - The control log ends with `package exit 0`, and the `grep -c` prints `1`.
  - The script prints `control smoke exit` followed by a non-zero number. `/tmp/p5-smoke-control.log` names `checks for updates against latest-linux.yml` as failed.
  - `/tmp/p5-package.log` ends with `package exit 0`.
  - The script prints `smoke exit 0`.
  - If no release is published, `/tmp/p5-smoke.log` shows the update check passed; that is the `could not be fetched (404)` case.
  - If a build fails for a missing package (for example `cmake`), that is a Verify failure: do not edit the Dockerfile.

### Task 5.14 — Report

- **Goal:** the orchestrator gets the result.
- **Target files and symbols:** none.
- **Steps:**
  1. Print the outputs of tasks 5.9, 5.11, 5.12 and 5.13, the `.deb` size and build time, the directory-test line from 5.11, and the list of changed files.
  2. Print this status block:
     ```text
     Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
     Summary: one or two sentences
     Concerns/Blockers: optional
     ```
  3. When the phase stopped at task 5.11, say so in the Summary. The orchestrator resumes at task 5.11 after phase 2.
- **Success criteria:** the status block is printed.
- **Verify:** no verification needed.

## Risks

| Risk | Likelihood × impact | Mitigation |
|---|---|---|
| aws-lc-rs and OpenSSL disagree on the ML-DSA encoding | Low × High | The gate is task 5.3. The fallback (RustCrypto `ml-dsa`) is a kongming and user decision, never the executor's. |
| `aws-lc-sys` build needs | Low × Medium | Phase 3 already built it in the image. Task 5.13 shows it again. |
| Feed-format drift breaks the version line | Low × High | Pinned on both sides: phase 1's `release-feeds.test.ts`, the `feed.rs` test, and `sign-release.ts --verify`. |
| Smoke-testing an older package against a newer unsigned feed reports "not verified", which the regex does not accept | Low × Low | It happens only when testing an old package. Do not widen the regex for it. |
| A release is built in a shell set up for a local feed | Low × High | `release-feeds.ts` refuses to run, `tauri-linux-build.sh` warns, and the tightened smoke fails (task 5.13's control). |
| Wycheproof files (about 1.8 MB) in the repository | Accepted | They are read at test time through `CARGO_MANIFEST_DIR`. |
| AGENTS.md does not yet describe `SAI_ATLAS_UPDATE_KEYS` | Low × Low | Phase 6 adds the Updates bullet. Until then, the PR description carries the local-feed recipe: a throwaway keyset in the `release-keys.json` format, signed with `sign-release.ts --trusted`. |

## Rollback

Revert the commits and release. Once a verifying release exists, every later release must stay signed until verifying installs have taken a release without the verifier. That revert release must itself be signed.

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
