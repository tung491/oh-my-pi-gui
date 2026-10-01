import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_EVENTS, type IpcTabStatusPayload } from "../shared/ipc-types";
import type { RpcCommand, RpcResponse, SidecarStatus, SidecarStatusPayload } from "../shared/rpc-types";
import type { ReadyGate, ReadyGateOutcome, SidecarManager } from "./sidecar";
import { SidecarPool } from "./sidecar-pool";

const SWEEP_MS = 1_000;
const IDLE_MS = 5_000;

/**
 * SidecarManager stand-in for the hibernation path: scripted RPC replies, a
 * real pending count, and hibernate()/wake() that report status the way the
 * manager does. Running a wake's gate is the test's call (`becomeReady`), as
 * the manager does on the respawned child's first `ready`.
 */
class HibernationFake extends EventEmitter {
	currentStatus: SidecarStatus = "asleep";
	sessionFile: string | null = null;
	commands: RpcCommand[] = [];
	/** Command types answered with success: false. */
	failing = new Set<string>();
	/** Command types whose response never arrives (they time out). */
	hanging = new Set<string>();
	/** Per-command data overrides merged over the idle defaults. */
	replies: Record<string, Record<string, unknown>> = {};
	onCommand: ((command: RpcCommand) => void) | null = null;
	pending = 0;
	hibernations = 0;
	/** When set, hibernate() resolves only once this does (the old process is still draining). */
	drain: PromiseWithResolvers<void> | null = null;
	wakes: Array<{ sessionPath: string | null; gate: ReadyGate | null }> = [];
	restarts: Array<string | undefined> = [];
	starts = 0;
	/** A child the manager stopped is still running its own teardown. */
	draining = false;

	/** As SidecarManager does: every extension UI request is also a frame. */
	emitExtensionUi(request: Record<string, unknown>): void {
		const frame = { type: "extension_ui_request", ...request };
		this.emit("extensionUi", frame);
		this.emit("frame", frame);
	}
	readonly rpcClient: {
		command: (command: RpcCommand, timeoutMs?: number) => Promise<RpcResponse>;
		pendingCount: number;
	};

	constructor(public cwd: string) {
		super();
		const fake = this;
		this.rpcClient = {
			command: (command, timeoutMs = 8_000) => fake.command(command, timeoutMs),
			get pendingCount() {
				return fake.pending;
			},
		};
	}

	get status(): SidecarStatus {
		return this.currentStatus;
	}

	command(command: RpcCommand, timeoutMs: number): Promise<RpcResponse> {
		this.commands.push(command);
		this.onCommand?.(command);
		this.pending++;
		return new Promise<RpcResponse>((resolve, reject) => {
			if (this.hanging.has(command.type)) {
				setTimeout(() => {
					this.pending--;
					reject(new Error(`RPC timeout (${timeoutMs}ms): ${command.type}`));
				}, timeoutMs);
				return;
			}
			queueMicrotask(() => {
				this.pending--;
				if (this.failing.has(command.type)) {
					resolve({ type: "response", command: command.type, success: false, error: "refused" });
					return;
				}
				resolve({ type: "response", command: command.type, success: true, data: this.reply(command.type) });
			});
		});
	}

	reply(type: string): Record<string, unknown> {
		const defaults: Record<string, Record<string, unknown>> = {
			get_state: {
				isStreaming: false,
				isCompacting: false,
				queuedMessageCount: 0,
				planModeEnabled: false,
				agentsPaused: false,
				collab: { role: null, readOnly: false, participants: [] },
				sessionFile: this.sessionFile,
			},
			get_jobs: { jobs: [] },
			get_plan_mode: { enabled: false },
			get_goal: { enabled: false },
			get_loop_mode: { enabled: false, state: "off" },
			get_vibe_mode: { enabled: false },
			set_plan_mode: { enabled: true, planFilePath: "local://PLAN.md" },
			set_loop_mode: { enabled: true, state: "waiting" },
		};
		return { ...defaults[type], ...this.replies[type] };
	}

