---
phase: 1
title: "Document byte channel and mailto opener"
status: pending
priority: P1
effort: "6h"
dependencies: []
---
# Phase 1: Document byte channel and mailto opener

## Goal

Add `fs:read-document` to both shells. It returns the base64 bytes, size,
mtime, resolved absolute path and signature of a PDF, ZIP (OOXML/ODF), OLE
(legacy .xls) or HTML-table spreadsheet file. The read is bounded: it opens the
file once and never reads more than the 32 MiB cap plus one byte, even when the
file grows after `fstat`. An optional `ifChanged` stamp makes the call return
`unchanged` without bytes when size and mtime still match, which drives the
event-driven refresh in Phase 2. In the Tauri shell the handler returns
`Reply::Later` and does the I/O on a blocking thread with a timeout, so a slow
or hung mount never stalls the window's other calls. Both shells return
byte-identical JSON shapes, with Rust twins for every TS test.

Images are **not** read through this channel: they keep `fs:read-image`, and
`sniffImageMime` stays where it is.
<!-- Red team: K6, K7 -->

Also widen `system:open-external` to accept `mailto:` in both shells, with twin
tests, so a mail link in a document reaches the mail client.
<!-- Validation: mailto -->

## Files to Create / Modify

<!-- Red team: R2, R4, R15 -->
- **Create:**
  - `src/main/fs-read-document.ts`, `src/main/fs-read-document.test.ts`
  - `src/main/external-url.ts`, `src/main/external-url.test.ts`
- **Modify:**
  - `src/shared/ipc-types.ts`: `IPC_COMMANDS` after `FS_READ_PDF`; new types after `IpcFsReadPdfResult`; `OmpApi["fs"]` after `readPdf`.
  - `src/shared/bridge/create-omp-api.ts`: the `fs:` block, after `readPdf`.
  - `src/shared/bridge/create-omp-api.test.ts`
  - `src/main/ipc.ts`: a handler after the `FS_READ_PDF` handler; the `SYSTEM_OPEN_EXTERNAL` handler (today `ipc.ts:733-737`) calls `isAllowedExternalUrl`. The `gui_open_url` host tool (`ipc.ts:1174`) stays http/https only and is not touched.
  - `src-tauri/src/services/ipc.rs`: `fs_read_document` after `fs_read_pdf`; new tests in `mod tests`.
  - `src-tauri/src/services/system.rs`: `allowed_external_url` (`system.rs:15-17`) accepts `mailto:`; new `allowed_web_url` keeps the old http/https rule; test renames in its `mod tests`.
  - `src-tauri/src/services/host_tools.rs`: `gui_open_url` (`host_tools.rs:18`) calls `allowed_web_url`, so the agent's tool stays http/https only.
  - `src-tauri/src/lib.rs`: the production host's `open_url` (`lib.rs:208-214`) also accepts `mailto:`. It is the second guard behind `system:open-external`.
  - `src-tauri/src/testing.rs`: the fake host's `open_url` (`testing.rs:122-129`) accepts `mailto:` the same way.
  - `src-tauri/src/services/mod.rs`: the `CHANNELS` table (the `("fs:read-pdf", Scope::Main)` row) and `register` (the `fs:read-pdf` line).
  - `src-tauri/tests/channels.rs`: `EXPECTED_CHANNEL_COUNT` (`channels.rs:14`).
  - `src-tauri/contracts/services.api.txt` **and** `src-tauri/contracts/ports.api.txt`: every handler takes `sai_atlas_lib::ports::Caller`, so `check-module.sh` (`scripts/check-module.sh:121-122`) lists it in the `ports` snapshot too (`ports.api.txt:857-859` holds `fs_read`, `fs_read_image`, `fs_read_pdf`).
  - `src-tauri/contracts/services.parity.json`

## Test Matrix (TDD)

