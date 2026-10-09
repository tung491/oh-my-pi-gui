---
phase: 2
title: "Maintainer: key setup, restore check and the CI dry run"
status: pending
priority: P1
effort: 0.25d
wave: maintainer
executor: maintainer (no agent)
dependencies: [1]
---

<!-- Updated: Validation Session 1 - 2026-10-09 - new phase, made from the former phase 1's key setup (task group B), its restore check and its CI dry run; every task is maintainer-only -->

# Phase 2: Key setup, restore check and the CI dry run (maintainer only)

## Goal

The maintainer generates the two release keysets and stores the current one as secrets of the `release-signing` environment. The maintainer keeps one backup of both outside GitHub and proves that both restore and sign. The public keys are committed with their fingerprints in both READMEs. The maintainer then runs the `sign-release` workflow on the synthetic `0.0.0-signing-check` draft, plus a wrong-digest control run. That shows the secrets, the container and `setup-bun` work before any real release depends on them. Phase 5's last task needs the committed `release-keys.json` from this phase.

Run it after phase 1 is merged to `main`. `workflow_dispatch` runs only workflows on the default branch, and the environment allows only `main`.

## Executor instruction (agents)

Executor instruction: run nothing in this phase. Print exactly `STOP_FOR_MAINTAINER: phase 2 task 2.1 needs the maintainer to generate the release keys, store them as GitHub environment secrets and run the CI dry run; an agent must not perform it.` End the phase with `Status: BLOCKED`.

Maintainer pass condition for the whole phase: every task below shows its pass condition met, recorded in the key-setup PR.

## Never (maintainer and agents)

- Never paste, print or commit a private key or a secret value. Pass keys to `gh secret set` on stdin from the file, and report only success or failure.
- Never generate keys inside the repository, and never commit a file that contains `PRIVATE KEY`.
- Never publish the `v0.0.0-signing-check` draft. With immutable releases on, a published release's tag name can never be reused. The draft is deleted, never published.
- Never sign anything but the synthetic `0.0.0-signing-check` release with a release key outside a real release.

## Files this phase owns

| Path | Action |
|---|---|
| `src-tauri/src/updater/release-keys.json` | create (maintainer only) |
| `README.md`, `README.vi.md` | replace the four `—` fingerprint cells of the "Verify a download" table that phase 1 added |
| GitHub settings | the `release-signing` environment, its secrets and variable, immutable releases; the `v0.0.0-signing-check` tag and draft, which are deleted at the end |

## Tasks (maintainer)

### Task 2.1 — Phase 1 is on `main`

- **Goal:** the workflow exists on the default branch.
- **Executor instruction:** run nothing in this task. Print exactly `STOP_FOR_MAINTAINER: phase 2 task 2.1 needs the maintainer to confirm phase 1 is merged to main; an agent must not perform it.` End the phase with `Status: BLOCKED`.
- **Maintainer steps:** `git fetch origin && git show origin/main:.github/workflows/sign-release.yml >/dev/null; echo $?`
- **Maintainer pass condition:** the command prints `0`.

### Task 2.2 — Generate both keysets and write `release-keys.json`

- **Goal:** `2026a` and `2026b` exist on the maintainer's machine, and the working tree has `release-keys.json` with both.
- **Executor instruction:** run nothing in this task. Print exactly `STOP_FOR_MAINTAINER: phase 2 task 2.2 needs the maintainer to generate the release keysets; an agent must not perform it.` End the phase with `Status: BLOCKED`.
- **Maintainer steps:** on a machine with OpenSSL ≥ 3.5.5:
  ```bash
  K=$(mktemp -d /tmp/sai-atlas-keys.XXXXXX); chmod 700 "$K"; cd "$K"; umask 077
  for k in 2026a 2026b; do
    openssl genpkey -algorithm ML-DSA-65 -out "$k-mldsa65.key"
    openssl genpkey -algorithm ED25519 -out "$k-ed25519.key"
  done
  pub() { openssl pkey -in "$1" -pubout -outform DER | base64 -w0; }
  printf '{\n  "keysets": [\n    { "id": "2026a", "mlDsa65": "%s", "ed25519": "%s" },\n    { "id": "2026b", "mlDsa65": "%s", "ed25519": "%s" }\n  ],\n  "retiredSigners": []\n}\n' \
    "$(pub 2026a-mldsa65.key)" "$(pub 2026a-ed25519.key)" "$(pub 2026b-mldsa65.key)" "$(pub 2026b-ed25519.key)" \
    > <repo>/src-tauri/src/updater/release-keys.json
  echo "$K"
  ```
  Replace `<repo>` with the GUI checkout on `main`, in a new branch, for example `release-keys`.
- **Maintainer pass condition:** `bun scripts/sign-release.ts --fingerprints` in the repository prints four rows: `2026a` ML-DSA-65 and Ed25519, then `2026b` ML-DSA-65 and Ed25519.

