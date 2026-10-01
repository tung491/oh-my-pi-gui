import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { createMessagesStore, useMessagesStore } from "../../stores/messages";
import { createSessionStore, useSessionStore } from "../../stores/session";
import {
	addRuntimeStore,
	deleteSessionRuntime,
	registerSessionRuntime,
	type SessionRuntime,
	SessionRuntimeProvider,
	setFocusedSessionRuntime,
	type TabCommand,
	withSessionRuntime,
} from "../../stores/session-runtime-context";
import { useToastStore } from "../../stores/toast";
import { useToolsStore } from "../../stores/tools";

import { MessageBubble } from "./MessageBubble";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

const toolCallId = "call_read_package";
const assistantMessage: AgentMessage = {
	role: "assistant",
	content: [
		{
			type: "toolCall",
			id: toolCallId,
			name: "read",
			arguments: { path: "packages/gui/package.json" },
		},
	],
	timestamp: "2026-08-02T12:00:00.000Z",
};
const toolResultMessage: AgentMessage = {
	role: "toolResult",
	toolCallId,
	toolName: "read",
	content: [{ type: "text", text: '{"name":"@oh-my-pi/omp-gui"}' }],
	isError: false,
	timestamp: "2026-08-02T12:00:01.000Z",
};

const PANE_TAB = "pane-retry";

interface TestElement {
	dispatchEvent: (event: object) => boolean;
	textContent: string | null;
	getAttribute: (name: string) => string | null;
}

let mountedRoot: Root | null = null;
let mountedContainer: HTMLDivElement | null = null;

async function mount(element: ReactElement) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	mountedRoot = root;
	mountedContainer = container;
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	return container;
}

/** Dispatch inside act(); linkedom's Event has a getter-only eventPhase React writes to. */
async function dispatch(target: TestElement, event: InstanceType<typeof Event>): Promise<void> {
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		target.dispatchEvent(event);
	});
}

async function click(element: TestElement): Promise<void> {
	await dispatch(element, new Event("click", { bubbles: true, cancelable: true }));
}

/** Let the click's promise chain (RPC, then catch) settle. */
async function settle(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0));
	});
}

function response(success: boolean): RpcResponse {
	return success
		? { type: "response", command: "prompt", success: true }
		: { type: "response", command: "prompt", success: false, error: "x" };
}

/** A split-view pane runtime with its own client and its own transcript. */
function paneRuntime(command: TabCommand, messages: AgentMessage[]): SessionRuntime {
	const runtime = registerSessionRuntime({ tabId: PANE_TAB, command, stores: new Map() });
	addRuntimeStore(runtime, "messages", createMessagesStore());
	addRuntimeStore(runtime, "session", createSessionStore());
	withSessionRuntime(PANE_TAB, () => useMessagesStore.setState({ messages }));
	return runtime;
}

function installWindowRpc() {
	const prompt = vi.fn(async () => response(true));
	const abortAndPrompt = vi.fn(async () => response(true));
	(window as unknown as Record<string, unknown>).omp = { rpc: { prompt, abortAndPrompt } };
	return { prompt, abortAndPrompt };
}

afterEach(async () => {
	if (mountedRoot) {
		const root = mountedRoot;
		await act(async () => root.unmount());
	}
	mountedContainer?.remove();
	mountedRoot = null;
	mountedContainer = null;
	deleteSessionRuntime(PANE_TAB);
	setFocusedSessionRuntime(null);
	delete (window as unknown as Record<string, unknown>).omp;
	useMessagesStore.getState().reset();
	useToastStore.setState({ toasts: [] });
	useToolsStore.getState().reset();
});

