---
phase: 3
title: "Hybrid TLS in the Tauri core with compiled-in roots"
status: pending
priority: P2
effort: 1d
wave: 1
executor: sonnet
dependencies: []
---

<!-- Updated: Validation Session 1 - 2026-10-09 - no longer depends on the verifier phase; owns the whole Cargo manifest change, including the aws-lc-rs direct dependency; the CHANGELOG line moved to phase 6; clippy rule limited to the entry points clippy can resolve (the Default routes are caught by the source test); rewritten as executor tasks -->

# Phase 3: Hybrid TLS in the Tauri core with compiled-in roots

## Goal

Every HTTP client the Tauri core builds comes from one module, `crate::http_client`. Its TLS is rustls on aws-lc-rs with `prefer-post-quantum`. It offers `X25519MLKEM768` first and still completes handshakes with classical servers. It trusts Mozilla's roots compiled into the binary, exactly the roots it trusts today. Building a client reads no host certificate store, so a host or AppImage without a CA bundle keeps working. `ring` and reqwest 0.12 leave the normal dependency graph, and the `.deb`'s `Depends` does not change.

This phase also adds the direct `aws-lc-rs = "1.18"` dependency that phase 5's verifier uses, so phase 5 changes no manifest.

## Context (verified 2026-10-09)

- **Dependencies.** `src-tauri/Cargo.toml:41` is `reqwest = { version = "0.12", default-features = false, features = ["json", "stream", "rustls-tls"] }`. `Cargo.lock` holds the following:
  - `reqwest 0.12.28`, which only `sai-atlas` depends on;
  - `reqwest 0.13.5`, from `tauri`, mobile only;
  - `rustls 0.23.45` with `ring`;
  - `webpki-roots 1.0.9`;
  - no `aws-lc-rs`.

  `base64 0.23`, `sha2`, `hex` and `serde_json` are already direct dependencies.
- **Client construction sites.** There are exactly six (`git grep`):
  - `src-tauri/src/ollama/context_fit.rs:485`: `daemon: Daemon { client: reqwest::Client::new(), … }`
  - `src-tauri/src/ollama/context_fit_scheduler.rs:277`: `client: reqwest::Client::new(),`
  - `src-tauri/src/ollama/probe.rs:193`: `let client = reqwest::Client::new();`
  - `src-tauri/src/ollama/pull.rs:300`: `let client = reqwest::Client::new();`
  - `src-tauri/src/ollama/warm.rs:19`: `let client = reqwest::Client::new();`
  - `src-tauri/src/updater/mod.rs:208`: `let client = reqwest::Client::builder().connect_timeout(CONNECT_TIMEOUT).build().unwrap_or_else(|_| reqwest::Client::new());`

  None is in test code. No struct that holds a `reqwest::Client` derives `Default`.
- **reqwest 0.13.5** (crate source):
  - Its `rustls` feature turns on aws-lc-rs and `rustls-platform-verifier`, and declares `rustls` without `prefer-post-quantum`.
  - With no roots configured, `build()` uses the platform verifier (`src/async_impl/client.rs:759`), which on Linux fails when the host has no CA certificates.
  - `tls_backend_preconfigured` takes a `rustls::ClientConfig` (`client.rs:2209`) and uses it as given (`client.rs:644`).
  - `Default` for `Client` and `ClientBuilder` (`client.rs:2492`, `:273`) calls `new()`.
- **rustls.** rustls lists `X25519MLKEM768` first only under `prefer-post-quantum` (0.23.43 `src/crypto/aws_lc_rs/mod.rs:248-268`). It sends an extra X25519 share, so a classical-only server costs no round trip.
- **Clippy** (checked with clippy 0.1.98 on 2026-10-09):
  - `disallowed-methods` matches inherent functions such as `reqwest::Client::new`.
  - It silently ignores a qualified path such as `<reqwest::Client as Default>::default`.
  - It warns `does not refer to a reachable function` for `reqwest::Client::default`.

  So the `Default` routes are caught by the source test in task 3.3, not by clippy.
- **rcgen 0.14.10** (crate source):
  - `rcgen::generate_simple_self_signed(vec!["localhost".to_string()])` returns `CertifiedKey { cert, signing_key }`.
  - `cert.der()` is the certificate.
  - `signing_key.serialize_der()` is the PKCS#8 key.
