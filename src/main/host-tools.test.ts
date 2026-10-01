import { describe, expect, it } from "vitest";
import type { HostToolCallRequest, HostToolResult } from "../shared/rpc-types";
import { answerHostToolCall, type HostToolAnswer } from "./host-tools";

function call(id: string, toolName: string): HostToolCallRequest {
	return { type: "host_tool_call", id, toolCallId: `call-${id}`, toolName, arguments: {} };
}

function harness(execute: (name: string) => HostToolAnswer) {
	const sent: HostToolResult[] = [];
	let forwarded = 0;
	const answer = (request: HostToolCallRequest) =>
		answerHostToolCall(
			{ sendSideChannel: frame => sent.push(frame) },
			request,
			name => execute(name),
			() => forwarded++,
		);
	return { sent, answer, forwarded: () => forwarded };
}

describe("answerHostToolCall", () => {
	it("answers a synchronous tool at once", () => {
		const { sent, answer, forwarded } = harness(() => "Opened in browser");
		expect(answer(call("1", "gui_open_url"))).toBe(true);
		expect(sent).toEqual([{ type: "host_tool_result", id: "1", result: "Opened in browser" }]);
		expect(forwarded()).toBe(0);
	});

	it("counts an asynchronous tool as answered before its value arrives", async () => {
		let resolve: (text: string) => void = () => {};
		const { sent, answer } = harness(() => new Promise<string>(done => (resolve = done)));
		expect(answer(call("2", "gui_clipboard_read"))).toBe(true);
		expect(sent).toEqual([]);
		resolve("copied text");
		await Promise.resolve();
		expect(sent).toEqual([{ type: "host_tool_result", id: "2", result: "copied text" }]);
	});

	it("answers with an error when the asynchronous read fails", async () => {
		const { sent, answer } = harness(() => Promise.reject(new Error("clipboard unavailable")));
		expect(answer(call("3", "gui_clipboard_read"))).toBe(true);
		await new Promise(done => setTimeout(done, 0));
		expect(sent).toEqual([{ type: "host_tool_result", id: "3", error: "clipboard unavailable" }]);
	});

	it("forwards a tool main does not own and sends nothing itself", () => {
		const { sent, answer, forwarded } = harness(() => undefined);
		expect(answer(call("4", "extension_tool"))).toBe(false);
		expect(forwarded()).toBe(1);
		expect(sent).toEqual([]);
	});
});
