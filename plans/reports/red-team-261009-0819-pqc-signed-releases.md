# Red team: signed Linux releases and hybrid TLS plan

Date: 2026-10-09 08:19 KST. Plan: `plans/261009-0433-pqc-signed-releases-hybrid-tls/`.
Reviewers (Opus, read-only, full tier): Security Adversary (fact checker), Failure Mode Analyst (flow tracer), Assumption Destroyer (scope auditor).

Phase numbers in this report predate the plan's Validation Session 1. There, phase 1 was split into phases 1 and 2, phase 2 became phase 5 and phase 5 became phase 6. `plan.md` → Red Team Review maps each finding to the current phases.

**Outcome.** The three reviewers raised 24 findings, which merge into 15: 1 Critical, 9 High and 5 Medium. All 15 cite `file:line` evidence and pass the evidence filter. The user accepted all 15 on 2026-10-09 and they are applied to the plan. Seven take a different or narrower fix than the reviewer suggested (3, 4, 6, 11, 13, 14, 15). For finding 6 the user chose to keep the previous signer's keys as environment secrets. None of the findings argues that the cryptography is wrong. The formats, sizes, SPKI prefixes, rustls group order and aws-lc-rs stable ML-DSA API all checked out against OpenSSL 3.5.5 and the crate sources.

The controller re-ran finding 1 on this host: on Bun 1.4.2 a `node:https` server with `ecdhCurve: "X25519MLKEM768"` accepted an X25519-only `openssl s_client`, while `tls.createServer` with the same options refused it.

## Findings

| # | Finding | Sev | Reviewers | Disposition | Applies to |
|---|---|---|---|---|---|
| 1 | Bun's `node:https` server ignores `ecdhCurve`, so the sidecar probe can never pass | Critical | AD | Accept | Phase 4 |
| 2 | The signing workflow signs whatever the draft holds; nothing binds it to the maintainer's bytes, the tag or the feed version | High | SA, AD, FMA | Accept | Phases 1, 5 |
| 3 | The job that holds the keys needs Bun and the npm tree (`yaml`, `postinstall`), and installs neither safely | High | SA, AD | Accept (modified) | Phase 1 |
| 4 | A test feed base or test keyset can reach a release build; the smoke check passes on any error naming the feed, including broken TLS | High | SA, AD, FMA | Accept (modified) | Phases 1, 2, 3, 5 |
| 5 | The "not verified" message tells users to download from the releases page an attacker may control | High | SA | Accept | Phases 2, 5 |
| 6 | Dual-signing cannot run (the tool refuses the previous signer), helps installs two rotations behind rather than one, and puts both keysets of one generation online | High | FMA, AD, SA | Accept; the previous key stays an environment secret (user) | Phase 1, plan.md |
| 7 | Every pre-publish check uses the new key file, never the keysets installed builds trust | High | FMA | Accept | Phases 1, 2 |
| 8 | The verifier first meets real GitHub (302 to the asset host) only after `latest` already points at the first verifying release | High | FMA | Accept | Phases 2, 5 |
| 9 | The CI dry run signs a real-version test feed with production keys, uploads test PEMs, and cannot be dispatched before phase 1 is on `main` | High | SA, AD | Accept | Phase 1 |
| 10 | The `2026b` recovery keyset is never exercised, so a bad backup surfaces only in an emergency | High | FMA | Accept | Phase 1 |
| 11 | The draft that was verified is not necessarily what gets published (re-runs, `--clobber`, a `releaseDate` of "now", no concurrency group, a stale `dist-release/`) | Medium | FMA | Accept (narrower fix) | Phases 1, 5 |
| 12 | `disallowed-methods` misses `Client::default` / `ClientBuilder::default`; phase 2's live test adds a seventh client site | Medium | SA, AD | Accept | Phases 2, 3 |
| 13 | Freeze and replay (an unsigned "not newer" feed) are not named anywhere | Medium | SA | Accept (docs only) | plan.md, Phase 5 |
| 14 | The signature file name is the literal `latest-linux.yml`, so a Tauri macOS build would check `latest-mac.yml` against Linux signatures | Medium | FMA | Accept (narrower fix) | Phase 2 |
| 15 | The sidecar guard runs plain Bun (`BUN_BE_BUN=1`), so "catches an omp change" is false | Medium | FMA | Accept (narrower fix) | Phases 4, 5 |

