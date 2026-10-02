import { describe, expect, it, vi } from "vitest";
import {
	OLLAMA_REMEDY_COMMANDS,
	type OllamaRemedyId,
	type OllamaRemedyResult,
	type OllamaStatus,
} from "../../shared/ollama-types";
import {
	createRemedyGate,
	type ExecError,
	type ExecFileFn,
	INSTALL_LINE,
	isRemedyId,
	type RemedyDeps,
	runRemedy,
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

function fakeExec(error: ExecError | null, stderr = ""): { execFile: ExecFileFn; calls: Call[] } {
	const calls: Call[] = [];
	return {
		calls,
		execFile: (file, args, _options, callback) => {
			calls.push({ file, args });
			setTimeout(() => callback(error, "", stderr), 0);
		},
	};
}

function exitError(code: number | string, extra: Partial<ExecError> = {}): ExecError {
	return Object.assign(new Error(`exit ${code}`), { code, ...extra });
}

function deps(
	execFile: ExecFileFn,
	states: OllamaStatus["state"][] = ["stopped"],
): Partial<RemedyDeps> & Pick<RemedyDeps, "probe"> {
	let i = 0;
	return {
		platform: "linux",
		execFile,
		settleIntervalMs: 0,
		settleAttempts: 5,
		probe: async () => status(states[Math.min(i++, states.length - 1)]),
	};
}

describe("runRemedy", () => {
	it("runs systemctl start through pkexec and waits for the daemon to answer", async () => {
		const exec = fakeExec(null);
		const result = await runRemedy("linux-start", deps(exec.execFile, ["stopped", "stopped", "ok"]));
		expect(exec.calls).toEqual([{ file: "pkexec", args: ["systemctl", "start", "ollama.service"] }]);
		expect(result).toEqual({ outcome: "applied", status: status("ok") });
	});

	it("runs the fixed install line through pkexec sh -c", async () => {
		const exec = fakeExec(null);
		await runRemedy("linux-install", deps(exec.execFile, ["ok"]));
		expect(exec.calls).toEqual([{ file: "pkexec", args: ["sh", "-c", INSTALL_LINE] }]);
	});

	it("runs exactly the command the screen shows the user", () => {
		expect(INSTALL_LINE).toBe(OLLAMA_REMEDY_COMMANDS["linux-install"]);
	});

	it("reports failed when the command succeeds but the daemon never comes up", async () => {
		let probes = 0;
		const result = await runRemedy("linux-start", {
			...deps(fakeExec(null).execFile),
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
		["missing pkexec", exitError("ENOENT"), "", "unavailable"],
		["dismissed dialog (126)", exitError(126), "", "cancelled"],
		[
			"failed authentication (127)",
			exitError(127),
			"Error executing command as another user: Not authorized",
			"cancelled",
		],
		[
			"no authentication agent (127)",
			exitError(127),
			"Error executing command as another user: No authentication agent found.",
			"unavailable",
		],
		["command failure", exitError(5), "Failed to start ollama.service: Unit ollama.service not found.", "failed"],
		["timeout", exitError("ETIMEDOUT", { killed: true, signal: "SIGTERM" }), "", "failed"],
	] as const)("maps %s to %s", async (_label, error, stderr, outcome) => {
		const exec = fakeExec(error, stderr);
		const result = await runRemedy("linux-start", deps(exec.execFile));
		expect(result.outcome).toBe(outcome);
		expect(result.status).toEqual(status("stopped"));
		if (outcome === "failed" && stderr) expect(result.fault).toBe(stderr);
		if (outcome === "cancelled") expect(result.fault).toBeUndefined();
	});

	it("keeps only the stderr tail as the fault", async () => {
		const exec = fakeExec(exitError(1), `${"x".repeat(2000)}END`);
		const result = await runRemedy("linux-install", deps(exec.execFile));
		expect(result.fault?.length).toBe(500);
		expect(result.fault?.endsWith("END")).toBe(true);
	});

	it("rejects ids outside the closed set without running anything", async () => {
		const exec = fakeExec(null);
		await expect(runRemedy("rm -rf /" as never, deps(exec.execFile))).rejects.toThrow(/Unknown/);
		await expect(runRemedy("toString" as never, deps(exec.execFile))).rejects.toThrow(/Unknown/);
		expect(exec.calls).toEqual([]);
	});

	it("rejects off Linux", async () => {
		const exec = fakeExec(null);
		await expect(runRemedy("linux-start", { ...deps(exec.execFile), platform: "darwin" })).rejects.toThrow(/Linux/);
		expect(exec.calls).toEqual([]);
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
