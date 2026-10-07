/**
 * Composer submit with attached documents: the wire message names each
 * document after the typed text exactly as the paperclip's draft lines did,
 * and every path that gives the composer back a send returns the documents
 * as documents, never as text.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { type ComposerDocument, useComposerStore } from "../../stores/composer";
import { useInputHistoryStore } from "../../stores/input-history";
import { useMessagesStore } from "../../stores/messages";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { useToastStore } from "../../stores/toast";
import { appendDocumentPaths } from "./attach-document";
import { useComposerSubmit } from "./use-composer-submit";

const { document, window, Event, CustomEvent, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, CustomEvent, HTMLElement, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const ok = (data?: unknown): RpcResponse => ({ type: "response", command: "x", success: true, data });
const failed = (error: string): RpcResponse => ({ type: "response", command: "x", success: false, error });

const DOCUMENTS: ComposerDocument[] = [
	{ path: "/home/u/Q3 report.docx", name: "Q3 report.docx" },
	{ path: "/home/u/Bob's notes.pdf", name: "Bob's notes.pdf" },
	{ path: "/home/u/Báo cáo.xlsx", name: "Báo cáo.xlsx" },
];
const PATHS = DOCUMENTS.map(document => document.path);

let container: Element;
let root: Root;
let prompt: Mock;
let followUp: Mock;
let send: ReturnType<typeof useComposerSubmit> | null = null;

function Harness({ isStreaming }: { isStreaming: boolean }) {
	const composer = useComposerStore(state => state);
	send = useComposerSubmit({
		text: composer.draft,
		images: composer.images,
		sending: composer.sending,
		status: "ready",
		isStreaming,
		mode: "steer",
		queuedMessageCount: 0,
		commands: [],
		emojiAutocomplete: false,
		routeReady: true,
		setText: composer.setDraft,
		setImages: composer.setImages,
		setMenu: () => {},
		setSending: composer.setSending,
	});
	return null;
}

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount({ isStreaming = false } = {}): Promise<void> {
	prompt = vi.fn(async () => ok());
	followUp = vi.fn(async () => ok());
	(window as unknown as Record<string, unknown>).omp = {
		rpc: { prompt, followUp, steer: vi.fn(async () => ok()) },
		prefs: { set: vi.fn(async () => ({})), get: vi.fn(async () => []) },
	};
	useSessionStore.setState({ status: "ready", isStreaming, cwd: "/tmp", sessionId: "s1" });
	useTabsStore.setState({
		tabs: [{ kind: "agent", id: "t0", cwd: "/tmp", status: "ready", unreadDone: false }],
		activeTabId: "t0",
		bundles: new Map(),
	});
	container = document.createElement("div") as unknown as Element;
	document.body.appendChild(container as never);
	root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider>
				<Harness isStreaming={isStreaming} />
			</I18nProvider>,
		);
	});
}

async function compose(draft: string, documents: ComposerDocument[]): Promise<void> {
	await act(async () => {
		useComposerStore.getState().setDraft(draft);
		useComposerStore.getState().setDocuments(documents);
	});
}

async function submit(): Promise<void> {
	await act(async () => send?.());
	await flush();
	await flush();
}

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	send = null;
	useComposerStore.getState().reset();
	useSessionStore.getState().reset();
	useMessagesStore.getState().reset();
	useInputHistoryStore.setState({ entries: [], navIndex: -1, navDraft: "", navContext: undefined });
	useTabsStore.getState().reset();
	useToastStore.setState({ toasts: [] });
	vi.restoreAllMocks();
});

describe("composer submit with attached documents", () => {
	it("sends the typed text followed by the same quoted path lines the paperclip wrote", async () => {
		await mount();
		await compose("  summarize these  ", DOCUMENTS);
		await submit();

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt.mock.calls[0]?.[0]).toBe(appendDocumentPaths("summarize these", PATHS));
		expect(prompt.mock.calls[0]?.[0]).toBe(
			`summarize these\n'/home/u/Q3 report.docx'\n"/home/u/Bob's notes.pdf"\n'/home/u/Báo cáo.xlsx'`,
		);
		expect(useComposerStore.getState().draft).toBe("");
		expect(useComposerStore.getState().documents).toEqual([]);
		expect(useInputHistoryStore.getState().entries[0]?.prompt).toBe(appendDocumentPaths("summarize these", PATHS));
	});

	it("sends documents with no typed text", async () => {
		await mount();
		await compose("", DOCUMENTS.slice(0, 1));
		await submit();

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt.mock.calls[0]?.[0]).toBe("'/home/u/Q3 report.docx'");
		expect(useComposerStore.getState().documents).toEqual([]);
	});

	it("does nothing with neither text nor attachments", async () => {
		await mount();
		await compose("   ", []);
		await submit();

		expect(prompt).not.toHaveBeenCalled();
	});

	it("gives a failed send back as text and document cards, not path lines", async () => {
		await mount();
		prompt.mockResolvedValueOnce(failed("boom"));
		await compose("summarize these", DOCUMENTS);
		await submit();

		expect(useComposerStore.getState().draft).toBe("summarize these");
		expect(useComposerStore.getState().documents).toEqual(DOCUMENTS);
	});

	it("gives a thrown send back with its documents", async () => {
		await mount();
		prompt.mockRejectedValueOnce(new Error("bridge down"));
		await compose("", DOCUMENTS.slice(1));
		await submit();

		expect(useComposerStore.getState().draft).toBe("");
		expect(useComposerStore.getState().documents).toEqual(DOCUMENTS.slice(1));
	});

	it("sends queue shorthand documents with the first item only", async () => {
		await mount();
		await compose("=>\n1. read them\n2. then summarize", DOCUMENTS.slice(0, 1));
		await submit();

		expect(prompt).toHaveBeenCalledWith("read them\n'/home/u/Q3 report.docx'", [], "followUp");
		expect(followUp).toHaveBeenCalledWith("then summarize", undefined);
		expect(useComposerStore.getState().documents).toEqual([]);
	});

	it("queues documents alone as one item", async () => {
		await mount({ isStreaming: true });
		await compose("=>", DOCUMENTS.slice(0, 1));
		await submit();

		expect(followUp).toHaveBeenCalledWith("'/home/u/Q3 report.docx'", []);
	});

	it("gives an unsent queue shorthand back with its documents", async () => {
		await mount();
		prompt.mockResolvedValueOnce(failed("busy"));
		await compose("=>\n1. read them\n2. then summarize", DOCUMENTS);
		await submit();

		expect(followUp).not.toHaveBeenCalled();
		expect(useComposerStore.getState().draft).toBe("=>\n1. read them\n2. then summarize");
		expect(useComposerStore.getState().documents).toEqual(DOCUMENTS);
	});

	it("keeps documents that already went out off a partially sent queue's remainder", async () => {
		await mount();
		followUp.mockResolvedValueOnce(failed("busy"));
		await compose("=>\n1. read them\n2. then summarize", DOCUMENTS);
		await submit();

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(useComposerStore.getState().draft).toBe("=> then summarize");
		expect(useComposerStore.getState().documents).toEqual([]);
	});

	it("gives a refused queue item back with its documents", async () => {
		await mount();
		await compose("=>\n1. /share\n2. then summarize", DOCUMENTS);
		await submit();

		expect(prompt).not.toHaveBeenCalled();
		expect(useComposerStore.getState().draft).toBe("=>\n1. /share\n2. then summarize");
		expect(useComposerStore.getState().documents).toEqual(DOCUMENTS);
	});
});