	start(): void {
		this.starts++;
		if (this.currentStatus === "asleep") this.emitStatus("starting");
	}
	restart(_cwd?: string, sessionPath?: string): void {
		this.restarts.push(sessionPath);
		this.emitStatus("starting");
	}
	hibernate(): Promise<void> {
		this.hibernations++;
		this.emitStatus("asleep", "Hibernated");
		return this.drain?.promise ?? Promise.resolve();
	}
	wake(sessionPath: string | null, gate: ReadyGate | null = null): void {
		this.wakes.push({ sessionPath, gate });
		this.emitStatus("starting");
	}
	/** The respawned child is up: run the wake's gate, then report what it decided. */
	async becomeReady(): Promise<ReadyGateOutcome> {
		const gate = this.wakes[this.wakes.length - 1]?.gate;
		const outcome = gate ? await gate(this.rpcClient as never) : {};
		if (outcome.error) this.emitStatus("error", outcome.error, outcome.modesNotRestored);
		else this.emitStatus("ready", undefined, outcome.modesNotRestored);
		return outcome;
	}
	kill(): void {}
	dispose(): void {
		this.removeAllListeners();
	}
	sendSideChannel(): void {}
	emitStatus(status: SidecarStatus, message?: string, modesNotRestored?: string[]): void {
		this.currentStatus = status;
		const payload: SidecarStatusPayload = { status, message, cwd: this.cwd };
		if (modesNotRestored?.length) payload.modesNotRestored = modesNotRestored;
		this.emit("status", payload);
	}
	emitEvents(events: object[]): void {
		this.emit("events", events);
	}
	commandTypes(): string[] {
		return this.commands.map(command => command.type);
	}
}

interface FakeWindow {
	win: BrowserWindow;
	sent: Array<{ channel: string; data: unknown }>;
}

function fakeWindow(id: number): FakeWindow {
	const emitter = new EventEmitter();
	const sent: Array<{ channel: string; data: unknown }> = [];
	const win = {
		webContents: {
			id,
			send: (channel: string, data: unknown) => {
				sent.push({ channel, data });
			},
		},
		isDestroyed: () => false,
		once: (event: string, listener: () => void) => emitter.once(event, listener),
	} as unknown as BrowserWindow;
	return { win, sent };
}

let tempDir: string;

beforeEach(() => {
	vi.useFakeTimers();
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-gui-hibernation-"));
});

