/**
 * The quick-entry rules that need no Electron: where the bar goes, what a
 * submit may carry, which macOS chords the bar swallows, and the per-window
 * prompt queue. Main owns a prompt until its chat window acknowledges it, so
 * every queue transition is pure and returns new state; src/main/quick-entry.ts
 * applies them.
 */

import type { QuickEntryFailure, QuickEntryPrompt, QuickEntryReturned, QuickEntryTarget } from "../shared/ipc-types";
import type { Rect } from "./window-bounds";

export const QUICK_ENTRY_MAX_CHARS = 100_000;
export const QUICK_ENTRY_SIZE = { width: 680, height: 168 } as const;
/** Recent workspaces offered besides Work. */
export const QUICK_ENTRY_WORKSPACE_LIMIT = 9;

/** Centred horizontally, its top edge at 30% of the work area, never off it. */
export function quickEntryBounds(workArea: Rect, size: { width: number; height: number }): Rect {
	const width = Math.min(size.width, workArea.width);
	const height = Math.min(size.height, workArea.height);
	return {
		x: workArea.x + Math.round((workArea.width - width) / 2),
		y: workArea.y + Math.min(Math.round(workArea.height * 0.3), workArea.height - height),
		width,
		height,
	};
}

/** A well-formed target, rebuilt so no extra field from the sender survives. */
export function parseTarget(value: unknown): QuickEntryTarget | null {
	if (typeof value !== "object" || value === null) return null;
	const { kind, cwd } = value as { kind?: unknown; cwd?: unknown };
	if (kind === "chat" || kind === "work") return { kind };
	if (kind === "workspace" && typeof cwd === "string" && cwd.length > 0) return { kind, cwd };
	return null;
}

export type SubmitValidation =
	| { ok: true; text: string; target: QuickEntryTarget }
	| { ok: false; reason: Extract<QuickEntryFailure, "invalid" | "workspace-missing"> };

/**
 * Main re-checks everything the bar sends: trimmed text of 1 to
 * QUICK_ENTRY_MAX_CHARS characters, a known target, and a workspace that was
 * offered for this show and still exists. A crafted cwd therefore cannot open
 * an arbitrary directory as an agent workspace.
 */
export function validateSubmit(
	payload: unknown,
	offeredCwds: ReadonlySet<string>,
	isDirectory: (path: string) => boolean,
): SubmitValidation {
	if (typeof payload !== "object" || payload === null) return { ok: false, reason: "invalid" };
	const { text, target } = payload as { text?: unknown; target?: unknown };
	if (typeof text !== "string") return { ok: false, reason: "invalid" };
	const trimmed = text.trim();
	if (trimmed.length === 0 || trimmed.length > QUICK_ENTRY_MAX_CHARS) return { ok: false, reason: "invalid" };
	const parsed = parseTarget(target);
	if (!parsed) return { ok: false, reason: "invalid" };
	if (parsed.kind === "workspace" && !(offeredCwds.has(parsed.cwd) && isDirectory(parsed.cwd))) {
		return { ok: false, reason: "workspace-missing" };
	}
	return { ok: true, text: trimmed, target: parsed };
}

/** The remembered target, unless it is malformed or names a workspace no longer offered. */
export function resolveInitialTarget(saved: unknown, offeredCwds: ReadonlySet<string>): QuickEntryTarget {
	const target = parseTarget(saved);
	if (!target || (target.kind === "workspace" && !offeredCwds.has(target.cwd))) return { kind: "chat" };
	return target;
}

/** The parts of Electron's before-input-event Input the chord guard reads. */
export interface MenuChordInput {
	type: string;
	key: string;
	meta: boolean;
}

/**
 * Editing and caret chords the bar's text field needs (undo and redo, copy,
 * cut, paste, select all, line and word navigation and deletion), plus ⌘Q.
 */
const MAC_BAR_CHORDS = new Set([
	"a",
	"c",
	"v",
	"x",
	"z",
	"q",
	"arrowleft",
	"arrowright",
	"arrowup",
	"arrowdown",
	"backspace",
	"delete",
]);

/**
 * macOS dispatches application-menu key equivalents while the bar is key, and
 * the menu targets the main window: ⌘W from the bar would close it. The bar
 * swallows every other ⌘ chord. Windows and Linux bars have no menu.
 */