| Case | Test file | Red (before code) | Green |
|---|---|---|---|
| `document read returns a docx as base64 with the zip signature` | `src/main/fs-read-document.test.ts` | vitest exit 1, "Failed to resolve import" | pass |
| `document read returns a legacy xls with the ole signature` | same | exit 1 | pass |
| `document read returns an html spreadsheet export with the html signature` <!-- Red team: K11 --> | same | exit 1 | pass |
| `document read returns a pdf with the pdf signature` | same | exit 1 | pass |
| `document read rejects bytes with no known signature as unsupported` (a PNG and plain text both refused) <!-- Red team: K7 --> | same | exit 1 | pass |
| `document read rejects a file over the size cap as too large` | same | exit 1 | pass |
| `document read refuses a file that grows past the cap after it was opened` <!-- Red team: R4 --> | same | exit 1 | pass |
| `document read returns unchanged without data when the stamp matches` <!-- Validation: refresh --> | same | exit 1 | pass |
| `document read returns the bytes when the stamp is stale` <!-- Validation: refresh --> | same | exit 1 | pass |
| `document read rejects a directory as not a file` | same | exit 1 | pass |
| `document read reports a missing file as not ok` | same | exit 1 | pass |
| The same 11 names in snake_case | `src-tauri/src/services/ipc.rs` `mod tests` | `cargo test … document` fails to compile (exit 101) | pass |
| `dispatches_fs_read_document_as_a_deferred_reply` (Rust only: the handler returns `Reply::Later`) <!-- Red team: R4 --> | `ipc.rs` `mod tests` | compile error | pass |
| `reads a document over its own channel with tab and change stamp` | `src/shared/bridge/create-omp-api.test.ts` | exit 1, `readDocument is not a function` | pass |
| `allows http https and mailto urls` <!-- Validation: mailto --> | `src/main/external-url.test.ts` | exit 1 (missing module) | pass |
| `refuses file javascript and data urls` | same | exit 1 | pass |
| The same 2 names in snake_case | `src-tauri/src/services/system.rs` `mod tests` | `allows_http_https_and_mailto_urls` fails (mailto refused) | pass |
| `the host tool still refuses mailto urls` (Rust only: `allowed_web_url`) | `system.rs` `mod tests` | compile error | pass |
| Channel count and scope parity | `src-tauri/tests/channels.rs` | fails once the TS command exists without a Rust registration | pass |

## Tasks

### Task 1.1 — Precondition: the sibling plan is committed
- **Goal:** Never edit shared contract files while the attachment-cards work is uncommitted.
- **Target files and symbols:** none modified.
- **Steps:**
  1. Run `git ls-files --error-unmatch src/main/fs-read-pdf.ts src/renderer/lib/pdf-thumbnail.ts src/renderer/components/attachments/AttachmentCard.tsx`.
  2. Run `git status --porcelain src src-tauri e2e e2e-tauri | wc -l`.
  3. Record `git rev-parse HEAD` as the plan-start commit. The final phase's CSP check compares against it.
  4. Record the current value: `grep -n "EXPECTED_CHANNEL_COUNT: usize" src-tauri/tests/channels.rs`. Task 1.5 raises it by exactly 1 from this recorded value. <!-- Red team: K1 -->
- **Success criteria:** All three files are tracked, the tree under those dirs is clean, and the channel count is recorded.
- **Verify:**
  - Step 1 exits 0.
  - Step 2 prints exactly `0`.
  - Step 4 prints one line.

