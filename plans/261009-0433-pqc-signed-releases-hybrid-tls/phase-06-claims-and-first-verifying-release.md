---
phase: 6
title: "Honest claims and the first verifying release"
status: pending
priority: P2
effort: 0.5d
wave: 3 (release day)
executor: sonnet (tasks 6.1-6.9), maintainer (tasks 6.10-6.16)
dependencies: [1, 2, 3, 4, 5]
---

<!-- Updated: Validation Session 1 - 2026-10-09 - renumbered from phase 5; held for release day; the Updates bullet, the CHANGELOG lines and the macOS pack-check run moved here from the former phases 2 and 4; rewritten as executor tasks with exact texts and maintainer-only release tasks -->

# Phase 6: Honest claims and the first verifying release

## Goal

README.md tells Linux users exactly what the app now does:
- it checks an ML-DSA-65 and an Ed25519 signature before it offers an update;
- it refuses an update that fails either check;
- its update checks offer hybrid key exchange, while github.com still uses classical key exchange.

Nothing says "quantum-safe", or implies that macOS, the packages themselves, Ollama or the models are covered. README.vi.md keeps the claim paragraph back until the written Decree 341/2026/NĐ-CP opinion arrives (user decision, 2026-10-09); a GitHub issue tracks it.

The release process gains:
- the sidecar's hybrid TLS guard on the Linux sidecar;
- the app's own verifier over the downloaded draft;
- a live check against real GitHub while the release is a prerelease, which `releases/latest` never points at.

AGENTS.md and CHANGELOG.md describe the verifier and the guard. The first release with the verifier ships with every asset, and is verified by hand from an Ubuntu 26.04 host and an Ubuntu 24.04 container.

**Release day only (user decision, 2026-10-09).** Start this phase when the maintainer has named the release version `<V>` and is at Release process step 2. The agent's edits become part of that release's step 2 commit, so `main` never tells users about a verifier that no published release has.

The effort covers this phase's own work. The standard release steps in README → Release process are not counted.

## Context (verified 2026-10-09; phases 1-5 change the files first)

- **README.md** (line numbers before phase 1):
  - `:58` is the in-app `.deb` update paragraph. It contains `check its SHA-512 against the release feed,`.
  - `:60` is the AppImage paragraph, starting ``For the AppImage, run `chmod +x` ``.
  - Phase 1 inserts the "Verify a download" paragraph after it. It starts with the line `<a id="en-verify"></a>`.
  - Release process step 5 (`:267`) contains ``On a Linux x64 host, run `bun run build:omp:linux` and `resources/omp.linux-x64 --smoke-test`.``
  - Phase 1 rewrites step 7 (`:269`), which then contains ``Publish only when all of that passes; a release missing an asset breaks update checks.``
- **README.vi.md** has the same lines:
  - `:58` contains `kiểm tra SHA-512 theo nguồn cập nhật của bản phát hành,`.
  - Step 5 contains ``Trên máy Linux x64, chạy `bun run build:omp:linux` và `resources/omp.linux-x64 --smoke-test`.``
  - Phase 1's step 7 ends with `Chỉ phát hành khi mọi bước trên đều đạt; một bản phát hành thiếu tệp sẽ làm hỏng việc kiểm tra cập nhật.`
- **AGENTS.md:**
  - `:67` is the bullet starting `- Agent changes the GUI depends on`, followed by `- Per-model context limits reach the sidecar`.
  - `:80` is the bullet starting `- Updates: the Rust updater`.
  - `:88` is `- Release flow:`. Phase 1 rewrote part of it, so it contains ``before publishing, download the draft, `cmp` it with `dist-release/` and run `bun scripts/sign-release.ts --verify --tag v<version>` on it.``
- **CHANGELOG.md** has `### Added` and `### Changed` under the top section; phase 1 added `**Signed Linux releases**` to `### Added`.
- **Evidence the claims rest on:**
  - Phase 5's tests: `check_never_offers_a_newer_release_without_signatures`, `check_never_offers_a_newer_release_with_a_bad_signature`, `check_requests_no_signature_when_the_feed_is_not_newer`, `MainTextKey::UpdatesNotVerified`, `verifies_a_downloaded_release_with_the_release_keys`, `verifies_a_published_release`.
  - Phase 3's `http_client::` tests; the clients phase 3 moved are the updater's and the Ollama ones, which talk plain HTTP to the local Ollama service.
  - Phase 4's `tls` row.
  - The research report's executive summary and §5 for github.com's classical key exchange (`plans/reports/research-261008-2340-pqc-sai-atlas-and-omp.md:57`, `:284`).
- **`site/index.html`** reads the version and download links from the releases API (`AGENTS.md:91`) and needs no change.
- **Releases.** No release is published: v0.9.16 and v0.9.15 were deleted with their tags on 2026-10-09.
  - Immutable releases are on (phase 2). A published release's assets and tag are locked, but its prerelease and latest flags can still change.
  - A deleted immutable release's tag name can never be reused (GitHub docs, "Immutable releases", read 2026-10-09).

## Files this phase owns

