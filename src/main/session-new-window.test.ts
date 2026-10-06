import { describe, expect, it, type Mock, vi } from "vitest";
import type { SessionKind } from "../shared/ipc-types";
import { type OpenInNewWindowDeps, openSessionInNewWindow } from "./session-new-window";

interface Harness {
	deps: OpenInNewWindowDeps;
	kindFor: Mock<(path: string) => Promise<SessionKind>>;
	focusWindow: Mock<(winId: number) => boolean>;
	spawnWindow: Mock<(cwd: string, sessionPath: string | undefined) => boolean>;
}

function harness(
	options: { atCap?: boolean; kind?: SessionKind; owner?: { tabId: string; winId: number } } = {},
): Harness {
	const kindFor = vi.fn(async (_path: string): Promise<SessionKind> => options.kind ?? "agent");
	const focusWindow = vi.fn((_winId: number) => true);
	const spawnWindow = vi.fn((_cwd: string, _sessionPath: string | undefined) => true);
	return {
		kindFor,
		focusWindow,
		spawnWindow,
		deps: {
			sidecarPool: { sessionOwner: () => options.owner ?? null, atCap: options.atCap ?? false },
			sessionIndex: { kindFor },
			focusWindow,
			spawnWindow,
			callerCwd: () => "/caller",
		},
	};
}

describe("openSessionInNewWindow", () => {
	it("focuses the live owner before the kind check", async () => {
		const { deps, kindFor, focusWindow, spawnWindow } = harness({ kind: "chat", owner: { tabId: "t1", winId: 7 } });
		expect(await openSessionInNewWindow(deps, { sessionPath: "/s/chat.jsonl" })).toBe(true);
		expect(focusWindow).toHaveBeenCalledWith(7);
		expect(kindFor).not.toHaveBeenCalled();
		expect(spawnWindow).not.toHaveBeenCalled();
	});

	it("refuses a chat-stamped session with kind-mismatch and opens no window", async () => {
		const { deps, spawnWindow } = harness({ kind: "chat" });
		expect(await openSessionInNewWindow(deps, { sessionPath: "/s/chat.jsonl", cwd: "/work" })).toEqual({
			refusal: "kind-mismatch",
		});
		expect(spawnWindow).not.toHaveBeenCalled();
		// The refusal wins over the cap: the user learns why, not that the app is full.
		const capped = harness({ kind: "chat", atCap: true });
		expect(await openSessionInNewWindow(capped.deps, { sessionPath: "/s/chat.jsonl" })).toEqual({
			refusal: "kind-mismatch",
		});
	});

	it("opens an agent session in a new window without a session kind", async () => {
		const { deps, spawnWindow } = harness();
		expect(await openSessionInNewWindow(deps, { sessionPath: "/s/agent.jsonl", cwd: "/work" })).toBe(true);
		expect(spawnWindow).toHaveBeenCalledWith("/work", "/s/agent.jsonl");
		// No cwd in the payload: the caller's.
		expect(await openSessionInNewWindow(deps, {})).toBe(true);
		expect(spawnWindow).toHaveBeenLastCalledWith("/caller", undefined);
	});

	it("returns false at the pool cap", async () => {
		const { deps, spawnWindow } = harness({ atCap: true });
		expect(await openSessionInNewWindow(deps, { sessionPath: "/s/agent.jsonl" })).toBe(false);
		expect(spawnWindow).not.toHaveBeenCalled();
	});
});