SA = Security Adversary, FMA = Failure Mode Analyst, AD = Assumption Destroyer.

## Proposed changes

1. **Probe server.** Use `tls.createServer({ key, cert, ecdhCurve: "X25519MLKEM768", minVersion: "TLSv1.3" })` and write a minimal `HTTP/1.1 200` response by hand for the `fetch` check, as the research measurement M6 did. Record the Bun behaviour in the phase 4 risks. Evidence: phase-04:21, :28; controller re-run above.
2. **Bind the signing run to the maintainer's bytes.**
   - `sign-release.yml` takes the required inputs `tag`, `feed_sha256` and `sums_sha256`, computed locally from the release directory, and reads them through `env:`.
   - It requires the tag to match `^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$` and the feed's `version:` line to equal the tag without its `v`.
   - It refuses to sign when the downloaded bytes differ from the two digests, then runs `sha512sum -c` on the packages and only then signs.
   - `sign-release.ts --verify` gains `--tag v<V>`, which also requires every `files[].url` to name V.
   - Phase 5 `cmp`s the downloaded draft against the local directory before publishing.
   - The README states that a leaked maintainer token with `repo` scope, not only an account takeover, can start and approve a signing run.
   - Evidence: phase-01:17, :77, :83-87; phase-05:69.
3. **Keep npm code out of the keyed job.**
   - `sign-release.ts` imports only `node:` modules and parses the feed with Bun's built-in `Bun.YAML.parse`; every mode runs with `bun --no-install`. `Bun.YAML.parse` exists in Bun 1.4.2 and works under `--no-install` (controller check). This replaces the reviewers' second job: with no npm code at all, one job suffices, and the keys are deleted before `--verify` runs.
   - Bun comes from the SHA-pinned `oven-sh/setup-bun` (as in `ci.yml:21`), never from `curl | bash` and never through `bun install`. `actions/checkout` runs with `persist-credentials: false`.
   - Evidence: phase-01:28, :82-86; `package.json:10`, `:87`; `scripts/release-feeds.ts:36`.
4. **Refuse test trust in a release, and make the smoke check prove the network path.**
   - `release-feeds.ts` refuses to run when `SAI_ATLAS_UPDATE_BASE` or `SAI_ATLAS_UPDATE_KEYS` is set, and `tauri-linux-build.sh` warns when it passes either. Because `release-feeds.ts` now names the variable, phase 1 takes it off the packaging test's list of files that may not contain `SAI_ATLAS_UPDATE_BASE` (`scripts/tauri-packaging-config.test.ts:286-297`).
   - The reviewers' binary inspection is not taken. Whether the production URL literal survives in a binary built with the override depends on the optimiser, so its presence proves nothing. A compiled-in marker is equally fragile. The tightened smoke check proves the base behaviourally instead. Test keys take effect only together with the base override, so the base is the only override that matters.
   - The smoke regex becomes `/could not be fetched \(404\)|"state":"(not-available|available)"/`, so DNS, TLS and HTTP must all work.
   - Evidence: `scripts/tauri-linux-build.sh:31`; `e2e-tauri/packaged-smoke.e2e.ts:357`; `src-tauri/src/updater/feed.rs:103`, `:106`.
5. **Safer message.** Replace the last sentence of `updates.notVerified`.
   - en: "This update could not be verified, so Sai ATLAS did not offer it. Someone other than the Sai ATLAS team may have changed it. Do not install it by hand unless it passes the check in README → Verify a download."
   - vi: "Không xác minh được bản cập nhật này nên Sai ATLAS không đề xuất cài đặt. Có thể ai đó ngoài nhóm Sai ATLAS đã thay đổi nó. Đừng tự cài đặt trừ khi nó vượt qua bước kiểm tra trong README → Xác minh tệp tải về."
   - Evidence: phase-02:32, :67; `README.md:58`.