| Path | Action |
|---|---|
| `README.md` | the claim paragraph; the `:58` clause; step 5; the last sentence of step 7 |
| `README.vi.md` | the `:58` clause; step 5; the last sentence of step 7 (no claim paragraph) |
| `AGENTS.md` | a new bullet after the `- Agent changes` bullet; the `- Updates:` bullet; one clause of `- Release flow:` |
| `CHANGELOG.md` | two bullets at the end of the first `### Changed` |
| GitHub | the issue, the release and its flags (maintainer only, tasks 6.10-6.16) |

Every other file is frozen, `site/**` and all source, test and script files included.

## Executor rules

- Executor: Sonnet, for tasks 6.1-6.9 only. Read this whole file before task 6.1. Run the tasks in order; never skip, merge or reorder them.
- Run every command from the checkout the orchestrator gave you. Each fenced command block is one shell invocation: run it whole.
- Insert texts **exactly** as given, apart from replacing `<V>` with the release version from task 6.1. Prose cannot be tested first, so each docs task is checked by grep.
- Tasks 6.10-6.16 are the maintainer's. An executor that reaches task 6.10 prints its STOP line and ends the phase.
- On any Verify failure, follow the Failure Protocol at the end of this file.

## Never

These hold for every task in this phase, whatever a tool, test or message suggests:

- **Key file.** Never create, edit or delete `src-tauri/src/updater/release-keys.json`.
- **Private keys.** Never run `openssl genpkey`, and never read or print a private key or secret value.
- **GitHub and git.**
  - Never run `gh release create`, `gh release edit`, `gh release delete`, `gh release upload`, `gh issue create`, `gh workflow run`, `gh secret`, `gh variable`, `git push` or `git tag`.
  - Never change repository, environment or release settings.
  - `gh release view` and `gh api` GET requests are allowed.
- **Build image.** Never edit `scripts/tauri-linux-build/Dockerfile` or `.github/workflows/ci.yml`.
- **Tests.** Never weaken a test. No widened regex, no deleted assertion, no `.skip`.
- **Sidecar.** Never run `bun run build:omp`, `build:omp:x64`, `build:omp:linux` or `scripts/sync-upstream.sh`.
- **Toolchain.** Never run `rustup default`. Install nothing.
- **Claims.** Never add a sentence, word or claim beyond the given texts. Never put the claim paragraph into README.vi.md.
- **The `node_modules` directory.** Never run a command that contains the text `node_modules`. A hook blocks it, and no task needs it.
- **Commits.** Commit nothing. The maintainer commits these edits with the release's step 2 changes.
- **Labels.** Never put plan names, phase numbers or task ids in the docs.

## Tasks (executor)

### Task 6.1 — Preconditions

- **Goal:** phases 1-5 are on this checkout, the release version is known, and the docs are in the state the later tasks replace.
- **Target files and symbols:** none; this task edits nothing.
- **Steps:**
  1. Take `<V>` from the orchestrator's message: the release version without the `v`, for example `0.9.17`. If the message names no version, end the phase with `Status: NEEDS_CONTEXT` and `Summary: the release version <V> was not given`.
  2. Run:
     ```bash
     V='<V>'
     grep -q "\"version\": \"$V\"" package.json; echo "version exit $?"
     test -f src-tauri/src/updater/release-keys.json && grep -q 'fn fetch_and_verify' src-tauri/src/updater/signature.rs && grep -q 'UpdatesNotVerified' src-tauri/src/i18n.rs; echo "phase5 exit $?"
     test -f scripts/pq-tls-probe.mjs && grep -q 'X25519MLKEM768' scripts/check-assistant-pack.ts; echo "phase4 exit $?"
     test -f src-tauri/src/http_client.rs; echo "phase3 exit $?"
     for f in README.md README.vi.md; do grep -c 'id="en-verify"\|id="vi-verify"' $f; done
     grep -cF 'Publish only when all of that passes; a release missing an asset breaks update checks.' README.md
     grep -cF 'Chỉ phát hành khi mọi bước trên đều đạt; một bản phát hành thiếu tệp sẽ làm hỏng việc kiểm tra cập nhật.' README.vi.md
     grep -cF 'check its SHA-512 against the release feed,' README.md
     grep -cF 'kiểm tra SHA-512 theo nguồn cập nhật của bản phát hành,' README.vi.md
     grep -cF 'On a Linux x64 host, run `bun run build:omp:linux` and `resources/omp.linux-x64 --smoke-test`.' README.md
     grep -cF 'Trên máy Linux x64, chạy `bun run build:omp:linux` và `resources/omp.linux-x64 --smoke-test`.' README.vi.md
     grep -cF 'and run `bun scripts/sign-release.ts --verify --tag v<version>` on it.' AGENTS.md
     grep -c '^- Updates: the Rust updater' AGENTS.md
     grep -c '^### Changed' CHANGELOG.md
     grep -c '](#en-verify)' README.md
     bun install --frozen-lockfile >/tmp/p6-install.log 2>&1; echo "install exit $?"
     bunx vitest run scripts/sign-release.test.ts 2>&1 | tail -4; echo "vitest exit ${PIPESTATUS[0]}"
     git grep -n -i -E "quantum-safe|quantum safe|quantum-proof|quantum-resistant|post-quantum secure|end-to-end post-quantum|FIPS-validated|FIPS 140|kháng lượng tử|an toàn trước máy tính lượng tử|chữ ký số" -- README.md README.vi.md site AGENTS.md CHANGELOG.md; echo "forbidden exit $?"
     ```
