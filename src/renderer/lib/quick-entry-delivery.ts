/**
 * Delivers quick-entry prompts in a chat window. Main queues each accepted
 * prompt for this window and nudges it; the drain claims the queue, opens one
 * new tab per prompt, and hands the text to that tab's composer, which sends
 * it once the tab is ready (InputArea). Prompts go one at a time because only
 * the visible tab mounts a composer: the next tab opens after the previous
 * prompt was handed off, its tab closed, or the ceiling passed.
 */

import type { StoreApi } from "zustand";
import type { QuickEntryFailure, QuickEntryPrompt, QuickEntryTarget } from "../../shared/ipc-types";
import type { ComposerStore } from "../stores/composer";
import { sessionRuntimeStore } from "../stores/session-runtime-context";
import { type OpenTabFailure, useTabsStore } from "../stores/tabs";
import { toast } from "../stores/toast";
import { translate } from "./i18n";
import { reportRuntimeError } from "./runtime-errors";

/** How long a new tab may take to become ready before its prompt is left in its composer. */
export const QUICK_ENTRY_HANDOFF_CEILING_MS = 60_000;

/**
 * The openTab arguments each target already uses elsewhere (Work, workspace).
 * Every prompt opens a task tab: a chat target, which older builds still
 * send, opens a Work task like the sidebar's New task button.
 */
export function quickEntryTabArgs(
	target: QuickEntryTarget,
): { kind: "agent"; work: true } | { kind: "agent"; cwd: string } {
	switch (target.kind) {
		case "chat":
		case "work":
			return { kind: "agent", work: true };
		case "workspace":
			return { kind: "agent", cwd: target.cwd };
	}
}

/** Resolves once boot reconciliation has settled, so GET_TABS cannot re-select the old tab. */
export function whenTabsReconciled(): Promise<void> {
	if (useTabsStore.getState().reconciled) return Promise.resolve();
	return new Promise(resolve => {
		const unsubscribe = useTabsStore.subscribe(state => {
			if (!state.reconciled) return;
			unsubscribe();
			resolve();
		});
	});
}

let draining: Promise<void> | null = null;
let nudgedWhileDraining = false;

/**
 * Claim and deliver everything main queued for this window. Single-flight: a
 * nudge during a drain only makes the running one claim again before it ends.
 */
export function drainQuickEntry(): Promise<void> {
	if (draining) {
		nudgedWhileDraining = true;
		return draining;
	}
	draining = (async () => {
		try {
			await whenTabsReconciled();
			do {
				nudgedWhileDraining = false;
				for (;;) {
					const prompts = await window.omp.quickEntry.claimPending();
					if (prompts.length === 0) break;
					for (const prompt of prompts) await deliver(prompt);
				}
			} while (nudgedWhileDraining);
		} catch (error) {
			reportRuntimeError("quick-entry", error);
		} finally {
			draining = null;
		}
	})();
	return draining;
}

async function deliver(prompt: QuickEntryPrompt): Promise<void> {
	const failure: { reason: OpenTabFailure | null } = { reason: null };
	const tabId = await useTabsStore.getState().openTab(quickEntryTabArgs(prompt.target), {
		onFailure: reason => {
			failure.reason = reason;
		},
	});
	const composer = tabId ? sessionRuntimeStore<ComposerStore>(tabId, "composer") : null;
	if (!tabId || !composer) {
		await returnToBar(prompt, failure.reason === "cap" ? "tab-cap" : "tab-failed");
		return;
	}
	composer.getState().queueAutoSubmit({ id: prompt.id, text: prompt.text });
	const outcome = await handoff(tabId, composer, prompt.id);
	if (outcome === "closed" || outcome === "reset") {
		await returnToBar(prompt, "interrupted");
	} else if (outcome === "timeout") {
		// Never sent silently later: the text stays visible in that tab's composer.
		composer.getState().clearAutoSubmit();
		await window.omp.quickEntry.ack(prompt.id);
		toast({ variant: "warning", message: translate("quickEntry.toast.leftInTab") });
	}
}

type HandoffOutcome = "handed-off" | "reset" | "closed" | "timeout";

/**
 * InputArea took the prompt (sent it, or kept the text, and acknowledged), a
 * new session reset the composer and dropped the text, the tab closed, or
 * time ran out.
 */
function handoff(tabId: string, composer: StoreApi<ComposerStore>, promptId: string): Promise<HandoffOutcome> {
	const tabOpen = () => useTabsStore.getState().tabs.some(tab => tab.id === tabId);
	return new Promise(resolve => {
		let settled = false;
		const finish = (outcome: HandoffOutcome) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribeComposer();
			unsubscribeTabs();
			resolve(outcome);
		};
		const timer = setTimeout(() => finish("timeout"), QUICK_ENTRY_HANDOFF_CEILING_MS);
		const settle = (state: ComposerStore) => {
			if (state.autoSubmit === null) finish(state.handedOff === promptId ? "handed-off" : "reset");
		};
		const unsubscribeComposer = composer.subscribe(settle);
		const unsubscribeTabs = useTabsStore.subscribe(() => {
			if (!tabOpen()) finish("closed");
		});
		if (!tabOpen()) finish("closed");
		else settle(composer.getState());
	});
}

/** Main puts the prompt in the bar's restore list; the bar never opens by itself. */
async function returnToBar(prompt: QuickEntryPrompt, reason: QuickEntryFailure): Promise<void> {
	await window.omp.quickEntry.returnToBar(prompt, reason);
	toast({ variant: "warning", message: translate("quickEntry.toast.returned") });
}
