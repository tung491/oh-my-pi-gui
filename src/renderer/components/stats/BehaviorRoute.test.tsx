import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { BehaviorRoute, shareOf } from "./BehaviorRoute";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

/** What the agent's stats server answers for `GET /api/stats/frustration`. */
const frustration = {
	overall: { messages: 40, judged: 10, annoyed: 8, atAssistant: 4, angry: 1 },
	byModel: [
		{
			key: "anthropic/opus/4.5.0",
			label: "opus 4.5",
			models: ["claude-opus-4-5", "anthropic/claude-opus-4.5"],
			modelClass: "anthropic",
			family: "opus",
			revision: "4.5.0",
			firstSeen: 1,
			messages: 40,
			judged: 10,
			annoyed: 8,
			atAssistant: 4,
			angry: 0,
		},
	],
	judgeAvailable: false,
	job: { state: "idle" },
};

const fetchStats = vi.fn(async (_path: string, _params?: Record<string, string>) => frustration);
Object.assign(window as unknown as Record<string, unknown>, { omp: { stats: { fetch: fetchStats } } });

let root: Root | null = null;
let container: { textContent: string | null; remove: () => void } | null = null;

async function mount(): Promise<string> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	container = host as unknown as { textContent: string | null; remove: () => void };
	root = createRoot(host as unknown as Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<BehaviorRoute range="24h" refreshKey={0} />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0));
	});
	return container.textContent ?? "";
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	container?.remove();
	container = null;
	fetchStats.mockClear();
});

describe("Behavior stats", () => {
	it("reads the agent's frustration tallies, not the retired behavior route", async () => {
		await mount();
		expect(fetchStats).toHaveBeenCalledWith("/api/stats/frustration", { range: "24h" });
		expect(fetchStats.mock.calls.some(([path]) => path === "/api/stats/behavior")).toBe(false);
	});

	it("shows each tally as a share of the messages and lists every model version", async () => {
		const text = await mount();
		expect(text).toContain("Judge coverage");
		expect(text).toContain("25.0%");
		expect(text).toContain("10 judged · 30 by pattern");
		expect(text).toContain("Annoyed");
		expect(text).toContain("20.0%");
		expect(text).toContain("At the assistant");
		expect(text).toContain("Angry");
		expect(text).toContain("2.5%");
		expect(text).toContain("opus 4.5");
		expect(text).toContain("claude-opus-4-5, anthropic/claude-opus-4.5");
		expect(text).not.toContain("Stats unavailable");
	});

	it("shows a dash instead of dividing by zero", () => {
		expect(shareOf(0, 0)).toBe("—");
		expect(shareOf(1, 4)).toBe("25.0%");
	});
});
