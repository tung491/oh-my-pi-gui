/**
 * Read the agent's `models.yml` for provider configuration.
 *
 * The file lives in the agent dir (models.yml preferred, models.yaml
 * fallback) and is parsed with the `yaml` package. The GUI no longer writes
 * provider entries; the one-time Ollama-only cleanup in `provider-cleanup.ts`
 * edits the document itself after a backup.
 */
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { parseDocument } from "yaml";
import {
	CUSTOM_MODEL_EFFORTS,
	CUSTOM_PROVIDER_APIS,
	type CustomModelEffort,
	type CustomProviderApi,
	type CustomProviderDiscovery,
	type CustomProviderModelCost,
	type CustomProviderModelInput,
	type CustomProviderModelThinking,
	type CustomProviderView,
} from "../shared/ipc-types";
import { agentDir } from "./agent-paths";

const MASK_PREVIEW_LEN = 4;

/**
 * Provider ids the agent already knows — a `models.yml` entry under one of
 * these is an *override* of the built-in, not a custom provider, and the
 * listing flags it as `builtin`.
 *
 * Union of `KnownProvider` and `AuthProviderId`, generated from
 * `packages/catalog/src/compat/{provider-ids,auth-ids}.ts` by
 * `bun run gen:compat` in the monorepo. The GUI has no catalog dependency, so
 * this is a checked-in copy: when the catalog adds a provider, a missing id
 * here lists its override as a custom provider.
 */
const BUILTIN_PROVIDERS: ReadonlySet<string> = new Set([
	"abliteration",
	"aiand",
	"aimlapi",
	"alibaba-coding-plan",
	"alibaba-token-plan",
	"amazon-bedrock",
	"anthropic",
	"azure",
	"baseten",
	"bedrock-mantle",
	"cerebras",
	"charm-hyper",
	"cline-pass",
	"cloudflare-ai-gateway",
	"commandcode",
	"coreweave",
	"cursor",
	"deepinfra",
	"deepseek",
	"devin",
	"exa",
	"firepass",
	"fireworks",
	"github-copilot",
	"gitlab-duo",
	"gitlab-duo-agent",
	"gmi-cloud",
	"google",
	"google-antigravity",
	"google-gemini-cli",
	"google-vertex",
	"groq",
	"huggingface",
	"kagi",
	"kilo",
	"kimi-code",
	"litellm",
	"llama.cpp",
	"lm-studio",
	"local",
	"meta",
	"minimax",
	"minimax-code",
	"minimax-code-cn",
	"mistral",
	"moonshot",
	"muse-code",
	"nanogpt",
	"novita",
	"nvidia",
	"ollama",
	"ollama-cloud",
	"openai",
	"openai-codex",
	"openai-codex-device",
	"opencode-go",
	"opencode-zen",
	"openrouter",
	"parallel",
	"perplexity",
	"qianfan",
	"qwen-portal",
	"sakana",
	"siliconflow",
	"siliconflow-cn",
	"singularityapi",
	"stencil",
	"synthetic",
	"tavily",
	"together",
	"typesafe",
	"umans",
	"venice",
	"vercel-ai-gateway",
	"vllm",
	"wafer-serverless",
	"web",
	"xai",
	"xai-oauth",
	"xiaomi",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-cn",
	"xiaomi-token-plan-sgp",
	"yolo-auto",
	"zai",
	"zai-coding-plan",
	"zenmux",
	"zhipu-coding-plan",
]);

const DISCOVERY_TYPES: ReadonlySet<string> = new Set([
	"ollama",
	"llama.cpp",
	"lm-studio",
	"openai-models-list",
	"proxy",
	"litellm",
]);
const AUTH_MODES: ReadonlySet<string> = new Set(["apiKey", "none", "oauth"]);
const THINKING_MODES: ReadonlySet<string> = new Set([
	"effort",
	"budget",
	"google-level",
	"anthropic-adaptive",
	"anthropic-budget-effort",
]);