6. **Make dual-signing workable.**
   - `release-keys.json` gains a `retiredSigners` list. Those keysets may sign during a window and get PEM files and self-verification, but `signature.rs` never trusts them.
   - `--verify` accepts a PEM from either list.
   - Dual-signing starts at the second rotation. At the first rotation, installs that trust `[2026a, 2026b]` already verify `2026b` alone.
   - The wording becomes "installs two rotations behind".
   - **User choice (2026-10-09):** the previous signer's private keys stay `RELEASE_SIGNING_PREVIOUS_*` secrets of the environment. The user accepts that a takeover during a window leaves installs one rotation behind with no recovery keyset.
   - Evidence: phase-01:71, :75, :77, :85-86, :115-117; plan.md:33.
7. **Continuity gate.** A test requires HEAD's `release-keys.json` to share at least one byte-identical trusted keyset with the file at the newest release tag. It skips while no release tag exists, which is the case today. The workflow's verify job also runs `--verify --trusted <file at the newest release tag>` when one exists. Evidence: phase-01:71, :77; phase-02:73-75, :91-94.
8. **Meet GitHub before `latest` moves.**
   - The first verifying release, and every later one, is published first as a prerelease. GitHub's `releases/latest` skips prereleases, while the assets are already public under `/download/v<V>/`.
   - An ignored Rust test, `verifies_a_published_prerelease`, fetches `/download/v<V>/latest-linux.yml` and its signatures through `crate::http_client` and the production `fetch_and_verify`, following GitHub's redirect.
   - Only after it passes is the release marked latest.
   - `ReleaseServer` gains a 302 route, so the flow tests follow a redirect the way GitHub serves assets.
   - Evidence: phase-02:74-75; `src-tauri/src/updater/mod.rs:768-793`; phase-05:69-70.
9. **Harmless dry run.**
   - The CI dry run signs a synthetic directory: two small dummy files named for version `0.0.0-signing-check`, run through `release-feeds.ts`, under the tag `v0.0.0-signing-check`. A `0.0.0` feed is never newer than any install.
   - Only the packages, the feed and `SHA512SUMS` are uploaded.
   - Phase 1 states that it merges to `main` before the dry run, because `workflow_dispatch` and the environment's branch rule both need the workflow on `main`.
   - Evidence: phase-01:75, :77, :81, :94, :119, :147-153, :162; `scripts/release-feeds.ts:118-129`.
10. **Exercise the backup.** At key setup, restore `2026b` from the backup copy and sign the same synthetic directory locally with `--keyset 2026b`, then `--verify` it. Record both keysets' results in the PR. README → Release signing keys adds a yearly restore check of every backed-up keyset. Evidence: phase-01:92-96, :117-118, :162.
11. **Publish what was verified.**
   - `release-feeds.ts` refuses a non-empty `--out` directory. `releaseDate` is left as it is: the digest inputs and the maintainer's `cmp` catch any re-run.
   - The workflow has `concurrency: sign-release-${{ inputs.tag }}`, and `--verify` fails on unexpected `.sig`, `.pem`, `.deb` or `.AppImage` files (other assets, such as macOS files, are ignored).
   - The maintainer's final sequence — download, `cmp`, directory test, publish as prerelease, live test, mark latest — runs with no upload in between.
   - Repository setting: enable GitHub immutable releases, so published assets cannot change. GitHub's docs say only the assets and the tag lock, and the prerelease and latest flags stay editable. A deleted immutable release's tag name can never be reused.
   - The reviewer's alternative, a workflow that publishes the release itself, is not taken, because the directory test needs the maintainer's cargo build.
   - Evidence: `scripts/release-feeds.ts:173`, `:201`, `:203`; phase-01:83, :86-87.