describe("MessageBubble tool messages", () => {
	it("hydrates a completed tool card and folds away the standalone result", () => {
		useToolsStore.getState().hydrateMessages([assistantMessage, toolResultMessage]);

		const entry = useToolsStore.getState().activeTools.get(toolCallId);
		expect(entry).toMatchObject({
			toolName: "read",
			args: { path: "packages/gui/package.json" },
			status: "done",
			isError: false,
		});

		const callHtml = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble message={assistantMessage} />
			</I18nProvider>,
		);
		expect(callHtml).toContain("read");
		expect(callHtml).toContain("packages/gui/package.json");
		expect(
			renderToStaticMarkup(
				<I18nProvider>
					<MessageBubble message={toolResultMessage} />
				</I18nProvider>,
			),
		).toBe("");
	});

	it("shows edited files for freeform edit calls in collapsed headers", () => {
		const message: AgentMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_edit_patch",
					name: "edit",
					arguments: {
						input: "*** Begin Patch\n[packages/gui/src/first.ts#A1B2] PUT 1.=1:\n+first\n[packages/gui/src/second.ts#C3D4] PUT 1.=1:\n+second\n*** End Patch\n",
					},
				},
			],
			timestamp: "2026-08-12T00:00:00.000Z",
		};
		useToolsStore.getState().hydrateMessages([message]);

		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble message={message} />
			</I18nProvider>,
		);
		expect(html).toContain("packages/gui/src/first.ts +1");
	});

	it("keeps repeated provider call ids paired with their own historical results", async () => {
		const firstCall: AgentMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "read:0", name: "read", arguments: { path: "first.txt" } }],
			timestamp: "2026-08-02T12:00:02.000Z",
		};
		const firstResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "read:0",
			toolName: "read",
			content: [{ type: "text", text: "FIRST_RESULT" }],
			timestamp: "2026-08-02T12:00:03.000Z",
		};
		const secondCall: AgentMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "read:0", name: "read", arguments: { path: "second.txt" } }],
			timestamp: "2026-08-02T12:00:04.000Z",
		};
		const secondResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "read:0",
			toolName: "read",
			content: [{ type: "text", text: "SECOND_RESULT" }],
			timestamp: "2026-08-02T12:00:05.000Z",
		};
		useToolsStore.getState().hydrateMessages([firstCall, firstResult, secondCall, secondResult]);
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(
					<I18nProvider>
						<div id="first-call">
							<MessageBubble message={firstCall} />
						</div>
						<div id="second-call">
							<MessageBubble message={secondCall} />
						</div>
					</I18nProvider>,
				);
			});
			const firstNode = container.querySelector("#first-call");
			const secondNode = container.querySelector("#second-call");
			const firstButton = firstNode?.querySelector("button");
			const secondButton = secondNode?.querySelector("button");
			if (!firstNode || !secondNode || !firstButton || !secondButton) throw new Error("tool cards did not render");
			await act(async () => firstButton.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
			await act(async () => secondButton.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
			expect(firstNode.textContent).toContain("FIRST_RESULT");
			expect(firstNode.textContent).not.toContain("SECOND_RESULT");
			expect(secondNode.textContent).toContain("SECOND_RESULT");
			expect(secondNode.textContent).not.toContain("FIRST_RESULT");
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});
});

describe("MessageBubble user content", () => {
	it("shows an assistant reaction on the user bubble", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "user",
						content: [{ type: "text", text: "Ship it?" }],
						timestamp: "2026-08-06T00:00:00.000Z",
					}}
					reaction="👍"
				/>
			</I18nProvider>,
		);
		expect(html).toContain('role="img"');
		expect(html).toContain("👍");
	});

	it("renders user text through the same Markdown pipeline as assistant text", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "user",
						content: [{ type: "text", text: "**bold** and `code`" }],
						timestamp: "2026-08-06T00:00:00.000Z",
					}}
				/>
			</I18nProvider>,
		);
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<code");
	});

	it("keeps SQL JSONPath dollars literal instead of parsing them as inline math", () => {
		const sql =
			"JSON_SET(o.parameters, '$.reasoning_effort.required', FALSE, '$.reasoning_effort.default', 'medium')";
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "user",
						content: [{ type: "text", text: sql }],
						timestamp: "2026-08-13T00:00:00.000Z",
					}}
				/>
			</I18nProvider>,
		);
		expect(html).toContain("$.reasoning_effort.required");
		expect(html).toContain("$.reasoning_effort.default");
		expect(html).not.toContain("katex");
	});
});

describe("MessageBubble compaction summaries", () => {
	it("shows the maintenance method and before-to-after context size", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "compactionSummary",
						summary: "Long archived context details.",
						shortSummary: "Kept the active work.",
						method: "remote",
						tokensBefore: 256_000,
						tokensAfter: 20_000,
						timestamp: "2026-08-20T00:00:00.000Z",
					}}
				/>
			</I18nProvider>,
		);

		expect(html).toContain("Remote compacted · 256.0k → 20.0k");
		expect(html).toContain("Kept the active work.");
		expect(html).not.toContain("Long archived context details.");
	});

	it("preserves an unknown maintenance method and a zero-token starting point", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "compactionSummary",
						summary: "Future compactor finished.",
						method: "future",
						tokensBefore: 0,
						tokensAfter: 12,
						timestamp: "2026-08-20T00:00:00.000Z",
					}}
				/>
			</I18nProvider>,
		);

		expect(html).toContain("future · 0 → 12");
	});
});