/** Absolute path to the agent's models file (`models.yml` preferred, `models.yaml` fallback). */
export function modelsPath(): string {
	const dir = agentDir();
	const yml = path.join(dir, "models.yml");
	if (existsSync(yml)) return yml;
	const legacy = path.join(dir, "models.yaml");
	// A fresh install writes the preferred name; only an existing `models.yaml`
	// keeps being used.
	return existsSync(legacy) ? legacy : yml;
}

function readModelsProviders(): Record<string, unknown> {
	const file = modelsPath();
	if (!existsSync(file)) return {};
	const doc = parseDocument(readFileSync(file, "utf8"));
	const issue = doc.errors[0] ?? doc.warnings[0];
	if (doc.errors.length > 0) throw new Error(`${file}: ${issue?.message ?? "invalid YAML"}`);
	const contents = doc.toJS();
	const providers = contents?.providers;
	return typeof providers === "object" && providers !== null ? (providers as Record<string, unknown>) : {};
}

function maskApiKey(key: unknown): { hasApiKey: boolean; apiKeyPreview?: string } {
	if (typeof key !== "string" || key.length === 0) return { hasApiKey: false };
	return { hasApiKey: true, apiKeyPreview: `•••${key.slice(-MASK_PREVIEW_LEN)}` };
}

// ============================================================================
// Wire ← file parsing (toView): surface every GUI-editable field, tolerate
// free-form file content (unknown shapes degrade to undefined, never throw).
// ============================================================================

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (typeof v === "string") out[k] = v;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function asApi(value: unknown): CustomProviderApi | undefined {
	return typeof value === "string" && (CUSTOM_PROVIDER_APIS as readonly string[]).includes(value)
		? (value as CustomProviderApi)
		: undefined;
}

function asCost(value: unknown): CustomProviderModelCost | undefined {
	if (!value || typeof value !== "object") return undefined;
	const rec = value as Record<string, unknown>;
	const cost: CustomProviderModelCost = {};
	if (asNumber(rec.input) !== undefined) cost.input = asNumber(rec.input);
	if (asNumber(rec.output) !== undefined) cost.output = asNumber(rec.output);
	if (asNumber(rec.cacheRead) !== undefined) cost.cacheRead = asNumber(rec.cacheRead);
	if (asNumber(rec.cacheWrite) !== undefined) cost.cacheWrite = asNumber(rec.cacheWrite);
	return Object.keys(cost).length > 0 ? cost : undefined;
}

/**
 * Effort ladder as the agent's ModelThinkingSchema resolves it: `efforts` wins,
 * then the legacy `levels` list, then the `minLevel`..`maxLevel` range. Without
 * this a hand-written range config reads back as "no thinking" and the next save
 * deletes the block.
 */
function thinkingEfforts(rec: Record<string, unknown>): CustomModelEffort[] {
	const isEffort = (value: unknown): value is CustomModelEffort =>
		typeof value === "string" && (CUSTOM_MODEL_EFFORTS as readonly string[]).includes(value);
	const fromList = (value: unknown): CustomModelEffort[] => (Array.isArray(value) ? value.filter(isEffort) : []);
	const explicit = fromList(rec.efforts);
	if (explicit.length > 0) return explicit;
	const levels = fromList(rec.levels);
	if (levels.length > 0) return levels;
	if (!isEffort(rec.minLevel) || !isEffort(rec.maxLevel)) return [];
	const min = CUSTOM_MODEL_EFFORTS.indexOf(rec.minLevel);
	const max = CUSTOM_MODEL_EFFORTS.indexOf(rec.maxLevel);
	return CUSTOM_MODEL_EFFORTS.slice(min, Math.max(min, max) + 1);
}

function asThinking(value: unknown): CustomProviderModelThinking | undefined {
	if (!value || typeof value !== "object") return undefined;
	const rec = value as Record<string, unknown>;
	if (typeof rec.mode !== "string" || !THINKING_MODES.has(rec.mode)) return undefined;
	const efforts = thinkingEfforts(rec);
	if (efforts.length === 0) return undefined;
	const thinking: CustomProviderModelThinking = {
		mode: rec.mode as CustomProviderModelThinking["mode"],
		efforts,
	};
	const defaultLevel = asString(rec.defaultLevel);
	if (defaultLevel && (CUSTOM_MODEL_EFFORTS as readonly string[]).includes(defaultLevel)) {
		thinking.defaultLevel = defaultLevel as CustomProviderModelThinking["defaultLevel"];
	}
	if (typeof rec.supportsDisplay === "boolean") thinking.supportsDisplay = rec.supportsDisplay;
	return thinking;
}