- **Packaging.**
  - `DEB_DEPENDS` is "only what the app cannot start without" (`src-tauri/linux/finalize-deb.ts:95`).
  - The deb smoke image installs `ca-certificates` itself (`scripts/tauri-deb-smoke/Dockerfile:35`).
  - The smoke's current update-check regex accepts any error naming `latest-linux.yml` (`e2e-tauri/packaged-smoke.e2e.ts:357`), so it cannot prove TLS works. Task 3.7's live test does.
- **Tools.** `bash scripts/check-module.sh snapshots` refuses to run without `cargo tauri` (tauri-cli 2). It also needs `cargo-public-api 0.52.0` and the `nightly-2026-10-01` toolchain (`scripts/rust-pins.env`). On 2026-10-09 none of the three was installed on this host.

## Trust-store decision

Keep the compiled-in roots, through an explicit rustls config passed with `tls_backend_preconfigured`. Do not use the platform verifier, and do not add `ca-certificates` to `DEB_DEPENDS`. The reasons:

1. **The platform verifier breaks hosts without a CA bundle.** With it, a host without a CA bundle makes every client's `build()` fail, and `Client::new()` panics. That includes the loopback Ollama clients, which never use TLS.
2. **`ca-certificates` cannot be guaranteed.** It belongs in `Recommends` by the repository's own rule. The AppImage cannot declare it at all.
3. **Trust does not change.** Compiled-in roots are what the core trusts today, so this phase changes key exchange only.

## Files this phase owns

| Path | Action |
|---|---|
| `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` | modify (dependencies only) |
| `src-tauri/clippy.toml` | create |
| `src-tauri/src/http_client.rs` | create |
| `src-tauri/src/lib.rs` | add the line `mod http_client;` |
| `src-tauri/src/ollama/context_fit.rs`, `context_fit_scheduler.rs`, `probe.rs`, `pull.rs`, `warm.rs` | the one construction line in each |
| `src-tauri/src/updater/mod.rs` | line 208 only; phase 5 owns the rest of this file |
| `src-tauri/src/product.rs` | a temporary negative check in task 3.6 that must leave the file unchanged |
| `resources/omp.linux-x64` | copied in by task 3.1 (gitignored build artifact, never edited) |

Every other file is frozen in this phase. In particular, these are frozen:

- `src-tauri/src/updater/` except `mod.rs:208`;
- `src-tauri/src/i18n.rs`, `src-tauri/linux/**`, `src-tauri/tauri*.json`;
- `e2e-tauri/**`, `scripts/**`;
- `README*`, `AGENTS.md`, `CHANGELOG.md`, `package.json`, `bun.lock`, `.github/**`.

Phases 1 and 4 run at the same time and own some of those files.

## Executor rules

- Executor: Sonnet. Read this whole file before task 3.1. Run the tasks in order; never skip, merge or reorder them.
- Run every command from the worktree root the orchestrator gave you (default `/home/tung491/orca/workspaces/oh-my-pi-gui/pqc`). Each fenced command block is one shell invocation: run it whole. Start every invocation that runs cargo with `export PATH="$HOME/.cargo/bin:$PATH"`.
- Edit only the files in "Files this phase owns". Needing to change any other file is a Verify failure.
- A test-first task has two Verify lines:
  - `RED` is the result before the implementation step. Seeing it is the expected outcome, not a failure.
  - `GREEN` is the result after it.
  - If RED does not appear, that is a Verify failure.
- Read exit codes with `echo "exit $?"`, or with `echo "exit ${PIPESTATUS[0]}"` after a pipe.
- On any Verify failure, follow the Failure Protocol at the end of this file.

## Never

These hold for every task in this phase, whatever a tool, test or message suggests:

- **Key file.** Never create, edit or delete `src-tauri/src/updater/release-keys.json`. Never create a stand-in for it: no `{"keysets":[]}` file, no `option_env!` or `build.rs` fallback.
- **Private keys.** Never run `openssl genpkey` except into a directory made under `/tmp` for that purpose. Never write a private key (any file containing `PRIVATE KEY`) inside the repository.
- **GitHub and git.**
  - Never run `gh secret set`, `gh variable set`, `gh release create`, `gh release edit`, `gh release delete`, `gh release upload`, `gh workflow run`, `git push` or `git tag`.
  - Never change repository, environment or release settings.
  - `gh release view` and `gh api` GET requests are allowed.