### Task 1.2 — Red: TS tests for the document reader
- **Goal:** Pin the result shape before writing the code.
- **Target files and symbols:** create `src/main/fs-read-document.test.ts`, importing `readDocumentFile` and `FS_DOCUMENT_MAX_BYTES` from `./fs-read-document`.
- **Steps:**
  1. Copy the harness from `src/main/fs-read-pdf.test.ts`: a `mkdtempSync` dir in `beforeEach` and `rmSync` in `afterEach`.
  2. Define these byte constants:
     - `ZIP = Buffer.from([0x50,0x4b,0x03,0x04,0x14,0,0,0])`
     - `OLE = Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1,0,0])`
     - `HTML = Buffer.from("﻿  <html><body><table><tr><td>a</td></tr></table></body></html>", "utf8")`
     - `PDF = Buffer.from("%PDF-1.7\n%âã\n", "latin1")`
     - `PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")`
  3. Write the 11 `it(...)` cases with the exact titles from the Test Matrix, under `describe("readDocumentFile", …)`. `stamp(file)` is `{ size, mtimeMs: Math.floor(statSync(file).mtimeMs) }`. Expected values (use `toEqual`):
     - **docx:** `{ ok: true, data: ZIP.toString("base64"), ...stamp, resolvedPath: file, signature: "zip" }`.
     - **xls:** the same shape with `signature: "ole"`.
     - **html export named `a.xls`:** the same shape with `signature: "html"`.
     - **pdf:** the same shape with `signature: "pdf"`.
     - **no signature:** `PNG` named `a.png` and `"hello"` named `a.docx` each give `{ ok: false, ...stamp, resolvedPath: file, error: "unsupported" }`.
     - **10 bytes with `maxBytes: 4`:** `{ ok: false, size: 10, mtimeMs: <floor>, resolvedPath: file, error: "too-large" }`.
     - **grows after open:** a 4-byte `ZIP.subarray(0,4)` file, `maxBytes: 8`, and the test-only option `afterOpen: () => appendFileSync(file, Buffer.alloc(16))`. Expect `ok === false` and `error === "too-large"`.
     - **matching stamp:** write `ZIP`, call with `ifChanged: stamp(file)`. Expect `{ ok: true, unchanged: true, ...stamp, resolvedPath: file }` and `"data" in result === false`.
     - **stale stamp:** call with `ifChanged: { size: stamp.size + 1, mtimeMs: stamp.mtimeMs }`. Expect the full docx shape.
     - **directory:** `{ ok: false, size: 0, mtimeMs: 0, resolvedPath: dir, error: "not-a-file" }`.
     - **missing file:** `ok === false`, `size === 0`, and `typeof error === "string"`.
  4. Run the tests.
- **Success criteria:** The test file exists, and it fails only because the module is missing.
- **Verify:** `bunx vitest run src/main/fs-read-document.test.ts; echo "exit=$?"` prints a line containing `Failed to resolve import "./fs-read-document"` and ends with `exit=1`.

### Task 1.3 — Green: the TS document reader
<!-- Red team: R4, K6, K7, K11 -->
- **Goal:** One pure, absolute-path, bounded reader that the Electron handler calls.
- **Target files and symbols:**
  - Create `src/main/fs-read-document.ts` with these exports: `FS_DOCUMENT_MAX_BYTES = 32 * 1024 * 1024`, `documentSignature(header: Buffer): IpcDocumentSignature | null`, and `readDocumentFile(abs: string, options?: { maxBytes?: number; ifChanged?: { size: number; mtimeMs: number }; afterOpen?: () => void | Promise<void> }): Promise<IpcFsReadDocumentResult>`. `afterOpen` exists only so the growth test can append between `fstat` and the read; production callers never pass it.
  - `src/shared/ipc-types.ts`: the types from plan.md "Shared contracts".
- **Steps:**
  1. Add the plan.md contract types and `FS_READ_DOCUMENT: "fs:read-document"` to `src/shared/ipc-types.ts`. Give the constant a one-line doc comment in the style of `FS_READ_PDF`: "Read a document's bytes (PDF, ZIP, OLE or HTML-table signature; bounded by a size cap), or report that it is unchanged since a size and mtime stamp, for the in-app preview".
  2. Implement `documentSignature(header)` with these checks, in order:
     - `%PDF-` → `pdf`;
     - `50 4b 03 04` → `zip`;
     - `d0 cf 11 e0 a1 b1 1a e1` → `ole`;
     - after skipping a UTF-8 BOM and ASCII whitespace, the lowercased bytes start with `<!doctype html`, `<html` or `<table` → `html`;
     - otherwise `null`. Images return `null`: they are read through `fs:read-image`.
  3. Implement `readDocumentFile`. Mirror the sibling's bounded PDF read (`read_pdf_bytes` in `src-tauri/src/services/ipc.rs`, which reads at most one byte past the cap):
     1. `handle = await fsp.open(abs, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)` so a FIFO cannot stall the open. On a throw, return `{ ok: false, size: 0, mtimeMs: 0, error: <message> }`.
     2. `stat = await handle.stat()`. If it is not a file, return `{ ok: false, size: 0, mtimeMs: 0, resolvedPath: abs, error: "not-a-file" }`.
     3. Set `mtimeMs = Math.floor(stat.mtimeMs)`, `cap = maxBytes ?? FS_DOCUMENT_MAX_BYTES`.
     4. If `ifChanged` matches `stat.size` and `mtimeMs`, return `{ ok: true, unchanged: true, size: stat.size, mtimeMs, resolvedPath: abs }`.
     5. If `stat.size > cap`, return `{ ok: false, size: stat.size, mtimeMs, resolvedPath: abs, error: "too-large" }`.
     6. `await options.afterOpen?.()`.
     7. Read into a `Buffer.alloc(cap + 1)` with `handle.read` in a loop until EOF or `cap + 1` bytes. If more than `cap` bytes arrived, return `too-large` with `size` = bytes read.
     8. Run `documentSignature(bytes.subarray(0, 512))`. If it is null, return `{ ok: false, size: stat.size, mtimeMs, resolvedPath: abs, error: "unsupported" }`.
     9. Otherwise return `{ ok: true, data: base64, size: bytesRead, mtimeMs, resolvedPath: abs, signature }`.
     10. Close the handle in `finally`. Wrap the whole function in a try/catch, so it never throws.
  4. Run the tests.