### Task 2.3 — The environment, the secrets and immutable releases

- **Goal:** only an approved run on `main` can read the `2026a` private keys, and published releases cannot change.
- **Executor instruction:** run nothing in this task. Print exactly `STOP_FOR_MAINTAINER: phase 2 task 2.3 needs the maintainer to create the release-signing environment and its secrets; an agent must not perform it.` End the phase with `Status: BLOCKED`.
- **Maintainer steps:**
  1. Go to GitHub → `tung491/oh-my-pi-gui` → Settings → Environments → New environment `release-signing`. Set deployment branches to "Selected branches" with `main` only, and add yourself as a required reviewer.
  2. In the key directory from task 2.2:
     ```bash
     gh secret set RELEASE_SIGNING_MLDSA65_KEY --env release-signing --repo tung491/oh-my-pi-gui < 2026a-mldsa65.key
     gh secret set RELEASE_SIGNING_ED25519_KEY --env release-signing --repo tung491/oh-my-pi-gui < 2026a-ed25519.key
     gh variable set RELEASE_SIGNING_KEYSET --env release-signing --repo tung491/oh-my-pi-gui --body 2026a
     ```
  3. Go to Settings → General → Releases and enable immutable releases.
- **Maintainer pass condition:**
  - `gh secret list --env release-signing --repo tung491/oh-my-pi-gui` lists the two secret names. It never prints the values.
  - `gh variable list --env release-signing --repo tung491/oh-my-pi-gui` shows `RELEASE_SIGNING_KEYSET 2026a`.
  - The Releases setting shows immutable releases on.

### Task 2.4 — Backup and restore check for both keysets

- **Goal:** the backup outside GitHub restores, and both keysets sign a release that `--verify` accepts.
- **Executor instruction:** run nothing in this task. Print exactly `STOP_FOR_MAINTAINER: phase 2 task 2.4 needs the maintainer to back up the keys and run the restore check; an agent must not perform it.` End the phase with `Status: BLOCKED`.
- **Maintainer steps:**
  1. Copy the four `.key` files into the backup you control, such as a password manager entry or an encrypted USB drive.
  2. Delete the key directory from task 2.2: `rm -rf "$K"`.
  3. For each `id` in `2026a` and `2026b`, in the repository, run as one shell:
     ```bash
     set -euo pipefail
     W=$(mktemp -d /tmp/sai-atlas-restore.XXXXXX); chmod 700 "$W"; mkdir -p "$W/keys" "$W/src/appimage" "$W/src/deb"
     # copy <id>-mldsa65.key and <id>-ed25519.key from the backup into "$W/keys" now
     printf 'signing check\n' > "$W/src/appimage/Sai ATLAS_0.0.0-signing-check_amd64.AppImage"
     printf 'signing check\n' > "$W/src/deb/Sai ATLAS_0.0.0-signing-check_amd64.deb"
     bun scripts/release-feeds.ts --version 0.0.0-signing-check --linux "$W/src" --out "$W/rel"
     bun scripts/sign-release.ts --keys "$W/keys" --keyset <id> "$W/rel"
     bun scripts/sign-release.ts --verify --tag v0.0.0-signing-check "$W/rel"
     rm -rf "$W"
     ```
- **Maintainer pass condition:** both runs end without an error, and `--verify` prints its `ok` lines. Record "restore check passed for 2026a and 2026b on <date>" in the PR.

### Task 2.5 — Fingerprints in both READMEs, then commit the public keys

- **Goal:** `main` holds `release-keys.json` and README fingerprints that match it.
- **Executor instruction:** run nothing in this task. Print exactly `STOP_FOR_MAINTAINER: phase 2 task 2.5 needs the maintainer to commit release-keys.json; an agent must not perform it.` End the phase with `Status: BLOCKED`.
- **Maintainer steps:**
  1. Run `bun scripts/sign-release.ts --fingerprints`. In README.md and README.vi.md, replace each `—` in the fingerprint table with the hex for that keyset and algorithm.
  2. Run:
     ```bash
     bunx vitest run scripts/sign-release.test.ts 2>&1 | tee /tmp/p2-sign.log | tail -5
     grep -c 'SKIP: src-tauri/src/updater/release-keys.json is not committed yet' /tmp/p2-sign.log
     git grep -n "PRIVATE KEY"; grep -rl "PRIVATE KEY" src-tauri scripts .github README.md README.vi.md
     ```
  3. Commit `src-tauri/src/updater/release-keys.json`, README.md and README.vi.md only, with message `feat(release): add the release signing public keys`. Open the PR with the four fingerprints and the restore-check line, and merge it to `main`.