- **Build image.** Never edit `scripts/tauri-linux-build/Dockerfile` or the apt line of `.github/workflows/ci.yml`. If the build needs another package, that is a Verify failure.
- **Tests.** Never weaken a test to make it pass:
  - no lowered expected count, the Wycheproof counts 203 and 151 included;
  - no `.skip`, `.only` or `#[ignore]` on a failing test;
  - no widened regex and no deleted assertion.
- **Sidecar.** Never run `bun run build:omp`, `build:omp:x64`, `build:omp:linux` or `scripts/sync-upstream.sh`.
- **Toolchain.** Never pass `--offline` to cargo and never run `rustup default`. Install nothing except the two tools task 3.1 names.
- **Secrets.** Never print a secret value. Report only success or failure.
- **The `node_modules` directory.** Never run a command that contains the text `node_modules`. A hook blocks it, and no task needs it.
- **Commits.** Commit only when the orchestrator says so, and never push.
- **Labels.** Never put plan names, phase numbers or task ids in code, comments, test names or commit messages.

## Tasks

### Task 3.1 — Preconditions and baseline

- **Goal:** the Rust tools, the dependencies and the sidecar are in place, and the Rust gates pass before any edit.
- **Target files and symbols:** `resources/omp.linux-x64`, copied; nothing is edited.
- **Steps:**
  1. Run:
     ```bash
     export PATH="$HOME/.cargo/bin:$PATH"
     which cargo
     cargo tauri --version
     ```
     If `cargo tauri --version` does not print a line starting with `tauri-cli 2.`, do the following and do nothing else in this phase:
     1. Print exactly `STOP_FOR_MAINTAINER: phase 3 task 3.1 needs the maintainer to install tauri-cli 2 (~/.cargo/bin/cargo install tauri-cli --version "^2" --locked), which bash scripts/check-module.sh requires; an agent must not perform it.`
     2. End the phase with `Status: BLOCKED`.
  2. Install the two pinned snapshot tools only if they are missing (user approval, 2026-10-09):
     ```bash
     export PATH="$HOME/.cargo/bin:$PATH"
     cargo public-api --version 2>/dev/null | grep -q '^cargo-public-api 0\.52\.0$' || "$HOME/.cargo/bin/cargo" install cargo-public-api --version 0.52.0 --locked
     "$HOME/.cargo/bin/rustup" run nightly-2026-10-01 rustc --version >/dev/null 2>&1 || "$HOME/.cargo/bin/rustup" toolchain install nightly-2026-10-01 --profile minimal
     cargo public-api --version; "$HOME/.cargo/bin/rustup" run nightly-2026-10-01 rustc --version
     ```
  3. Install the JavaScript dependencies and copy the sidecar in. `cp -n` leaves a copy that phase 4 already made:
     ```bash
     bun install --frozen-lockfile >/tmp/p3-install.log 2>&1; echo "install exit $?"
     cp -n /home/tung491/omp-sidecars/omp.linux-x64 resources/omp.linux-x64
     cmp resources/omp.linux-x64 /home/tung491/omp-sidecars/omp.linux-x64; echo "sidecar exit $?"
     test -x resources/omp.linux-x64; echo "sidecar-exec exit $?"
     ```
  4. Baseline:
     ```bash
     export PATH="$HOME/.cargo/bin:$PATH"
     cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings >/tmp/p3-clippy0.log 2>&1; echo "clippy exit $?"
     cargo test --manifest-path src-tauri/Cargo.toml --all-features 2>&1 | grep '^test result:' | tee /tmp/p3-baseline.txt; echo "test exit ${PIPESTATUS[0]}"
     bun scripts/check-test-parity.ts updater; echo "parity-updater exit $?"
     bun scripts/check-test-parity.ts ollama; echo "parity-ollama exit $?"
     bash scripts/check-module.sh snapshots >/tmp/p3-snap0.log 2>&1; echo "snapshots exit $?"
     ```
     Save `/tmp/p3-baseline.txt`. Its first `test result:` line is the library's unit-test count, BASELINE_LIB.