- **Success criteria:** All 11 cases pass. `src/main/ipc.ts` is not yet touched, so `sniffImageMime` and `fs:read-image` are unchanged.
- **Verify:**
  - `bunx vitest run src/main/fs-read-document.test.ts; echo "exit=$?"` ends with `exit=0`.
  - `bun run check:types; echo "exit=$?"` ends with `exit=0`.

### Task 1.4 — Electron handler and bridge (red, then green)
- **Goal:** Expose the reader as `window.omp.fs.readDocument` in Electron.
- **Target files and symbols:** `src/shared/bridge/create-omp-api.test.ts` (a new `it`); `create-omp-api.ts` `fs.readDocument`; `OmpApi["fs"].readDocument`; `src/main/ipc.ts` `ipcMain.handle(IPC_COMMANDS.FS_READ_DOCUMENT, …)`.
- **Steps:**
  1. **Red.** Add `it("reads a document over its own channel with tab and change stamp", …)`, using the existing `fakePort` helper. It calls `api.fs.readDocument("docs/a.docx", { tabId: "t1", ifChanged: { size: 3, mtimeMs: 7 } })` and expects `invokes` to equal `[{ channel: IPC_COMMANDS.FS_READ_DOCUMENT, args: [{ path: "docs/a.docx", tabId: "t1", ifChanged: { size: 3, mtimeMs: 7 } }] }]`. Run it; it must fail.
  2. **Green.** In `create-omp-api.ts`, add `readDocument: (path: string, options: { tabId?: string; ifChanged?: { size: number; mtimeMs: number } } = {}) => port.invoke(IPC_COMMANDS.FS_READ_DOCUMENT, { path, tabId: options.tabId, ifChanged: options.ifChanged }) as Promise<IpcFsReadDocumentResult>` after `readPdf`. Add the method to `OmpApi["fs"]` in `ipc-types.ts`.
  3. In `src/main/ipc.ts`, add `import { readDocumentFile } from "./fs-read-document";`. After the `FS_READ_PDF` handler, add an async handler `(event, payload: IpcFsReadDocumentPayload | undefined)`:
     1. If `payload?.path` is not a non-empty string, return `{ ok: false, size: 0, mtimeMs: 0, error: "invalid-path" }`.
     2. Expand a leading `~/` with `os.homedir()`.
     3. If the path is absolute, use `path.normalize(raw)`.
     4. Otherwise get `cwdFor(deps, event, payload.tabId)` (`ipc.ts:104`). If it is null, return `error: "no-workspace"`.
     5. Then `resolveWithin(cwd, raw)` (`ipc.ts:241`). If it is null, return `error: "outside-workspace"`.
     6. Accept `ifChanged` only when both fields are finite numbers. Return `readDocumentFile(abs, { ifChanged })`.
- **Success criteria:** The bridge test passes, and the types compile.
- **Verify:**
  - `bunx vitest run src/shared/bridge/create-omp-api.test.ts; echo "exit=$?"` ends with `exit=1` after step 1, and with `exit=0` after step 3.
  - `bun run check:types; echo "exit=$?"` ends with `exit=0`.

