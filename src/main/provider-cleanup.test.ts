import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parse } from "yaml";
import { IPC_COMMANDS } from "../shared/ipc-types";
import { backupStamp, cleanConfig, registerProviderCleanupIpc } from "./provider-cleanup";

const MODELS_YML = `# hand-written config
providers:
  anthropic:
    baseUrl: https://proxy.example.com
  my-proxy:
    api: openai-completions
    baseUrl: https://my-proxy.example.com/v1
    apiKey: sk-secret
    models:
      - id: proxy-model
  ollama:
    baseUrl: http://127.0.0.1:11434
`;

describe("provider cleanup", () => {
	let dir: string;
	let originalEnv: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "omp-provider-cleanup-"));
		originalEnv = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
	});

	afterEach(() => {
		if (originalEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalEnv;
		rmSync(dir, { recursive: true, force: true });
	});

	const backups = () => readdirSync(dir).filter(name => name.startsWith("models.yml.bak-"));

	test("backs up byte-identically, keeps only ollama, and a second run is a no-op", () => {
		const file = join(dir, "models.yml");
		writeFileSync(file, MODELS_YML);
		const now = new Date(2026, 9, 2, 9, 5, 7);

		const result = cleanConfig(now);

		expect(result.removed.sort()).toEqual(["anthropic", "my-proxy"]);
		expect(result.backupPath).toBe(join(dir, "models.yml.bak-20261002-090507"));
		expect(readFileSync(result.backupPath as string, "utf8")).toBe(MODELS_YML);
		expect(Object.keys(parse(readFileSync(file, "utf8")).providers)).toEqual(["ollama"]);
		expect(readFileSync(file, "utf8")).toContain("# hand-written config");

		const again = cleanConfig(new Date(2026, 9, 2, 9, 6, 0));
		expect(again).toEqual({ backupPath: null, removed: [] });
		expect(backups()).toEqual(["models.yml.bak-20261002-090507"]);
	});

	test("does nothing without a models file", () => {
		expect(cleanConfig()).toEqual({ backupPath: null, removed: [] });
		expect(readdirSync(dir)).toEqual([]);
	});

	test("refuses to overwrite an existing backup and leaves the config untouched", () => {
		const file = join(dir, "models.yml");
		writeFileSync(file, MODELS_YML);
		const now = new Date(2026, 9, 2, 9, 5, 7);
		writeFileSync(join(dir, `models.yml.bak-${backupStamp(now)}`), "older backup");

		expect(() => cleanConfig(now)).toThrow();
		expect(readFileSync(file, "utf8")).toBe(MODELS_YML);
		expect(readFileSync(join(dir, `models.yml.bak-${backupStamp(now)}`), "utf8")).toBe("older backup");
	});

	test("never backs up or rewrites a file that does not parse", () => {
		const file = join(dir, "models.yml");
		const broken = "providers:\n  anthropic: [unclosed\n";
		writeFileSync(file, broken);

		expect(() => cleanConfig()).toThrow();
		expect(readFileSync(file, "utf8")).toBe(broken);
		expect(backups()).toEqual([]);
	});

	test("throws without writing a backup when providers is an alias it cannot edit", () => {
		const file = join(dir, "models.yml");
		const aliased = "base: &p\n  anthropic:\n    baseUrl: https://proxy.example.com\nproviders: *p\n";
		writeFileSync(file, aliased);

		expect(() => cleanConfig()).toThrow(/cannot remove provider "anthropic"/);
		expect(readFileSync(file, "utf8")).toBe(aliased);
		expect(readdirSync(dir)).toEqual(["models.yml"]);
	});

	test("registers the cleanup handler on the cleanup channel", async () => {
		writeFileSync(join(dir, "models.yml"), MODELS_YML);
		const handlers = new Map<string, () => unknown>();
		registerProviderCleanupIpc({
			handle: (channel: string, listener: () => unknown) => {
				handlers.set(channel, listener);
			},
		} as never);

		const handler = handlers.get(IPC_COMMANDS.PROVIDER_CLEANUP_CONFIG);
		expect(handler).toBeDefined();
		const result = (await handler?.()) as { removed: string[] };
		expect(result.removed.sort()).toEqual(["anthropic", "my-proxy"]);
		expect(existsSync(join(dir, "models.yml"))).toBe(true);
	});
});
