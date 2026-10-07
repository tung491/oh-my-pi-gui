---
title: "Everyday-work rebrand implemented: the egress audit found two cloud calls, release checks found two process bugs"
date: 2026-10-07
summary: "All 9 phases merged on rebrand/everyday-work; the egress audit, offline checks in en and vi, and the full gate pass on the final deb; the release step is the user's."
---

# Everyday-work rebrand implemented: the egress audit found two cloud calls, release checks found two process bugs

## What happened
Phases 1–8 and the Phase 9 work up to the release step are merged on `rebrand/everyday-work` (head `c610616`). The final `.deb` (sha256 `550c4ca6…`) passes:
- the full gate and the clean-clone CI check;
- the deb smoke, fake-microphone and window-geometry checks, and both e2e suites;
- the offline checks in English and Vietnamese.

The egress audit (`plans/reports/egress-audit-261005-everyday-work-rebrand.md`) found two destinations that were not allowed. Both causes were proven:
- **npm.** Settings › Updates asked npm for omp's version (`get_omp_update`). That call is removed; the page checks only the app's GitHub releases.
- **ollama.com.** Ollama 0.35 fetches model recommendations from ollama.com every ~4 h. `OLLAMA_NO_CLOUD=1` stops it and keeps downloads working. The welcome screen's start/install step writes it as a drop-in, and the `.deb` ships it at `/usr/lib/systemd/system/ollama.service.d/sai-atlas.conf`. That file applies after a reboot, because the package runs no install script.

The LibreOffice timeout check found two bugs in how processes are cleaned up:
- **Hanging conversions.** Under Bun, `execFile`'s timeout never settles once LibreOffice's launcher is stopped, so a stuck conversion hung the tool call forever. LibreOffice now runs in its own process group and is group-killed (`88ea3cd`).
- **Dead processes until quit.** The Tauri supervisor is the subreaper for tool processes, but it reaped orphans only at shutdown, so every orphan stayed a zombie until the app quit. It now reaps on SIGCHLD, peeking with `waitid(WNOWAIT)` so omp's own status still reaches `child.wait()` (`89a610d`).

The Vietnamese pass found raw tool ids in approvals, English pack summaries and file suffixes, `<html lang="en">`, and an English plural "s" appended to Vietnamese counts. All are fixed.

## Decision
- **Kept:** local Ollama only, on this computer only; Ubuntu GNOME only; typed office tools with no bash.
- **Settled during review and release (user decisions, recorded in plan.md Decisions):**
  - The deb ships the no-cloud drop-in.
  - Approvals show plain sentences.
  - Pack text follows `SAI_ATLAS_LANG`.
  - A language switch reaches the assistant at the next launch.
  - "Agent" stays.
- **Stale tests rewritten, not loosened:** the hard-kill smoke used the removed `!` shell shortcut.

## Next steps
The user's release step, Task 9.7 step 4:
1. Keep the audited Linux sidecar and rebuild the macOS sidecars.
2. Pack-check each sidecar.
3. Bump the version, tag, build, then make a draft release.

Nothing is published without the user's go. Open follow-ups are in plan.md "Follow-ups after this plan".

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
