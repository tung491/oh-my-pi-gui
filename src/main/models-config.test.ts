/**
 * models-config.ts tests: the read path the GUI still uses (provider listing,
 * built-in flagging, tolerant parsing, file resolution).
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { listModelsProviders, modelsPath } from "./models-config";

describe("models-config", () => {
	let testDir: string;
	let originalEnv: string | undefined;

	beforeEach(() => {
		testDir = join(tmpdir(), `omp-test-models-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		originalEnv = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = testDir;
	});

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.PI_CODING_AGENT_DIR = originalEnv;
		} else {
			delete process.env.PI_CODING_AGENT_DIR;
		}
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("modelsPath", () => {
		test("points a fresh install at models.yml", () => {
			expect(modelsPath()).toBe(join(testDir, "models.yml"));
		});

		test("keeps using an existing legacy models.yaml", () => {
			writeFileSync(join(testDir, "models.yaml"), "providers: {}\n", "utf8");
			expect(modelsPath()).toBe(join(testDir, "models.yaml"));
		});
	});

	describe("thinking ladder", () => {
		test("reads both legacy thinking shapes as an ordered efforts ladder", () => {
			const file = modelsPath();
			writeFileSync(
				file,
				`providers:
  legacy-thinking:
    api: openai-completions
    baseUrl: https://api.test.com/v1
    models:
      - id: ranged-model
        thinking:
          mode: effort
          minLevel: low
          maxLevel: high
      - id: levelled-model
        thinking:
          mode: budget
          levels: [minimal, medium]
          effortMap: {minimal: low}
`,
				"utf8",
			);

			const loaded = listModelsProviders().find(provider => provider.id === "legacy-thinking");
			if (!loaded) throw new Error("legacy-thinking provider missing after parse");
			// The agent normalizes both legacy shapes to an ordered `efforts`
			// ladder. A view that loses it renders "no thinking" for a thinking
			// model.
			expect(loaded.models[0].thinking).toEqual({ mode: "effort", efforts: ["low", "medium", "high"] });
			expect(loaded.models[1].thinking).toEqual({ mode: "budget", efforts: ["minimal", "medium"] });
		});
	});

	describe("built-in roster", () => {
		test("flags a hand-written built-in override as built-in, not as a custom provider", () => {
			writeFileSync(
				modelsPath(),
				"providers:\n  meta:\n    api: openai-completions\n    baseUrl: https://x.test/v1\n",
			);
			expect(listModelsProviders().find(p => p.id === "meta")?.builtin).toBe(true);
		});
	});

	describe("toView fidelity", () => {
		test("tolerates malformed file content without throwing", () => {
			const path = modelsPath();
			writeFileSync(
				path,
				`
providers:
  broken-provider:
    api: 123
    baseUrl: null
    models: not-an-array
    discovery: invalid
    cost:
      input: "not a number"
`,
				"utf8",
			);

			const providers = listModelsProviders();
			const saved = providers.find(p => p.id === "broken-provider");
			expect(saved).toBeDefined();
			expect(saved?.api).toBe("openai-completions"); // fallback
			expect(saved?.baseUrl).toBe("");
			expect(saved?.models).toEqual([]);
			expect(saved?.discovery).toBeUndefined();
		});
	});
});
