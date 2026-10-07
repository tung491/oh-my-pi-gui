# Phase 2 report: main-process Ollama service

Status: DONE_WITH_CONCERNS

## Files
- Created `src/main/ollama/{base-url,probe,hardware,pull,remedy,warm,register-ipc}.ts`, tests beside every module except `register-ipc` (Electron glue), and `test-fake-ollama.ts` (node:http fake daemon shared by the tests).
- `src/main/ipc.ts`: one import and one `registerOllamaIpc()` call before the `MODELS_*` handlers (+3 lines).

## Checks
- `bunx vitest run src/main/ollama`: 68 tests pass (stable over 3 runs); `bunx vitest run src/main`: 375 pass.
- `bun run check:types`: clean. `bunx biome check src/main/ollama src/main/ipc.ts`: clean.

## Deviations
- Progress throttling is a latest-frame-wins 100 ms throttle inside `OllamaPuller`, not `event-batcher.ts`: that class is typed to `AgentSessionEvent`, batches instead of coalescing, and is outside this phase's ownership.
- After an `applied` remedy, `runRemedy` re-probes up to 10 times at 500 ms intervals until the daemon answers, because `systemctl start` returns before Ollama is listening.
- The base URL is reduced to `protocol//host` as the agent's `normalizeOllamaBaseUrl` does, so `OLLAMA_BASE_URL=http://h:1/v1` probes `http://h:1/api/*`.
- The renderer's `warm` resolves once the request is sent; an invalid tag on `warm`/`remedy` rejects (programming error), and an invalid tag on `pull` resolves an error frame.