describe("MessageBubble completion events", () => {
	it("renders supervised-process failures as one compact status row without the wire type", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					compact
					message={{
						role: "custom",
						customType: "launch-completion",
						content: "Supervised process backend-smoke failed with exit code 1.",
						details: {
							daemons: [{ name: "backend-smoke", state: "failed", exitCode: 1 }],
						},
						display: true,
						timestamp: "2026-08-20T00:00:00.000Z",
					}}
				/>
			</I18nProvider>,
		);
		expect(html).toContain("backend-smoke");
		expect(html).toContain("exit 1");
		expect(html).not.toContain("launch-completion");
		expect(html).not.toContain("omp-custom-turn");
	});

	it("keeps background output behind one native disclosure row", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "custom",
						customType: "async-result",
						content: "<system-notice>Background job bg-7 has completed.\nBUILD_OUTPUT</system-notice>",
						details: { jobs: [{ jobId: "bg-7", type: "bash", label: "bun run build" }] },
						display: true,
						timestamp: "2026-08-20T00:00:00.000Z",
					}}
				/>
			</I18nProvider>,
		);
		expect(html).toContain("bun run build");
		expect(html).toContain("Background job completed");
		expect(html).toContain("<details");
		expect(html).not.toContain("<details open");
		expect(html).toContain("BUILD_OUTPUT");
	});
});

describe("MessageBubble noise filtering", () => {
	const at = "2026-08-02T12:00:00.000Z";

	it('renders nothing for punctuation-only text or thinking blocks (model filler like ".")', () => {
		for (const text of [".", "…", "---", " ", "***"]) {
			for (const message of [
				{ role: "assistant" as const, content: [{ type: "text" as const, text }], timestamp: at },
				{ role: "assistant" as const, content: [{ type: "thinking" as const, thinking: text }], timestamp: at },
			]) {
				expect(
					renderToStaticMarkup(
						<I18nProvider>
							<MessageBubble message={message} />
						</I18nProvider>,
					),
				).toBe("");
			}
		}
	});

	it("keeps real text, CJK, and emoji-only blocks", () => {
		for (const text of ["已修复", "Done.", "👍"]) {
			const message: AgentMessage = { role: "assistant", content: [{ type: "text", text }], timestamp: at };
			expect(
				renderToStaticMarkup(
					<I18nProvider>
						<MessageBubble message={message} />
					</I18nProvider>,
				),
			).toContain(text);
		}
	});

	it("compacts tool-only messages — no hover footer chrome", () => {
		useToolsStore.getState().hydrateMessages([assistantMessage, toolResultMessage]);
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble message={assistantMessage} />
			</I18nProvider>,
		);
		// The timestamp/copy/branch footer is message-level chrome a tool card
		// doesn't need (copy would copy an empty string).
		expect(html).not.toContain("Copy message text");
		expect(html).toContain("py-1.5");
	});

	it("keeps the footer on text-bearing messages", () => {
		const mixed: AgentMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "Fixed." },
				{ type: "toolCall", id: "call_mixed", name: "read", arguments: { path: "x" } },
			],
			timestamp: at,
		};
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble message={mixed} />
			</I18nProvider>,
		);
		expect(html).toContain("Fixed.");
		expect(html).toContain("Copy message text");
		expect(html).toContain("py-3");
	});

	it("offers branch-to-new-tab on user and assistant messages even before legacy ids are resolved", () => {
		const user: AgentMessage = {
			role: "user",
			entryId: "user-entry",
			content: [{ type: "text", text: "branch point" }],
			timestamp: at,
		};
		const assistant: AgentMessage = {
			role: "assistant",
			entryId: "assistant-entry",
			content: [{ type: "text", text: "answer" }],
			timestamp: at,
		};
		const render = (message: AgentMessage) =>
			renderToStaticMarkup(
				<I18nProvider>
					<MessageBubble message={message} />
				</I18nProvider>,
			);

		expect(render(user)).toContain("Branch to a new tab from here");
		expect(render(assistant)).toContain("Branch to a new tab from here");
		expect(render({ ...assistant, entryId: undefined })).toContain("Branch to a new tab from here");
	});

	it("uses compact chrome for expanded process details containing reasoning and tools", () => {
		const processMessage: AgentMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Inspect first." },
				{ type: "toolCall", id: "call_process", name: "read", arguments: { path: "x" } },
			],
			timestamp: at,
		};
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble compact message={processMessage} />
			</I18nProvider>,
		);
		expect(html).toContain("read");
		expect(html).not.toContain("Copy message text");
		expect(html).toContain("py-1.5");
		expect(html).toContain("omp-assistant-turn--compact");
	});

	it("uses the full-width transcript content surface for assistant output", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "assistant",
						content: [{ type: "text", text: "A long answer that must follow the transcript reading measure." }],
						timestamp: at,
					}}
				/>
			</I18nProvider>,
		);
		expect(html).toContain('class="omp-transcript-content min-w-0"');
		expect(html).not.toContain('class="min-w-0 flex-1"');
	});
});

