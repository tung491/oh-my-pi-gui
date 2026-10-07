# Sizing the Ollama context window from machine specs

Researched 2026-10-07 18:53 KST. Scope: the `num_ctx` that the sidecar sends to a local Ollama server, which `patches/omp/0001-ollama-native-api-num-ctx.patch` currently caps at a fixed 16384 (`OLLAMA_NATIVE_DEFAULT_CONTEXT`) unless `OLLAMA_CONTEXT_LENGTH` is set.

## Answer

Yes, it is possible, and on this machine the fixed 16k cap leaves most of the room unused. The context does not cost a fixed amount of memory per token, though. The cost is the model's KV cache, and it differs by about 25× between models. A rule that looks only at VRAM, such as "16 GiB means 64k", would be generous for Gemma 4 and could overflow the GPU with a dense 8B model. The correct input is free VRAM divided by the model's KV bytes per token. Ollama's `/api/show` already returns every value needed to work out the second number.

## Evidence from this machine

The machine has an RTX 5080 with 16 GiB (about 6.8 GiB already in use by other processes), 60 GiB of RAM, and Ollama 0.35.0.

I loaded `gemma-4-E2B-it-qat-q4_0` at three context sizes and read `size_vram` from `/api/ps`:

| `num_ctx` | Resident size (all in VRAM) |
|---|---|
| 16 384 | 1 723 MiB |
| 32 768 | 1 755 MiB |
| 131 072 (the model's trained maximum) | 2 449 MiB |

Going from 16k to the full 128k costs about 700 MiB, which is roughly 5.6 KiB per token. That matches the value worked out from `model_info`: of 35 layers, 20 share their KV with another layer, and of the 15 that keep their own cache only 3 are global, so 3 × 2 × 1 KV head × 512 dim × 2 bytes gives 6 KiB per token. The 12 sliding-window layers hold only 512 tokens each.

For comparison, a dense GQA model such as an 8B with 36 layers, 8 KV heads and a head dimension of 128 needs 2 × 36 × 8 × 128 × 2 bytes, which is 144 KiB per token. A 128k context for that model takes about 18 GiB of KV cache alone and would not fit on this card.

## External facts

- Ollama's own default context depends on VRAM: 4k below 24 GiB, 32k from 24 to 48 GiB, and 256k at 48 GiB or more ([docs.ollama.com/context-length](https://docs.ollama.com/context-length)). On this 16 GiB card it would choose 4k, which is why the patch sends `num_ctx` at all.
- Setting `OLLAMA_KV_CACHE_TYPE=q8_0` roughly halves KV memory, but it requires flash attention, and a quantized cache with flash attention off aborts the model load ([smcleod.net](https://smcleod.net/2024/12/bringing-k/v-context-quantisation-to-ollama/), [ssdnodes](https://www.ssdnodes.com/learn/ollama-context-length-num-ctx)). This is a server setting, so the sidecar cannot rely on it.
- When the model does not fit, Ollama offloads layers to the CPU instead of failing. A context that is too large therefore shows up as a large slowdown, not as an error.

## Recommended design

Size the context per model inside the agent patch, where `/api/show` is already called during discovery, not in the GUI, which knows the machine but not the model.

```ts
// model-discovery.ts (patch), next to the existing context resolution
function kvBytesPerToken(info: Record<string, unknown>, arch: string): number {
	const n = (k: string) => Number(info[`${arch}.${k}`] ?? 0);
	const layers = n("block_count") - n("attention.shared_kv_layers");
	const kvHeads = n("attention.head_count_kv") || n("attention.head_count");
	const k = n("attention.key_length") || n("embedding_length") / n("attention.head_count");
	const v = n("attention.value_length") || k;
	const pattern = info[`${arch}.attention.sliding_window_pattern`];
	// Sliding-window layers hold a bounded window; only global layers grow with num_ctx.
	const globalLayers = Array.isArray(pattern) ? pattern.slice(0, layers).filter(swa => !swa).length : layers;
	return globalLayers * kvHeads * (k + v) * 2; // f16 cache, the server default
}

function fitContext(trained: number, kvPerToken: number, budgetBytes: number): number {
	if (!(kvPerToken > 0)) return OLLAMA_NATIVE_DEFAULT_CONTEXT; // unknown arch: keep today's behavior
	let ctx = OLLAMA_NATIVE_DEFAULT_CONTEXT;
	while (ctx * 2 <= trained && ctx * 2 * kvPerToken <= budgetBytes) ctx *= 2;
	return ctx;
}
```

Three details carry most of the risk:

1. **Budget.** Use free VRAM minus the model weights minus a margin of about 1 GiB for the compute graph, not total VRAM. Other applications already use 6.8 GiB here. The agent can read the weight size from `/api/tags` and free VRAM from `/api/ps` together with `nvidia-smi`, or the GUI can pass in a budget through an environment variable. On Apple Silicon, use around 60% of unified memory, because macOS limits how much of it the GPU can use.
2. **Precedence.** An explicit `OLLAMA_CONTEXT_LENGTH` must stay a hard cap. Auto-sizing applies only when it is unset, and 16384 stays the floor.
3. **Stability.** Calculate once at discovery and cache the result per model. If `num_ctx` drifts from one request to the next, Ollama reloads the model on every turn.

A simpler option is for the GUI to set `OLLAMA_CONTEXT_LENGTH` from VRAM tiers in `src/main/sidecar.ts`. It is about 20 lines and needs no patch change, but it ignores the model, so it has to stay conservative (for example 32k at 16 GiB). That gives up the 128k that Gemma 4 could actually use here.

## Trade-offs to note

- A larger window raises the ceiling, but it does not make each turn cost more. KV memory is allocated when the model loads, and prompt evaluation time grows only with the tokens actually sent.
- Small models such as E2B and E4B lose accuracy at long range well before 128k. A cap of 64k may be the better default even when memory allows more. That is a product decision, not a memory one.
- The agent budgets compaction against `contextWindow`, so raising it also delays compaction. That is the intended effect, but it is a change users will notice.

## Next steps

1. Add `kvBytesPerToken` and `fitContext` to the patch's discovery path, keep `OLLAMA_CONTEXT_LENGTH` as the override, and test with fixture `model_info` for Gemma 4 (SWA plus shared KV) and a dense Qwen or Llama model.
2. Regenerate `patches/omp/0001-*.patch`, run `bun run build:omp`, and confirm with `/api/ps` that `context_length` and `size_vram` match the prediction for both installed Gemma models.
3. Update the patch's `docs/models.md` and `docs/environment-variables.md` lines that state "default 16384".

## Unresolved questions

- What is the product cap? Should the window be the full trained context when it fits, or limited to 64k for quality on small models?
- Should a VRAM figure from the GUI (Electron or Tauri) be the source of truth, or should the agent probe the GPU itself? Probing differs between NVIDIA, AMD and Metal.
- Ollama's response for a CPU-only or AMD setup was not tested here.