### Task 1.5 — Rust handler with twin tests (red, then green)
<!-- Red team: R4, K1 -->
- **Goal:** Byte-identical behaviour in the Tauri shell, without blocking the window's call queue.
- **Target files and symbols:** `src-tauri/src/services/ipc.rs`: `pub fn fs_read_document(ctx: &Arc<AppCtx>, caller: Caller, args: Vec<Value>) -> Reply`, private `fn read_document_file(abs: &Path, max_bytes: u64, if_changed: Option<(u64, u64)>) -> Value`, private `fn read_document_with(abs: &Path, max_bytes: u64, if_changed: Option<(u64, u64)>, after_open: impl FnOnce()) -> Value`, private `fn document_signature(header: &[u8]) -> Option<&'static str>`, `const FS_DOCUMENT_MAX_BYTES: u64 = 32 * 1024 * 1024;` and `const DOCUMENT_READ_TIMEOUT: Duration = Duration::from_secs(30);`.
- **Steps:**
  1. **Red.** In `mod tests`, add 11 `#[test]` functions whose names are the snake_case of the TS titles, for example `document_read_returns_a_docx_as_base64_with_the_zip_signature`.
     - Each writes the same bytes into a `tempfile::tempdir()`, calls `super::read_document_file(&path, super::FS_DOCUMENT_MAX_BYTES, None)` and asserts `assert_eq!` on the same `json!` shape as the TS test, including `"resolvedPath"`.
     - The too-large case passes `4`. The growth case calls `super::read_document_with(&path, 8, None, || { /* append 16 bytes with OpenOptions::append */ })`. The stamp cases pass `Some((size, mtime_ms))`.
     - Compute `mtimeMs` as `std::fs::metadata(&p).unwrap().modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64`.
     - Add the Rust-only `#[tokio::test] async fn dispatches_fs_read_document_as_a_deferred_reply()`: build `ctx(&fakes)` as `dispatches_fs_read_pdf_without_throwing` does, call `super::fs_read_document(&ctx, Caller::main(WindowId(1)), vec![json!({ "path": "/nonexistent/a.docx" })])`, and `assert!(matches!(reply, crate::bridge::Reply::Later(_)))`.
     - Run the tests.
  2. **Green.** Implement `document_signature` with the same order and HTML rule as TS.
  3. Implement `read_document_with`. Open with the sibling's `open_for_sniff` (the `O_NONBLOCK` opener already in `ipc.rs`), take `metadata()` from the handle, compare the stamp, check the cap, call `after_open()`, then `take(max_bytes + 1).read_to_end` exactly as `read_pdf_bytes` does. It returns `json!` objects; `"data"` and `"signature"` are present only on a successful full read, and `"unchanged": true` only on a matching stamp. `read_document_file` calls it with `|| {}`.
  4. Implement `fs_read_document`:
     1. Parse `path`, `tabId` and `ifChanged` (`size`, `mtimeMs` as `u64`) from the payload.
     2. If `path` is empty, return `Reply::ok` with the `"invalid-path"` shape.
     3. Run `expand_home(path)`.
     4. If the result is relative and `ctx.tabs.cwd_for(caller, tab_id)` is None, return `Reply::ok` with `"no-workspace"`.
     5. Return `Reply::Later(Box::pin(async move { … }))`. Inside: `tokio::time::timeout(DOCUMENT_READ_TIMEOUT, tokio::task::spawn_blocking(move || { /* resolve_within for a relative path ("outside-workspace" when None), then read_document_file */ })).await`. A join error returns `{ ok: false, size: 0, mtimeMs: 0, error: <message> }`; an elapsed timeout returns the same shape with `error: "timed-out"`. The blocking thread may stay stuck on a hung mount, but the window's queue moves on.
  5. In `src-tauri/src/services/mod.rs`, add `("fs:read-document", Scope::Main),` after `("fs:read-pdf", Scope::Main),` in `CHANNELS`, and `reg.register("fs:read-document", Scope::Main, ipc::fs_read_document);` after the `fs:read-pdf` registration.
  6. In `src-tauri/tests/channels.rs`, raise `EXPECTED_CHANNEL_COUNT` by exactly 1 from the value recorded in Task 1.1 step 4. Do not type a number from this plan.