12. **Close the `Default` bypass.** Add `<reqwest::Client as Default>::default` and `<reqwest::ClientBuilder as Default>::default` to `disallowed-methods`, plus a source test that fails on `Client::default`, `ClientBuilder::default` or a `derive(Default)` struct with a `reqwest::Client` field outside `http_client.rs`. Phase 2's live tests build their client through `crate::http_client`. Evidence: reqwest 0.13.5 `src/async_impl/client.rs:273`, `:2492`.
13. **Name freeze and replay.** Add both to NOT in scope and to the README claim ("a feed that is not newer is not checked, so the signatures do not stop someone holding back updates"); immutable releases (11) narrow it. The reviewer's suggestion to also verify a "not newer" feed on manual checks is rejected: it adds a request per check and protects only against an active attacker on github.com's classical TLS today. Evidence: `src-tauri/src/updater/mod.rs:267-270`, `:298-300`; `feed.rs:29-32`.
14. **Derive the signature name from `FEED_FILE`.** Use a pure function `signature_name(feed_file, keyset, alg)` and test it with both feed names. State that a Tauri macOS release stays blocked until `latest-mac.yml` is signed. Signing `latest-mac.yml` stays out of scope (Electron/macOS is out). Evidence: `feed.rs:21-27`; phase-02:30, :105.
15. **Narrow the guard's claim.** The guard proves that the embedded Bun runtime's defaults offer and require hybrid key exchange; it does not exercise omp's transport layer. The reviewer's second probe through omp's own requests is rejected as scope beyond the request. Evidence: phase-04:14, :33; `assistant-pack/test/compiled.test.ts:1-3`, `:36-49`; omp `packages/ai/src/utils/transport-fetch.ts:25-40`.

## Fact-check corrections to apply in the sweep

- `SAI_ATLAS_UPDATE_BASE` also appears at `README.vi.md:268` (plan.md:56 lists only some files).
- `Config` has a second test literal at `src-tauri/src/updater/mod.rs:999`; phase 2 must add `keysets` there too.
- `compiled.test.ts` lines are `:117`–`:152`, not `:120`–`:167`.
- The plan says rustls sends a key share for the first group only. It also sends the X25519 share carried inside the hybrid group (`client/hs.rs:290-299`). No conclusion changes.
- The 3.5.5 floor's stated reason is loose. CVE-2025-15469 affects `openssl dgst`, not `pkeyutl`. Keep the floor; fix the reason.

## Resolved `[UNVERIFIED]` items (Assumption Destroyer, from crate sources and upstream docs)

- reqwest 0.13.5 has every API the six call sites use, with `json` and `stream`; Linux proxy environment variables are still honoured without `system-proxy`.
- aws-lc-sys (read at 0.40.0) uses the cc builder on Linux x86_64 when bindings are pregenerated, so a C compiler (`build-essential`) is enough; CMake is not needed.
- `gh` is in Ubuntu 26.04 universe (`gh 2.46.0-4`). GitHub's `ubuntu-26.04` runner has been in public preview since 2026-06-11, so the container can be dropped once it is generally available.
- aws-lc-rs 1.18.1 exports `ML_DSA_65` and `ML_DSA_65_SIGNING` in its stable `signature` module; verification is pure ML-DSA with an empty context, matching OpenSSL `-rawin`. The interop test itself still has to run (phase 2 gate).
- rcgen 0.14.10 needs `default-features = false` with `aws_lc_rs` and `pem`, as the plan has it.

Still open: whether macOS LibreSSL accepts the probe's certificate commands, and whether Bun's `fetch` honours a per-request `tls.rejectUnauthorized`; both are settled by running phase 4's tests.

## User decision on finding 6 (2026-10-09: option b)

- **Original decision:** signing runs in CI with the current keyset's private keys as `release-signing` environment secrets; the user accepts that a GitHub takeover can sign.
- **Concern:** during a dual-signing window the plan also stores the previous signer as environment secrets. Installs one rotation behind trust exactly those two keysets, so a takeover during the window leaves them no offline keyset to recover with.
- **Options:** (a) the maintainer signs the previous half locally from the backup during the window, which keeps one keyset of every generation offline at the cost of one manual step per release in the window; (b) keep it as environment secrets and accept that risk for the window.
- **Chosen:** (b).

## Controller checks after adjudication

- The probe design from finding 1 works on Bun 1.4.2. Against a `tls.createServer` with a hand-written HTTP reply, the default `tls.connect` succeeds and an X25519-only client fails with a handshake alert. `fetch` with `tls: { rejectUnauthorized: false }` returns `200 ok`. That settles the plan's old question about `fetch` and `rejectUnauthorized` for this Bun version.
- GitHub immutable releases: only the assets and the tag lock; the title, notes, prerelease flag and latest designation stay editable; a deleted release's tag name cannot be reused (docs.github.com, "Immutable releases", read 2026-10-09).
