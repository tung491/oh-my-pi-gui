import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	OLLAMA_REMEDY_COMMANDS,
	type OllamaInstallProgress,
	type OllamaRemedyId,
	type OllamaRemedyResult,
	type OllamaStatus,
} from "../../shared/ollama-types";
import {
	createRemedyGate,
	type ExecError,
	isRemedyId,
	REMEDY_COMMANDS,
	type RemedyDeps,
	runRemedy,
	type SpawnFn,
} from "./remedy";

function status(state: OllamaStatus["state"]): OllamaStatus {
	return {
		state,
		baseUrl: "http://127.0.0.1:11434",
		modelCount: 0,
		installedTags: [],
		platform: "linux",
		remedy: state === "ok" ? null : "linux-start",
	};
}

interface Call {
	file: string;
	args: readonly string[];
}

/** How a scripted child ends: an exit code (with optional signal), a spawn error, or never (until killed). */
type Ending = { code: number | null; signal?: NodeJS.Signals } | { error: ExecError } | "hang";

/** A child that writes `stderr` chunks one tick apart, then ends as scripted. */
function fakeSpawn(
	ending: Ending,
	stderr: readonly string[] = [],
): { spawn: SpawnFn; calls: Call[]; kills: NodeJS.Signals[] } {
	const calls: Call[] = [];
	const kills: NodeJS.Signals[] = [];
	return {
		calls,
		kills,
		spawn: (file, args, handlers) => {
			calls.push({ file, args });
			void (async () => {
				for (const chunk of stderr) {
					await new Promise(resolve => setTimeout(resolve, 0));
					handlers.onOutput("stdout", "noise on stdout 99%\n");
					handlers.onOutput("stderr", chunk);
				}
				await new Promise(resolve => setTimeout(resolve, 0));
				if (ending === "hang") return;
				if ("error" in ending) handlers.onError(ending.error);
				else handlers.onExit(ending.code, ending.signal ?? null);
			})();
			return {
				kill: signal => {
					kills.push(signal);
					if (ending === "hang") setTimeout(() => handlers.onExit(null, signal), 0);
				},
			};
		},
	};
}

/** The no-cloud steps both remedies end with, as the screen shows them. */
const NO_CLOUD_SCRIPT = [
	"mkdir -p /etc/systemd/system/ollama.service.d &&",
	"f=/etc/systemd/system/ollama.service.d/sai-atlas.conf &&",
	`s=$(printf '[Service]\\nEnvironment="OLLAMA_NO_CLOUD=1"') &&`,
	`{ [ "$(cat "$f" 2>/dev/null)" = "$s" ] || printf '%s\\n' "$s" > "$f"; } &&`,
	"systemctl daemon-reload &&",
	"systemctl restart ollama.service",
].join("\n");

const DROP_IN_DIR = "/etc/systemd/system/ollama.service.d";
const DROP_IN = '[Service]\nEnvironment="OLLAMA_NO_CLOUD=1"\n';

interface Sandbox {
	dropInDir: string;
	run(id: OllamaRemedyId, installerStatus?: number): { status: number | null; log: string[] };
}

const sandboxes: string[] = [];

/**
 * A scratch directory standing in for the drop-in directory, with fake
 * `systemctl` and `curl` that only log their arguments. PATH holds nothing
 * else, so the script under test can reach neither the real systemctl nor /etc.
 */
function sandbox(): Sandbox {
	const root = mkdtempSync(path.join(tmpdir(), "sai-atlas-remedy-"));
	sandboxes.push(root);
	const bin = path.join(root, "bin");
	const dropInDir = path.join(root, "ollama.service.d");
	const log = path.join(root, "calls.log");
	mkdirSync(bin);
	for (const tool of ["sh", "cat", "mkdir"]) {
		const real = ["/bin", "/usr/bin"].map(dir => path.join(dir, tool)).find(file => existsSync(file));
		if (!real) throw new Error(`${tool} not found`);
		symlinkSync(real, path.join(bin, tool));
	}
	writeFileSync(path.join(bin, "systemctl"), '#!/bin/sh\necho "systemctl $*" >> "$CALLS"\n', { mode: 0o755 });
	writeFileSync(path.join(bin, "curl"), '#!/bin/sh\necho "curl $*" >> "$CALLS"\necho "exit $INSTALLER_STATUS"\n', {
		mode: 0o755,
	});
	return {
		dropInDir,
		run(id, installerStatus = 0) {
			expect(dropInDir).toMatch(/^[\w/.-]+$/);
			const script = OLLAMA_REMEDY_COMMANDS[id].replaceAll(DROP_IN_DIR, dropInDir);
			expect(script).not.toContain("/etc/");
			const result = spawnSync(path.join(bin, "sh"), ["-c", script], {
				env: { PATH: bin, CALLS: log, INSTALLER_STATUS: String(installerStatus) },
				encoding: "utf8",
			});
			const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
			return { status: result.status, log: calls };
		},
	};
}