- **Success criteria:** The Rust tests pass, and the channel test passes.
- **Verify:**
  - After step 1: `PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features --lib document; echo "exit=$?"` ends with `exit=101`.
  - After step 6: the same command ends with `exit=0`, and its output contains `12 passed`, or more if other `document` tests exist.
  - After step 6: `PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features --test channels; echo "exit=$?"` ends with `exit=0`.
  - `git diff -U0 src-tauri/tests/channels.rs | grep -c "^[-+]const EXPECTED_CHANNEL_COUNT"` prints `2`.

### Task 1.6 — `mailto:` through `system:open-external` in both shells (red, then green)
<!-- Validation: mailto --> <!-- Red team: R15 -->
- **Goal:** A `mailto:` link that the preview's link router allows actually opens the mail client in both shells, while the agent's `gui_open_url` tool keeps its http/https rule.
- **Target files and symbols:** `src/main/external-url.ts` `isAllowedExternalUrl(url: unknown): url is string`; `src/main/external-url.test.ts`; `src/main/ipc.ts` `SYSTEM_OPEN_EXTERNAL` handler; `system.rs` `allowed_external_url` and new `pub fn allowed_web_url(url: &str) -> bool`; `host_tools.rs` `gui_open_url`; `lib.rs` and `testing.rs` `open_url`.
- **Steps:**
  1. **Red.** Write `external-url.test.ts` with `it("allows http https and mailto urls")` (`https://a.b`, `http://a.b`, `mailto:a@b.c` → true) and `it("refuses file javascript and data urls")` (`file:///etc/passwd`, `javascript:alert(1)`, `data:text/html,x`, `""`, `42` → false). In `system.rs` `mod tests`, rename `allows_only_http_and_https_urls` to `allows_http_https_and_mailto_urls` and add the `mailto:` assertion; add `refuses_file_javascript_and_data_urls` with the same refused inputs (string ones); add `the_host_tool_still_refuses_mailto_urls`: `assert!(allowed_web_url("https://a.b")); assert!(!allowed_web_url("mailto:a@b.c"));`. Run both suites.
  2. **Green.** `isAllowedExternalUrl` returns true only for a string starting with `https://`, `http://` or `mailto:`. In `ipc.ts`, the `SYSTEM_OPEN_EXTERNAL` handler becomes `if (isAllowedExternalUrl(url)) await shell.openExternal(url);`.
  3. In `system.rs`, move today's body of `allowed_external_url` into `allowed_web_url`, and make `allowed_external_url` return `allowed_web_url(url) || url.starts_with("mailto:")`. Update its doc comment to name the three schemes. In `host_tools.rs`, `gui_open_url` calls `super::system::allowed_web_url`.
  4. In `lib.rs` `open_url`, accept `lower.starts_with("mailto:")` next to http/https, and say so in the refusal message (`"refused to open a URL that is not http, https or mailto"`). In `testing.rs` `open_url`, accept `mailto:` the same way.
  5. Append `{ "ts": "src/main/external-url.test.ts", "rust": "src-tauri/src/services/system.rs" }` to `services.parity.json`.
- **Success criteria:** Both suites pass; the agent tool still refuses `mailto:`.
- **Verify:**
  - After step 1: `bunx vitest run src/main/external-url.test.ts; echo "exit=$?"` ends with `exit=1`.
  - After step 4: the same command ends with `exit=0`.
  - After step 4: `PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features --lib services::system; echo "exit=$?"` ends with `exit=0`.
  - `grep -c "allowed_web_url" src-tauri/src/services/host_tools.rs` prints `1`.

