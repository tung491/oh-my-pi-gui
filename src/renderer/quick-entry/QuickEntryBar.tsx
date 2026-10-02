/**
 * The quick-entry bar's page. Type, pick Chat or an Agent workspace, press
 * Enter (or Send): main queues the prompt for a new tab in the main window and hides the
 * bar. A prompt that never reached a tab comes back here on the next summon.
 * Plain text only: the page has no markdown or HTML sink.
 */

import { type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
	QuickEntryBarApi,
	QuickEntryBarState,
	QuickEntryFailure,
	QuickEntryTarget,
	QuickEntryWorkspace,
} from "../../shared/ipc-types";
import { Button } from "../components/common/Button";
import { TextArea } from "../components/common/Input";
import { SegmentedControl } from "../components/common/SegmentedControl";
import { basename } from "../lib/format";
import { useLang, useT } from "../lib/i18n";
import { isImeKeyEvent } from "../lib/ime";
import { onEscape } from "../lib/keymap";
import { applyScheme } from "./appearance";

const ERROR_KEYS: Record<QuickEntryFailure, string> = {
	"tab-cap": "tabs.parallelCap",
	"no-window": "quickEntry.error.noWindow",
	"workspace-missing": "quickEntry.error.workspaceMissing",
	"tab-failed": "quickEntry.error.tabFailed",
	interrupted: "quickEntry.error.interrupted",
	invalid: "quickEntry.error.invalid",
};

/** The select's value for Work, which is not a path. */
const WORK_VALUE = "";

/** An unsent message waiting to come back into the draft. */
interface RestoreEntry {
	id: string;
	text: string;
	target: QuickEntryTarget;
	reason: QuickEntryFailure | null;
	/** Main's restore list holds it, so taking it must be reported. */
	fromMain: boolean;
}

