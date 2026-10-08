/**
 * useShadowMount: the open shadow root a docx or pptx render draws into. The
 * render's disposer runs exactly once, including when the render resolves
 * after the preview was torn down, and `data-rendered` marks the host only
 * once the render resolved. Same linkedom harness as ThinkingBlock.test.tsx.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useShadowMount } from "./shadow-mount";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const openExternal = vi.fn(async (_url: string) => {});
Object.assign(window, { omp: { system: { openExternal } } });

type Render = (mount: HTMLDivElement, root: ShadowRoot, signal: AbortSignal) => Promise<() => void>;

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function Probe({ render, version }: { render: Render; version: number }): ReactElement {
	const hostRef = useShadowMount(render, [version]);
	return <div ref={hostRef} data-probe-host />;
}

let container: Element | null = null;
let root: Root | null = null;

async function mount(render: Render, version = 1): Promise<HTMLElement> {
	container = document.createElement("div") as unknown as Element;
	document.body.appendChild(container as never);
	const created = createRoot(container);
	root = created;
	await act(async () => {
		created.render(<Probe render={render} version={version} />);
	});
	const host = container.querySelector("[data-probe-host]");
	if (!host) throw new Error("no host");
	return host as unknown as HTMLElement;
}

async function rerender(render: Render, version: number): Promise<void> {
	const mounted = root;
	if (!mounted) throw new Error("not mounted");
	await act(async () => {
		mounted.render(<Probe render={render} version={version} />);
	});
}

async function unmount(): Promise<void> {
	const mounted = root;
	root = null;
	if (mounted) {
		await act(async () => {
			mounted.unmount();
		});
	}
}

/** Lets pending promise callbacks run until `condition` holds or the deadline passes. */
async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition() && Date.now() < deadline) {
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 5));
		});
	}
}

afterEach(async () => {
	await unmount();
	container?.remove();
	container = null;
	openExternal.mockClear();
});

describe("useShadowMount", () => {
	it("aborts a render still pending at unmount and disposes it once it resolves", async () => {
		const pending = deferred<() => void>();
		const dispose = vi.fn();
		let signal: AbortSignal | null = null;
		const host = await mount((_mount, _root, renderSignal) => {
			signal = renderSignal;
			return pending.promise;
		});
		expect(signal).not.toBeNull();
		expect((signal as AbortSignal | null)?.aborted).toBe(false);

		await unmount();
		expect((signal as AbortSignal | null)?.aborted).toBe(true);
		expect(dispose).not.toHaveBeenCalled();

		pending.resolve(dispose);
		await waitFor(() => dispose.mock.calls.length > 0);
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(host.hasAttribute("data-rendered")).toBe(false);
	});

	it("marks the host only after the render resolves, and clears it on unmount", async () => {
		const pending = deferred<() => void>();
		const dispose = vi.fn();
		let mountNode: HTMLDivElement | null = null;
		const host = await mount(mountTarget => {
			mountNode = mountTarget;
			return pending.promise;
		});
		expect(host.shadowRoot?.childNodes.length).toBe(1);
		expect(host.shadowRoot?.firstChild).toBe(mountNode);
		expect(host.hasAttribute("data-rendered")).toBe(false);

		pending.resolve(dispose);
		await waitFor(() => host.getAttribute("data-rendered") === "true");
		expect(host.getAttribute("data-rendered")).toBe("true");

		await unmount();
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(host.hasAttribute("data-rendered")).toBe(false);
		expect(host.shadowRoot?.childNodes.length).toBe(0);
	});

	it("leaves the host unmarked when the render rejects", async () => {
		const pending = deferred<() => void>();
		const host = await mount(() => pending.promise);
		pending.reject(new Error("broken document"));
		await waitFor(() => false, 50);
		expect(host.hasAttribute("data-rendered")).toBe(false);
	});

	it("disposes the previous render and starts afresh when its deps change", async () => {
		const first = vi.fn();
		const second = vi.fn();
		const render = vi.fn<Render>(async () => first);
		const host = await mount(render, 1);
		await waitFor(() => host.getAttribute("data-rendered") === "true");

		render.mockImplementation(async () => second);
		await rerender(render, 2);
		expect(first).toHaveBeenCalledTimes(1);
		await waitFor(() => host.getAttribute("data-rendered") === "true");
		expect(render).toHaveBeenCalledTimes(2);
		expect(host.shadowRoot?.childNodes.length).toBe(1);
		expect(second).not.toHaveBeenCalled();
	});

	it("routes link clicks inside the shadow root to the system opener", async () => {
		let mountNode: HTMLDivElement | null = null;
		await mount(async mountTarget => {
			mountNode = mountTarget;
			return () => {};
		});
		const link = document.createElement("a");
		link.setAttribute("href", "https://example.com/doc");
		(mountNode as HTMLDivElement | null)?.appendChild(link as never);
		const event = new Event("click", { bubbles: true, cancelable: true });
		link.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(openExternal).toHaveBeenCalledWith("https://example.com/doc");
	});
});
