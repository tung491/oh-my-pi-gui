import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @tauri-apps/api/mocks installs its fake IPC on `window`; vitest runs this file in node.
const globals = globalThis as Record<string, unknown>;
if (!("window" in globalThis)) globals.window = globalThis;

const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
const { createTauriPort } = await import("./tauri-port");
type Channel = import("@tauri-apps/api/core").Channel<{ channel: string; payload: unknown }>;

interface Call {
	cmd: string;
	payload: Record<string, unknown>;
}

let calls: Call[];
let attached: Channel | null;
let respond: (call: Call) => unknown;

function invokes(): Call[] {
	return calls.filter(call => call.cmd !== "omp_attach");
}

async function settle(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
	calls = [];
	attached = null;
	respond = () => "ok";
	mockIPC((cmd, payload) => {
		const call = { cmd, payload: (payload ?? {}) as Record<string, unknown> };
		calls.push(call);
		if (cmd === "omp_attach") {
			attached = call.payload.onMessage as Channel;
			return null;
		}
		return respond(call);
	});
});

afterEach(() => {
	clearMocks();
});

describe("createTauriPort", () => {
	it("invoke forwards channel positional args and a rising seq", async () => {
		const port = createTauriPort("omp_invoke", "gen-1");
		await port.invoke("prefs:get", { key: "language" });
		await port.invoke("system:save-dialog", "a.html", [{ name: "HTML", extensions: ["html"] }]);
		const [first, second] = invokes();
		expect(first.cmd).toBe("omp_invoke");
		expect(first.payload).toMatchObject({ channel: "prefs:get", args: [{ key: "language" }], seq: 0 });
		expect(second.payload).toMatchObject({
			channel: "system:save-dialog",
			args: ["a.html", [{ name: "HTML", extensions: ["html"] }]],
			seq: 1,
		});
	});

	it("attach and every invoke carry the same page generation", async () => {
		const port = createTauriPort("omp_quick_entry_invoke", "gen-xyz");
		await port.invoke("quick-entry:submit", { text: "hi" });
		port.send("quick-entry:dismiss");
		await settle();
		expect(calls[0]).toMatchObject({ cmd: "omp_attach", payload: { gen: "gen-xyz" } });
		expect(attached).not.toBeNull();
		for (const call of invokes()) {
			expect(call.cmd).toBe("omp_quick_entry_invoke");
			expect(call.payload.gen).toBe("gen-xyz");
		}
	});

	it("undefined args become null", async () => {
		const port = createTauriPort("omp_invoke", "gen-1");
		await port.invoke("system:save-dialog", undefined, undefined);
		expect(invokes()[0].payload.args).toEqual([null, null]);
	});

	it("invoke rejects with an Error carrying the Rust message", async () => {
		respond = () => {
			throw { message: "not ported: fs:read" };
		};
		const port = createTauriPort("omp_invoke", "gen-1");
		const error = await port.invoke("fs:read", { path: "x" }).catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("not ported: fs:read");
	});

	it("on registers synchronously and the remover stops delivery", async () => {
		const port = createTauriPort("omp_invoke", "gen-1");
		const received: unknown[] = [];
		const remove = port.on("sessions:changed", payload => received.push(payload));
		// No IPC round trip per subscription: only the one attach has gone out.
		expect(calls.map(call => call.cmd)).toEqual(["omp_attach"]);
		attached?.onmessage({ channel: "sessions:changed", payload: 1 });
		remove();
		attached?.onmessage({ channel: "sessions:changed", payload: 2 });
		expect(received).toEqual([1]);
	});

	it("a throwing listener does not stop the others", async () => {
		const port = createTauriPort("omp_invoke", "gen-1");
		const received: unknown[] = [];
		port.on("log:line", () => {
			throw new Error("boom");
		});
		port.on("log:line", payload => received.push(payload));
		attached?.onmessage({ channel: "log:line", payload: { lines: ["a"] } });
		await settle();
		expect(received).toEqual([{ lines: ["a"] }]);
		const reports = invokes().filter(call => call.payload.channel === "runtime:error-report");
		expect(reports).toHaveLength(1);
		expect(reports[0].payload.args).toEqual([
			{
				source: "preload",
				message: 'IPC handler for "log:line" failed: boom',
				details: { channel: "log:line" },
			},
		]);
	});

	it("send swallows rejections", async () => {
		respond = () => {
			throw new Error("nobody listens");
		};
		const port = createTauriPort("omp_invoke", "gen-1");
		expect(() => port.send("tray:state-push", { working: 0 })).not.toThrow();
		await settle();
		expect(invokes()[0].payload).toMatchObject({ channel: "tray:state-push", seq: 0 });
	});
});