### Task 1.7 — Parity, both snapshots, clippy
<!-- Red team: R2 -->
- **Goal:** Keep the port gates green, including the `ports` snapshot.
- **Target files and symbols:** `src-tauri/contracts/services.parity.json`, `src-tauri/contracts/services.api.txt`, `src-tauri/contracts/ports.api.txt`.
- **Steps:**
  1. Append `{ "ts": "src/main/fs-read-document.test.ts", "rust": "src-tauri/src/services/ipc.rs" }` to `services.parity.json`, matching its two-space formatting.
  2. In **both** `services.api.txt` and `ports.api.txt`, insert this exact line directly after the `sai_atlas_lib::services::ipc::fs_read(` line and before the `fs_read_image(` line (cargo public-api sorts `(` before `_`): `pub fn sai_atlas_lib::services::ipc::fs_read_document(&alloc::rcs::arc::Arc<sai_atlas_lib::ctx::AppCtx>, sai_atlas_lib::ports::Caller, alloc::vec::Vec<serde_json::value::Value>) -> sai_atlas_lib::bridge::Reply`. `services::system` is a private module, so `allowed_web_url` adds no snapshot line.
  3. Run the gates. If `check-module.sh snapshots` prints a diff for any other line, apply the Failure Protocol; do not regenerate the snapshot blindly.
- **Success criteria:** Parity, every snapshot and clippy pass.
- **Verify:**
  - `grep -c "services::ipc::fs_read_document(" src-tauri/contracts/services.api.txt src-tauri/contracts/ports.api.txt` prints `src-tauri/contracts/services.api.txt:1` and `src-tauri/contracts/ports.api.txt:1`.
  - `bun scripts/check-test-parity.ts services; echo "exit=$?"` ends with `exit=0`.
  - `bash scripts/check-module.sh snapshots` exits 0, and its last line starts with `check-module snapshots: PASS`.
  - `PATH="$HOME/.cargo/bin:$PATH" cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings; echo "exit=$?"` ends with `exit=0`.

### Task 1.8 — Phase commit
- **Goal:** One revertable commit.
- **Target files and symbols:** every file listed in this phase.
- **Steps:**
  1. Run `bunx biome check src/main/fs-read-document.ts src/main/fs-read-document.test.ts src/main/external-url.ts src/main/external-url.test.ts src/main/ipc.ts src/shared/ipc-types.ts src/shared/bridge/create-omp-api.ts src/shared/bridge/create-omp-api.test.ts`.
  2. Run `bunx vitest run src/renderer/lib/markdown-image.test.tsx src/main; echo "exit=$?"` as the guard that `fs:read-image` is unchanged.
  3. Run `git add` on the phase files.
  4. Run `git commit -m "feat(fs): read document bytes for the in-app preview and open mailto links in both shells"`.
- **Success criteria:** Biome is clean, the image guard passes, and the commit exists.
- **Verify:**
  - The biome command exits 0.
  - Step 2 ends with `exit=0`. If `src/renderer/lib/markdown-image.test.tsx` does not exist, run `grep -rln "readImage" src --include=*.test.ts --include=*.test.tsx` and pass every listed file instead; the step must still end with `exit=0`.
  - `git log -1 --format=%s` prints `feat(fs): read document bytes for the in-app preview and open mailto links in both shells`.

## Verification

- `bunx vitest run src/main src/shared` exits 0.
- `bun run check:types` exits 0.
- `PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --all-features` exits 0.
- `bun scripts/check-test-parity.ts services` exits 0.
- `bash scripts/check-module.sh snapshots` prints a last line starting `check-module snapshots: PASS` (every `contracts/*.api.txt`, `services` and `ports` included).

## Risks & Rollback

- **A hung network mount (GVFS, sshfs, NFS).** The Tauri read runs on a blocking thread behind `Reply::Later` with a 30 s timeout, so the window's other calls are admitted meanwhile; Electron's handler is async. The renderer issues reads only on open, Reload and matching write events, never on a timer.
- **A file that grows during the read.** The read stops one byte past the cap, so at most 32 MiB + 1 byte is read and the result is `too-large`.
- **Electron and Rust disagree on `mtimeMs` rounding.** Both floor to whole milliseconds, and each shell's tests compare against that shell's own `stat`.
- **Widening `mailto:` reaches the agent's `gui_open_url`.** It does not: that tool calls `allowed_web_url` (Rust) and keeps its inline http/https check (Electron, `ipc.ts:1174`).
- **Rollback:** `git revert <phase commit>`. No renderer caller exists until Phase 2; the `mailto:` widening reverts with it.

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
