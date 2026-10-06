import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { describe, expect, it, type Mock, vi } from "vitest";
import type { IpcSpawnTabResult, SessionKind } from "../shared/ipc-types";
import type { SidecarManager } from "./sidecar";
import type { SidecarPool } from "./sidecar-pool";
import { type SpawnTabDeps, spawnTabForWindow } from "./tab-spawn";

/** Minimal BrowserWindow stand-in (only the identity fields the guard touches). */
function fakeWindow(): BrowserWindow {
	return {
		webContents: { id: 1 },
		isDestroyed: () => false,
		once: () => new EventEmitter(),
	} as unknown as BrowserWindow;
}

interface Harness {
	deps: SpawnTabDeps;
	acquire: Mock<(...args: unknown[]) => SidecarManager>;
	kindFor: Mock<(path: string) => Promise<SessionKind>>;
	sessionOwner: Mock<() => { tabId: string; winId: number } | null>;
}

function harness(options: { atCap?: boolean } = {}): Harness {
	const acquire = vi.fn(() => ({}) as SidecarManager);
	const kindFor = vi.fn(async (_path: string): Promise<SessionKind> => "agent");
	const sessionOwner = vi.fn(() => null);
	return {
		acquire,
		kindFor,
		sessionOwner,
		deps: {
			sidecarPool: {
				sessionOwner,
				atCap: options.atCap ?? false,
				acquire,
			} as unknown as Pick<SidecarPool, "sessionOwner" | "atCap" | "acquire">,
			sessionIndex: { kindFor },
			fallbackCwd: () => "/fallback",
			defaultWorkspace: () => "/default-workspace",
		},
	};
}

describe("spawnTabForWindow refusal contracts", () => {
	it("spawns an agent session for a chat request", async () => {
		const { deps, acquire, kindFor } = harness();
		const fresh = await spawnTabForWindow(deps, fakeWindow(), { cwd: "/work", kind: "chat" });

		expect(fresh?.tabId).toEqual(expect.any(String));
		expect(acquire).toHaveBeenLastCalledWith(
			"/work",
			expect.anything(),
			expect.any(String),
			undefined,
			"agent",
			undefined,
			true,
		);
		expect(kindFor).not.toHaveBeenCalled();

		// An agent file opened with a chat request resumes as an agent session.
		const resumed = await spawnTabForWindow(deps, fakeWindow(), { sessionPath: "/s/agent.jsonl", kind: "chat" });

		expect(resumed?.tabId).toEqual(expect.any(String));
		expect(acquire).toHaveBeenLastCalledWith(
			"/fallback",
			expect.anything(),
			expect.any(String),
			"/s/agent.jsonl",
			"agent",
			undefined,
			false,
		);
	});

	it("refuses a chat-stamped session file with kind-mismatch", async () => {
		const { deps, acquire, kindFor } = harness();
		kindFor.mockResolvedValue("chat");
		for (const kind of ["agent", "chat"] as const) {
			const result = await spawnTabForWindow(deps, fakeWindow(), { sessionPath: "/s/chat.jsonl", kind });

			expect(result).toEqual({ tabId: null, refusal: "kind-mismatch" });
		}
		expect(acquire).not.toHaveBeenCalled();
		expect(kindFor).toHaveBeenCalledWith("/s/chat.jsonl");
	});

	it("refuses a chat-stamped session file even when the payload omits kind", async () => {
		const { deps, acquire, kindFor } = harness();
		kindFor.mockResolvedValue("chat");
		const result = await spawnTabForWindow(deps, fakeWindow(), { sessionPath: "/s/chat.jsonl" });

		expect(result).toEqual({ tabId: null, refusal: "kind-mismatch" });
		expect(acquire).not.toHaveBeenCalled();
	});

	it("owner wins over kind resolution (F-OWN checked first, kindFor not consulted)", async () => {
		const { deps, acquire, kindFor, sessionOwner } = harness();
		sessionOwner.mockReturnValue({ tabId: "t-owner", winId: 7 });
		const result: IpcSpawnTabResult | null = await spawnTabForWindow(deps, fakeWindow(), {
			sessionPath: "/s/owned.jsonl",
			kind: "chat",
		});

		expect(result).toEqual({ tabId: null, ownerTabId: "t-owner", ownerWinId: 7, refusal: "owned" });
		expect(kindFor).not.toHaveBeenCalled();
		expect(acquire).not.toHaveBeenCalled();
	});

	it("returns null at the pool cap", async () => {
		const { deps, acquire } = harness({ atCap: true });
		const result = await spawnTabForWindow(deps, fakeWindow(), {});

		expect(result).toBeNull();
		expect(acquire).not.toHaveBeenCalled();
	});

	it("fresh tabs bypass auto-resume, spawn agent by default, and never consult kindFor", async () => {
		const { deps, acquire, kindFor } = harness();
		const result = await spawnTabForWindow(deps, fakeWindow(), { cwd: "/work" });

		expect(result?.tabId).toEqual(expect.any(String));
		expect(acquire).toHaveBeenCalledWith(
			"/work",
			expect.anything(),
			expect.any(String),
			undefined,
			"agent",
			undefined,
			true,
		);
		expect(kindFor).not.toHaveBeenCalled();
	});

	it("spawns Work as a full agent in the GUI default workspace", async () => {
		const { deps, acquire, kindFor } = harness();
		const result = await spawnTabForWindow(deps, fakeWindow(), { defaultWorkspace: true });

		expect(result).toEqual({ tabId: expect.any(String), cwd: "/default-workspace" });
		expect(acquire).toHaveBeenCalledWith(
			"/default-workspace",
			expect.anything(),
			expect.any(String),
			undefined,
			"agent",
			undefined,
			true,
		);
		expect(kindFor).not.toHaveBeenCalled();
	});

	it("passes a worktree binding through to acquire (plan/20)", async () => {
		const { deps, acquire } = harness();
		const worktree = { name: "fix-login", branch: "omp/gui/fix-login", baseCwd: "/repo" };
		const result = await spawnTabForWindow(deps, fakeWindow(), { cwd: "/wt/gui-fix-login-deadbeef", worktree });

		expect(result?.tabId).toEqual(expect.any(String));
		expect(acquire).toHaveBeenCalledWith(
			"/wt/gui-fix-login-deadbeef",
			expect.anything(),
			expect.any(String),
			undefined,
			"agent",
			worktree,
			true,
		);
	});
});