describe("MessageBubble turn chrome", () => {
	const at = "2026-08-02T12:00:00.000Z";
	const paneQuestion: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: "pane question" }],
		timestamp: at,
	};
	const paneAnswer: AgentMessage = {
		role: "assistant",
		content: [{ type: "text", text: "pane answer" }],
		model: "claude-sonnet-4",
		timestamp: at,
	};

	function seedOtherPane(): void {
		// The window-level store holds a different conversation; a retry that
		// escaped its pane would re-send this text instead.
		useMessagesStore.setState({
			messages: [{ role: "user", content: [{ type: "text", text: "other pane question" }], timestamp: at }],
		});
	}

	it("heads an assistant turn with the app-icon avatar, the author, the model, and the time", async () => {
		const container = await mount(<MessageBubble message={paneAnswer} />);
		const avatar = container.querySelector("[data-assistant-avatar]");
		expect(avatar).not.toBeNull();
		expect(avatar?.getAttribute("aria-hidden")).toBe("true");
		expect(avatar?.querySelector('img[data-logo-tone="light"][src$="sai-atlas-icon-on-light.svg"]')).not.toBeNull();
		expect(avatar?.querySelector('img[data-logo-tone="dark"][src$="sai-atlas-icon-on-dark.svg"]')).not.toBeNull();
		expect(container.textContent).toContain("Sai ATLAS");
		expect(container.textContent).toContain("claude-sonnet-4");
	});

	it("marks the user card with an avatar and the author name", async () => {
		const container = await mount(<MessageBubble message={paneQuestion} />);
		const avatar = container.querySelector("[data-user-avatar]");
		expect(avatar).not.toBeNull();
		expect(avatar?.getAttribute("aria-hidden")).toBe("true");
		expect(avatar?.nextElementSibling?.classList.contains("omp-user-bubble")).toBe(true);
		expect(container.querySelector(".omp-user-bubble")?.textContent).toContain("You");
	});

	it("re-sends the pane's last user message through the pane's own client", async () => {
		const windowRpc = installWindowRpc();
		const command = vi.fn<TabCommand>(async () => response(true));
		const runtime = paneRuntime(command, [paneQuestion, paneAnswer]);
		seedOtherPane();
		const container = await mount(
			<SessionRuntimeProvider runtime={runtime}>
				<MessageBubble message={paneAnswer} retryable />
			</SessionRuntimeProvider>,
		);
		const retry = container.querySelector('button[aria-label="Retry this turn"]') as TestElement | null;
		if (!retry) throw new Error("Retry button did not render");
		expect(retry.getAttribute("title")).toBe("Retry this turn");
		expect(retry.getAttribute("title") ?? "").not.toMatch(/[⌘⌥⌃⇧]/);

		await click(retry);
		await settle();

		expect(command).toHaveBeenCalledWith(
			expect.objectContaining({ type: "prompt", message: "pane question" }),
			undefined,
		);
		expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ message: "other pane question" }), undefined);
		expect(windowRpc.prompt).not.toHaveBeenCalled();
		expect(windowRpc.abortAndPrompt).not.toHaveBeenCalled();
	});

	it("surfaces a failed retry as an error toast instead of an unhandled rejection", async () => {
		installWindowRpc();
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		try {
			const command = vi.fn<TabCommand>(async () => response(false));
			const runtime = paneRuntime(command, [paneQuestion, paneAnswer]);
			const container = await mount(
				<SessionRuntimeProvider runtime={runtime}>
					<MessageBubble message={paneAnswer} retryable />
				</SessionRuntimeProvider>,
			);
			const retry = container.querySelector('button[aria-label="Retry this turn"]') as TestElement | null;
			if (!retry) throw new Error("Retry button did not render");

			await click(retry);
			await settle();

			expect(command).toHaveBeenCalledTimes(1);
			// A rejected send starts no turn, so Retry is usable again at once.
			expect(retry.getAttribute("disabled")).toBeNull();
			expect(useToastStore.getState().toasts).toContainEqual(
				expect.objectContaining({
					variant: "error",
					title: "Command failed",
					message: expect.stringContaining("x"),
				}),
			);
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", unhandled);
		}
	});

	it("sends one retry when Retry is clicked again before the first send settles", async () => {
		installWindowRpc();
		let release: (value: RpcResponse) => void = () => {};
		const command = vi.fn<TabCommand>(
			() =>
				new Promise<RpcResponse>(resolve => {
					release = resolve;
				}),
		);
		const runtime = paneRuntime(command, [paneQuestion, paneAnswer]);
		const container = await mount(
			<SessionRuntimeProvider runtime={runtime}>
				<MessageBubble message={paneAnswer} retryable />
			</SessionRuntimeProvider>,
		);
		const retry = container.querySelector('button[aria-label="Retry this turn"]') as TestElement | null;
		if (!retry) throw new Error("Retry button did not render");

		await click(retry);
		await click(retry);
		expect(command).toHaveBeenCalledTimes(1);

		release(response(true));
		await settle();
		expect(command).toHaveBeenCalledTimes(1);
	});

	it("keeps Retry disabled after the send is acknowledged until the retried turn starts streaming", async () => {
		const command = vi.fn<TabCommand>(async () => response(true));
		const runtime = paneRuntime(command, [paneQuestion, paneAnswer]);
		const container = await mount(
			<SessionRuntimeProvider runtime={runtime}>
				<MessageBubble message={paneAnswer} retryable />
			</SessionRuntimeProvider>,
		);
		const retry = container.querySelector('button[aria-label="Retry this turn"]') as TestElement | null;
		if (!retry) throw new Error("Retry button did not render");

		await click(retry);
		await settle();
		// The prompt is acknowledged before its agent_start event lands.
		expect(retry.getAttribute("disabled")).not.toBeNull();
		await click(retry);
		await settle();
		expect(command).toHaveBeenCalledTimes(1);

		await act(async () => {
			withSessionRuntime(PANE_TAB, () => useSessionStore.setState({ isStreaming: true }));
		});
		expect(retry.getAttribute("disabled")).toBeNull();
	});

	it("re-enables Retry when an acknowledged send never starts a turn", async () => {
		vi.useFakeTimers();
		try {
			const command = vi.fn<TabCommand>(async () => response(true));
			const runtime = paneRuntime(command, [paneQuestion, paneAnswer]);
			const container = await mount(
				<SessionRuntimeProvider runtime={runtime}>
					<MessageBubble message={paneAnswer} retryable />
				</SessionRuntimeProvider>,
			);
			const retry = container.querySelector('button[aria-label="Retry this turn"]') as TestElement | null;
			if (!retry) throw new Error("Retry button did not render");

			await click(retry);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1000);
			});
			expect(retry.getAttribute("disabled")).not.toBeNull();

			await act(async () => {
				await vi.advanceTimersByTimeAsync(10_000);
			});
			expect(retry.getAttribute("disabled")).toBeNull();
			await click(retry);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});
			expect(command).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("disables Retry while the shared session is read-only for this viewer", async () => {
		const command = vi.fn<TabCommand>(async () => response(true));
		const runtime = paneRuntime(command, [paneQuestion, paneAnswer]);
		withSessionRuntime(PANE_TAB, () =>
			useSessionStore.setState({ collab: { role: "guest", readOnly: true, participants: [] } }),
		);
		const container = await mount(
			<SessionRuntimeProvider runtime={runtime}>
				<MessageBubble message={paneAnswer} retryable />
			</SessionRuntimeProvider>,
		);
		const retry = container.querySelector('button[aria-label="Retry this turn"]') as TestElement | null;
		if (!retry) throw new Error("Retry button did not render");
		expect(retry.getAttribute("disabled")).not.toBeNull();

		await click(retry);
		await settle();
		expect(command).not.toHaveBeenCalled();
	});

	it("offers Retry only on the turn marked retryable", async () => {
		const runtime = paneRuntime(
			vi.fn<TabCommand>(async () => response(true)),
			[paneQuestion, paneAnswer],
		);
		const container = await mount(
			<SessionRuntimeProvider runtime={runtime}>
				<MessageBubble message={paneAnswer} />
			</SessionRuntimeProvider>,
		);
		expect(container.textContent).toContain("pane answer");
		expect(container.querySelector('button[aria-label="Retry this turn"]')).toBeNull();
	});
});
