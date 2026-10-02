import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectOllamaInstall, type InstallChecks, isOllamaInstalled, parseTags, probeOllama, remedyFor } from "./probe";
import { closedPortUrl, type FakeOllama, sendJson, startFakeOllama } from "./test-fake-ollama";

function checks(over: Partial<{ unit: boolean; path: boolean; files: string[] }> = {}): InstallChecks {
	return {
		systemdUnit: async () => over.unit ?? false,
		onPath: async () => over.path ?? false,
		exists: path => (over.files ?? []).includes(path),
	};
}

let fake: FakeOllama | undefined;
afterEach(async () => {
	await fake?.close();
	fake = undefined;
});

describe("probeOllama", () => {
	it("reports ok with the version and installed tags", async () => {
		fake = await startFakeOllama((req, res) => {
			if (req.url === "/api/version") return sendJson(res, { version: "0.12.3" });
			if (req.url === "/api/tags")
				return sendJson(res, { models: [{ name: "qwen3:4b" }, { name: "gpt-oss:20b" }, {}] });
			sendJson(res, { error: "not found" }, 404);
		});
		const status = await probeOllama({ baseUrl: fake.url, platform: "linux", checks: checks() });
		expect(status).toEqual({
			state: "ok",
			baseUrl: fake.url,
			version: "0.12.3",
			modelCount: 2,
			installedTags: ["qwen3:4b", "gpt-oss:20b"],
			platform: "linux",
			remedy: null,
		});
	});

	it("reports stopped with the start remedy when the systemd unit exists but nothing answers", async () => {
		const status = await probeOllama({
			baseUrl: await closedPortUrl(),
			platform: "linux",
			checks: checks({ unit: true }),
		});
		expect(status.state).toBe("stopped");
		expect(status.remedy).toBe("linux-start");
		expect(status.fault).toBeTruthy();
		expect(status.installedTags).toEqual([]);
	});

	it("reports stopped with no start remedy when only the binary is on PATH", async () => {
		const status = await probeOllama({
			baseUrl: await closedPortUrl(),
			platform: "linux",
			checks: checks({ path: true }),
		});
		expect(status.state).toBe("stopped");
		// No ollama.service to start: systemctl would only fail after the password prompt.
		expect(status.remedy).toBeNull();
	});

	it("reports absent with the install remedy when nothing is installed", async () => {
		const status = await probeOllama({ baseUrl: await closedPortUrl(), platform: "linux", checks: checks() });
		expect(status.state).toBe("absent");
		expect(status.remedy).toBe("linux-install");
	});

	it("offers no remedy off Linux", async () => {
		const status = await probeOllama({ baseUrl: await closedPortUrl(), platform: "darwin", checks: checks() });
		expect(status).toMatchObject({ state: "absent", remedy: null, platform: "darwin" });
	});

	it("treats a daemon that never answers as down within the timeout", async () => {
		fake = await startFakeOllama(() => {
			// Never respond.
		});
		const started = Date.now();
		const status = await probeOllama({
			baseUrl: fake.url,
			platform: "linux",
			checks: checks({ unit: true }),
			timeoutMs: 100,
		});
		expect(status.state).toBe("stopped");
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("treats a malformed tags body as down", async () => {
		fake = await startFakeOllama((req, res) => {
			if (req.url === "/api/version") return sendJson(res, { version: "1" });
			sendJson(res, { nope: true });
		});
		const status = await probeOllama({ baseUrl: fake.url, platform: "linux", checks: checks() });
		expect(status.state).toBe("absent");
	});
});

describe("isOllamaInstalled", () => {
	it("tells a systemd install from a binary on PATH on Linux", async () => {
		expect(await detectOllamaInstall("linux", checks({ unit: true }), undefined)).toEqual({
			installed: true,
			systemdUnit: true,
		});
		expect(await detectOllamaInstall("linux", checks({ path: true }), undefined)).toEqual({
			installed: true,
			systemdUnit: false,
		});
		expect(await isOllamaInstalled("linux", checks(), undefined)).toBe(false);
	});

	it("checks the macOS app bundle", async () => {
		expect(await isOllamaInstalled("darwin", checks({ files: ["/Applications/Ollama.app"] }), undefined)).toBe(true);
		expect(await isOllamaInstalled("darwin", checks(), undefined)).toBe(false);
	});

	it("checks the Windows per-user install", async () => {
		const exe = join("C:\\Users\\u\\AppData\\Local", "Programs", "Ollama", "ollama.exe");
		expect(await isOllamaInstalled("win32", checks({ files: [exe] }), "C:\\Users\\u\\AppData\\Local")).toBe(true);
		expect(await isOllamaInstalled("win32", checks(), undefined)).toBe(false);
	});
});

describe("remedyFor", () => {
	it("maps Linux states to remedies", () => {
		expect(remedyFor("ok", "linux", true)).toBeNull();
		expect(remedyFor("stopped", "linux", true)).toBe("linux-start");
		expect(remedyFor("stopped", "linux", false)).toBeNull();
		expect(remedyFor("absent", "linux", false)).toBe("linux-install");
		expect(remedyFor("absent", "win32", false)).toBeNull();
	});
});

describe("parseTags", () => {
	it("rejects a body without a models array", () => {
		expect(() => parseTags(null)).toThrow();
		expect(() => parseTags({ models: "x" })).toThrow();
	});
});