export function isBlockedMenuChord(platform: NodeJS.Platform, input: MenuChordInput): boolean {
	if (platform !== "darwin" || input.type !== "keyDown" || !input.meta) return false;
	return !MAC_BAR_CHORDS.has(input.key.toLowerCase());
}

/** One chat window's prompts: queued for it, then leased to its renderer until acknowledged. */
export interface WindowQueue {
	readonly pending: readonly QuickEntryPrompt[];
	readonly leased: readonly QuickEntryPrompt[];
}

/** Keyed by the chat window's webContents id. */
export type QuickEntryQueue = ReadonlyMap<number, WindowQueue>;

function withWindow(queue: QuickEntryQueue, windowId: number, next: WindowQueue): QuickEntryQueue {
	const copy = new Map(queue);
	if (next.pending.length === 0 && next.leased.length === 0) copy.delete(windowId);
	else copy.set(windowId, next);
	return copy;
}

function windowQueue(queue: QuickEntryQueue, windowId: number): WindowQueue {
	return queue.get(windowId) ?? { pending: [], leased: [] };
}

export function enqueue(queue: QuickEntryQueue, windowId: number, prompt: QuickEntryPrompt): QuickEntryQueue {
	const current = windowQueue(queue, windowId);
	return withWindow(queue, windowId, { ...current, pending: [...current.pending, prompt] });
}

/**
 * Lease the window's pending prompts to its renderer. They stay in main until
 * acknowledged; the result holds only the prompts leased by this call, so a
 * prompt is handed out once per lease.
 */
export function claim(
	queue: QuickEntryQueue,
	windowId: number,
): { queue: QuickEntryQueue; claimed: QuickEntryPrompt[] } {
	const current = windowQueue(queue, windowId);
	const claimed = [...current.pending];
	if (claimed.length === 0) return { queue, claimed };
	return { queue: withWindow(queue, windowId, { pending: [], leased: [...current.leased, ...claimed] }), claimed };
}

/** The prompt reached its tab's composer: main forgets it. */
export function ack(queue: QuickEntryQueue, windowId: number, id: string): QuickEntryQueue {
	const current = queue.get(windowId);
	if (!current) return queue;
	return withWindow(queue, windowId, { ...current, leased: current.leased.filter(prompt => prompt.id !== id) });
}

/** The renderer reloaded: its leases go back to pending, ahead of newer prompts, for the boot drain. */
export function releaseLeases(queue: QuickEntryQueue, windowId: number): QuickEntryQueue {
	const current = queue.get(windowId);
	if (!current || current.leased.length === 0) return queue;
	return withWindow(queue, windowId, { pending: [...current.leased, ...current.pending], leased: [] });
}

/**
 * The renderer gave a leased prompt back. Main's own copy is returned, so the
 * restore list never carries text the chat window rewrote.
 */
export function returnPrompt(
	queue: QuickEntryQueue,
	windowId: number,
	id: string,
	reason: QuickEntryFailure,
): { queue: QuickEntryQueue; returned: QuickEntryReturned | null } {
	const current = queue.get(windowId);
	const prompt = current?.leased.find(entry => entry.id === id);
	if (!current || !prompt) return { queue, returned: null };
	return {
		queue: withWindow(queue, windowId, { ...current, leased: current.leased.filter(entry => entry.id !== id) }),
		returned: { ...prompt, reason },
	};
}

/** The window closed: every prompt it still held goes back to the bar, one entry each, oldest first. */
export function closeWindow(
	queue: QuickEntryQueue,
	windowId: number,
): { queue: QuickEntryQueue; returned: QuickEntryReturned[] } {
	const current = queue.get(windowId);
	if (!current) return { queue, returned: [] };
	const returned = [...current.leased, ...current.pending].map(prompt => ({
		...prompt,
		reason: "interrupted" as const,
	}));
	return { queue: withWindow(queue, windowId, { pending: [], leased: [] }), returned };
}

/** The bar took a restored prompt into its draft; it is listed exactly once. */
export function consumeRestored(restored: readonly QuickEntryReturned[], id: string): QuickEntryReturned[] {
	return restored.filter(entry => entry.id !== id);
}
