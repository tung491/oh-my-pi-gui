/**
 * An office job's finished file opens in one click: its card starts expanded
 * and is never folded into the compact "N steps" group, in finalized history
 * and in the live turn alike. Every other tool keeps its usual behaviour.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { ToolCard } from "../tools/ToolCard";
import { StreamingRows } from "./ChatStream";
import { buildHistoryRows } from "./chat-stream-utils";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
globals.cancelAnimationFrame = (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle);

const at = "2026-10-06T09:00:00.000Z";
const REPORT = "/home/u/Documents/Sai ATLAS/Report.docx";

function assistant(content: AgentMessage["content"]): AgentMessage {
	return { role: "assistant", content, timestamp: at };
}

function result(toolCallId: string, toolName: string, text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: at,
	};
}

const officeOutput = JSON.stringify({ file: REPORT, kind: "docx", check: "3 headings" });

/** read → office_report (with narration and a second read in the same message) → final answer. */
const run: AgentMessage[] = [
	assistant([{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "/home/u/notes.md" } }]),
	result("call-read", "read", "# Notes"),
	assistant([
		{ type: "text", text: "Writing the report now." },
		{ type: "toolCall", id: "call-glob", name: "glob", arguments: { pattern: "*.md" } },
		{ type: "toolCall", id: "call-report", name: "office_report", arguments: { markdown: "# Notes" } },
	]),
	result("call-glob", "glob", "notes.md"),
	result("call-report", "office_report", officeOutput),
	assistant([{ type: "text", text: "Your report is ready." }]),
];

let root: Root | null = null;
let container: Element | null = null;

async function mount(element: ReactElement): Promise<Element> {
	const host = document.createElement("div") as unknown as Element;
	document.body.appendChild(host as never);
	container = host;
	root = createRoot(host);
	const mounted = root;
	await act(async () => {
		mounted.render(<I18nProvider>{element}</I18nProvider>);
	});
	return host;
}

afterEach(async () => {
	const mounted = root;
	if (mounted) await act(async () => mounted.unmount());
	container?.remove();
	root = null;
	container = null;
	useToolsStore.getState().reset();
	useMessagesStore.getState().reset();
	useUiStore.setState({ transcriptDetail: "compact", toolsExpandAll: { expanded: false, seq: 0 } });
});

describe("office cards in finalized history", () => {
	it("keeps an office call out of the compact steps group, in call order", () => {
		const rows = buildHistoryRows(run, "compact");
		expect(rows.map(row => row.kind)).toEqual(["process", "message", "message"]);

		const steps = rows[0];
		if (steps?.kind !== "process") throw new Error("steps row missing");
		expect(steps.toolNames).toEqual(["read", "glob"]);
		expect(steps.stepCount).toBe(2);
		expect(steps.messages.flatMap(message => (Array.isArray(message.content) ? message.content : []))).toContainEqual(
			{ type: "text", text: "Writing the report now." },
		);

		const office = rows[1];
		if (office?.kind !== "message") throw new Error("office row missing");
		expect(office.message.content).toEqual([
			{ type: "toolCall", id: "call-report", name: "office_report", arguments: { markdown: "# Notes" } },
		]);
		const answer = rows[2];
		if (answer?.kind !== "message") throw new Error("answer row missing");
		expect(answer.message.content).toEqual([{ type: "text", text: "Your report is ready." }]);
	});

	it("leaves full detail unchanged", () => {
		const rows = buildHistoryRows(run, "full");
		expect(rows.map(row => row.kind)).toEqual(["message", "message", "message"]);
		const middle = rows[1];
		if (middle?.kind !== "message") throw new Error("middle row missing");
		expect(Array.isArray(middle.message.content) && middle.message.content).toHaveLength(3);
	});

	it("still folds a run without office calls into one steps group", () => {
		const plain = run.filter(message => message.role !== "toolResult" || message.toolName !== "office_report");
		const withoutOffice = plain.map(message =>
			message.role === "assistant" && Array.isArray(message.content)
				? {
						...message,
						content: message.content.filter(block => block.type !== "toolCall" || block.name !== "office_report"),
					}
				: message,
		);
		expect(buildHistoryRows(withoutOffice, "compact").map(row => row.kind)).toEqual(["process", "message"]);
	});
});

describe("office card expansion", () => {
	it.each(["office_report", "office_slides", "office_clean"])("starts %s expanded", async name => {
		const host = await mount(<ToolCard toolCallId="call-x" toolName={name} args={{}} />);
		expect(host.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("true");
	});

	it("shows the finished file's Open button without a click", async () => {
		useToolsStore.getState().hydrateMessages(run);
		const host = await mount(<ToolCard toolCallId="call-report" toolName="office_report" args={{}} />);
		expect(host.querySelector("[data-office-file]")).not.toBeNull();
		expect(host.textContent).toContain("Open");
	});

	it("keeps other tools collapsed", async () => {
		const host = await mount(<ToolCard toolCallId="call-read" toolName="read" args={{ path: "/home/u/notes.md" }} />);
		expect(host.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("false");
	});
});

describe("office cards in the live turn", () => {
	const live = assistant([
		{ type: "toolCall", id: "live-glob", name: "glob", arguments: { pattern: "*.md" } },
		{ type: "toolCall", id: "live-report", name: "office_report", arguments: { markdown: "# Notes" } },
	]);

	function cardNames(scope: Element | null): string[] {
		if (!scope) return [];
		return Array.from(scope.querySelectorAll(".omp-tool-name")).map(node => node.textContent ?? "");
	}

	it("renders a running office card outside the collapsed compact steps group", async () => {
		useUiStore.setState({ transcriptDetail: "compact" });
		useMessagesStore.setState({ streamingMessage: live });
		const host = await mount(<StreamingRows expanded={false} onExpandedChange={() => {}} />);
		const group = host.querySelector(".omp-execution-group");
		expect(group).not.toBeNull();
		expect(cardNames(group)).toEqual([]);
		expect(cardNames(host)).toEqual(["office_report"]);
		expect(group?.textContent).toContain("1 step");
	});

	it("keeps both cards in place in full detail", async () => {
		useUiStore.setState({ transcriptDetail: "full" });
		useMessagesStore.setState({ streamingMessage: live });
		const host = await mount(<StreamingRows expanded={false} onExpandedChange={() => {}} />);
		expect(host.querySelector(".omp-execution-group")).toBeNull();
		expect(cardNames(host)).toEqual(["glob", "office_report"]);
	});
});
