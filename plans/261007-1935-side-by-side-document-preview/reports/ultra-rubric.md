# Ultra verifier rubric — side-by-side document preview

Score each candidate 1–20 per criterion, with evidence (cite candidate section and,
where it makes a codebase claim, whether the claim holds at the cited file).

## Hard constraints (any failure = candidate ineligible)

- H1. Renders in-app with JS only; no LibreOffice/soffice/server conversion at run time.
- H2. Works in both shells: every new IPC command has Electron + Tauri handlers,
  bridge, types, Rust tests with TS twins, snapshots.
- H3. Keeps the CSP (or changes it explicitly with the guard test updated and a reason).
- H4. Untrusted document/model content is never injected unsanitized into the
  main document; no script execution path from a document.
- H5. Heavy renderer libraries are lazy (dynamic import + chunk rule + `LAZY_CHUNKS`).
- H6. Every phase follows the `--advice` handover contract (ordered tasks with
  Goal / Target files & symbols / Steps / Success criteria / mechanical Verify)
  and contains the verbatim Failure Protocol block.
- H7. `--tdd`: each phase states failing tests first with the expected red state
  written as a pass condition, then green.

## Weighted criteria

| # | Criterion | Weight |
|---|---|---|
| C1 | Outcome fit: genuinely side by side with the chat, input AND output files, docx/pptx/xlsx/pdf (+csv/images/text) covered, read-only | 3 |
| C2 | Grounding: file paths, symbols, commands and contracts match the real repo (verify a sample) | 3 |
| C3 | Executability by a weaker model: no inferred steps, exact paths, decidable Verify | 3 |
| C4 | Security & robustness: isolation of rendered HTML, path policy, size caps, corrupt/large file handling, staleness | 2 |
| C5 | Test design: matrix quality, realistic fixtures (assistant-pack fixtures), e2e on Tauri | 2 |
| C6 | Simplicity (KISS/DRY): reuses the drawer/Files preview/sniffers, minimal new IPC, sensible phase count, no unrequested scope | 2 |
| C7 | Coordination with the pending attachment-cards plan (shared PDF loader / byte IPC, behavior with or without it) | 1 |

Return: per-candidate scores, hard-constraint pass/fail, ranking, winner (or
reject-all with reasons), margin note, confidence.
