# Phase 2 — Main-process Ollama service

Parallel with phases 3, 4 and 5.

## File ownership

Creates `src/main/ollama/{base-url,probe,hardware,pull,remedy,warm,register-ipc}.ts` and a `.test.ts` beside each non-trivial module.
Edits `src/main/ipc.ts`, adding exactly one `registerOllamaIpc(...)` call next to the existing `MODELS_*` handlers (~line 975).

## Requirements

1. **base-url.ts**: `ollamaBaseUrl(env)` copies the agent's rule (`OLLAMA_BASE_URL` → normalised `OLLAMA_HOST` → `http://127.0.0.1:11434`), using the login-shell env from `shell-env.ts`. Port the agent's `normalizeOllamaHostEnv` cases as tests.
2. **probe.ts** `probeOllama()`: `GET /api/version` and `/api/tags` with a 1.5 s timeout.
   - Success → `ok` with `modelCount` and `installedTags`.
   - Connection refused or timeout → decide between `stopped` and `absent` the way `welcome/backend/ollama.go` does. Linux: `systemctl cat ollama.service` succeeds or `which ollama` resolves → stopped. macOS: `/Applications/Ollama.app` or `which ollama`. Windows: `%LOCALAPPDATA%\Programs\Ollama\ollama.exe`.
   - `remedy` is `linux-start` / `linux-install` on Linux, otherwise `null`.
3. **hardware.ts** `readMachine()`: `os.totalmem()` for RAM. VRAM, best effort and never throwing: `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` (Linux/Windows), else `app.getGPUInfo("complete")` for the name only. Apple Silicon (`process.platform === "darwin" && process.arch === "arm64"`) → `unifiedMemory: true`, VRAM null. Each probe has a 2 s timeout. If RAM itself is unreadable, return `null`.
4. **OLLAMA_MODEL_SCREEN**: run `readMachine()` and `probeOllama()` in parallel, then `chooseModels()` from phase 1. When Ollama is down, `installed` is `null` on every card (the "unknown" state).
5. **pull.ts**: `POST /api/pull {model, stream: true}` and parse NDJSON. Aggregate per digest exactly as `welcome/backend/pull.go` does: clamp `completed ≤ total`, `percent = -1` until a total is known, cap at 99 until `status === "success"`. Send `OLLAMA_PULL_PROGRESS` to the requesting webContents, throttled to ≤ 10 Hz with `event-batcher.ts`. Only one pull at a time; a second one is rejected with an error. Cancel aborts the fetch (Ollama keeps finished layers, so a re-pull resumes).
6. **warm.ts**: `POST /api/generate {model, keep_alive: "10m"}` with no prompt. Fire and forget, and log failures.
7. **remedy.ts** `runRemedy(id)`: Linux only. `linux-start` → `execFile("pkexec", ["systemctl", "start", "ollama.service"])`. `linux-install` → `execFile("pkexec", ["sh", "-c", INSTALL_LINE])`, where `INSTALL_LINE` is a module constant. Reject any id outside the closed set, and reject on other platforms. Afterwards re-probe and return the new `OllamaStatus`. Exit code 126/127 from pkexec (dialog dismissed) → a typed "cancelled" result, not an error toast.
8. **OLLAMA_OPEN_DOWNLOAD** → `shell.openExternal("https://ollama.com/download")` (fixed URL).

## Validation

- Unit tests run against a local `Bun.serve` fake Ollama: tags, a version endpoint, and a pull NDJSON stream with two layers, an unknown total and a mid-stream cancel. This is a real HTTP server, not a mocked module.
- `bunx vitest run src/main/ollama`, `bun run check:types`.

## Risk

`pkexec` is missing on some distros. In that case `runRemedy` returns `{ unavailable: true }`, and the screen keeps showing the command for the user to copy. A curl-pipe-sh installer runs remote code as root. That is the user-chosen behaviour, is shown verbatim before running, and needs polkit authorisation.
