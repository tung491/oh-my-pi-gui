import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { StatsClient } from "./stats-client";
import { StatsServerManager } from "./stats-server";

afterEach(() => vi.restoreAllMocks());

test("a live listener is never respawned by a demand-driven revive", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stats-revive-"));
	const binary = path.join(directory, "stats-live.ts");
	await fs.writeFile(
		binary,
		`#!/usr/bin/env bun
process.stdout.write("Dashboard available at: http://127.0.0.1:55123\\n");
await Bun.sleep(5000);
`,
	);
	await fs.chmod(binary, 0o755);
	const server = new StatsServerManager(binary);
	try {
		server.start();
		await expect.poll(() => server.port, { timeout: 5000 }).toBe(55123);
		// Every open dashboard polls; a revive that ignored the live child would
		// stack listeners and hand the client a port nobody owns after the first exit.
		expect(server.ensureRunning()).toBe("already-pending");
		expect(server.port).toBe(55123);
	} finally {
		server.kill();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("a never-started server comes up on the first demand read", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stats-lazy-"));
	const binary = path.join(directory, "stats-lazy.ts");
	await fs.writeFile(
		binary,
		`#!/usr/bin/env bun
process.stdout.write("Dashboard available at: http://127.0.0.1:55124\\n");
await Bun.sleep(5000);
`,
	);
	await fs.chmod(binary, 0o755);
	// The app never calls start(): the first dashboard read is what spawns it.
	const server = new StatsServerManager(binary);
	try {
		expect(server.port).toBe(0);
		expect(server.ensureRunning()).toBe("scheduled");
		await expect.poll(() => server.port, { timeout: 5000 }).toBe(55124);
		expect(server.ensureRunning()).toBe("already-pending");
	} finally {
		server.kill();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("stats does not contact an unrelated default server before its own listener is ready", async () => {
	const fetch = vi.spyOn(globalThis, "fetch");
	const client = new StatsClient();
	expect(await client.probe()).toBe(false);
	await expect(client.fetch("/api/stats/requests")).rejects.toThrow("not ready");
	expect(fetch).not.toHaveBeenCalled();
});

test("split numeric loopback readiness selects the bundled listener and resets after exit", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stats-ready-"));
	const binary = path.join(directory, "stats.ts");
	await fs.writeFile(
		binary,
		`#!/usr/bin/env bun
process.stdout.write("\\x1b[32mDashboard available at: http://127.0.0.1:54");
await Bun.sleep(30);
process.stdout.write("321\\x1b[39m\\n");
await Bun.sleep(100);
process.exit(1);
`,
	);
	await fs.chmod(binary, 0o755);
	const server = new StatsServerManager(binary);
	const ports: number[] = [];
	const exits: number[] = [];
	server.on("ready", port => ports.push(port));
	server.on("exit", () => exits.push(server.port));
	try {
		server.start();
		await expect.poll(() => ports, { timeout: 5000 }).toEqual([54321]);
		await expect.poll(() => exits, { timeout: 5000 }).toEqual([0]);
	} finally {
		server.kill();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

async function fakeStats(name: string, body: string): Promise<{ directory: string; binary: string }> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), `omp-stats-${name}-`));
	const binary = path.join(directory, "stats.ts");
	await fs.writeFile(binary, `#!/usr/bin/env bun\nconst dir = ${JSON.stringify(directory)};\n${body}`);
	await fs.chmod(binary, 0o755);
	return { directory, binary };
}

const readOr = (file: string) => fs.readFile(file, "utf8").catch(() => "");

test("the stats child carries the flag that ties its life to the GUI", async () => {
	const { directory, binary } = await fakeStats(
		"orphans",
		`await Bun.write(dir + "/env", process.env.BUN_FEATURE_FLAG_NO_ORPHANS ?? "unset");
await Bun.sleep(5000);
`,
	);
	const inherited = process.env.BUN_FEATURE_FLAG_NO_ORPHANS;
	const server = new StatsServerManager(binary);
	try {
		server.start();
		await expect.poll(() => readOr(path.join(directory, "env")), { timeout: 5000 }).toBe("1");
		// Set on the child alone: anything this process spawns later must not inherit it.
		expect(process.env.BUN_FEATURE_FLAG_NO_ORPHANS).toBe(inherited);
	} finally {
		server.kill();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("stop() ends the child with SIGINT and never schedules a restart", async () => {
	const { directory, binary } = await fakeStats(
		"stop",
		`import { appendFileSync, writeFileSync } from "node:fs";
appendFileSync(dir + "/spawns", "x");
process.on("SIGINT", () => {
	writeFileSync(dir + "/signal", "SIGINT");
	process.exit(130);
});
process.stdout.write("Dashboard available at: http://127.0.0.1:55125\\n");
await Bun.sleep(5000);
`,
	);
	const server = new StatsServerManager(binary);
	const exits: Array<number | null> = [];
	server.on("exit", code => exits.push(code));
	try {
		server.start();
		await expect.poll(() => server.port, { timeout: 5000 }).toBe(55125);
		server.stop();
		expect(server.port).toBe(0);
		expect(exits).toEqual([null]);
		await expect.poll(() => readOr(path.join(directory, "signal")), { timeout: 5000 }).toBe("SIGINT");
		// A non-zero exit from a stopped child must not enter the crash ladder.
		await new Promise(resolve => setTimeout(resolve, 500));
		expect(await readOr(path.join(directory, "spawns"))).toBe("x");
		expect(exits).toEqual([null]);
	} finally {
		server.kill();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("a read after stop() revives the server", async () => {
	const { directory, binary } = await fakeStats(
		"revive-after-stop",
		`process.on("SIGINT", () => process.exit(0));
process.stdout.write("Dashboard available at: http://127.0.0.1:55126\\n");
await Bun.sleep(5000);
`,
	);
	const server = new StatsServerManager(binary);
	try {
		server.start();
		await expect.poll(() => server.port, { timeout: 5000 }).toBe(55126);
		server.stop();
		expect(server.ensureRunning()).toBe("scheduled");
		await expect.poll(() => server.port, { timeout: 5000 }).toBe(55126);
	} finally {
		server.kill();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("reads keep the server up and their absence stops it", async () => {
	const { directory, binary } = await fakeStats(
		"idle",
		`process.on("SIGINT", () => process.exit(0));
process.stdout.write("Dashboard available at: http://127.0.0.1:55127\\n");
await Bun.sleep(30000);
`,
	);
	// Reads ten times faster than the idle window, so a loaded host stalling
	// timers for a few hundred milliseconds cannot fake an idle stop.
	const server = new StatsServerManager(binary, { idleStopMs: 1000 });
	try {
		server.start();
		await expect.poll(() => server.port, { timeout: 5000 }).toBe(55127);
		const touch = setInterval(() => server.noteActivity(), 100);
		await new Promise(resolve => setTimeout(resolve, 2200));
		clearInterval(touch);
		expect(server.port).toBe(55127);
		await expect.poll(() => server.port, { timeout: 3000 }).toBe(0);
		expect(server.ensureRunning()).toBe("scheduled");
	} finally {
		server.kill();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("a server stopped while booting never announces its port", async () => {
	// Ignores SIGINT so the stopped child still prints its URL, as a slow
	// shutdown would; that late line must not reach the manager.
	const { directory, binary } = await fakeStats(
		"stop-booting",
		`import { writeFileSync } from "node:fs";
process.on("SIGINT", () => {});
writeFileSync(dir + "/up", "1");
await Bun.sleep(300);
process.stdout.write("Dashboard available at: http://127.0.0.1:55128\\n");
writeFileSync(dir + "/printed", "1");
await Bun.sleep(800);
`,
	);
	const server = new StatsServerManager(binary);
	const ready: number[] = [];
	server.on("ready", port => ready.push(port));
	try {
		server.start();
		await expect.poll(() => readOr(path.join(directory, "up")), { timeout: 5000 }).toBe("1");
		server.stop();
		await expect.poll(() => readOr(path.join(directory, "printed")), { timeout: 5000 }).toBe("1");
		await new Promise(resolve => setTimeout(resolve, 100));
		expect(ready).toEqual([]);
		expect(server.port).toBe(0);
	} finally {
		server.kill();
		await fs.rm(directory, { recursive: true, force: true });
	}
});