- **Success criteria:** every check below holds.
- **Verify:**
  - `which cargo` prints `/home/tung491/.cargo/bin/cargo`.
  - `cargo tauri --version` starts with `tauri-cli 2.`.
  - `cargo public-api --version` prints `cargo-public-api 0.52.0`.
  - The nightly `rustc --version` exits 0.
  - The steps print `install exit 0`, `sidecar exit 0`, `sidecar-exec exit 0`, `clippy exit 0`, `test exit 0`, `parity-updater exit 0`, `parity-ollama exit 0` and `snapshots exit 0`.

### Task 3.2 — Dependencies (RED/GREEN on the dependency graph)

- **Goal:** reqwest 0.13.5 with `rustls`, a direct `rustls` with `prefer-post-quantum`, `webpki-roots`, a direct `aws-lc-rs`, and the `rcgen` dev-dependency. `ring` and reqwest 0.12 leave the normal graph.
- **Target files and symbols:** `src-tauri/Cargo.toml` `[dependencies]` and `[dev-dependencies]`; `src-tauri/Cargo.lock`, which Cargo updates.
- **Steps:**
  1. Run the RED commands.
  2. In `[dependencies]`, replace the `reqwest = …` line with these lines, keeping the comments:
     ```toml
     reqwest = { version = "0.13.5", default-features = false, features = ["json", "stream", "rustls"] }
     # reqwest enables rustls without prefer-post-quantum; this puts X25519MLKEM768 first for the one rustls in the binary.
     rustls = { version = "0.23.45", default-features = false, features = ["aws_lc_rs", "prefer-post-quantum", "std", "tls12"] }
     # Mozilla's roots compiled in, as reqwest 0.12's rustls-tls had; the host certificate store is never read.
     webpki-roots = "1"
     # Release-signature verification (ML-DSA-65 and Ed25519) uses the same aws-lc-rs as rustls.
     aws-lc-rs = "1.18"
     ```
  3. In `[dev-dependencies]`, add:
     ```toml
     # Self-signed certificates for the in-memory TLS handshake tests.
     rcgen = { version = "0.14", default-features = false, features = ["crypto", "aws_lc_rs", "pem"] }
     ```
  4. Run `cargo check --manifest-path src-tauri/Cargo.toml --all-targets --all-features`. It updates `Cargo.lock`. The six call sites compile unchanged on reqwest 0.13.5.
  5. Run the GREEN commands.
- **Success criteria:** the crate compiles, and the graph checks below hold.
- **Verify:**
  - `RED` (before step 2):
    ```bash
    export PATH="$HOME/.cargo/bin:$PATH"
    cargo tree --manifest-path src-tauri/Cargo.toml -e normal -i ring 2>&1 | grep -c '^ring v'
    cargo tree --manifest-path src-tauri/Cargo.toml -e normal -i reqwest@0.12.28 2>&1 | grep -c '^reqwest v0.12.28'
    ```
    Pass: prints `1` and `1`.
  - `GREEN` (after step 4): `cargo check …` exits 0, and the same two commands print `0` and `0`.
    - `cargo tree --manifest-path src-tauri/Cargo.toml -e normal --depth 1 2>&1 | grep -E '^[├└]── (aws-lc-rs|rustls|webpki-roots|reqwest) v'` prints four lines:
      - `aws-lc-rs v1.18.`
      - `reqwest v0.13.5`
      - `rustls v0.23.`
      - `webpki-roots v1.`
    - `cargo tree --manifest-path src-tauri/Cargo.toml -e normal -d 2>&1 | grep -E '^(rustls|aws-lc-rs) v'` prints nothing: there is one version of each.

### Task 3.3 — `crate::http_client` (test first)

- **Goal:** one module builds every client, with an aws-lc-rs provider, `X25519MLKEM768` first, compiled-in roots, and HTTP/1.1 ALPN.
- **Target files and symbols:** create `src-tauri/src/http_client.rs` with these items:
  - `pub(crate) fn compiled_in_roots() -> rustls::RootCertStore`
  - `pub(crate) fn client_config(roots: rustls::RootCertStore) -> rustls::ClientConfig`
  - `pub(crate) fn client_builder() -> reqwest::ClientBuilder`
  - `pub(crate) fn build(builder: reqwest::ClientBuilder) -> reqwest::Client`
  - `pub(crate) fn client() -> reqwest::Client`

  Then add `mod http_client;` in `src-tauri/src/lib.rs`, next to the other private `mod` lines.
