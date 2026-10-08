import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Store from "electron-store";
import { describe, expect, it, vi } from "vitest";
import type { CommandOutputFrame, PromptResultFrame, SidecarStatus, SidecarStatusPayload } from "../shared/rpc-types";
import { ASSISTANT_PACK_FILES } from "./assistant-pack";
import {
	missingSidecarMessage,
	type SidecarFailureReport,
	SidecarManager,
	type SidecarStartRefusalReport,
} from "./sidecar";

/** The `--tools` value of the spawn contract for the platform running the suite. */
const PACK_TOOLS =
	process.platform === "linux"
		? "read,glob,write,ask,diagnose,system_status,open_item,os_setting,office_report,office_slides,office_clean"
		: "read,glob,write,ask,office_report,office_slides,office_clean";

/** The pack part of the spawn argv, written out so the test does not restate the code it checks. */
function packFlags(pack: string): string[] {
	return [
		"--no-extensions",
		"--no-rules",
		"--no-context-files",
		"--extension",
		pack,
		"--tools",
		PACK_TOOLS,
		"--system-prompt",
		path.join(pack, "system-prompt.md"),
		"--append-system-prompt",
		path.join(pack, "append-system-prompt.md"),
		"--config",
		path.join(pack, "config.yml"),
		"--approval-mode",
		"always-ask",
	];
}

/** Flags the pack passes itself, so a profile's copy shows up as a second occurrence. */
const PACK_OWNED_FLAGS = ["--tools", "--config", "--append-system-prompt", "--no-rules", "--no-context-files"];