function asInput(value: unknown): Array<"text" | "image"> | undefined {
	if (!Array.isArray(value)) return undefined;
	const out = value.filter((v): v is "text" | "image" => v === "text" || v === "image");
	return out.length > 0 ? out : undefined;
}

function asDiscovery(value: unknown): CustomProviderDiscovery | undefined {
	if (!value || typeof value !== "object") return undefined;
	const rec = value as Record<string, unknown>;
	if (typeof rec.type !== "string" || !DISCOVERY_TYPES.has(rec.type)) return undefined;
	const discovery: CustomProviderDiscovery = { type: rec.type as CustomProviderDiscovery["type"] };
	const timeoutMs = asNumber(rec.timeoutMs);
	if (timeoutMs !== undefined) discovery.timeoutMs = timeoutMs;
	return discovery;
}

function modelToView(raw: unknown): CustomProviderModelInput | null {
	if (!raw || typeof raw !== "object") return null;
	const m = raw as Record<string, unknown>;
	const id = asString(m.id);
	if (!id) return null;
	const view: CustomProviderModelInput = { id };
	const fields: Array<[keyof CustomProviderModelInput, unknown]> = [
		["name", asString(m.name)],
		["api", asApi(m.api)],
		["baseUrl", asString(m.baseUrl)],
		["reasoning", m.reasoning === true ? true : undefined],
		["thinking", asThinking(m.thinking)],
		["input", asInput(m.input)],
		["supportsTools", asBoolean(m.supportsTools)],
		["cost", asCost(m.cost)],
		["premiumMultiplier", asNumber(m.premiumMultiplier)],
		["contextWindow", asNumber(m.contextWindow)],
		["maxTokens", asNumber(m.maxTokens)],
		["omitMaxOutputTokens", asBoolean(m.omitMaxOutputTokens)],
		["headers", asStringRecord(m.headers)],
	];
	for (const [key, value] of fields) {
		if (value !== undefined) {
			view[key] = value as never;
		}
	}
	return view;
}

function toView(id: string, raw: unknown): CustomProviderView & { apiKey?: string } {
	const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const models: CustomProviderModelInput[] = [];
	if (Array.isArray(rec.models)) {
		for (const m of rec.models) {
			const view = modelToView(m);
			if (view) models.push(view);
		}
	}
	const { hasApiKey, apiKeyPreview } = maskApiKey(rec.apiKey);
	const compat = rec.compat && typeof rec.compat === "object" ? (rec.compat as Record<string, unknown>) : undefined;
	const extraBody =
		compat?.extraBody && typeof compat.extraBody === "object"
			? (compat.extraBody as Record<string, unknown>)
			: undefined;
	const auth = asString(rec.auth);
	return {
		id,
		api: asApi(rec.api) ?? "openai-completions",
		baseUrl: asString(rec.baseUrl) ?? "",
		hasApiKey,
		apiKeyPreview,
		auth: auth && AUTH_MODES.has(auth) ? (auth as CustomProviderView["auth"]) : undefined,
		authHeader: asBoolean(rec.authHeader),
		headers: asStringRecord(rec.headers),
		discovery: asDiscovery(rec.discovery),
		disableStrictTools: asBoolean(rec.disableStrictTools),
		transport: rec.transport === "pi-native" ? "pi-native" : undefined,
		extraBody: extraBody && Object.keys(extraBody).length > 0 ? extraBody : undefined,
		models,
		builtin: BUILTIN_PROVIDERS.has(id),
		apiKey: typeof rec.apiKey === "string" ? rec.apiKey : undefined,
	};
}

/** List configured providers (custom + user overrides), apiKey masked. */
export function listModelsProviders(): CustomProviderView[] {
	const providers = readModelsProviders();
	return Object.entries(providers).map(([id, raw]) => {
		const { apiKey: _secret, ...view } = toView(id, raw);
		return view;
	});
}