- **Steps:**
  1. Write the file with only its module doc comment and a `#[cfg(test)] mod tests` holding the five tests below, then add `mod http_client;` to `lib.rs`.
     - The module doc comment says what every client gets: aws-lc-rs, `X25519MLKEM768` first, the classical fallback, compiled-in Mozilla roots and no host store. It also says why the host store is not used: a host without a CA bundle would make every client fail to build.
     - `offers_x25519mlkem768_first`: `client_config(compiled_in_roots()).crypto_provider().kx_groups[0].name()` is `rustls::NamedGroup::X25519MLKEM768`. `rustls::crypto::aws_lc_rs::default_provider().kx_groups[0].name()` is too, which catches feature unification regressing.
     - `negotiates_x25519mlkem768_with_a_hybrid_only_server`:
       1. Create a certificate with `rcgen::generate_simple_self_signed(vec!["localhost".to_string()])`.
       2. Build a server provider from `rustls::crypto::aws_lc_rs::default_provider()` with `kx_groups = vec![rustls::crypto::aws_lc_rs::kx_group::X25519MLKEM768]`.
       3. Build a `rustls::ServerConfig::builder_with_provider(Arc::new(provider)).with_protocol_versions(rustls::DEFAULT_VERSIONS)?.with_no_client_auth().with_single_cert(vec![cert.der().clone()], PrivatePkcs8KeyDer::from(signing_key.serialize_der()).into())`.
       4. Build a `ClientConnection` from `client_config(<RootCertStore holding that certificate>)` for `"localhost"`.
       5. Run `handshake(&mut client, &mut server)`.
       6. Both sides' `negotiated_key_exchange_group().map(|group| group.name())` are `Some(NamedGroup::X25519MLKEM768)`.
     - `still_connects_to_a_classical_only_server`: the same with `kx_group::X25519` only; both sides negotiate `NamedGroup::X25519`.
     - `builds_a_client_with_the_compiled_in_roots`:
       - `compiled_in_roots().len()` equals `webpki_roots::TLS_SERVER_ROOTS.len()`.
       - `client()` returns.
       - `build(client_builder().connect_timeout(std::time::Duration::from_secs(5)))` returns.
     - `no_other_module_builds_a_client_through_default`:
       1. Walk `src/` under `env!("CARGO_MANIFEST_DIR")` recursively and read every `.rs` file except `src/http_client.rs`.
       2. Fail with the file name when a file contains `Client::default` or `ClientBuilder::default`.
       3. Also fail when a `#[derive(` attribute that lists `Default` is followed, before the struct's closing `}`, by a field line whose type is `reqwest::Client` or `Client`.

     Add a test-only helper `handshake`:
     ```rust
     fn handshake(client: &mut rustls::ClientConnection, server: &mut rustls::ServerConnection) {
         for _ in 0..32 {
             let mut wire = Vec::new();
             while client.wants_write() { client.write_tls(&mut wire).expect("client write"); }
             let mut input = wire.as_slice();
             while !input.is_empty() { server.read_tls(&mut input).expect("server read"); }
             server.process_new_packets().expect("server handshake");
             let mut wire = Vec::new();
             while server.wants_write() { server.write_tls(&mut wire).expect("server write"); }
             let mut input = wire.as_slice();
             while !input.is_empty() { client.read_tls(&mut input).expect("client read"); }
             client.process_new_packets().expect("client handshake");
             if !client.is_handshaking() && !server.is_handshaking() { return; }
         }
         panic!("the handshake did not complete");
     }
     ```
  2. Run RED.
  3. Implement:
     - `compiled_in_roots()` is `rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() }`.
     - `client_config(roots)` uses `rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::aws_lc_rs::default_provider())).with_protocol_versions(rustls::DEFAULT_VERSIONS)` with the given roots and no client auth, then sets `alpn_protocols = vec![b"http/1.1".to_vec()]` (what reqwest 0.12 sent without `http2`). Use `.expect("…")` on `with_protocol_versions`, behind `#[allow(clippy::expect_used)]`, with a comment that the default versions are always supported by the default provider.
     - `client_builder()` is `reqwest::Client::builder().tls_backend_preconfigured(client_config(compiled_in_roots()))`, with `#[allow(clippy::disallowed_methods)]` and a comment saying this is the one place allowed to call it.
     - `build(builder)` is `builder.build().expect("…")`, behind `#[allow(clippy::expect_used)]`. The comment says it reads no host state with this configuration, the unit test builds it, and it replaces `Client::new()` calls that already panicked on a build error.
     - `client()` is `build(client_builder())`.
  4. Run GREEN.