afterEach(() => {
	vi.useRealTimers();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

/** A saved session on disk, as omp writes it after the first assistant message. */
function savedSession(name: string): string {
	const file = path.join(tempDir, `${name}.jsonl`);
	fs.writeFileSync(file, "{}\n");
	return file;
}

interface Harness {
	pool: SidecarPool;
	window: FakeWindow;
	/** The visible tab. */
	front: HibernationFake;
	/** A ready background tab with a saved session. */
	back: HibernationFake;
	backFile: string;
}

/** One window: a visible tab and a ready background tab, hibernation on. */
function harness({ enable = true } = {}): Harness {
	const fakes: HibernationFake[] = [];
	const pool = new SidecarPool(
		cwd => {
			const fake = new HibernationFake(cwd);
			fakes.push(fake);
			return fake as unknown as SidecarManager;
		},
		10,
		{ hibernation: { sweepMs: SWEEP_MS, minIdleMs: IDLE_MS } },
	);
	const window = fakeWindow(1);
	const frontFile = savedSession("front");
	const backFile = savedSession("back");
	pool.acquire(tempDir, window.win, "front", frontFile);
	pool.acquire(tempDir, window.win, "back", backFile);
	const [front, back] = fakes;
	front.sessionFile = frontFile;
	back.sessionFile = backFile;
	front.emitStatus("ready");
	back.emitStatus("ready");
	if (enable) pool.setHibernation({ enabled: true, idleMinutes: 5 });
	return { pool, window, front, back, backFile };
}

/** Run sweeps until the idle window has passed, letting each sweep's checks settle. */
async function idlePast(ms = IDLE_MS + SWEEP_MS): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
}

function tabStatuses(window: FakeWindow, tabId: string): IpcTabStatusPayload[] {
	return window.sent
		.filter(entry => entry.channel === IPC_EVENTS.TAB_STATUS)
		.map(entry => entry.data as IpcTabStatusPayload)
		.filter(payload => payload.tabId === tabId);
}

describe("tab hibernation: the toggle", () => {
	it("runs no timer and never hibernates while off (the default)", async () => {
		const { pool, back } = harness({ enable: false });
		expect(vi.getTimerCount()).toBe(0);
		await idlePast(IDLE_MS * 10);
		expect(back.hibernations).toBe(0);
		expect(back.commands).toEqual([]);
		pool.disposeAll();
	});

	it("starts one sweep when turned on, and stops it when turned off", () => {
		const { pool } = harness({ enable: false });
		pool.setHibernation({ enabled: true, idleMinutes: 5 });
		pool.setHibernation({ enabled: true, idleMinutes: 10 });
		expect(vi.getTimerCount()).toBe(1);
		pool.setHibernation({ enabled: false, idleMinutes: 10 });
		expect(vi.getTimerCount()).toBe(0);
		pool.disposeAll();
	});

	it("clears the sweep in disposeAll", () => {
		const { pool } = harness();
		expect(vi.getTimerCount()).toBe(1);
		pool.disposeAll();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("uses the preference's minutes when no test idle time is set", async () => {
		const fakes: HibernationFake[] = [];
		const pool = new SidecarPool(
			cwd => {
				const fake = new HibernationFake(cwd);
				fakes.push(fake);
				return fake as unknown as SidecarManager;
			},
			10,
			{ hibernation: { sweepMs: SWEEP_MS } },
		);
		const window = fakeWindow(1);
		const file = savedSession("back");
		pool.acquire(tempDir, window.win, "front");
		pool.acquire(tempDir, window.win, "back", file);
		fakes[1].sessionFile = file;
		fakes[0].emitStatus("ready");
		fakes[1].emitStatus("ready");
		pool.setHibernation({ enabled: true, idleMinutes: 5 });
		await vi.advanceTimersByTimeAsync(4 * 60_000);
		expect(fakes[1].hibernations).toBe(0);
		await vi.advanceTimersByTimeAsync(61_000);
		expect(fakes[1].hibernations).toBe(1);
		pool.disposeAll();
	});
});

describe("tab hibernation: an idle background tab", () => {
	it("checks the sidecar, then stops it back to asleep", async () => {
		const { pool, window, front, back } = harness();
		await idlePast();
		expect(back.hibernations).toBe(1);
		expect(new Set(back.commandTypes())).toEqual(
			new Set(["get_state", "get_jobs", "get_plan_mode", "get_goal", "get_loop_mode", "get_vibe_mode"]),
		);
		expect(tabStatuses(window, "back").at(-1)?.status).toBe("asleep");
		expect(front.hibernations).toBe(0);
		pool.disposeAll();
	});

	it("keeps the session claim while asleep, so opening it elsewhere still finds this tab", async () => {
		const { pool, back, backFile } = harness();
		await idlePast();
		expect(back.hibernations).toBe(1);
		expect(pool.sessionOwner(backFile)).toEqual({ tabId: "back", winId: 1 });
		pool.disposeAll();
	});

	it("waits a full idle window after the last frame", async () => {
		const { pool, back } = harness();
		await vi.advanceTimersByTimeAsync(IDLE_MS - 1_000);
		back.emit("frame", { type: "notice" });
		await vi.advanceTimersByTimeAsync(2_000);
		expect(back.hibernations).toBe(0);
		await idlePast();
		expect(back.hibernations).toBe(1);
		pool.disposeAll();
	});

	it("does not sweep a tab again while it sleeps, and quits without a prompt", async () => {
		const { pool, back } = harness();
		await idlePast();
		const sent = back.commands.length;
		await idlePast(IDLE_MS * 4);
		expect(back.hibernations).toBe(1);
		expect(back.commands).toHaveLength(sent);
		expect(pool.tabInventory().every(fact => !fact.inFlight)).toBe(true);
		pool.disposeAll();
	});

	it("leaves hibernated tabs asleep and stops sweeping when the toggle goes off", async () => {
		const { pool, window, back, front } = harness();
		await idlePast();
		pool.setHibernation({ enabled: false, idleMinutes: 5 });
		await idlePast(IDLE_MS * 4);
		expect(back.currentStatus).toBe("asleep");
		expect(back.wakes).toEqual([]);
		expect(front.commands).toEqual([]);
		pool.setActiveTab(window.win, "back");
		expect(back.wakes).toHaveLength(1);
		pool.disposeAll();
	});
});

describe("tab hibernation: cheap checks keep a tab awake", () => {
	it("while it is visible, including either pane of a split", async () => {
		const { pool, window, front, back } = harness();
		pool.setTabView(window.win, "front", ["front", "back"], {
			axis: "columns",
			firstTabId: "front",
			secondTabId: "back",
			ratio: 0.5,
		});
		await idlePast(IDLE_MS * 3);
		expect(front.hibernations + back.hibernations).toBe(0);
		expect(front.commands.length + back.commands.length).toBe(0);
		pool.disposeAll();
	});

	it("while a run or a compaction is in flight", async () => {
		const { pool, back } = harness();
		back.emitEvents([{ type: "agent_start" }]);
		await idlePast(IDLE_MS * 2);
		expect(back.hibernations).toBe(0);
		back.emitEvents([{ type: "agent_end" }, { type: "auto_compaction_start" }]);
		await idlePast(IDLE_MS * 2);
		expect(back.hibernations).toBe(0);
		expect(back.commands).toEqual([]);
		pool.disposeAll();
	});

	it("while one of main's own commands (a rename) is in flight", async () => {
		const { pool, back, backFile } = harness();
		back.hanging.add("set_session_name");
		void pool
			.commandForIdleSession(backFile, { type: "set_session_name", name: "x", sessionPath: backFile })
			.catch(() => {});
		await vi.advanceTimersByTimeAsync(IDLE_MS + SWEEP_MS - 1);
		expect(back.hibernations).toBe(0);
		expect(back.commandTypes()).toEqual(["set_session_name"]);
		pool.disposeAll();
	});

	it("while a blocking extension request is unanswered, until it is answered", async () => {
		const { pool, back } = harness();
		back.emitExtensionUi({ id: "ask-1", method: "confirm", title: "t", message: "m" });
		await idlePast(IDLE_MS * 2);
		expect(back.hibernations).toBe(0);
		// Answered through the side channel, whichever sidecar the fallback picks.
		pool.routeSideChannel("ask-1", { type: "extension_ui_response", id: "ask-1", confirmed: true }, true);
		await idlePast();
		expect(back.hibernations).toBe(1);
		pool.disposeAll();
	});

	it("while a blocking extension request is unanswered, until the sidecar cancels it", async () => {
		const { pool, back } = harness();
		back.emitExtensionUi({ id: "ask-2", method: "select", title: "t", options: [] });
		await idlePast(IDLE_MS * 2);
		expect(back.hibernations).toBe(0);
		back.emitExtensionUi({ id: "c-1", method: "cancel", targetId: "ask-2" });
		await idlePast();
		expect(back.hibernations).toBe(1);
		pool.disposeAll();
	});

	it("does not wait on a fire-and-forget extension update", async () => {
		const { pool, back } = harness();
		back.emitExtensionUi({ id: "w-1", method: "setStatus", key: "k", text: "t" });
		await idlePast();
		expect(back.hibernations).toBe(1);
		pool.disposeAll();
	});

	it("stays awake while an extension keeps updating its widgets", async () => {
		// Every frame counts as activity, so a periodic status update keeps the
		// tab awake: the safe direction, since main cannot tell a clock from
		// progress on real work.
		const { pool, back } = harness();
		for (let elapsed = 0; elapsed < IDLE_MS * 3; elapsed += IDLE_MS / 2) {
			back.emitExtensionUi({ id: `w-${elapsed}`, method: "setStatus", key: "k", text: String(elapsed) });
			await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
		}
		expect(back.hibernations).toBe(0);
		await idlePast();
		expect(back.hibernations).toBe(1);
		pool.disposeAll();
	});

	it("while a plan proposal waits for approval, until it is settled", async () => {
		const { pool, back } = harness();
		back.emitEvents([{ type: "plan_proposal", planFilePath: "local://PLAN.md", planContent: "x", options: [] }]);
		await idlePast(IDLE_MS * 2);
		expect(back.hibernations).toBe(0);
		pool.notePlanProposalSettled(back as unknown as SidecarManager);
		await idlePast();
		expect(back.hibernations).toBe(1);
		pool.disposeAll();
	});

	it("while the session has no file on disk yet (no assistant reply so far)", async () => {
		const { pool, back, backFile } = harness();
		fs.rmSync(backFile);
		await idlePast(IDLE_MS * 2);
		expect(back.hibernations).toBe(0);
		expect(back.commands).toEqual([]);
		pool.disposeAll();
	});

	it("while the tab has no session at all, or is the startup placeholder", async () => {
		const fakes: HibernationFake[] = [];
		const pool = new SidecarPool(
			cwd => {
				const fake = new HibernationFake(cwd);
				fakes.push(fake);
				return fake as unknown as SidecarManager;
			},
			10,
			{ hibernation: { sweepMs: SWEEP_MS, minIdleMs: IDLE_MS } },
		);
		const window = fakeWindow(1);
		pool.acquire(tempDir, window.win, "front");
		pool.acquire(tempDir, window.win, "unsaved");
		pool.acquire(tempDir, window.win, "placeholder", savedSession("p"), "agent", undefined, false, true);
		for (const fake of fakes) fake.emitStatus("ready");
		pool.setHibernation({ enabled: true, idleMinutes: 5 });
		await idlePast(IDLE_MS * 2);
		expect(fakes.map(fake => fake.hibernations)).toEqual([0, 0, 0]);
		pool.disposeAll();
	});
});

describe("tab hibernation: sidecar checks keep a tab awake", () => {
	const blockers: Array<[string, (fake: HibernationFake) => void]> = [
		["it is streaming", fake => (fake.replies.get_state = { isStreaming: true })],
		["it is compacting", fake => (fake.replies.get_state = { isCompacting: true })],
		["a message is queued", fake => (fake.replies.get_state = { queuedMessageCount: 1 })],
		["a collab session is hosted", fake => (fake.replies.get_state = { collab: { role: "host" } })],
		["agents are paused", fake => (fake.replies.get_state = { agentsPaused: true })],
		["a prewalk switch is armed", fake => (fake.replies.get_state = { prewalkArmed: true })],
		["it is on another session file", fake => (fake.replies.get_state = { sessionFile: "/elsewhere.jsonl" })],
		[
			"a background job still runs after agent_end",
			fake => (fake.replies.get_jobs = { jobs: [{ id: "j", type: "bash", status: "running", label: "x" }] }),
		],
		["a goal is active", fake => (fake.replies.get_goal = { enabled: true, status: "active" })],
		["a goal is paused", fake => (fake.replies.get_goal = { enabled: false, status: "paused" })],
		["vibe mode is on", fake => (fake.replies.get_vibe_mode = { enabled: true })],
		[
			"a loop prompt is running",
			fake => (fake.replies.get_loop_mode = { enabled: true, state: "running", prompt: "p" }),
		],
		[
			"a loop has a limit",
			fake =>
				(fake.replies.get_loop_mode = {
					enabled: true,
					state: "waiting",
					limit: { kind: "iterations", initial: 3, remaining: 2 },
				}),
		],
		[
			"plan mode is on a reviewed plan file",
			fake => {
				fake.replies.get_state = { planModeEnabled: true };
				fake.replies.get_plan_mode = { enabled: true, planFilePath: "local://reviewed.md" };
			},
		],
		["a check fails", fake => fake.failing.add("get_jobs")],
	];

	for (const [label, arrange] of blockers) {
		it(`when ${label}`, async () => {
			const { pool, back } = harness();
			arrange(back);
			await idlePast(IDLE_MS + SWEEP_MS * 3);
			expect(back.hibernations).toBe(0);
			expect(back.commandTypes()).toContain("get_state");
			pool.disposeAll();
		});
	}

	it("when a check times out, and retries on a later sweep", async () => {
		const { pool, back } = harness();
		back.hanging.add("get_jobs");
		await idlePast();
		expect(back.pending).toBeGreaterThan(0);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(back.hibernations).toBe(0);
		// One attempt at a time: the next one starts only after this one timed out.
		expect(back.commandTypes().filter(type => type === "get_jobs").length).toBeLessThanOrEqual(2);
		back.hanging.delete("get_jobs");
		await vi.advanceTimersByTimeAsync(5_000 + SWEEP_MS * 2);
		expect(back.hibernations).toBe(1);
		pool.disposeAll();
	});

	it("when a frame arrives while the checks run", async () => {
		const { pool, back } = harness();
		back.onCommand = command => {
			if (command.type === "get_jobs") back.emit("frame", { type: "notice" });
		};
		await idlePast();
		expect(back.commandTypes()).toContain("get_jobs");
		expect(back.hibernations).toBe(0);
		pool.disposeAll();
	});

	it("when the tab is shown while the checks run", async () => {
		const { pool, window, back } = harness();
		back.onCommand = command => {
			if (command.type === "get_vibe_mode") pool.setActiveTab(window.win, "back");
		};
		await idlePast();
		expect(back.hibernations).toBe(0);
		pool.disposeAll();
	});

	it("but a completed goal or a waiting loop does not", async () => {
		const { pool, back } = harness();
		back.replies.get_goal = { enabled: false, status: "complete" };
		back.replies.get_loop_mode = { enabled: true, state: "waiting" };
		await idlePast();
		expect(back.hibernations).toBe(1);
		pool.disposeAll();
	});
});

describe("tab hibernation: waking", () => {
	it("respawns the session it slept on when the tab is viewed", async () => {
		const { pool, window, back, backFile } = harness();
		await idlePast();
		pool.setActiveTab(window.win, "back");
		expect(back.wakes).toEqual([{ sessionPath: backFile, gate: null }]);
		await back.becomeReady();
		expect(tabStatuses(window, "back").at(-1)?.status).toBe("ready");
		pool.disposeAll();
	});

	it("waits for a drain that is still running, then wakes once", async () => {
		const { pool, window, back } = harness();
		back.drain = Promise.withResolvers<void>();
		await idlePast();
		expect(back.hibernations).toBe(1);
		expect(pool.sessionOwnerIsLive(back.sessionFile as string)).toBe(true);
		pool.setActiveTab(window.win, "back");
		pool.setActiveTab(window.win, "front");
		pool.setActiveTab(window.win, "back");
		expect(back.wakes).toEqual([]);
		back.drain.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(back.wakes).toHaveLength(1);
		pool.disposeAll();
	});

	it("keeps a refused wake's session owned while the stopped child drains", async () => {
		const { pool, window, back } = harness();
		await idlePast();
		pool.setActiveTab(window.win, "back");
		// The gate refused: the manager reports error and stops the child.
		back.draining = true;
		back.emitStatus("error", "Plan mode could not be restored", ["plan"]);
		expect(pool.sessionOwnerIsLive(back.sessionFile as string)).toBe(true);
		back.draining = false;
		expect(pool.sessionOwnerIsLive(back.sessionFile as string)).toBe(false);
		pool.disposeAll();
	});

	it("does not wake after a drain when the tab was hidden again meanwhile", async () => {
		const { pool, window, back } = harness();
		back.drain = Promise.withResolvers<void>();
		await idlePast();
		pool.setActiveTab(window.win, "back");
		pool.setActiveTab(window.win, "front");
		back.drain.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(back.wakes).toEqual([]);
		expect(pool.sessionOwnerIsLive(back.sessionFile as string)).toBe(false);
		pool.disposeAll();
	});

	it("wakes a tab restarted while its wake waits for the old process, keeping its modes", async () => {
		const { pool, window, back, backFile } = harness();
		back.replies.get_state = { planModeEnabled: true };
		back.drain = Promise.withResolvers<void>();
		await idlePast();
		pool.setActiveTab(window.win, "back");
		expect(back.wakes).toEqual([]);
		const restarts = back.restarts.length;
		pool.restart(back as unknown as SidecarManager);
		expect(back.restarts).toHaveLength(restarts);
		expect(back.wakes.map(wake => wake.sessionPath)).toEqual([backFile]);
		await back.becomeReady();
		expect(back.commandTypes()).toContain("set_plan_mode");
		// The wake queued behind the drain finds the tab already up.
		back.drain.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(back.wakes).toHaveLength(1);
		pool.disposeAll();
	});

	it("restarts a sleeping tab onto another session without the modes it slept with", async () => {
		const { pool, back } = harness();
		back.replies.get_state = { planModeEnabled: true };
		await idlePast();
		const other = savedSession("other");
		const restarts = back.restarts.length;
		pool.restart(back as unknown as SidecarManager, other);
		expect(back.wakes).toEqual([]);
		expect(back.restarts.slice(restarts)).toEqual([other]);
		pool.disposeAll();
	});

	it("launches fresh when the session was deleted while the tab slept", async () => {
		const { pool, window, back } = harness();
		await idlePast();
		pool.noteSessionFile("back", null);
		pool.setActiveTab(window.win, "back");
		expect(back.wakes.map(wake => wake.sessionPath)).toEqual([null]);
		pool.disposeAll();
	});

	it("re-arms plan mode, then the loop, before the tab reports ready", async () => {
		const { pool, window, back } = harness();
		back.replies.get_state = { planModeEnabled: true };
		back.replies.get_plan_mode = { enabled: true, planFilePath: "local://PLAN.md" };
		back.replies.get_loop_mode = { enabled: true, state: "paused" };
		await idlePast();
		expect(back.hibernations).toBe(1);
		pool.setActiveTab(window.win, "back");
		back.commands = [];
		const statusesBefore = tabStatuses(window, "back").length;
		const outcome = await back.becomeReady();
		expect(back.commands).toEqual([
			{ type: "set_plan_mode", enabled: true },
			{ type: "set_loop_mode", enabled: true },
		]);
		expect(outcome).toEqual({ modesNotRestored: [] });
		expect(
			tabStatuses(window, "back")
				.slice(statusesBefore)
				.map(payload => payload.status),
		).toEqual(["ready"]);
		pool.disposeAll();
	});

	it("leaves the tab in error, never ready, when plan mode cannot be re-armed", async () => {
		const { pool, window, back } = harness();
		back.replies.get_state = { planModeEnabled: true };
		back.replies.get_plan_mode = { enabled: true };
		back.replies.get_loop_mode = { enabled: true, state: "waiting" };
		await idlePast();
		pool.setActiveTab(window.win, "back");
		back.failing.add("set_plan_mode");
		back.commands = [];
		const outcome = await back.becomeReady();
		expect(outcome).toEqual({ error: "Plan mode could not be restored", modesNotRestored: ["plan"] });
		expect(back.commandTypes()).toEqual(["set_plan_mode"]);
		expect(tabStatuses(window, "back").at(-1)?.status).toBe("error");
		pool.disposeAll();
	});

	it("treats a plan-mode reply that is not armed as a failed restore", async () => {
		const { pool, window, back } = harness();
		back.replies.get_state = { planModeEnabled: true };
		await idlePast();
		pool.setActiveTab(window.win, "back");
		back.replies.set_plan_mode = { enabled: false };
		expect((await back.becomeReady()).error).toBe("Plan mode could not be restored");
		pool.disposeAll();
	});

	it("becomes ready with a warning when only the loop cannot be re-armed", async () => {
		const { pool, window, back } = harness();
		back.replies.get_loop_mode = { enabled: true, state: "waiting" };
		await idlePast();
		pool.setActiveTab(window.win, "back");
		back.failing.add("set_loop_mode");
		expect(await back.becomeReady()).toEqual({ modesNotRestored: ["loop"] });
		expect(back.currentStatus).toBe("ready");
		pool.disposeAll();
	});

	it("forgets the armed modes when something else restarts the sleeping tab", async () => {
		const { pool, window, back, backFile } = harness();
		back.replies.get_state = { planModeEnabled: true };
		await idlePast();
		back.restart(undefined, backFile);
		back.emitStatus("ready");
		back.emitStatus("asleep");
		pool.setActiveTab(window.win, "back");
		// A plain resume, as for any asleep tab: no gate, no modes re-applied.
		expect(back.wakes).toEqual([]);
		expect(back.restarts.at(-1)).toBe(backFile);
		pool.disposeAll();
	});

	it("can hibernate again after a wake", async () => {
		const { pool, window, back } = harness();
		await idlePast();
		pool.setActiveTab(window.win, "back");
		await back.becomeReady();
		pool.setActiveTab(window.win, "front");
		await idlePast();
		expect(back.hibernations).toBe(2);
		pool.disposeAll();
	});
});