- **Maintainer pass condition:**
  - The vitest run shows `19 passed | 1 skipped`: only the continuity test skips, because no release tag holds the file yet.
  - The `grep -c` prints `0`.
  - Both private-key searches print nothing.
  - The PR is merged.

### Task 2.6 — CI dry run on the synthetic draft

- **Goal:** the real secrets sign the synthetic draft in CI, `--verify` passes there, and a wrong digest fails before signing.
- **Executor instruction:** run nothing in this task. Print exactly `STOP_FOR_MAINTAINER: phase 2 task 2.6 needs the maintainer to run the sign-release workflow on the synthetic draft; an agent must not perform it.` End the phase with `Status: BLOCKED`.
- **Maintainer steps** (in the repository, on an up-to-date `main`):
  ```bash
  set -euo pipefail
  W=$(mktemp -d /tmp/sai-atlas-dry.XXXXXX); mkdir -p "$W/src/appimage" "$W/src/deb"
  printf 'signing check\n' > "$W/src/appimage/Sai ATLAS_0.0.0-signing-check_amd64.AppImage"
  printf 'signing check\n' > "$W/src/deb/Sai ATLAS_0.0.0-signing-check_amd64.deb"
  bun scripts/release-feeds.ts --version 0.0.0-signing-check --linux "$W/src" --out "$W/rel"
  git tag v0.0.0-signing-check origin/main && git push origin v0.0.0-signing-check
  gh release create v0.0.0-signing-check --draft --title "signing check (never published)" --notes "Synthetic signing check; deleted after the run." "$W"/rel/*
  gh workflow run sign-release.yml -f tag=v0.0.0-signing-check -f feed_sha256="$(sha256sum "$W/rel/latest-linux.yml" | cut -d' ' -f1)" -f sums_sha256="$(sha256sum "$W/rel/SHA512SUMS" | cut -d' ' -f1)"
  sleep 10; RUN=$(gh run list --workflow sign-release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
  echo "approve run $RUN in the browser (Actions → the run → Review deployments)"; gh run watch "$RUN" --exit-status
  gh run view "$RUN" --log | grep -c 'PRIVATE KEY' || true
  rm -rf "$HOME/sai-atlas-signing-check"; gh release download v0.0.0-signing-check -D "$HOME/sai-atlas-signing-check"
  # negative control: a wrong feed digest
  gh workflow run sign-release.yml -f tag=v0.0.0-signing-check -f feed_sha256="$(printf '0%.0s' $(seq 64))" -f sums_sha256="$(sha256sum "$W/rel/SHA512SUMS" | cut -d' ' -f1)"
  sleep 10; BAD=$(gh run list --workflow sign-release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
  echo "approve run $BAD"; gh run watch "$BAD" --exit-status || echo "control failed as expected"
  gh run view "$BAD" --json jobs --jq '.jobs[0].steps[] | "\(.name) \(.conclusion)"'
  gh release delete v0.0.0-signing-check --cleanup-tag --yes; git tag -d v0.0.0-signing-check
  rm -rf "$W"
  ```
  `$HOME/sai-atlas-signing-check` holds only public files: the synthetic packages, the feed, `SHA512SUMS`, the signatures and the PEM keys. Phase 5's last task runs the app's verifier on it. Delete it after phase 5 completes.
- **Maintainer pass condition:**
  - The first run succeeds. Its last step prints `--verify`'s `ok` lines.
  - The `grep -c 'PRIVATE KEY'` prints `0`.
  - `$HOME/sai-atlas-signing-check` holds four `.2026a.` signature files and two `sai-atlas-release-2026a-*.pem` files.
  - The control run fails at `Check the inputs and the draft`, and `Sign` shows `skipped`.
  - `gh release view v0.0.0-signing-check` then fails with `release not found`.
  - Record the two run URLs in the key-setup PR.

## Risks

| Risk | Likelihood × impact | Mitigation |
|---|---|---|
| The wrong key is stored as a secret, or the backup is damaged | Low × High | The workflow's self-verify fails when a private key does not match the trusted file. The dry run catches it before a real release, and the restore check proves both backed-up keysets sign. |
| The container lacks a tool or `setup-bun` fails inside it | Medium × Low | The dry run shows it. Fix the workflow in a follow-up PR, which runs phase 1's workflow tests, and repeat task 2.6. |
| `gh release download` or `upload` cannot see the draft in CI | Low × Medium | `gh` finds drafts by tag name. If the dry run fails here, switch those calls to the REST API with the release id in a follow-up PR. |
| The tag `v0.0.0-signing-check` is published by mistake | Low × Low | Its tag name can never be reused. Use `v0.0.1-signing-check` for later dry runs; it is still never newer than any install. |

## Rollback

Delete the draft and the tag if a failed run left them. Revert the key-setup PR only if no later work depends on it. Keep the secrets and the backup either way.

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