- **Success criteria:** the five tests pass.
- **Verify** (`export PATH="$HOME/.cargo/bin:$PATH"; cargo test --manifest-path src-tauri/Cargo.toml --all-features --lib http_client:: > /tmp/p3-http.log 2>&1; echo "exit $?"; grep -c 'error\[E' /tmp/p3-http.log; grep '^test result:' /tmp/p3-http.log`). Pass `--lib` with every filtered `cargo test`: the crate has five more test targets, and without it each prints its own `test result:` line after the library's.
  - `RED` (after step 1): prints `exit 101`, then a count of 1 or more (compile errors: the functions do not exist yet), and no `test result:` line.
  - `GREEN`: prints `exit 0`, then `0`, then a line starting `test result: ok. 5 passed; 0 failed`.

### Task 3.4 — The clippy rule (RED: clippy flags the six sites)

- **Goal:** clippy rejects the reqwest entry points everywhere but `crate::http_client`.
- **Target files and symbols:** create `src-tauri/clippy.toml`.
- **Steps:**
  1. Write `src-tauri/clippy.toml`:
     ```toml
     # Build HTTP clients with crate::http_client: compiled-in roots and X25519MLKEM768 first.
     # Clippy cannot match the Default routes (Client::default, ClientBuilder::default, derive(Default));
     # a source test in src/http_client.rs catches those.
     disallowed-methods = [
       { path = "reqwest::Client::new", reason = "build HTTP clients with crate::http_client (compiled-in roots, X25519MLKEM768 first)" },
       { path = "reqwest::Client::builder", reason = "build HTTP clients with crate::http_client (compiled-in roots, X25519MLKEM768 first)" },
       { path = "reqwest::ClientBuilder::new", reason = "build HTTP clients with crate::http_client (compiled-in roots, X25519MLKEM768 first)" },
       { path = "reqwest::get", reason = "build HTTP clients with crate::http_client (compiled-in roots, X25519MLKEM768 first)" },
     ]
     ```
     If `src-tauri/clippy.toml` already exists, append the `disallowed-methods` entry instead, keeping what is there.
  2. Run the RED command.
- **Success criteria:** clippy now fails on exactly the six sites, and every path in the file resolves.
- **Verify:**
  - `RED`:
    ```bash
    export PATH="$HOME/.cargo/bin:$PATH"
    cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings 2>&1 | tee /tmp/p3-clippy1.log | tail -3; echo "exit ${PIPESTATUS[0]}"
    ```
    Pass: prints `exit 101`.
  - `test "$(grep -c 'use of a disallowed method' /tmp/p3-clippy1.log)" -ge 7; echo $?` prints `0`. There are six sites, and `mod.rs:208` names two methods; cargo may repeat a diagnostic for the test target.
  - `grep -o 'src/[a-z_/]*\.rs' /tmp/p3-clippy1.log | sort -u` lists exactly these six files: `src/ollama/context_fit.rs`, `src/ollama/context_fit_scheduler.rs`, `src/ollama/probe.rs`, `src/ollama/pull.rs`, `src/ollama/warm.rs`, `src/updater/mod.rs`.
  - `grep -c 'does not refer to a reachable function' /tmp/p3-clippy1.log` prints `0`.

### Task 3.5 — Move the six sites to `crate::http_client`

- **Goal:** every client comes from `crate::http_client`.
- **Target files and symbols:** the six lines listed in Context.
- **Steps:**
  1. In the five `ollama/*.rs` files, replace `reqwest::Client::new()` with `crate::http_client::client()`.
  2. In `src-tauri/src/updater/mod.rs:208`, replace the whole right-hand side with `crate::http_client::build(crate::http_client::client_builder().connect_timeout(CONNECT_TIMEOUT))`.
  3. Run GREEN.
