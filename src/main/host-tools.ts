/**
 * How main answers a sidecar's host tool call. Kept free of Electron so the
 * answered-inline contract with SidecarPool is testable.
 */
import type { HostToolCallRequest, HostToolResult } from "../shared/rpc-types";

/** A main-process tool's answer; `undefined` means main does not own the tool. */
export type HostToolAnswer = string | Promise<string> | undefined;

/**
 * Answer `request` from main when `execute` owns the tool, otherwise `forward`
 * it to the renderer. Returns SidecarPool's answered-inline flag, decided
 * synchronously: a tool whose answer is still pending (the clipboard is read
 * asynchronously) counts as answered here, because its result never comes back
 * through a renderer, so the pool must not record an owner for it.
 */
export function answerHostToolCall(
	sidecar: { sendSideChannel(frame: HostToolResult): void },
	request: HostToolCallRequest,
	execute: (name: string, args: Record<string, unknown>) => HostToolAnswer,
	forward: () => void,
): boolean {
	const answer = execute(request.toolName, request.arguments);
	if (answer === undefined) {
		forward();
		return false;
	}
	const reply = (frame: Pick<HostToolResult, "result" | "error">) =>
		sidecar.sendSideChannel({ type: "host_tool_result", id: request.id, ...frame });
	if (typeof answer === "string") {
		reply({ result: answer });
	} else {
		answer.then(
			result => reply({ result }),
			(error: unknown) => reply({ error: error instanceof Error ? error.message : String(error) }),
		);
	}
	return true;
}
