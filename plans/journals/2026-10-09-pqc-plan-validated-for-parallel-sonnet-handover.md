---
title: PQC plan validated for parallel Sonnet handover
date: 2026-10-09
summary: Signed-releases + hybrid-TLS plan restructured into 6 phases / 3 waves with TDD Verify lines; kongming handover review BLOCK then PASS
---

# PQC plan validated for parallel Sonnet handover

## What happened
`/ak-plan validate plans/261009-0433-pqc-signed-releases-hybrid-tls --parallel --tdd --advice` ran a 6-question interview. The plan was then rebuilt for Sonnet executors.

**Answers.**
- Phase 1 goes in its own PR.
- Sonnet runs every agent phase.
- The verifier starts early on fixture keys.
- The last phase is held for release day.
- The sidecar is copied in, not rebuilt.
- Executors may install `cargo-public-api` 0.52.0 and `nightly-2026-10-01` if missing.

**New phase layout.**
- Wave 1: phases 1, 3 and 4 (signing tooling, hybrid TLS in the Tauri core, sidecar TLS guard).
- Maintainer: phase 2 (key setup and the CI dry run).
- Wave 2: phase 5 (the fail-closed verifier). Task 5.11 waits for the committed `release-keys.json`.
- Wave 3: phase 6 (claims and the first verifying release, on release day).

**Format.** Every task gives Goal, Target files and symbols, Steps, Success criteria and Verify. Code tasks have RED and GREEN lines. Each phase has a Never block and the literal Failure Protocol, and plan.md has wave gates and shared-worktree rules.

## Findings worth keeping
- **Clippy `Default` routes.** Clippy 0.1.98 `disallowed-methods` silently ignores `<reqwest::Client as Default>::default`, and `-D warnings` does not promote the warning. The `Default` routes are covered by a source test (`no_other_module_builds_a_client_through_default`), not by clippy.
- **Filtered test runs.** The src-tauri crate has six test targets, so `cargo test <filter> | tail` loses the library's `test result:` line. Every filtered Verify now passes `--lib`, writes a log and greps it.
- **i18n mirror test.** Its first assertion compares key counts. A new Rust-only key's RED therefore shows `left == right`, not the key name.
- **Wycheproof.** At commit `12fd3aa`: 203 ML-DSA-65 verify vectors without a context, and 151 Ed25519 vectors.
- **tauri-cli** is missing on the host, and `check-module.sh` needs it. It is a maintainer prerequisite.

## Decision
The kongming handover review first returned BLOCK. It had five false-verdict defects:
- the `tail` widths;
- the i18n RED;
- dead code under clippy;
- an AGENTS.md count;
- the panic-message tail.

It also flagged six improvisation risks. All were fixed, and the recheck returned PASS.

## Next steps
- **Maintainer:** install tauri-cli 2.
- **Run waves 1-2:** `/ak:cook plans/261009-0433-pqc-signed-releases-hybrid-tls/plan.md --parallel --advice`.
- **Maintainer:** phase 2 after phase 1 merges.
- **Release day:** phase 6.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