- **Success criteria:** clippy passes, and every test passes as before, plus the five new ones.
- **Verify** (`GREEN`):
  ```bash
  export PATH="$HOME/.cargo/bin:$PATH"
  cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings >/tmp/p3-clippy2.log 2>&1; echo "clippy exit $?"
  grep -c 'does not refer to a reachable function' /tmp/p3-clippy2.log
  cargo test --manifest-path src-tauri/Cargo.toml --all-features 2>&1 | grep '^test result:' | head -1; echo "test exit ${PIPESTATUS[0]}"
  git grep -n "reqwest::Client::new\|reqwest::Client::builder\|reqwest::ClientBuilder::new\|reqwest::get(\|Client::default\|ClientBuilder::default" -- src-tauri/src | grep -v '^src-tauri/src/http_client.rs:'; echo "grep exit $?"
  ```
  Pass:
  - `clippy exit 0`.
  - The `grep -c` prints `0`.
  - `test exit 0`, with the first `test result:` line showing BASELINE_LIB + 5 passed.
  - `grep exit 1`: no match outside `http_client.rs`.

### Task 3.6 — Negative check of the source test (RED is the point)

- **Goal:** the source test fails when a module builds a client through `Default`.
- **Target files and symbols:** `src-tauri/src/product.rs`. It is changed temporarily and must end unchanged.
- **Steps:**
  1. Append to `src-tauri/src/product.rs`:
     ```rust
     #[allow(dead_code)]
     fn stray_client() -> reqwest::Client {
         reqwest::Client::default()
     }
     ```
  2. Run the RED command.
  3. Remove the lines you appended.
  4. Run the restore check.
- **Success criteria:** the test failed while the stray function existed, and `product.rs` is back to its committed content.
- **Verify:**
  - `RED`: `export PATH="$HOME/.cargo/bin:$PATH"; cargo test --manifest-path src-tauri/Cargo.toml --all-features --lib no_other_module_builds_a_client_through_default > /tmp/p3-default.log 2>&1; echo "exit $?"; grep -c 'product.rs' /tmp/p3-default.log; grep '^test result:' /tmp/p3-default.log` prints `exit 101`, then a count of 1 or more, then a line starting `test result: FAILED. 0 passed; 1 failed`.
  - Restore: `git diff --quiet -- src-tauri/src/product.rs; echo "exit $?"` prints `exit 0`.

### Task 3.7 — Live check against github.com (ignored test)

- **Goal:** the new TLS stack reaches GitHub with the compiled-in roots. The smoke's current regex cannot prove this.
- **Target files and symbols:** `src-tauri/src/http_client.rs`, a new test `reaches_github_over_tls` marked `#[ignore = "network: run with --ignored"]`, on a `#[tokio::test]`.
- **Steps:**
  1. Write the test:
     1. `client().get("https://github.com/tung491/oh-my-pi-gui/releases/latest/download/latest-linux.yml").send().await` must return `Ok(response)`.
     2. The response status must be one of 200, 302 or 404. While no release is published it is 404, and reqwest follows the redirect when there is one.
     3. On `Err`, the assertion message includes the error, which names a TLS failure.
  2. Run RED; the test does not exist yet, so the filter matches nothing.
  3. Implement the test, then run GREEN.
- **Success criteria:** the ignored test passes over the network.
- **Verify** (`export PATH="$HOME/.cargo/bin:$PATH"; cargo test --manifest-path src-tauri/Cargo.toml --all-features --lib reaches_github_over_tls -- --ignored > /tmp/p3-live.log 2>&1; echo "exit $?"; grep '^test result:' /tmp/p3-live.log`):
  - `RED` (before step 1): prints `exit 0` and a line starting `test result: ok. 0 passed; 0 failed`, with no test matching.
  - `GREEN`: prints `exit 0` and a line starting `test result: ok. 1 passed; 0 failed`.

### Task 3.8 — Phase gate

- **Goal:** every Rust gate passes, and the packaging inputs are untouched.
- **Target files and symbols:** none; this task edits nothing.
- **Steps:** run:
  ```bash
  export PATH="$HOME/.cargo/bin:$PATH"
  cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings >/dev/null 2>&1; echo "clippy exit $?"
  cargo test --manifest-path src-tauri/Cargo.toml --all-features >/tmp/p3-test.log 2>&1; echo "test exit $?"
  bun scripts/check-test-parity.ts updater; echo "parity-updater exit $?"
  bun scripts/check-test-parity.ts ollama; echo "parity-ollama exit $?"
  bash scripts/check-module.sh snapshots >/tmp/p3-snap.log 2>&1; echo "snapshots exit $?"
  git diff --quiet -- src-tauri/linux src-tauri/tauri.conf.json src-tauri/tauri.linux.conf.json src-tauri/contracts; echo "frozen exit $?"
  git diff --stat -- src-tauri/src/updater/mod.rs | tail -1
  ```