export function QuickEntryBar({ api }: { api: QuickEntryBarApi }) {
	const t = useT();
	const { lang, setLang } = useLang();
	const [state, setState] = useState<QuickEntryBarState | null>(null);
	const [draft, setDraft] = useState("");
	const [target, setTarget] = useState<QuickEntryTarget>({ kind: "chat" });
	const [error, setError] = useState<QuickEntryFailure | null>(null);
	const [busy, setBusy] = useState(false);
	/** Drafts the user swapped out for a restored message; only this page holds them. */
	const [swappedOut, setSwappedOut] = useState<RestoreEntry[]>([]);
	const [focusTick, setFocusTick] = useState(0);
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const draftRef = useRef(draft);
	draftRef.current = draft;
	const seenShowId = useRef<number | null>(null);
	/** Restored ids already taken into the draft; main may still list them in a replayed state. */
	const taken = useRef(new Set<string>());

	useEffect(() => api.onState(setState), [api]);

	const fromMain: RestoreEntry[] = (state?.restored ?? [])
		.filter(entry => !taken.current.has(entry.id))
		.map(entry => ({ ...entry, fromMain: true }));
	const restoreList = [...fromMain, ...swappedOut];

	const take = useCallback(
		(entry: RestoreEntry) => {
			if (entry.fromMain) {
				taken.current.add(entry.id);
				api.consumeRestored(entry.id);
			} else {
				setSwappedOut(list => list.filter(item => item.id !== entry.id));
			}
			setDraft(entry.text);
			setTarget(entry.target);
			setError(entry.reason);
			setFocusTick(tick => tick + 1);
		},
		[api],
	);

	useEffect(() => {
		if (!state) return;
		if (state.language !== lang) setLang(state.language);
		const newShow = state.showId !== seenShowId.current;
		if (newShow) {
			seenShowId.current = state.showId;
			applyScheme();
			// A kept draft keeps the target it was written for.
			if (draftRef.current.trim() === "") setTarget(state.target);
			setError(null);
			setFocusTick(tick => tick + 1);
		}
		const next = state.restored.find(entry => !taken.current.has(entry.id));
		if (next && draftRef.current.trim() === "") take({ ...next, fromMain: true });
	}, [state, lang, setLang, take]);

	useLayoutEffect(() => {
		if (focusTick === 0) return;
		const input = inputRef.current;
		if (!input) return;
		input.focus();
		input.setSelectionRange(input.value.length, input.value.length);
	}, [focusTick]);

	const submit = async () => {
		const text = draft.trim();
		if (!text || busy) return;
		setBusy(true);
		try {
			const result = await api.submit({ text, target });
			if (result.ok) {
				setDraft("");
				setError(null);
			} else {
				setError(result.reason);
			}
		} catch {
			setError("no-window");
		} finally {
			setBusy(false);
		}
	};

	const swapInRestored = () => {
		const [next] = restoreList;
		if (!next) return;
		if (draft.trim()) {
			const replaced: RestoreEntry = {
				id: `draft-${Date.now()}`,
				text: draft,
				target,
				reason: null,
				fromMain: false,
			};
			setSwappedOut(list => [...list, replaced]);
		}
		take(next);
	};

	const onInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (isImeKeyEvent(event)) return;
		if (event.key !== "Enter" || event.shiftKey) return;
		event.preventDefault();
		void submit();
	};

	const workspaces = state?.workspaces ?? [];
	const listed: QuickEntryWorkspace[] =
		target.kind === "workspace" && !workspaces.some(workspace => workspace.cwd === target.cwd)
			? [...workspaces, { cwd: target.cwd, name: basename(target.cwd) || target.cwd }]
			: workspaces;
	const errorKey = error ? ERROR_KEYS[error] : null;

	return (
		<div
			className="flex h-screen flex-col gap-2 overflow-hidden p-3 text-(--omp-text)"
			onKeyDown={event => onEscape(event, api.dismiss)}
		>
			<TextArea
				aria-label={t("quickEntry.title")}
				onChange={event => setDraft(event.target.value)}
				onKeyDown={onInputKeyDown}
				placeholder={t("quickEntry.placeholder")}
				ref={inputRef}
				rows={3}
				value={draft}
			/>
			<div className="flex min-w-0 items-center gap-2">
				<SegmentedControl
					ariaLabel={t("quickEntry.target.aria")}
					onChange={value =>
						setTarget(current =>
							value === "chat" ? { kind: "chat" } : current.kind === "chat" ? { kind: "work" } : current,
						)
					}
					options={[
						{ value: "chat", label: t("quickEntry.target.chat") },
						{ value: "agent", label: t("quickEntry.target.agent") },
					]}
					value={target.kind === "chat" ? "chat" : "agent"}
				/>
				{target.kind !== "chat" && (
					<select
						aria-label={t("quickEntry.workspace.aria")}
						className="min-w-0 max-w-56 truncate rounded-md border border-(--omp-border) bg-(--omp-input-bg) px-2 py-1 text-omp-md text-(--omp-text)"
						onChange={event =>
							setTarget(
								event.target.value === WORK_VALUE
									? { kind: "work" }
									: { kind: "workspace", cwd: event.target.value },
							)
						}
						value={target.kind === "workspace" ? target.cwd : WORK_VALUE}
					>
						<option value={WORK_VALUE}>{t("sidebar.mode.work")}</option>
						{listed.map(workspace => (
							<option key={workspace.cwd} title={workspace.cwd} value={workspace.cwd}>
								{workspace.name}
							</option>
						))}
					</select>
				)}
				{restoreList.length > 0 && (
					<button
						className="shrink-0 rounded-md px-2 py-1 text-omp-md text-(--omp-accent) hover:bg-(--omp-accent-dim)"
						onClick={swapInRestored}
						type="button"
					>
						{t("quickEntry.restore", { count: restoreList.length })}
					</button>
				)}
				{errorKey ? (
					<span className="min-w-0 flex-1 truncate text-right text-omp-md text-(--omp-error)" role="alert">
						{t(errorKey)}
					</span>
				) : (
					<span className="min-w-0 flex-1 truncate text-right text-omp-sm text-(--omp-dim)">
						{t("quickEntry.hint")}
					</span>
				)}
				<Button
					aria-keyshortcuts="Enter"
					className="shrink-0"
					disabled={draft.trim() === ""}
					loading={busy}
					onClick={() => void submit()}
					size="sm"
					variant="primary"
				>
					{t("input.sendLabel")}
				</Button>
			</div>
		</div>
	);
}