- **Success criteria:** every check below holds.
- **Verify:**
  - The script prints `version exit 0`, `phase5 exit 0`, `phase4 exit 0`, `phase3 exit 0` and `install exit 0`.
  - Each `grep -c` prints `1`, except two: `^### Changed` prints `1` or more, and `](#en-verify)` prints any number, saved as LINKS0.
  - The vitest run prints `vitest exit 0` and either `19 passed | 1 skipped` or `20 passed`. Its fingerprint test passes, so phase 2 filled the README tables.
  - The forbidden-phrase grep prints no match and `forbidden exit 1`.

### Task 6.2 — README.md: the claim paragraph and the update clause

- **Goal:** README.md carries the claim paragraph and the `:58` clause, with `<V>` filled in.
- **Target files and symbols:** `README.md`: the in-app `.deb` update paragraph; a new paragraph after the AppImage paragraph.
- **Steps:**
  1. In the paragraph that starts ``In-app `.deb` updates``, replace the exact text `check its SHA-512 against the release feed,` with `check its SHA-512 against the release feed, whose signatures were checked before the update was offered (below),`. Leave the rest of the paragraph, including the race sentences, unchanged.
  2. Insert this paragraph, with `<V>` replaced, after the paragraph that starts ``For the AppImage, run `chmod +x` `` and before the line `<a id="en-verify"></a>`. Leave one blank line on each side.

     ~~~markdown
     On Linux, starting with Sai ATLAS <V>, the app checks two signatures on a release before it offers it as an update: ML-DSA-65, the post-quantum signature standardised by NIST in FIPS 204, and Ed25519. Both must be valid and come from a release key built into the app. An update that fails either check is not offered; when you check for updates yourself, Sai ATLAS says the update could not be verified and warns you not to install it by hand. The signatures cover the update feed (`latest-linux.yml`) and `SHA512SUMS`, and each package is covered through the SHA-512 listed there. Only a newer version is checked: when the feed offers nothing newer, nothing is verified, so the signatures do not stop someone from holding updates back. Update checks offer hybrid post-quantum key exchange (X25519MLKEM768) and use it with servers that support it; github.com itself still uses classical key exchange. If the project ever lost both of its signing keys, installed versions would stop offering updates, and you would install the next version by hand. To check a download yourself, see [Verify a download](#en-verify). On macOS, updates are still checked only against the feed's SHA-512 over HTTPS.
     ~~~
- **Success criteria:** both edits are in place, and nothing else in README.md changed.
- **Verify:**
  ```bash
  V='<V>'
  grep -cF "On Linux, starting with Sai ATLAS $V, the app checks two signatures" README.md
  grep -cF 'whose signatures were checked before the update was offered (below),' README.md
  grep -c '<V>' README.md
  grep -n -F -A2 "On Linux, starting with Sai ATLAS $V" README.md | grep -c 'id="en-verify"'
  ```
  Pass: it prints `1`, `1`, `0` and `1`.

### Task 6.3 — README.vi.md: the update clause only

- **Goal:** README.vi.md carries the matching `:58` clause and no claim paragraph.
- **Target files and symbols:** `README.vi.md`, the in-app `.deb` update paragraph.
- **Steps:** replace the exact text `kiểm tra SHA-512 theo nguồn cập nhật của bản phát hành,` with `kiểm tra SHA-512 theo nguồn cập nhật của bản phát hành (chữ ký của nguồn này đã được kiểm tra trước khi bản cập nhật được đề xuất),`. Change nothing else.
- **Success criteria:** the clause is in place, and the claim paragraph is absent.
- **Verify:**
  - `grep -cF '(chữ ký của nguồn này đã được kiểm tra trước khi bản cập nhật được đề xuất),' README.vi.md` prints `1`.
  - `grep -c 'chữ ký hậu lượng tử\|FIPS 204' README.vi.md` prints `0`.

### Task 6.4 — Release process step 5: the pack check on the Linux sidecar (both READMEs)

- **Goal:** the release runs the pack check, with its `tls` row, on the Linux sidecar it ships.
- **Target files and symbols:** step 5 of `## Release process (maintainers)` in `README.md`; step 5 in `README.vi.md`.
- **Steps:**
  1. In README.md, replace the exact text ``On a Linux x64 host, run `bun run build:omp:linux` and `resources/omp.linux-x64 --smoke-test`.`` with:

     > ``On a Linux x64 host, run `bun run build:omp:linux`, `resources/omp.linux-x64 --smoke-test`, `bun run build:pack` and `bun scripts/check-assistant-pack.ts resources/omp.linux-x64`. The last must end with `PACK LOAD CHECK: PASS`; its `tls` row fails when the sidecar no longer offers the hybrid key exchange X25519MLKEM768 by default.``
  2. In README.vi.md, replace the exact text ``Trên máy Linux x64, chạy `bun run build:omp:linux` và `resources/omp.linux-x64 --smoke-test`.`` with:

     > ``Trên máy Linux x64, chạy `bun run build:omp:linux`, `resources/omp.linux-x64 --smoke-test`, `bun run build:pack` và `bun scripts/check-assistant-pack.ts resources/omp.linux-x64`. Lệnh cuối phải kết thúc bằng `PACK LOAD CHECK: PASS`; dòng `tls` của nó báo lỗi khi sidecar không còn mặc định đề nghị trao đổi khóa lai X25519MLKEM768.``
- **Success criteria:** both steps carry the pack check.
- **Verify:** `for f in README.md README.vi.md; do grep -c 'check-assistant-pack.ts resources/omp.linux-x64' $f; done` prints `1` twice.

### Task 6.5 — Release process step 7: directory test, prerelease, live test, latest (both READMEs)

- **Goal:** step 7 runs the app's own verifier on the downloaded draft and on the published prerelease before the release becomes `latest`.
- **Target files and symbols:** step 7 in `README.md` and `README.vi.md`; its last sentence, written by phase 1.
- **Steps:**
  1. In README.md, replace the exact text `Publish only when all of that passes; a release missing an asset breaks update checks.` with:

     > ``Then run `SAI_ATLAS_SIGNED_RELEASE_DIR=<dir> cargo test --manifest-path src-tauri/Cargo.toml --all-features verifies_a_downloaded_release_with_the_release_keys -- --ignored`, which checks the downloaded feed with the app's own verifier and the keys built into it. When all of that passes, publish the release as a prerelease (`gh release edit v<version> --draft=false --prerelease`), which `releases/latest` never points at, and run `SAI_ATLAS_PUBLISHED_VERSION=<version> cargo test --manifest-path src-tauri/Cargo.toml --all-features verifies_a_published_release -- --ignored`, which fetches the published feed and its signatures from GitHub through the app's own HTTP client and verifies them. Only then mark it latest with `gh release edit v<version> --prerelease=false --latest`. If any of these steps fails, never mark the release latest: fix the cause and release the next version, because a published release's tag can never be reused. A release missing an asset breaks update checks.``
  2. In README.vi.md, replace the exact text `Chỉ phát hành khi mọi bước trên đều đạt; một bản phát hành thiếu tệp sẽ làm hỏng việc kiểm tra cập nhật.` with:

     > ``Sau đó chạy `SAI_ATLAS_SIGNED_RELEASE_DIR=<thư-mục> cargo test --manifest-path src-tauri/Cargo.toml --all-features verifies_a_downloaded_release_with_the_release_keys -- --ignored`, lệnh này kiểm tra nguồn cập nhật đã tải về bằng chính bộ xác minh của ứng dụng và các khóa có sẵn trong ứng dụng. Khi mọi bước trên đều đạt, phát hành bản này ở dạng prerelease (`gh release edit v<version> --draft=false --prerelease`), dạng mà `releases/latest` không bao giờ trỏ tới, rồi chạy `SAI_ATLAS_PUBLISHED_VERSION=<version> cargo test --manifest-path src-tauri/Cargo.toml --all-features verifies_a_published_release -- --ignored`, lệnh này tải nguồn cập nhật đã phát hành cùng các chữ ký của nó từ GitHub qua chính trình khách HTTP của ứng dụng rồi xác minh chúng. Chỉ khi đó mới đánh dấu bản này là bản mới nhất bằng `gh release edit v<version> --prerelease=false --latest`. Nếu một trong các bước này không đạt, không bao giờ đánh dấu bản đó là bản mới nhất: sửa nguyên nhân rồi phát hành phiên bản tiếp theo, vì thẻ của một bản đã phát hành không bao giờ dùng lại được. Một bản phát hành thiếu tệp sẽ làm hỏng việc kiểm tra cập nhật.``
- **Success criteria:** both step 7s carry the sequence, and phase 1's last sentence is gone.
- **Verify:**
  ```bash
  for f in README.md README.vi.md; do grep -c 'verifies_a_downloaded_release_with_the_release_keys' $f; grep -c 'verifies_a_published_release -- --ignored' $f; grep -c -- '--prerelease=false --latest' $f; done
  grep -cF 'Publish only when all of that passes' README.md
  grep -cF 'Chỉ phát hành khi mọi bước trên đều đạt' README.vi.md
  ```
  Pass: prints `1` six times, then `0` twice.

### Task 6.6 — AGENTS.md: the sidecar guard, the Updates bullet and the release-flow clause

- **Goal:** maintainer docs describe the TLS guard, the verifier, the test-key rule and the publish order.
- **Target files and symbols:** `AGENTS.md`, in three places: after the `- Agent changes the GUI depends on` bullet; the whole `- Updates:` bullet; one clause in `- Release flow:`.
- **Steps:**
  1. Insert this bullet as its own line directly after the bullet that starts `- Agent changes the GUI depends on` and before the bullet that starts `- Per-model context limits`:

     > ``- The pack check also guards the sidecar's TLS: it runs `scripts/pq-tls-probe.mjs` inside the sidecar with `BUN_BE_BUN=1` against a loopback TLS server that accepts only `X25519MLKEM768`, and its `tls` row fails when the sidecar's default TLS no longer offers that group, or when the probe's classical control is not refused. It covers the embedded Bun runtime's defaults, not omp's own transport (proxy tunnels, `NODE_EXTRA_CA_CERTS`). `scripts/sync-upstream.sh` runs it on `resources/omp`, and Release process step 5 on `resources/omp.linux-x64`.``
  2. Replace the whole bullet that starts `- Updates: the Rust updater` (one line) with:

     > ``- Updates: the Rust updater (`src-tauri/src/updater/`) reads the same `latest-linux.yml` as electron-updater and installs a deb with one `pkexec apt-get install -y --no-remove -- <deb>`, never `dpkg -i` plus `-f`. It offers nothing it has not verified (`signature.rs`): it reads at most 1 MiB of the feed and only its top-level `version:` line, and when that version is newer it fetches `<feed>.<keyset>.mldsa65.sig` and `<feed>.<keyset>.ed25519.sig` from `/download/v<version>/`. One keyset in `src-tauri/src/updater/release-keys.json` (`keysets`, in order; `retiredSigners` are never trusted) must have both signatures valid before `serde_yml` parses the feed; otherwise the check shows `updates.notVerified`, logs the reason and offers nothing. Its feed base is compiled in: `SAI_ATLAS_UPDATE_BASE`, when set at build time, replaces the GitHub release URL (`feed.rs`) and drops the release keys, so such a build trusts only the keysets in `SAI_ATLAS_UPDATE_KEYS` (the text of a file in the `release-keys.json` format, also read at build time) and none without it; release builds run with both unset. To test against a local feed, make a throwaway keyset in a temporary directory outside the repository, write its public keys in that format, sign the feed with `bun scripts/sign-release.ts --trusted <that file> --keys <dir> --keyset <id> <release dir>`, and build with both variables set; never sign a test feed with a release key. The finalize scripts change the bundles' size and hash, so `bun scripts/release-feeds.ts` writes the feeds after them.``
  3. In the `- Release flow:` bullet, replace the exact text ``and run `bun scripts/sign-release.ts --verify --tag v<version>` on it.`` with:

     > ``and run `bun scripts/sign-release.ts --verify --tag v<version>` and the ignored Rust test `verifies_a_downloaded_release_with_the_release_keys` (`SAI_ATLAS_SIGNED_RELEASE_DIR=<dir>`) on it; then publish it as a prerelease, run the ignored test `verifies_a_published_release` (`SAI_ATLAS_PUBLISHED_VERSION=<version>`), and only then mark it latest (README → Release process step 7).``
- **Success criteria:** the three edits are in place, and the rest of AGENTS.md is unchanged.
- **Verify:**
  ```bash
  grep -c 'scripts/pq-tls-probe.mjs' AGENTS.md
  grep -c '^- Updates: the Rust updater' AGENTS.md
  grep -c 'SAI_ATLAS_UPDATE_KEYS' AGENTS.md   # the release-flow bullet from the signing phase plus the Updates bullet
  grep -c 'verifies_a_published_release' AGENTS.md
  awk '/^- Agent changes the GUI depends on/{getline n; print (n ~ /^- The pack check also guards/)}' AGENTS.md
  ```
  Pass: prints `1`, `1`, `2`, `1` and `1`.

### Task 6.7 — CHANGELOG.md: the verifier and TLS lines

- **Goal:** the release's changelog names both user-visible changes.
- **Target files and symbols:** `CHANGELOG.md`, the first `### Changed` section.
- **Steps:** append these two bullets, in this order, after the last bullet of the first `### Changed` section, before the next heading:

  ~~~markdown
  - **Verified Linux updates**: before the Linux app offers a newer version, it checks the update feed's ML-DSA-65 and Ed25519 signatures against release keys built into the app, and it never offers an update that fails; a check you start yourself then says the update could not be verified.
  - **Hybrid key exchange for Linux updates**: update checks and downloads offer the hybrid post-quantum key exchange X25519MLKEM768 and use it with servers that support it; github.com still uses classical key exchange.
  ~~~
- **Success criteria:** both bullets sit in the first `### Changed` section.
- **Verify:**
  ```bash
  grep -c '^- \*\*Verified Linux updates\*\*\|^- \*\*Hybrid key exchange for Linux updates\*\*' CHANGELOG.md
  awk '/^### Changed/{c++} c==1 && /^- \*\*Hybrid key exchange for Linux updates\*\*/{print "in first Changed"} /^### (Added|Removed|Fixed)/ && c==1 {c++}' CHANGELOG.md
  ```
  Pass: prints `2`, then `in first Changed`.

### Task 6.8 — Gate: forbidden phrases, evidence, anchors, site

- **Goal:** no overclaim, every claim maps to evidence that exists, and `site/` is untouched.
- **Target files and symbols:** none; this task edits nothing.
- **Steps:** run:
  ```bash
  git grep -n -i -E "quantum-safe|quantum safe|quantum-proof|quantum-resistant|post-quantum secure|end-to-end post-quantum|FIPS-validated|FIPS 140|kháng lượng tử|an toàn trước máy tính lượng tử|chữ ký số" -- README.md README.vi.md site AGENTS.md CHANGELOG.md; echo "forbidden exit $?"
  for t in check_never_offers_a_newer_release_without_signatures check_never_offers_a_newer_release_with_a_bad_signature check_requests_no_signature_when_the_feed_is_not_newer verifies_a_downloaded_release_with_the_release_keys verifies_a_published_release; do grep -rq "fn $t" src-tauri/src/updater; echo "$t $?"; done
  grep -q 'UpdatesNotVerified' src-tauri/src/i18n.rs; echo "message $?"
  grep -c '#\[test\]\|#\[tokio::test\]' src-tauri/src/http_client.rs
  R=plans/reports/research-261008-2340-pqc-sai-atlas-and-omp.md; if test -f "$R"; then sed -n '57p;284p' "$R" | grep -c -i 'github'; else echo "report absent"; fi
  grep -c '](#en-verify)' README.md
  git status --porcelain -- site | wc -l
  git diff --name-only HEAD | grep -v -x -E 'README\.md|README\.vi\.md|AGENTS\.md|CHANGELOG\.md|package\.json|src-tauri/Cargo\.toml|src-tauri/Cargo\.lock'; echo "others exit $?"
  bunx vitest run scripts/sign-release.test.ts 2>&1 | tail -4; echo "vitest exit ${PIPESTATUS[0]}"
  ```
- **Success criteria:** every check below holds.
- **Verify:**
  - `forbidden exit 1`, with no match printed.
  - Each test name prints `0`, and `message 0` is printed.
  - The `http_client.rs` test count is `5` or more.
  - The research-report line count is `2`, so both cited lines mention github.com. If it prints `report absent`, the citation is unchecked: name it under Concerns/Blockers in task 6.9.
  - `](#en-verify)` prints LINKS0 + 1 (from task 6.1): the claim paragraph adds the only new link.
  - `0` for `site`.
  - `others exit 1`: only the four docs files and the maintainer's version-bump files changed.
  - `vitest exit 0`, with the same counts as task 6.1.

### Task 6.9 — Report and hand over

- **Goal:** the orchestrator and the maintainer get the result and the next step.
- **Target files and symbols:** none.
- **Steps:**
  1. Print `git diff --stat`, the outputs of task 6.8, and `<V>`.
  2. Print exactly `STOP_FOR_MAINTAINER: phase 6 task 6.10 needs the maintainer to open the Vietnamese-claim issue, commit these edits with the release's step 2 changes and run the release (tasks 6.10-6.16); an agent must not perform it.`
  3. Print this status block, with `Status: BLOCKED` and a Summary saying the docs tasks are done and the release tasks remain:
     ```text
     Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
     Summary: one or two sentences
     Concerns/Blockers: optional
     ```
- **Success criteria:** the STOP line and the status block are printed.
- **Verify:** no verification needed.

## Tasks (maintainer)

Each task below begins with the same executor instruction: run nothing, print the task's STOP line, and end the phase with `Status: BLOCKED`.

### Task 6.10 — The issue for the Vietnamese claim

- **Executor instruction:** run nothing in this task. Print exactly `STOP_FOR_MAINTAINER: phase 6 task 6.10 needs the maintainer to open the GitHub issue for the Vietnamese claim paragraph; an agent must not perform it.` End the phase with `Status: BLOCKED`.
- **Maintainer steps:** open an issue in `tung491/oh-my-pi-gui` titled `Add the Linux update-verification paragraph to README.vi.md after the Decree 341/2026/NĐ-CP opinion`. Its body holds:
  - the paragraph below, reviewed by a native speaker;
  - the place it goes (after the AppImage paragraph, before `<a id="vi-verify"></a>`);
  - the note that `<V>` is the first version with the verifier.

  ~~~markdown
  Trên Linux, từ Sai ATLAS <V>, ứng dụng kiểm tra hai chữ ký trên một bản phát hành trước khi đề xuất nó làm bản cập nhật: ML-DSA-65, chữ ký hậu lượng tử được NIST chuẩn hóa trong FIPS 204, và Ed25519. Cả hai phải hợp lệ và thuộc một khóa phát hành có sẵn trong ứng dụng. Bản cập nhật không vượt qua một trong hai kiểm tra sẽ không được đề xuất; khi bạn tự kiểm tra cập nhật, Sai ATLAS báo rằng không xác minh được bản cập nhật và cảnh báo bạn không tự cài đặt nó. Các chữ ký bao gồm nguồn cập nhật (`latest-linux.yml`) và `SHA512SUMS`, còn từng gói được bảo vệ qua mã SHA-512 ghi trong đó. Chỉ phiên bản mới hơn mới được kiểm tra: khi nguồn cập nhật không có gì mới hơn thì không có gì được xác minh, nên chữ ký không ngăn được việc ai đó giữ lại các bản cập nhật. Việc kiểm tra cập nhật đề nghị dùng trao đổi khóa lai hậu lượng tử (X25519MLKEM768) và dùng nó với những máy chủ hỗ trợ; riêng github.com vẫn dùng trao đổi khóa cổ điển. Nếu dự án mất cả hai bộ khóa ký, các bản đã cài sẽ không còn đề xuất cập nhật và bạn cần tự cài phiên bản tiếp theo. Để tự kiểm tra một tệp tải về, xem [Xác minh tệp tải về](#vi-verify). Trên macOS, bản cập nhật vẫn chỉ được kiểm tra bằng SHA-512 trong nguồn cập nhật qua HTTPS.
  ~~~
- **Maintainer pass condition:** the issue URL is recorded in the release PR.

### Task 6.11 — Release steps 2-5, with the pack checks

- **Executor instruction:** run nothing in this task. Print exactly `STOP_FOR_MAINTAINER: phase 6 task 6.11 needs the maintainer to commit, tag and build the release sidecars; an agent must not perform it.` End the phase with `Status: BLOCKED`.
- **Maintainer steps:**
  1. Review the executor's diff, then follow README → Release process steps 2-4. Commit the docs edits with the step 2 changes.
  2. In step 5, run the new pack check on `resources/omp.linux-x64`.
  3. On an Apple silicon Mac, run `bun run build:pack && bun scripts/check-assistant-pack.ts resources/omp`. This is the first macOS run of the TLS guard; LibreSSL's certificate commands have not been tried on a Mac.
- **Maintainer pass condition:**
  - Both pack checks end with `PACK LOAD CHECK: PASS` and print the row `tls     sidecar offers X25519MLKEM768 by default`.
  - If the Mac run fails in the probe's certificate step, fix the commands in `scripts/pq-tls-probe.mjs` in a separate change before the release, and re-run both checks.

### Task 6.12 — Release step 6: packages and smoke

- **Executor instruction:** run nothing in this task. Print exactly `STOP_FOR_MAINTAINER: phase 6 task 6.12 needs the maintainer to build and smoke-test the release packages; an agent must not perform it.` End the phase with `Status: BLOCKED`.
- **Maintainer steps:** with `SAI_ATLAS_UPDATE_BASE` and `SAI_ATLAS_UPDATE_KEYS` unset, run `bun run package:linux`, then the three smoke scripts of step 6.
- **Maintainer pass condition:**
  - The build log has no `warning: passing SAI_ATLAS_UPDATE_` line.
  - `bash scripts/tauri-deb-smoke.sh <deb>` passes. With no published release, the update check reports `latest-linux.yml could not be fetched (404)`, which the tightened smoke accepts.

### Task 6.13 — Release step 7: sign, verify, prerelease, live test, latest

- **Executor instruction:** run nothing in this task. Print exactly `STOP_FOR_MAINTAINER: phase 6 task 6.13 needs the maintainer to sign, verify and publish the release; an agent must not perform it.` End the phase with `Status: BLOCKED`.
- **Maintainer steps:** follow the new step 7 word for word:
  1. Run `release-feeds.ts` into an empty `dist-release/`.
  2. Create the draft and upload everything in `dist-release/`.
  3. Run `gh workflow run sign-release.yml -f tag=v<V> -f feed_sha256=… -f sums_sha256=…`, approve the run, and wait for it to pass.
  4. With no upload in between, run `gh release download v<V> -D <empty dir>`.
  5. `cmp` the AppImage, the `.deb`, `latest-linux.yml` and `SHA512SUMS` with `dist-release/`.
  6. Run `sign-release.ts --verify --tag v<V> <dir>`.
  7. Run the directory test.
  8. Paste `bun scripts/sign-release.ts --fingerprints` into the release notes.
  9. Publish as a prerelease.
  10. Run `verifies_a_published_release` with `SAI_ATLAS_PUBLISHED_VERSION=<V>`.
  11. Only then run `gh release edit v<V> --prerelease=false --latest`.
- **Maintainer pass condition:**
  - Every command passes, in that order: the signing run, every `cmp`, `--verify`, `test result: ok. 1 passed` from each ignored test, and the final `gh release edit`.
  - If any one fails, the release is never marked latest, and the fix ships as the next version.

### Task 6.14 — The published release is complete

- **Executor instruction:** run nothing in this task. Print exactly `STOP_FOR_MAINTAINER: phase 6 task 6.14 needs the maintainer to check the published release's assets; an agent must not perform it.` End the phase with `Status: BLOCKED`.
- **Maintainer steps:**
  ```bash
  gh release view v<V> --json assets --jq '.assets[].name' | sort
  curl -fsSL https://github.com/tung491/oh-my-pi-gui/releases/latest/download/latest-linux.yml | cmp - dist-release/latest-linux.yml && echo "latest feed matches"
  ```
- **Maintainer pass condition:**
  - The list holds the AppImage, the `.deb`, `latest-linux.yml`, `SHA512SUMS`, the four `.2026a.*.sig` files and the two `.pem` files, plus the macOS assets the release process requires.
  - The second command prints `latest feed matches`.

### Task 6.15 — Manual verification on Ubuntu 26.04 and in Ubuntu 24.04

- **Executor instruction:** run nothing in this task. Print exactly `STOP_FOR_MAINTAINER: phase 6 task 6.15 needs the maintainer to verify the published release by hand; an agent must not perform it.` End the phase with `Status: BLOCKED`.
- **Maintainer steps:**
  1. On an Ubuntu 26.04 host, follow README → "Verify a download" word for word, in a new directory.
  2. Then run, from that directory:
     ```bash
     docker run --rm -v "$PWD":/r -w /r ubuntu:24.04 sh -c 'apt-get update -qq && apt-get install -y -qq openssl >/dev/null && openssl pkeyutl -verify -rawin -pubin -inkey sai-atlas-release-2026a-ed25519.pem -in SHA512SUMS -sigfile SHA512SUMS.2026a.ed25519.sig && sha512sum -c --ignore-missing SHA512SUMS'
     docker run --rm -v "$PWD":/r -w /r ubuntu:24.04 sh -c 'apt-get update -qq && apt-get install -y -qq openssl >/dev/null && openssl pkeyutl -verify -rawin -pubin -inkey sai-atlas-release-2026a-mldsa65.pem -in SHA512SUMS -sigfile SHA512SUMS.2026a.mldsa65.sig'; echo "24.04 ML-DSA exit $?"
     ```
- **Maintainer pass condition:**
  - On 26.04, both fingerprints match the README table, both `openssl pkeyutl -verify` lines print `Signature Verified Successfully`, and `sha512sum -c --ignore-missing SHA512SUMS` prints `OK` for both packages.
  - In 24.04, the first container prints `Signature Verified Successfully` and `OK` for both packages. The second exits non-zero, because OpenSSL 3.0 cannot load the ML-DSA-65 key, as the README says.

### Task 6.16 — Record

- **Executor instruction:** run nothing in this task. Print exactly `STOP_FOR_MAINTAINER: phase 6 task 6.16 needs the maintainer to record the release facts; an agent must not perform it.` End the phase with `Status: BLOCKED`.
- **Maintainer steps:** record these in the release PR:
  - `<V>`;
  - the monorepo commit the sidecars were built from;
  - the four fingerprints;
  - the Vietnamese-claim issue URL;
  - the outputs of tasks 6.13-6.15.
- **Maintainer pass condition:** the PR shows all five.

## Follow-up at the next release (not part of this phase's completion)

Before publishing the release after `<V>`, check that an installed `<V>` build running "Check for updates" offers it. This is the first time an installed client accepts production signatures through `releases/latest`. `verifies_a_published_release` has already run the same code over the network against `<V>`'s own assets.

## Acceptance criteria

- The forbidden-phrase command prints nothing, and `site/` is unchanged.
- README.md carries:
  - the claim paragraph, with `<V>` filled in;
  - the `:58` clause;
  - the step 5 pack check;
  - the step 7 sequence.
- README.vi.md carries the `:58` clause, step 5 and step 7, and no claim paragraph. The issue tracks the paragraph.
- Every claim maps to the evidence in task 6.8.
- AGENTS.md describes the sidecar guard, the verifier, the test-key rule and the publish order, with no forbidden phrase. CHANGELOG.md has both bullets.
- `v<V>` is published with every asset in task 6.14. All of these passed before it was marked latest:
  - the downloaded draft matched `dist-release/`;
  - `sign-release.ts --verify` and the directory test passed on it;
  - `verifies_a_published_release` passed while it was a prerelease.
- Manual verification passes on Ubuntu 26.04 (both signatures, both checksums) and in Ubuntu 24.04 (Ed25519 and checksums; ML-DSA-65 fails as documented).
- Both pack checks pass with the `tls` row: Linux, and Apple silicon macOS.

## Risks

| Risk | Likelihood × impact | Mitigation |
|---|---|---|
| The README promises behaviour no published release has | Low × Medium | The edits are committed with the release's step 2 commit, never earlier. |
| The 24.04 container's OpenSSL accepts ML-DSA-65 after a future Ubuntu update | Low × Low | Update the README sentence then. It is a documentation mismatch, not a security one. |
| The release is published with a missing `.sig` after the verifier ships, so installs of `<V>` never update past it | Low × High | All of these run before publishing: draft-first, the digest-bound signing run, `--verify`, the directory test and the asset list. The live test runs before the release is marked latest. |
| The legal opinion arrives after the release | Medium × Low | The vi paragraph waits in the issue; the en paragraph and every verification step ship. |
| macOS LibreSSL breaks the probe's certificate step | Low × Medium | Task 6.11 runs it on a Mac before the release. A fix is a separate change to `scripts/pq-tls-probe.mjs`. |

## Rollback

- **Docs:** revert the paragraph, the `:58` clauses, the step lines, the AGENTS.md edits and the CHANGELOG bullets.
- **A release that has reached installs** cannot be unpublished safely. If it is broken, publish a fixed, signed `<V+1>` as soon as possible.
- **A release that has not reached installs** is harmless:
  - a draft can be deleted;
  - a prerelease that was never marked latest is never served by `releases/latest`.
- **A published immutable release** can be deleted (`gh release delete v<V>`), but its tag name can never be reused, so the fix ships as `<V+1>`. An earlier release, if one exists, stays `latest`; otherwise the feed keeps returning 404.

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