- **Success criteria:** every check below holds.
- **Verify:**
  - The script prints `clippy exit 0`, `test exit 0`, `parity-updater exit 0`, `parity-ollama exit 0`, `snapshots exit 0` and `frozen exit 0`.
  - The `mod.rs` diff stat shows `1 insertion(+), 1 deletion(-)`.

### Task 3.9 — Package and deb smoke

- **Goal:** the Linux packages build with aws-lc-sys in the unchanged Ubuntu 24.04 image, pass the finalize assertions and the glibc floor, and pass the deb smoke.
- **Target files and symbols:** none; build outputs land under `src-tauri/target-linux-2404/` (gitignored).
- **Steps:**
  1. If phase 4 runs in this same worktree and has not reported `Status: DONE`, wait for it. `package:linux` runs `build:pack`, which rewrites `resources/assistant-pack/`, the directory phase 4's checks read. Ask the orchestrator when unsure.
  2. Run in the background (it takes 20 minutes or more) with `SAI_ATLAS_UPDATE_BASE` and `SAI_ATLAS_UPDATE_KEYS` unset:
     ```bash
     env -u SAI_ATLAS_UPDATE_BASE -u SAI_ATLAS_UPDATE_KEYS bash -c 'start=$(date +%s); bun run package:linux > /tmp/p3-package.log 2>&1; code=$?; echo "package exit $code, $(( $(date +%s) - start ))s" >> /tmp/p3-package.log; exit $code'
     ```
  3. When it finishes, run:
     ```bash
     tail -3 /tmp/p3-package.log
     DEB=$(ls src-tauri/target-linux-2404/x86_64-unknown-linux-gnu/release/bundle/deb/*.deb); echo "$DEB"; stat -c '%s bytes' "$DEB"
     bash scripts/tauri-deb-smoke.sh "$DEB" > /tmp/p3-smoke.log 2>&1; echo "smoke exit $?"
     tail -30 /tmp/p3-smoke.log
     ```
- **Success criteria:** both commands succeed. Record the `.deb` size and the build time for the PR.
- **Verify:**
  - `/tmp/p3-package.log` ends with `package exit 0`.
  - The script prints `smoke exit 0`.
  - `/tmp/p3-smoke.log` shows the spec `checks for updates against latest-linux.yml` as passed.
  - If the build fails asking for `cmake` or another package, that is a Verify failure: do not edit the Dockerfile.

### Task 3.10 — Report

- **Goal:** the orchestrator gets the result.
- **Target files and symbols:** none.
- **Steps:**
  1. Print the outputs of tasks 3.8 and 3.9, the `.deb` size and build time, and the list of changed files.
  2. Print this status block:
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
| reqwest 0.13 compile changes at the call sites | Low × Low | The red team checked every API the six sites use in the 0.13.5 source. Task 3.2's `cargo check` shows it. |
| `tls_backend_preconfigured` is brittle across versions (`client.rs:2185-2201`) | Low × Medium | One `rustls` in the tree (task 3.2), plus `builds_a_client_with_the_compiled_in_roots` and the live test. |
| A later client bypasses `crate::http_client` | Low × Medium | Clippy rejects the named entry points, and the source test catches the `Default` routes. |
| `aws-lc-sys` needs more than `build-essential` in the image or CI | Low × Medium | Task 3.9 shows it. The fix is a recorded Dockerfile and `ci.yml` change outside this phase, through the Failure Protocol. |
| `rustls-platform-verifier` stays compiled but unused | Low × Low | Size only; reqwest's `rustls` feature requires it. |
| TLS-inspecting proxies and private CAs | Low × Low | They fail today and still fail. Phase 5's signatures, not TLS, make an update trustworthy. |

## Rollback

Revert the `Cargo.toml` lines, `http_client.rs`, `clippy.toml`, the `lib.rs` line and the six call sites; nothing is persisted. If phase 5 has merged, keep `aws-lc-rs`, which the verifier uses.

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