afterEach(() => {
	for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

const exitOk: Ending = { code: 0 };

function spawnError(code: string): Ending {
	return { error: Object.assign(new Error(`spawn pkexec ${code}`), { code }) };
}

function deps(
	spawn: SpawnFn,
	states: OllamaStatus["state"][] = ["stopped"],
): Partial<RemedyDeps> & Pick<RemedyDeps, "probe"> {
	let i = 0;
	return {
		platform: "linux",
		spawn,
		settleIntervalMs: 0,
		settleAttempts: 5,
		probe: async () => status(states[Math.min(i++, states.length - 1)]),
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("runRemedy", () => {
	it("runs the start script as one pkexec sh -c and waits for the daemon to answer", async () => {
		const exec = fakeSpawn(exitOk);
		const result = await runRemedy("linux-start", deps(exec.spawn, ["stopped", "stopped", "ok"]));
		expect(exec.calls).toEqual([{ file: "pkexec", args: ["sh", "-c", OLLAMA_REMEDY_COMMANDS["linux-start"]] }]);
		expect(result).toEqual({ outcome: "applied", status: status("ok") });
	});

	it("runs the install line and the no-cloud steps as one pkexec sh -c", async () => {
		const exec = fakeSpawn(exitOk);
		await runRemedy("linux-install", deps(exec.spawn, ["ok"]));
		expect(exec.calls).toEqual([{ file: "pkexec", args: ["sh", "-c", OLLAMA_REMEDY_COMMANDS["linux-install"]] }]);
	});

	it("runs exactly the command the screen shows the user", () => {
		for (const id of ["linux-start", "linux-install"] as const) {
			expect(REMEDY_COMMANDS[id]).toMatchObject({ file: "pkexec", args: ["sh", "-c", OLLAMA_REMEDY_COMMANDS[id]] });
		}
	});

	it("spells out the privileged scripts word for word", () => {
		expect(OLLAMA_REMEDY_COMMANDS["linux-start"]).toBe(NO_CLOUD_SCRIPT);
		expect(OLLAMA_REMEDY_COMMANDS["linux-install"]).toBe(
			`curl -fsSL https://ollama.com/install.sh | sh &&\n${NO_CLOUD_SCRIPT}`,
		);
	});

	it("reports failed when the command succeeds but the daemon never comes up", async () => {
		let probes = 0;
		const result = await runRemedy("linux-start", {
			...deps(fakeSpawn(exitOk).spawn),
			probe: async () => {
				probes++;
				return status("stopped");
			},
		});
		expect(result).toEqual({
			outcome: "failed",
			status: status("stopped"),
			fault: "Ollama is still not answering after the command finished",
		});
		// Every settle attempt was spent before giving up.
		expect(probes).toBe(5);
	});

	it.each([
		["missing pkexec", spawnError("ENOENT"), "", "unavailable"],
		["dismissed dialog (126)", { code: 126 }, "", "cancelled"],
		[
			"failed authentication (127)",
			{ code: 127 },
			"Error executing command as another user: Not authorized",
			"cancelled",
		],
		[
			"no authentication agent (127)",
			{ code: 127 },
			"Error executing command as another user: No authentication agent found.",
			"unavailable",
		],
		["command failure", { code: 5 }, "Failed to start ollama.service: Unit ollama.service not found.", "failed"],
		["death by signal", { code: null, signal: "SIGKILL" }, "", "failed"],
	] as const)("maps %s to %s", async (_label, ending, stderr, outcome) => {
		const exec = fakeSpawn(ending, stderr ? [stderr] : []);
		const result = await runRemedy("linux-start", deps(exec.spawn));
		expect(result.outcome).toBe(outcome);
		expect(result.status).toEqual(status("stopped"));
		if (outcome === "failed" && stderr) expect(result.fault).toBe(stderr);
		if (outcome === "cancelled") expect(result.fault).toBeUndefined();
	});

	it("stops the command with SIGTERM when it outlives its timeout", async () => {
		vi.useFakeTimers();
		const exec = fakeSpawn("hang", ["still downloading"]);
		const pending = runRemedy("linux-start", deps(exec.spawn));
		await vi.advanceTimersByTimeAsync(REMEDY_COMMANDS["linux-start"].timeoutMs);
		expect(exec.kills).toEqual(["SIGTERM"]);
		// The child's exit is a timer queued by the kill itself; fake timers place it just past the window.
		await vi.runOnlyPendingTimersAsync();
		const result = await pending;
		expect(result).toMatchObject({ outcome: "failed", fault: "Timed out: still downloading" });
	});

	it("waits for a root installer it cannot signal, and sends nothing after the done frame", async () => {
		vi.useFakeTimers();
		const frames: OllamaInstallProgress[] = [];
		let exit: (() => void) | undefined;
		const spawn: SpawnFn = (_file, _args, handlers) => {
			exit = () => {
				handlers.onOutput("stderr", ">>> Install complete.\n");
				handlers.onExit(0, null);
				handlers.onOutput("stderr", ">>> late output\n");
			};
			return {
				kill: () => handlers.onError(Object.assign(new Error("kill EPERM"), { code: "EPERM" })),
			};
		};
		const pending = runRemedy("linux-install", { ...deps(spawn, ["ok"]), onProgress: frame => frames.push(frame) });
		await vi.advanceTimersByTimeAsync(REMEDY_COMMANDS["linux-install"].timeoutMs);
		expect(frames.some(frame => frame.done)).toBe(false);
		exit?.();
		const result = await pending;
		expect(result).toEqual({ outcome: "applied", status: status("ok") });
		expect(frames.at(-1)).toEqual({ stage: "Install complete.", percent: -1, done: true });
	});

	it("keeps the last redraw of each curl bar line in the fault", async () => {
		const exec = fakeSpawn({ code: 1 }, ["\r##   10.0%\r#####  50.0%\ncurl: (56) connection reset\n"]);
		const result = await runRemedy("linux-install", deps(exec.spawn));
		expect(result.fault).toBe("#####  50.0%\ncurl: (56) connection reset");
	});

	it("keeps only the stderr tail as the fault", async () => {
		const exec = fakeSpawn({ code: 1 }, [`${"x".repeat(9000)}`, `${"x".repeat(2000)}END`]);
		const result = await runRemedy("linux-install", deps(exec.spawn));
		expect(result.fault?.length).toBe(500);
		expect(result.fault?.endsWith("END")).toBe(true);
	});

	it("rejects ids outside the closed set without running anything", async () => {
		const exec = fakeSpawn(exitOk);
		await expect(runRemedy("rm -rf /" as never, deps(exec.spawn))).rejects.toThrow(/Unknown/);
		await expect(runRemedy("toString" as never, deps(exec.spawn))).rejects.toThrow(/Unknown/);
		expect(exec.calls).toEqual([]);
	});

	it("rejects off Linux", async () => {
		const exec = fakeSpawn(exitOk);
		await expect(runRemedy("linux-start", { ...deps(exec.spawn), platform: "darwin" })).rejects.toThrow(/Linux/);
		expect(exec.calls).toEqual([]);
	});
});

describe("runRemedy install progress", () => {
	const installerOutput = [
		">>> Installing ollama to /usr/local\n",
		">>> Downloading ollama-linux-amd64.tar.zst\n",
		"\r#=#=#  ",
		"\r#######                       10.0%",
		"\r#################       55",
		".3%",
		"\r############################ 100.0%\n",
		">>> Enabling and starting ollama service...\n",
	];

	function record(): { frames: OllamaInstallProgress[]; onProgress: (frame: OllamaInstallProgress) => void } {
		const frames: OllamaInstallProgress[] = [];
		return { frames, onProgress: frame => frames.push(frame) };
	}

	it("streams the installer's stages and download percent, then a done frame", async () => {
		const exec = fakeSpawn(exitOk, installerOutput);
		const { frames, onProgress } = record();
		const result = await runRemedy("linux-install", { ...deps(exec.spawn, ["ok"]), onProgress });
		expect(result).toEqual({ outcome: "applied", status: status("ok") });
		expect(frames).toEqual([
			{ stage: null, percent: -1, done: false },
			{ stage: "Installing ollama to /usr/local", percent: -1, done: false },
			{ stage: "Downloading ollama-linux-amd64.tar.zst", percent: -1, done: false },
			{ stage: "Downloading ollama-linux-amd64.tar.zst", percent: 10, done: false },
			{ stage: "Downloading ollama-linux-amd64.tar.zst", percent: 55, done: false },
			{ stage: "Downloading ollama-linux-amd64.tar.zst", percent: 100, done: false },
			{ stage: "Enabling and starting ollama service...", percent: -1, done: false },
			{ stage: "Enabling and starting ollama service...", percent: -1, done: true },
		]);
	});

	it("sends the indeterminate frame before the command starts", async () => {
		const { frames, onProgress } = record();
		const spawn: SpawnFn = (file, args, handlers) => {
			expect(frames).toEqual([{ stage: null, percent: -1, done: false }]);
			return fakeSpawn(exitOk).spawn(file, args, handlers);
		};
		await runRemedy("linux-install", { ...deps(spawn, ["ok"]), onProgress });
		expect(frames.at(-1)?.done).toBe(true);
	});

	it.each([
		["cancelled", { code: 126 }],
		["unavailable", spawnError("ENOENT")],
		["failed", { code: 1 }],
	] as const)("still ends with a done frame when the install is %s", async (outcome, ending) => {
		const { frames, onProgress } = record();
		const result = await runRemedy("linux-install", { ...deps(fakeSpawn(ending).spawn, ["absent"]), onProgress });
		expect(result.outcome).toBe(outcome);
		expect(frames).toEqual([
			{ stage: null, percent: -1, done: false },
			{ stage: null, percent: -1, done: true },
		]);
	});

	it("sends the done frame only after the daemon settle finishes", async () => {
		const { frames, onProgress } = record();
		let probes = 0;
		const result = await runRemedy("linux-install", {
			...deps(fakeSpawn(exitOk).spawn),
			onProgress,
			probe: async () => {
				probes++;
				// Every settle probe happens before the run is reported done.
				expect(frames.some(frame => frame.done)).toBe(false);
				return status("stopped");
			},
		});
		expect(probes).toBe(5);
		expect(result.outcome).toBe("failed");
		expect(frames.at(-1)).toEqual({ stage: null, percent: -1, done: true });
	});

	it("sends a done frame even when the re-probe throws", async () => {
		const { frames, onProgress } = record();
		const pending = runRemedy("linux-install", {
			...deps(fakeSpawn(exitOk).spawn),
			onProgress,
			probe: async () => {
				throw new Error("probe broke");
			},
		});
		await expect(pending).rejects.toThrow("probe broke");
		expect(frames.at(-1)?.done).toBe(true);
	});

	it("keeps running when the progress listener throws", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = await runRemedy("linux-install", {
			...deps(fakeSpawn(exitOk, installerOutput).spawn, ["ok"]),
			onProgress: () => {
				throw new Error("window gone");
			},
		});
		expect(result.outcome).toBe("applied");
		warn.mockRestore();
	});

	it("sends nothing for the start remedy", async () => {
		const { frames, onProgress } = record();
		await runRemedy("linux-start", { ...deps(fakeSpawn(exitOk, installerOutput).spawn, ["ok"]), onProgress });
		expect(frames).toEqual([]);
	});
});

describe("the no-cloud drop-in", () => {
	it("writes exactly the no-cloud drop-in and reloads systemd before restarting Ollama", () => {
		for (const id of ["linux-start", "linux-install"] as const) {
			const box = sandbox();
			const { status: code, log } = box.run(id);
			expect(code).toBe(0);
			expect(readdirSync(box.dropInDir)).toEqual(["sai-atlas.conf"]);
			expect(readFileSync(path.join(box.dropInDir, "sai-atlas.conf"), "utf8")).toBe(DROP_IN);
			const installer = id === "linux-install" ? ["curl -fsSL https://ollama.com/install.sh"] : [];
			expect(log).toEqual([...installer, "systemctl daemon-reload", "systemctl restart ollama.service"]);
		}
	});

	it("leaves other drop-ins and an identical drop-in untouched", () => {
		for (const id of ["linux-start", "linux-install"] as const) {
			const box = sandbox();
			mkdirSync(box.dropInDir);
			const other = path.join(box.dropInDir, "override.conf");
			const ours = path.join(box.dropInDir, "sai-atlas.conf");
			writeFileSync(other, '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0"\n');
			writeFileSync(ours, DROP_IN);
			const past = new Date("2020-01-01T00:00:00Z");
			utimesSync(other, past, past);
			utimesSync(ours, past, past);
			expect(box.run(id).status).toBe(0);
			expect(readFileSync(other, "utf8")).toBe('[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0"\n');
			expect(statSync(other).mtime).toEqual(past);
			expect(statSync(ours).mtime).toEqual(past);
			expect(readdirSync(box.dropInDir).sort()).toEqual(["override.conf", "sai-atlas.conf"]);
		}
	});

	it("rewrites a sai-atlas drop-in whose content differs", () => {
		const box = sandbox();
		mkdirSync(box.dropInDir);
		writeFileSync(path.join(box.dropInDir, "sai-atlas.conf"), "[Service]\n");
		expect(box.run("linux-start").status).toBe(0);
		expect(readFileSync(path.join(box.dropInDir, "sai-atlas.conf"), "utf8")).toBe(DROP_IN);
	});

	it("touches neither the drop-in nor systemd when the installer fails", () => {
		const box = sandbox();
		const { status: code, log } = box.run("linux-install", 3);
		expect(code).toBe(3);
		expect(existsSync(box.dropInDir)).toBe(false);
		expect(log).toEqual(["curl -fsSL https://ollama.com/install.sh"]);
	});
});

describe("isRemedyId", () => {
	it("accepts only the closed set", () => {
		expect(isRemedyId("linux-start")).toBe(true);
		expect(isRemedyId("linux-install")).toBe(true);
		expect(isRemedyId("constructor")).toBe(false);
		expect(isRemedyId(1)).toBe(false);
	});
});

describe("createRemedyGate", () => {
	function offering(remedy: OllamaRemedyId | null): OllamaStatus {
		return { ...status(remedy === null ? "ok" : "stopped"), remedy };
	}

	it("runs the remedy the current status offers", async () => {
		const run = vi.fn(
			async (_id: OllamaRemedyId) => ({ outcome: "applied", status: status("ok") }) as OllamaRemedyResult,
		);
		const gate = createRemedyGate(async () => offering("linux-start"), run);
		await expect(gate("linux-start")).resolves.toMatchObject({ outcome: "applied" });
		expect(run).toHaveBeenCalledWith("linux-start");
	});

	it("refuses a remedy the current status does not offer, without running it", async () => {
		const run = vi.fn(
			async (_id: OllamaRemedyId) => ({ outcome: "applied", status: status("ok") }) as OllamaRemedyResult,
		);
		// Ollama is running: an install request (the curl | sh root prompt) must not run.
		await expect(createRemedyGate(async () => offering(null), run)("linux-install")).rejects.toThrow(/no longer/);
		await expect(createRemedyGate(async () => offering("linux-start"), run)("linux-install")).rejects.toThrow(
			/no longer/,
		);
		expect(run).not.toHaveBeenCalled();
	});

	it("joins a repeat of the running remedy and refuses a different one until it ends", async () => {
		const pending = Promise.withResolvers<OllamaRemedyResult>();
		const run = vi.fn((_id: OllamaRemedyId) => pending.promise);
		let offered: OllamaRemedyId | null = "linux-start";
		const gate = createRemedyGate(async () => offering(offered), run);

		const first = gate("linux-start");
		const second = gate("linux-start");
		expect(second).toBe(first);
		await expect(gate("linux-install")).rejects.toThrow(/already running/);

		pending.resolve({ outcome: "applied", status: status("ok") });
		await expect(second).resolves.toMatchObject({ outcome: "applied" });
		expect(run).toHaveBeenCalledTimes(1);

		// Settled: the next request is judged afresh.
		offered = "linux-install";
		run.mockResolvedValue({ outcome: "cancelled", status: status("absent") });
		await expect(gate("linux-install")).resolves.toMatchObject({ outcome: "cancelled" });
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("frees the gate after a refused or failed attempt", async () => {
		const run = vi.fn(async (_id: OllamaRemedyId) => {
			throw new Error("boom");
		});
		const gate = createRemedyGate(async () => offering("linux-start"), run);
		await expect(gate("linux-start")).rejects.toThrow("boom");
		await expect(gate("linux-start")).rejects.toThrow("boom");
		expect(run).toHaveBeenCalledTimes(2);
	});
});
