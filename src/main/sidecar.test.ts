import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Store from "electron-store";
import { describe, expect, it, vi } from "vitest";
import type { CommandOutputFrame, PromptResultFrame, SidecarStatus, SidecarStatusPayload } from "../shared/rpc-types";
import { missingSidecarMessage, type ReadyGate, type SidecarFailureReport, SidecarManager } from "./sidecar";

async function waitForReady(sidecar: SidecarManager): Promise<void> {
	const ready = Promise.withResolvers<void>();
	const onStatus = ({ status }: { status: SidecarStatus }) => {
		if (status === "ready") ready.resolve();
	};
	sidecar.on("status", onStatus);
	try {
		await ready.promise;
	} finally {
		sidecar.off("status", onStatus);
	}
}

describe("SidecarManager", () => {
	it("passes the active session path on a manual restart", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-"));
		const logPath = path.join(tempDir, "argv.json");
		const binaryPath = path.join(tempDir, "fake-sidecar.ts");
		const sessionPath = path.join(tempDir, "session.jsonl");
		await fs.writeFile(
			binaryPath,
			`#!/usr/bin/env bun\nimport * as fs from "node:fs/promises";\nawait fs.writeFile(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);
		await fs.chmod(binaryPath, 0o755);

		const sidecar = new SidecarManager({ binaryPath, cwd: tempDir });
		try {
			const firstReady = waitForReady(sidecar);
			sidecar.start();
			await firstReady;

			const restarted = waitForReady(sidecar);
			sidecar.restart(undefined, sessionPath);
			await restarted;

			const launch: unknown = JSON.parse(await fs.readFile(logPath, "utf8"));
			expect(launch).toEqual(["--mode", "rpc-ui", "--session", sessionPath]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("spawns a chat sidecar with --chat in the code-controlled argv", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-chat-"));
		const logPath = path.join(tempDir, "argv.json");
		const binaryPath = path.join(tempDir, "fake-sidecar.ts");
		await fs.writeFile(
			binaryPath,
			`#!/usr/bin/env bun\nimport * as fs from "node:fs/promises";\nawait fs.writeFile(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);
		await fs.chmod(binaryPath, 0o755);

		const sidecar = new SidecarManager({ binaryPath, cwd: tempDir, kind: "chat" });
		try {
			const ready = waitForReady(sidecar);
			sidecar.start();
			await ready;

			const launch: unknown = JSON.parse(await fs.readFile(logPath, "utf8"));
			expect(launch).toEqual(["--mode", "rpc-ui", "--chat"]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("forces a freshly created tab to bypass the CLI auto-resume setting", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-fresh-"));
		const logPath = path.join(tempDir, "argv.json");
		const binaryPath = path.join(tempDir, "fake-sidecar.ts");
		await fs.writeFile(
			binaryPath,
			`#!/usr/bin/env bun\nimport * as fs from "node:fs/promises";\nawait fs.writeFile(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);
		await fs.chmod(binaryPath, 0o755);

		const sidecar = new SidecarManager({ binaryPath, cwd: tempDir, fresh: true });
		try {
			const ready = waitForReady(sidecar);
			sidecar.start();
			await ready;

			const launch: unknown = JSON.parse(await fs.readFile(logPath, "utf8"));
			expect(launch).toEqual(["--mode", "rpc-ui", "--no-auto-resume"]);

			const restarted = waitForReady(sidecar);
			sidecar.restart();
			await restarted;
			const restartLaunch: unknown = JSON.parse(await fs.readFile(logPath, "utf8"));
			expect(restartLaunch).toEqual(["--mode", "rpc-ui"]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("routes prompt results and text-mode command output as dedicated frames", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-output-"));
		const binaryPath = path.join(tempDir, "fake-sidecar.ts");
		await fs.writeFile(
			binaryPath,
			`#!/usr/bin/env bun\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdout.write(JSON.stringify({ type: "prompt_result", id: "local-command", agentInvoked: false }) + "\\n");\nprocess.stdout.write(JSON.stringify({ type: "command_output", text: "Enabled models" }) + "\\n");\nprocess.stdin.resume();\n`,
		);
		await fs.chmod(binaryPath, 0o755);

		const sidecar = new SidecarManager({ binaryPath, cwd: tempDir });
		const received = Promise.withResolvers<CommandOutputFrame>();
		sidecar.once("commandOutput", frame => received.resolve(frame as CommandOutputFrame));
		const promptResult = Promise.withResolvers<PromptResultFrame>();
		sidecar.once("promptResult", frame => promptResult.resolve(frame as PromptResultFrame));
		try {
			sidecar.start();
			expect(await Promise.all([promptResult.promise, received.promise])).toEqual([
				{ type: "prompt_result", id: "local-command", agentInvoked: false },
				{ type: "command_output", text: "Enabled models" },
			]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("appends the workspace launch profile flags at spawn, denylist-proof", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-profile-"));
		const fakeHome = path.join(tempDir, "home");
		const workspaceCwd = path.join(tempDir, "workspace");
		await fs.mkdir(fakeHome, { recursive: true });
		await fs.mkdir(workspaceCwd, { recursive: true });
		const logPath = path.join(tempDir, "argv.json");
		const binaryPath = path.join(tempDir, "fake-sidecar.ts");
		await fs.writeFile(
			binaryPath,
			`#!/usr/bin/env bun\nimport * as fs from "node:fs/promises";\nawait fs.writeFile(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);
		await fs.chmod(binaryPath, 0o755);

		// electron-store/conf resolves its prefs path from os.homedir() per
		// construction, so a redirected HOME lands the store inside tempDir.
		// Discover the exact path through the same stack rather than hardcoding
		// conf internals, then seed the workspace profile into it.
		const originalHome = process.env.HOME;
		process.env.HOME = fakeHome;
		const sidecar = new SidecarManager({ binaryPath, cwd: workspaceCwd });
		try {
			// Same options as the loader; a variable sidesteps the excess-property
			// check on electron-store's Options type (projectName reaches conf).
			const storeOptions = { name: "prefs", projectName: "omp-gui" };
			const probe = new Store(storeOptions);
			await fs.mkdir(path.dirname(probe.path), { recursive: true });
			await fs.writeFile(
				probe.path,
				JSON.stringify({
					launchProfiles: {
						[workspaceCwd]: {
							appendSystemPrompt: "GUI injected",
							noRules: true,
							addDirs: ["/data/extra"],
							tools: ["read", "bash"],
							// Smuggled keys that could reach code-controlled flags —
							// parseLaunchProfile drops them before the mapping.
							"--session": "hijack",
							session: "hijack",
						},
					},
				}),
			);

			const ready = waitForReady(sidecar);
			sidecar.start();
			await ready;

			const launch: unknown = JSON.parse(await fs.readFile(logPath, "utf8"));
			expect(launch).toEqual([
				"--mode",
				"rpc-ui",
				"--append-system-prompt",
				"GUI injected",
				"--no-rules",
				"--add-dir",
				"/data/extra",
				"--tools",
				"read,bash",
			]);
		} finally {
			process.env.HOME = originalHome;
			sidecar.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("adoptCwd re-roots the reported cwd and plain restarts spawn there", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-adopt-"));
		// realpath: the spawned process's process.cwd() resolves /var symlinks.
		const adoptedCwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-adopted-")));
		const logPath = path.join(tempDir, "spawn.json");
		const binaryPath = path.join(tempDir, "fake-sidecar.ts");
		await fs.writeFile(
			binaryPath,
			`#!/usr/bin/env bun\nimport * as fs from "node:fs/promises";\nawait fs.writeFile(${JSON.stringify(logPath)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);
		await fs.chmod(binaryPath, 0o755);

		const sidecar = new SidecarManager({ binaryPath, cwd: tempDir });
		try {
			// Same-cwd adoption is a no-op; a new cwd moves the reported cwd.
			expect(sidecar.adoptCwd(tempDir)).toBe(false);
			expect(sidecar.adoptCwd(adoptedCwd)).toBe(true);
			expect(sidecar.cwd).toBe(adoptedCwd);

			// A plain restart (crash recovery, manual session resume) respawns in
			// the ADOPTED cwd — the session's workspace, not the stale spawn cwd.
			const ready = waitForReady(sidecar);
			sidecar.restart();
			await ready;

			const spawn = JSON.parse(await fs.readFile(logPath, "utf8")) as { cwd: string };
			expect(spawn.cwd).toBe(adoptedCwd);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
			await fs.rm(adoptedCwd, { recursive: true, force: true });
		}
	});

	it("keeps a boot-crashing sidecar in the restart loop instead of a false ready", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-boot-crash-"));
		const binaryPath = path.join(tempDir, "fake-sidecar.ts");
		// Advertises protocol v2 and never answers `negotiate_protocol`, then dies:
		// teardown rejects the pending negotiation on a generation that is already
		// gone, which is what used to report "ready" and zero the restart counter.
		await fs.writeFile(
			binaryPath,
			`#!/usr/bin/env bun\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 2, supportedProtocolVersions: [2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 }) + "\\n");\nsetTimeout(() => process.exit(3), 120);\n`,
		);
		await fs.chmod(binaryPath, 0o755);

		const statuses: SidecarStatusPayload[] = [];
		const sidecar = new SidecarManager({ binaryPath, cwd: tempDir });
		sidecar.on("status", payload => statuses.push(payload));
		try {
			sidecar.start();
			await expect
				.poll(() => statuses.some(payload => payload.status === "restarting"), { timeout: 9_000, interval: 50 })
				.toBe(true);
			// The rejected negotiation settles as a microtask after the status push.
			await delay(20);

			expect(statuses.at(-1)).toMatchObject({
				status: "restarting",
				restart: { attempt: 1, maxAttempts: 3 },
			});
			expect(statuses.filter(payload => payload.status === "ready")).toEqual([]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	}, 15_000);

	it("drops a spawn whose env resolution was superseded by a restart", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-superseded-"));
		const pidPath = path.join(tempDir, "pids.txt");
		const binaryPath = path.join(tempDir, "fake-sidecar.ts");
		await fs.writeFile(
			binaryPath,
			`#!/usr/bin/env bun\nimport * as fs from "node:fs/promises";\nawait fs.appendFile(${JSON.stringify(pidPath)}, String(process.pid) + "\\n");\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);
		await fs.chmod(binaryPath, 0o755);

		const sidecar = new SidecarManager({
			binaryPath,
			cwd: tempDir,
			proxyEnv: async () => {
				await delay(200);
				return {};
			},
		});
		const readPids = async (): Promise<string[]> => {
			try {
				return (await fs.readFile(pidPath, "utf8")).trim().split("\n").filter(Boolean);
			} catch {
				return [];
			}
		};
		try {
			sidecar.start();
			// Inside the first env window: restart() has no child to kill yet, so
			// without the guard both pending resolutions would spawn.
			await delay(50);
			sidecar.restart();
			await expect.poll(readPids, { timeout: 9_000, interval: 50 }).toHaveLength(1);
			// Both resolutions are 50ms apart, so a superseded spawn that was going
			// to happen has long since written its pid by now.
			await delay(1_000);
			expect(await readPids()).toHaveLength(1);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	}, 15_000);

	it("surfaces a reinstall instruction, not a build instruction, when the packaged binary is missing", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-nobin-packaged-"));
		const statuses: SidecarStatusPayload[] = [];
		const sidecar = new SidecarManager({ binaryPath: "", cwd: tempDir, packaged: true });
		sidecar.on("status", payload => statuses.push(payload));
		try {
			sidecar.start();
			expect(statuses[0]).toMatchObject({ status: "error" });
			expect(statuses[0].message).toContain("Reinstall");
			// A packaged user has no source checkout — sending them to build:omp
			// is an instruction they cannot follow.
			expect(statuses[0].message).not.toContain("build:omp");
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps the build instruction for a dev tree with no sidecar binary", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-nobin-dev-"));
		const statuses: SidecarStatusPayload[] = [];
		const sidecar = new SidecarManager({ binaryPath: "", cwd: tempDir });
		sidecar.on("status", payload => statuses.push(payload));
		try {
			sidecar.start();
			expect(statuses[0]).toMatchObject({ status: "error" });
			expect(statuses[0].message).toContain("build:omp");
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("names the missing packaged binary by path and the app to reinstall", () => {
		const message = missingSidecarMessage(true, "/Applications/Sai ATLAS.app/Contents/Resources");
		expect(message).toContain(path.join("/Applications/Sai ATLAS.app/Contents/Resources", "omp"));
		expect(message).toContain("Reinstall Sai ATLAS");
	});

	it("carries the crashed spawn's stderr into the restart reason and the crash report", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-stderr-"));
		const binaryPath = path.join(tempDir, "fake-sidecar.ts");
		await fs.writeFile(
			binaryPath,
			`#!/usr/bin/env bun\nprocess.stderr.write("dyld: Library not loaded: pi_natives\\n  Referenced by: omp\\n");\nsetTimeout(() => process.exit(4), 120);\n`,
		);
		await fs.chmod(binaryPath, 0o755);

		const reportFailure = vi.fn();
		const statuses: SidecarStatusPayload[] = [];
		const sidecar = new SidecarManager({ binaryPath, cwd: tempDir, reportFailure });
		sidecar.on("status", payload => statuses.push(payload));
		try {
			sidecar.start();
			await expect
				.poll(() => statuses.some(payload => payload.status === "restarting"), { timeout: 9_000, interval: 50 })
				.toBe(true);

			const reason = statuses[statuses.length - 1].message ?? "";
			expect(reason).toContain("Exit code 4");
			expect(reason).toContain("dyld: Library not loaded: pi_natives");
			// Stack-ish continuation lines stay out of the one-line reason.
			expect(reason).not.toContain("Referenced by");

			const report = reportFailure.mock.calls[0]?.[0] as SidecarFailureReport;
			expect(report).toMatchObject({ attempt: 1, maxAttempts: 3, cwd: tempDir });
			expect(report.stderr).toEqual(["dyld: Library not loaded: pi_natives", "  Referenced by: omp"]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	}, 15_000);

	describe("hibernation", () => {
		interface FakeOptions {
			/** Exit 0 when stdin closes, as RPC mode does after its teardown. */
			exitOnEof?: boolean;
			exitOnTerm?: boolean;
			/** Command types answered with success: false. */
			fail?: string[];
			/** Exit on this command, but only in the first spawn. */
			crashOnceOn?: string;
		}

		/** A fake sidecar that logs its spawns, stdin EOF, SIGTERM and every command. */
		async function fakeSidecar(
			dir: string,
			options: FakeOptions = {},
		): Promise<{ binaryPath: string; logPath: string }> {
			const logPath = path.join(dir, "log.txt");
			const crashMarker = path.join(dir, "crashed");
			const binaryPath = path.join(dir, "fake-sidecar.ts");
			const config = JSON.stringify({
				logPath,
				crashMarker,
				exitOnEof: options.exitOnEof ?? true,
				exitOnTerm: options.exitOnTerm ?? true,
				fail: options.fail ?? [],
				crashOnceOn: options.crashOnceOn ?? null,
			});
			await fs.writeFile(
				binaryPath,
				`#!/usr/bin/env bun
import * as fs from "node:fs";
const config = ${config};
// Teardown may remove the directory before a late SIGTERM is logged.
const log = line => {
	try {
		fs.appendFileSync(config.logPath, line + "\\n");
	} catch {}
};
log("spawn " + process.pid + " " + JSON.stringify(process.argv.slice(2)));
process.on("SIGTERM", () => {
	log("term");
	if (config.exitOnTerm) process.exit(0);
});
if (!config.exitOnEof) setInterval(() => {}, 1000);
const send = frame => process.stdout.write(JSON.stringify(frame) + "\\n");
send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] });
let buffer = "";
process.stdin.on("data", chunk => {
	buffer += chunk;
	for (let index = buffer.indexOf("\\n"); index >= 0; index = buffer.indexOf("\\n")) {
		const command = JSON.parse(buffer.slice(0, index));
		buffer = buffer.slice(index + 1);
		log("cmd " + command.type);
		if (command.type === config.crashOnceOn && !fs.existsSync(config.crashMarker)) {
			fs.writeFileSync(config.crashMarker, "");
			process.exit(3);
		}
		const success = !config.fail.includes(command.type);
		send({ type: "response", id: command.id, command: command.type, success, ...(success ? {} : { error: "refused" }) });
	}
});
process.stdin.on("end", () => {
	log("eof");
	if (config.exitOnEof) process.exit(0);
});
`,
			);
			await fs.chmod(binaryPath, 0o755);
			return { binaryPath, logPath };
		}

		async function logLines(logPath: string): Promise<string[]> {
			return (await fs.readFile(logPath, "utf8").catch(() => "")).split("\n").filter(Boolean);
		}

		function spawnedPids(lines: string[]): number[] {
			return lines.filter(line => line.startsWith("spawn ")).map(line => Number(line.split(" ")[1]));
		}

		function isAlive(pid: number): boolean {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		}

		function lastArgv(lines: string[]): unknown {
			const spawns = lines.filter(line => line.startsWith("spawn "));
			const last = spawns[spawns.length - 1] ?? "";
			return JSON.parse(last.slice(last.indexOf("[")));
		}

		it("stops through stdin EOF, reports asleep at once, and never restarts", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-hibernate-"));
			const { binaryPath, logPath } = await fakeSidecar(tempDir);
			const statuses: SidecarStatusPayload[] = [];
			const sidecar = new SidecarManager({ binaryPath, cwd: tempDir });
			sidecar.on("status", payload => statuses.push(payload));
			try {
				const ready = waitForReady(sidecar);
				sidecar.start();
				await ready;

				const stopped = sidecar.hibernate();
				expect(sidecar.status).toBe("asleep");
				expect(statuses[statuses.length - 1]).toMatchObject({ status: "asleep", message: "Hibernated" });
				expect(sidecar.rpcClient).toBeNull();
				await stopped;

				const lines = await logLines(logPath);
				expect(lines).toContain("eof");
				expect(lines).not.toContain("term");
				const [pid] = spawnedPids(lines);
				expect(isAlive(pid)).toBe(false);

				await delay(400);
				expect(sidecar.status).toBe("asleep");
				expect(spawnedPids(await logLines(logPath))).toHaveLength(1);
			} finally {
				sidecar.dispose();
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		});

		it("closes stdin first, then escalates to SIGTERM and SIGKILL when teardown overruns", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-hibernate-stuck-"));
			const { binaryPath, logPath } = await fakeSidecar(tempDir, { exitOnEof: false, exitOnTerm: false });
			const sidecar = new SidecarManager({ binaryPath, cwd: tempDir });
			try {
				const ready = waitForReady(sidecar);
				sidecar.start();
				await ready;

				const started = performance.now();
				await sidecar.hibernate({ drainMs: 300, termMs: 300 });
				expect(performance.now() - started).toBeGreaterThanOrEqual(550);

				const lines = await logLines(logPath);
				expect(lines.indexOf("eof")).toBeGreaterThan(-1);
				expect(lines.indexOf("term")).toBeGreaterThan(lines.indexOf("eof"));
				const [pid] = spawnedPids(lines);
				expect(isAlive(pid)).toBe(false);
				expect(sidecar.status).toBe("asleep");
			} finally {
				sidecar.dispose();
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		});

		it("does not spawn behind a hibernation that lands while the env resolves", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-hibernate-env-"));
			const { binaryPath, logPath } = await fakeSidecar(tempDir);
			const sidecar = new SidecarManager({
				binaryPath,
				cwd: tempDir,
				proxyEnv: () => delay(200).then(() => ({})),
			});
			try {
				sidecar.start();
				await sidecar.hibernate();
				await delay(500);
				expect(await logLines(logPath)).toEqual([]);
				expect(sidecar.status).toBe("asleep");
			} finally {
				sidecar.dispose();
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		});

		it("wakes into the session it slept on, or fresh when that session was deleted", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-wake-"));
			const { binaryPath, logPath } = await fakeSidecar(tempDir);
			const sessionPath = path.join(tempDir, "session.jsonl");
			const sidecar = new SidecarManager({ binaryPath, cwd: tempDir, fresh: true });
			try {
				let ready = waitForReady(sidecar);
				sidecar.start();
				await ready;
				expect(lastArgv(await logLines(logPath))).toEqual(["--mode", "rpc-ui", "--no-auto-resume"]);

				await sidecar.hibernate();
				ready = waitForReady(sidecar);
				sidecar.wake(sessionPath);
				await ready;
				expect(lastArgv(await logLines(logPath))).toEqual(["--mode", "rpc-ui", "--session", sessionPath]);

				// The first ready cleared the creation-time freshness; a wake with no
				// session must still refuse to auto-resume someone else's.
				await sidecar.hibernate();
				ready = waitForReady(sidecar);
				sidecar.wake(null);
				await ready;
				expect(lastArgv(await logLines(logPath))).toEqual(["--mode", "rpc-ui", "--no-auto-resume"]);
			} finally {
				sidecar.dispose();
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		});

		it("holds ready back until the wake's gate has finished", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-gate-"));
			const { binaryPath, logPath } = await fakeSidecar(tempDir);
			const statuses: SidecarStatusPayload[] = [];
			const sidecar = new SidecarManager({ binaryPath, cwd: tempDir });
			sidecar.on("status", payload => statuses.push(payload));
			let readyDuringGate = -1;
			try {
				sidecar.wake(path.join(tempDir, "session.jsonl"), async client => {
					const response = await client.command({ type: "set_plan_mode", enabled: true });
					expect(response.success).toBe(true);
					await delay(200);
					readyDuringGate = statuses.filter(payload => payload.status === "ready").length;
					return { modesNotRestored: ["loop"] };
				});
				await waitForReady(sidecar);

				expect(readyDuringGate).toBe(0);
				expect(await logLines(logPath)).toContain("cmd set_plan_mode");
				expect(statuses.filter(payload => payload.status === "ready")).toEqual([
					{ status: "ready", cwd: tempDir, message: undefined, restart: undefined, modesNotRestored: ["loop"] },
				]);
			} finally {
				sidecar.dispose();
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		});

		const refusePlanMode: ReadyGate = async client => {
			const response = await client.command({ type: "set_plan_mode", enabled: true });
			return response.success ? {} : { error: "Plan mode could not be restored", modesNotRestored: ["plan"] };
		};

		it("stops the child and goes to error instead of ready when the gate refuses", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-gate-refused-"));
			const { binaryPath, logPath } = await fakeSidecar(tempDir, { fail: ["set_plan_mode"] });
			const statuses: SidecarStatusPayload[] = [];
			const sidecar = new SidecarManager({ binaryPath, cwd: tempDir });
			sidecar.on("status", payload => statuses.push(payload));
			try {
				sidecar.wake(path.join(tempDir, "session.jsonl"), refusePlanMode);
				await expect.poll(() => sidecar.status, { timeout: 5_000, interval: 25 }).toBe("error");
				expect(statuses[statuses.length - 1]).toMatchObject({
					status: "error",
					message: "Plan mode could not be restored",
					modesNotRestored: ["plan"],
				});
				expect(statuses.some(payload => payload.status === "ready")).toBe(false);
				expect(sidecar.rpcClient).toBeNull();
				// Stopped the way hibernation stops it: stdin EOF, no signal.
				await expect.poll(() => sidecar.draining, { timeout: 5_000, interval: 25 }).toBe(false);
				const lines = await logLines(logPath);
				expect(lines).toContain("eof");
				expect(lines).not.toContain("term");
				expect(isAlive(spawnedPids(lines)[0])).toBe(false);
			} finally {
				sidecar.dispose();
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		});

		it("continues a refused wake's session on a plain restart, but not when re-rooted", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-gate-restart-"));
			const { binaryPath, logPath } = await fakeSidecar(tempDir, { fail: ["set_plan_mode"] });
			const sessionPath = path.join(tempDir, "session.jsonl");
			const sidecar = new SidecarManager({ binaryPath, cwd: tempDir });
			try {
				sidecar.wake(sessionPath, refusePlanMode);
				await expect.poll(() => sidecar.status, { timeout: 5_000, interval: 25 }).toBe("error");
				let ready = waitForReady(sidecar);
				sidecar.restart();
				await ready;
				expect(lastArgv(await logLines(logPath))).toEqual(["--mode", "rpc-ui", "--session", sessionPath]);

				await sidecar.hibernate();
				sidecar.wake(sessionPath, refusePlanMode);
				await expect.poll(() => sidecar.status, { timeout: 5_000, interval: 25 }).toBe("error");
				const otherProject = path.join(tempDir, "other");
				await fs.mkdir(otherProject);
				ready = waitForReady(sidecar);
				sidecar.restart(otherProject);
				await ready;
				expect(lastArgv(await logLines(logPath))).toEqual(["--mode", "rpc-ui"]);
			} finally {
				sidecar.dispose();
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		}, 15_000);

		it("waits for a hibernating child to exit before a restart spawns the next one", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-drain-restart-"));
			const { binaryPath, logPath } = await fakeSidecar(tempDir, { exitOnEof: false });
			const sidecar = new SidecarManager({ binaryPath, cwd: tempDir });
			try {
				let ready = waitForReady(sidecar);
				sidecar.start();
				await ready;

				const stopped = sidecar.hibernate({ drainMs: 300, termMs: 300 });
				expect(sidecar.draining).toBe(true);
				ready = waitForReady(sidecar);
				sidecar.restart();
				await ready;
				await stopped;

				const lines = await logLines(logPath);
				const spawns = lines.flatMap((line, index) => (line.startsWith("spawn ") ? [index] : []));
				expect(spawns).toHaveLength(2);
				// Only after the old child acknowledged SIGTERM did the new one start.
				expect(lines.indexOf("term")).toBeGreaterThan(-1);
				expect(spawns[1]).toBeGreaterThan(lines.indexOf("term"));
				expect(isAlive(spawnedPids(lines)[0])).toBe(false);
				expect(sidecar.draining).toBe(false);
			} finally {
				sidecar.dispose();
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		});

		it("re-runs the gate on the respawn when the child dies mid-gate", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-gate-crash-"));
			const { binaryPath, logPath } = await fakeSidecar(tempDir, { crashOnceOn: "set_plan_mode" });
			const sessionPath = path.join(tempDir, "session.jsonl");
			const sidecar = new SidecarManager({ binaryPath, cwd: tempDir });
			let gateRuns = 0;
			try {
				const ready = waitForReady(sidecar);
				sidecar.wake(sessionPath, async client => {
					gateRuns++;
					const response = await client.command({ type: "set_plan_mode", enabled: true });
					return response.success ? {} : { error: "Plan mode could not be restored" };
				});
				await ready;
				expect(gateRuns).toBe(2);
				const lines = await logLines(logPath);
				expect(lines.filter(line => line === "cmd set_plan_mode")).toHaveLength(2);
				// The respawn resumes the session the wake was for, not whatever
				// auto-resume would pick.
				const argvs = lines.filter(line => line.startsWith("spawn ")).map(line => line.slice(line.indexOf("[")));
				expect(argvs.map(argv => JSON.parse(argv))).toEqual([
					["--mode", "rpc-ui", "--session", sessionPath],
					["--mode", "rpc-ui", "--session", sessionPath],
				]);
			} finally {
				sidecar.dispose();
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		}, 10_000);

		it("keeps a pending wake's session and gate on a plain restart", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-gate-kept-"));
			const { binaryPath, logPath } = await fakeSidecar(tempDir);
			const sessionPath = path.join(tempDir, "session.jsonl");
			const sidecar = new SidecarManager({ binaryPath, cwd: tempDir });
			const gate = vi.fn(async () => ({}));
			try {
				sidecar.wake(sessionPath, gate);
				const ready = waitForReady(sidecar);
				// Restarted before the wake reached `ready`, as the banner or palette does.
				sidecar.restart();
				await ready;
				expect(gate).toHaveBeenCalledTimes(1);
				expect(lastArgv(await logLines(logPath))).toEqual(["--mode", "rpc-ui", "--session", sessionPath]);
			} finally {
				sidecar.dispose();
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		});

		it("drops a pending gate when a restart re-roots the tab or opens another session", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-gate-dropped-"));
			const { binaryPath, logPath } = await fakeSidecar(tempDir);
			const sessionPath = path.join(tempDir, "session.jsonl");
			const otherSession = path.join(tempDir, "other.jsonl");
			const otherProject = path.join(tempDir, "other");
			await fs.mkdir(otherProject);
			const sidecar = new SidecarManager({ binaryPath, cwd: tempDir });
			const gate = vi.fn(async () => ({}));
			try {
				sidecar.wake(sessionPath, gate);
				let ready = waitForReady(sidecar);
				sidecar.restart(otherProject);
				await ready;
				expect(lastArgv(await logLines(logPath))).toEqual(["--mode", "rpc-ui"]);

				await sidecar.hibernate();
				sidecar.wake(sessionPath, gate);
				ready = waitForReady(sidecar);
				sidecar.restart(undefined, otherSession);
				await ready;
				expect(lastArgv(await logLines(logPath))).toEqual(["--mode", "rpc-ui", "--session", otherSession]);
				expect(gate).not.toHaveBeenCalled();
			} finally {
				sidecar.dispose();
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		}, 10_000);
	});
});