/** An `assistant-pack/` beside a fake binary in `dir`, holding every listed file except `leaveOut`. */
async function makePackFixture(dir: string, leaveOut?: string): Promise<string> {
	const pack = path.join(dir, "assistant-pack");
	for (const file of ASSISTANT_PACK_FILES) {
		if (file === leaveOut) continue;
		const target = path.join(pack, file);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, "x");
	}
	await fs.mkdir(pack, { recursive: true });
	return pack;
}

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
		const pack = await makePackFixture(tempDir);

		const sidecar = new SidecarManager({ binaryPath, cwd: tempDir });
		try {
			const firstReady = waitForReady(sidecar);
			sidecar.start();
			await firstReady;

			const restarted = waitForReady(sidecar);
			sidecar.restart(undefined, sessionPath);
			await restarted;

			const launch: unknown = JSON.parse(await fs.readFile(logPath, "utf8"));
			expect(launch).toEqual(["--mode", "rpc-ui", "--session", sessionPath, ...packFlags(pack)]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("spawns every sidecar with the assistant pack flags and never --chat", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-pack-"));
		const logPath = path.join(tempDir, "argv.json");
		const envPath = path.join(tempDir, "env.json");
		const binaryPath = path.join(tempDir, "fake-sidecar.ts");
		await fs.writeFile(
			binaryPath,
			`#!/usr/bin/env bun\nimport * as fs from "node:fs/promises";\nawait fs.writeFile(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));\nawait fs.writeFile(${JSON.stringify(envPath)}, JSON.stringify({ lang: process.env.SAI_ATLAS_LANG ?? null, bashEnv: process.env.BASH_ENV ?? null, env: process.env.ENV ?? null, ompProfile: process.env.OMP_PROFILE ?? null, piProfile: process.env.PI_PROFILE ?? null, smolModel: process.env.PI_SMOL_MODEL ?? null, anthropic: process.env.ANTHROPIC_API_KEY ?? null, openai: process.env.OPENAI_API_KEY ?? null, ollamaCloud: process.env.OLLAMA_CLOUD_API_KEY ?? null, ollamaHost: process.env.OLLAMA_HOST ?? null }));\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);
		await fs.chmod(binaryPath, 0o755);
		const pack = await makePackFixture(tempDir);

		// A tab created as a chat still gets the pack: the chat branch is gone.
		// Shell startup files, omp profile selectors, role model overrides and
		// online provider credentials reaching the spawn env are removed, whether
		// from the login shell or the app's own env; the local Ollama address
		// survives; the app language is set last.
		const sidecar = new SidecarManager({
			binaryPath,
			cwd: tempDir,
			kind: "chat",
			fresh: true,
			shellEnv: () =>
				Promise.resolve({
					BASH_ENV: "/rc/bash_env",
					ENV: "/rc/env",
					OMP_PROFILE: "work",
					PI_SMOL_MODEL: "anthropic/claude-haiku-4-5",
					ANTHROPIC_API_KEY: "sk-ant",
					OLLAMA_CLOUD_API_KEY: "cloud",
					OLLAMA_HOST: "127.0.0.1:11434",
					SAI_ATLAS_LANG: "xx",
				}),
			language: () => "vi",
		});
		vi.stubEnv("PI_PROFILE", "work");
		vi.stubEnv("OPENAI_API_KEY", "sk-openai");
		try {
			const ready = waitForReady(sidecar);
			sidecar.start();
			await ready;

			const launch: unknown = JSON.parse(await fs.readFile(logPath, "utf8"));
			expect(launch).toEqual([
				"--mode",
				"rpc-ui",
				"--no-auto-resume",
				"--no-extensions",
				"--no-rules",
				"--no-context-files",
				"--extension",
				pack,
				"--tools",
				PACK_TOOLS,
				"--system-prompt",
				path.join(pack, "system-prompt.md"),
				"--append-system-prompt",
				path.join(pack, "append-system-prompt.md"),
				"--config",
				path.join(pack, "config.yml"),
				"--approval-mode",
				"always-ask",
			]);
			expect(launch).not.toContain("--chat");
			expect(JSON.parse(await fs.readFile(envPath, "utf8"))).toEqual({
				lang: "vi",
				bashEnv: null,
				env: null,
				ompProfile: null,
				piProfile: null,
				smolModel: null,
				anthropic: null,
				openai: null,
				ollamaCloud: null,
				ollamaHost: "127.0.0.1:11434",
			});
		} finally {
			vi.unstubAllEnvs();
			sidecar.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("passes the context limits overlay after the pack config and creates a missing file", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-overlay-"));
		const logPath = path.join(tempDir, "argv.json");
		const binaryPath = path.join(tempDir, "fake-sidecar.ts");
		const overlay = path.join(tempDir, "user-data", "ollama-context-limits.yml");
		await fs.writeFile(
			binaryPath,
			`#!/usr/bin/env bun\nimport * as fs from "node:fs/promises";\nawait fs.writeFile(${JSON.stringify(logPath)}, JSON.stringify({ argv: process.argv.slice(2), ollamaContext: process.env.OLLAMA_CONTEXT_LENGTH ?? null }));\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);
		await fs.chmod(binaryPath, 0o755);
		const pack = await makePackFixture(tempDir);

		const sidecar = new SidecarManager({ binaryPath, cwd: tempDir, contextLimitsOverlay: overlay });
		vi.stubEnv("OLLAMA_CONTEXT_LENGTH", undefined);
		try {
			const ready = waitForReady(sidecar);
			sidecar.start();
			await ready;

			const launch = JSON.parse(await fs.readFile(logPath, "utf8")) as { argv: string[]; ollamaContext: string };
			expect(launch.argv).toEqual(["--mode", "rpc-ui", ...packFlags(pack), "--config", overlay]);
			expect(launch.argv.indexOf(overlay)).toBeGreaterThan(launch.argv.indexOf(path.join(pack, "config.yml")));
			expect(await fs.readFile(overlay, "utf8")).toBe("ollama:\n  contextLimits: {}\n");
			// Models with no measured limit keep the global default.
			expect(launch.ollamaContext).toBe("131072");

			// An existing overlay is loaded as it is, never reset.
			const limits = 'ollama:\n  contextLimits:\n    "qwen3:8b": 32768\n';
			await fs.writeFile(overlay, limits);
			const restarted = waitForReady(sidecar);
			sidecar.restart();
			await restarted;
			expect(await fs.readFile(overlay, "utf8")).toBe(limits);
		} finally {
			vi.unstubAllEnvs();
			sidecar.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("surfaces a reinstall instruction when a pack file is missing", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-nopack-"));
		const spawnedPath = path.join(tempDir, "spawned");
		const binaryPath = path.join(tempDir, "fake-sidecar.ts");
		await fs.writeFile(
			binaryPath,
			`#!/usr/bin/env bun\nimport * as fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(spawnedPath)}, "1");\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);
		await fs.chmod(binaryPath, 0o755);
		// The directory exists with one listed file left out, so no fallback applies.
		await makePackFixture(tempDir, "config.yml");

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		const statuses: SidecarStatusPayload[] = [];
		const sidecar = new SidecarManager({ binaryPath, cwd: tempDir, packaged: true });
		sidecar.on("status", payload => statuses.push(payload));
		try {
			sidecar.start();
			expect(statuses).toHaveLength(1);
			expect(statuses[0]).toMatchObject({ status: "error" });
			expect(statuses[0].message).toContain("config.yml");
			expect(statuses[0].message).toContain("Reinstall Sai ATLAS");
			expect(sidecar.status).toBe("error");
			await delay(500);
			await expect(fs.stat(spawnedPath)).rejects.toThrow();
			expect(statuses).toHaveLength(1);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			sidecar.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("refuses to resume a chat-stamped session without spawning", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-chat-"));
		const spawnedPath = path.join(tempDir, "spawned");
		const binaryPath = path.join(tempDir, "fake-sidecar.ts");
		await fs.writeFile(
			binaryPath,
			`#!/usr/bin/env bun\nimport * as fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(spawnedPath)}, "1");\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);
		await fs.chmod(binaryPath, 0o755);
		await makePackFixture(tempDir);
		const sessionPath = path.join(tempDir, "old-chat.jsonl");
		await fs.writeFile(
			sessionPath,
			`{"title":"Old chat"}\n${JSON.stringify({ type: "session", id: "c", kind: "chat" })}\n`,
		);

		const statuses: SidecarStatusPayload[] = [];
		const sidecar = new SidecarManager({ binaryPath, cwd: tempDir });
		sidecar.on("status", payload => statuses.push(payload));
		try {
			// A restored tab resumes its file this way the first time it is shown.
			sidecar.restart(undefined, sessionPath);
			expect(statuses).toHaveLength(1);
			expect(statuses[0]).toMatchObject({ status: "error", refusal: "kind-mismatch" });
			expect(sidecar.status).toBe("error");
			// Asking again for the same file stays refused.
			sidecar.restart(undefined, sessionPath);
			expect(statuses.map(payload => payload.refusal)).toEqual(["kind-mismatch", "kind-mismatch"]);
			await delay(500);
			await expect(fs.stat(spawnedPath)).rejects.toThrow();
			expect(statuses).toHaveLength(2);
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
		const pack = await makePackFixture(tempDir);

		const sidecar = new SidecarManager({ binaryPath, cwd: tempDir, fresh: true });
		try {
			const ready = waitForReady(sidecar);
			sidecar.start();
			await ready;

			const launch: unknown = JSON.parse(await fs.readFile(logPath, "utf8"));
			expect(launch).toEqual(["--mode", "rpc-ui", "--no-auto-resume", ...packFlags(pack)]);

			const restarted = waitForReady(sidecar);
			sidecar.restart();
			await restarted;
			const restartLaunch: unknown = JSON.parse(await fs.readFile(logPath, "utf8"));
			expect(restartLaunch).toEqual(["--mode", "rpc-ui", ...packFlags(pack)]);
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
		await makePackFixture(tempDir);

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
		const pack = await makePackFixture(tempDir);

		// electron-store/conf resolves its prefs path from os.homedir() per
		// construction, so a redirected HOME lands the store inside tempDir.
		// Discover the exact path through the same stack rather than hardcoding
		// conf internals, then seed the workspace profile into it.
		const originalHome = process.env.HOME;
		process.env.HOME = fakeHome;
		// The extraFlags seam carries what a stored profile cannot express.
		const smuggled = [
			"--tools",
			"edit",
			"--yolo",
			"--config",
			"/x",
			"-e",
			"/y",
			"--hook",
			"/z",
			"--no-context-files",
		];
		const sidecar = new SidecarManager({ binaryPath, cwd: workspaceCwd, extraFlags: smuggled });
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
							tools: ["edit"],
							config: "/x",
							noLsp: true,
							sessionDir: "/data/sessions",
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
			// Only the profile flags that cannot change what the session loads survive.
			expect(launch).toEqual([
				"--mode",
				"rpc-ui",
				...packFlags(pack),
				"--no-lsp",
				"--session-dir",
				"/data/sessions",
			]);
			for (const token of [
				...smuggled,
				"GUI injected",
				"--append-system-prompt",
				"--no-rules",
				"--add-dir",
				"/data/extra",
			]) {
				if (PACK_OWNED_FLAGS.includes(token)) continue;
				expect(launch).not.toContain(token);
			}
			// The pack's own flags appear once each; the profile's copies are gone.
			for (const flag of PACK_OWNED_FLAGS) {
				expect((launch as string[]).filter(token => token === flag)).toHaveLength(1);
			}
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
		const pack = await makePackFixture(tempDir);

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

			const spawn = JSON.parse(await fs.readFile(logPath, "utf8")) as { argv: string[]; cwd: string };
			expect(spawn.cwd).toBe(adoptedCwd);
			expect(spawn.argv).toEqual(["--mode", "rpc-ui", ...packFlags(pack)]);
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
		await makePackFixture(tempDir);

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
		await makePackFixture(tempDir);

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
		await makePackFixture(tempDir);

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

	it("keeps the whole refused-start status for a window that subscribes late", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-late-"));
		const binaryPath = path.join(tempDir, "fake-sidecar.ts");
		await fs.writeFile(binaryPath, "#!/usr/bin/env bun\nprocess.stdin.resume();\n");
		await fs.chmod(binaryPath, 0o755);
		const sessionPath = path.join(tempDir, "old-chat.jsonl");
		await fs.writeFile(
			sessionPath,
			`{"title":"Old chat"}\n${JSON.stringify({ type: "session", id: "c", kind: "chat" })}\n`,
		);
		const noBinary = new SidecarManager({ binaryPath: "", cwd: tempDir, packaged: true });
		const partialPack = new SidecarManager({ binaryPath, cwd: tempDir, packaged: true });
		const chat = new SidecarManager({ binaryPath, cwd: tempDir });
		try {
			// Before any start, the payload is the asleep status in the sidecar's folder.
			expect(noBinary.statusPayload).toEqual({ status: "asleep", cwd: tempDir });
			// Nothing listens while these starts are refused: the payload is all a late window gets.
			noBinary.start();
			expect(noBinary.statusPayload).toEqual({
				status: "error",
				message: missingSidecarMessage(true, process.resourcesPath),
				cwd: tempDir,
			});
			await makePackFixture(tempDir, "config.yml");
			partialPack.start();
			expect(partialPack.statusPayload).toMatchObject({ status: "error", cwd: tempDir });
			expect(partialPack.statusPayload.message).toContain("config.yml");
			await fs.writeFile(path.join(tempDir, "assistant-pack", "config.yml"), "x");
			chat.restart(undefined, sessionPath);
			expect(chat.statusPayload).toEqual({
				status: "error",
				message: `The session file is stamped chat: ${sessionPath}`,
				cwd: tempDir,
				refusal: "kind-mismatch",
			});
		} finally {
			for (const sidecar of [noBinary, partialPack, chat]) sidecar.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("writes each refused start to the runtime log once", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-refusal-log-"));
		const binaryPath = path.join(tempDir, "fake-sidecar.ts");
		await fs.writeFile(binaryPath, "#!/usr/bin/env bun\nprocess.stdin.resume();\n");
		await fs.chmod(binaryPath, 0o755);
		await makePackFixture(tempDir, "config.yml");
		const reports: SidecarStartRefusalReport[] = [];
		const reportStartRefusal = (report: SidecarStartRefusalReport) => reports.push(report);
		const noBinary = new SidecarManager({ binaryPath: "", cwd: tempDir, packaged: true, reportStartRefusal });
		const partialPack = new SidecarManager({ binaryPath, cwd: tempDir, packaged: true, reportStartRefusal });
		try {
			noBinary.start();
			partialPack.start();
			expect(reports).toEqual([
				{ message: noBinary.statusPayload.message, cwd: tempDir },
				{ message: partialPack.statusPayload.message, cwd: tempDir },
			]);
			expect(reports[1]?.message).toContain("config.yml");
		} finally {
			noBinary.dispose();
			partialPack.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
