import { useTabRpc } from "../../lib/tab-rpc";
/**
 * Model picker: one searchable list of the local Ollama models, current model
 * highlighted. Selection calls set_model. Ollama needs no sign-in, so the list
 * carries no provider headers or account state.
 */

import { Check, Cpu, Search, TriangleAlert } from "lucide-react";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import type { ModelInfo } from "../../../shared/rpc-types";
import { applyModelInfo, hydrateSession } from "../../hooks/use-rpc-events";
import { formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { availableFilters, filterModels, type ModelFilter } from "../../lib/model-filters";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Badge, Button, Modal, Spinner, Tag } from "../common";

const FILTER_LABEL_KEYS: Record<ModelFilter, string> = {
	all: "modelPicker.filter.all",
	reasoning: "modelPicker.filter.reasoning",
};

const TILE = "flex size-7 shrink-0 items-center justify-center rounded-[22%]";
const TILE_CURRENT = `${TILE} bg-[linear-gradient(135deg,var(--omp-brand),var(--omp-btn-primary-bg))] text-(--omp-btn-primary-text)`;
const TILE_OTHER = `${TILE} border border-(--omp-border-muted) bg-(--omp-bg-secondary) text-(--omp-muted)`; // surface-ok: model tile

export function ModelPicker() {
	const tabRpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const t = useT();
	const open = useUiStore(state => state.modelPickerOpen);
	const close = useUiStore(state => state.closeModelPicker);
	const availableModels = useModelStore(state => state.availableModels);
	const current = useModelStore(state => state.model);
	const refreshAvailableModels = useModelStore(state => state.refreshAvailableModels);
	const openProviders = useUiStore(state => state.openProviders);
	// Live session usage: models whose window is smaller render with an
	// over-context warning and compact-first on pick (TUI markOverContext parity).
	const contextUsage = useSessionStore(state => state.contextUsage);
	const sidecarReady = useSessionStore(state => state.status) === "ready";

	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<ModelFilter>("all");
	const [switching, setSwitching] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [activeIndex, setActiveIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const listboxId = useId();

	const requestVersion = useRef(0);

	/** The model list is shared catalog state: it commits through the store's
	 * generation guard (which also drops every provider the GUI does not offer),
	 * so a `model_catalog_update` that lands mid-read can never be reverted by
	 * this response. `forceRefresh` belongs to the retry path, where the user is
	 * disputing what the list shows. */
	const load = useCallback(
		async (forceRefresh: boolean, failedCopy?: string): Promise<void> => {
			const version = ++requestVersion.current;
			setLoading(true);
			setError(null);
			if (!sidecarReady) {
				setError(t("modelPicker.notConnected"));
				setLoading(false);
				return;
			}
			try {
				await refreshAvailableModels(forceRefresh);
				if (version !== requestVersion.current) return;
				setLoading(false);
			} catch (cause) {
				if (version !== requestVersion.current) return;
				setLoading(false);
				const reason = cause instanceof Error ? cause.message : String(cause);
				setError(failedCopy ?? (reason || t("modelPicker.notResponding")));
			}
		},
		[refreshAvailableModels, sidecarReady, t],
	);

	useEffect(() => {
		if (!open) return undefined;
		setQuery("");
		setFilter("all");
		setActiveIndex(0);
		requestAnimationFrame(() => inputRef.current?.focus());
		void load(false);
		return () => {
			requestVersion.current++;
		};
	}, [open, load]);

	const filters = useMemo(() => availableFilters(availableModels), [availableModels]);
	// A catalog refresh can drop the last reasoning model; fall back to All
	// instead of filtering on a tag that is no longer offered.
	const activeFilter: ModelFilter = filters.includes(filter) ? filter : "all";
	useEffect(() => {
		if (activeFilter !== filter) setFilter(activeFilter);
	}, [activeFilter, filter]);

	const visibleModels = useMemo(
		() => filterModels(availableModels, { query, filter: activeFilter }),
		[activeFilter, availableModels, query],
	);

	// Row order for keyboard navigation is the catalog order.
	const flatOptions = useMemo(
		() =>
			visibleModels.map(model => ({
				provider: model.provider,
				modelId: model.id,
				key: `${model.provider}/${model.id}`,
			})),
		[visibleModels],
	);

	// Clamp the highlight when the visible list shrinks (search, reload).
	useEffect(() => {
		setActiveIndex(index => Math.min(index, Math.max(0, flatOptions.length - 1)));
	}, [flatOptions.length]);

	useEffect(() => {
		listRef.current?.querySelector(`[data-option-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);

	const isOverContext = (model: ModelInfo): boolean => {
		const tokens = contextUsage?.tokens ?? 0;
		const contextWindow = model.contextWindow ?? 0;
		return tokens > 0 && contextWindow > 0 && tokens > contextWindow;
	};

	const select = async (provider: string, modelId: string) => {
		if (!sidecarReady) return;
		const key = `${provider}/${modelId}`;
		setSwitching(key);
		try {
			// TUI parity: picking a model whose context window is smaller than the
			// live session usage compacts with the CURRENT model first, then
			// switches. The row carries the over-context warning before the pick.
			const target = availableModels.find(m => m.provider === provider && m.id === modelId);
			const overContext = target !== undefined && isOverContext(target);
			if (overContext) {
				const compactRes = await tabRpc.compact();
				if (!compactRes.success) {
					toast({ variant: "error", title: t("modelPicker.compactFailed"), message: compactRes.error });
					return;
				}
				toast({ variant: "info", message: t("modelPicker.compactedSwitching") });
			}
			const response = await tabRpc.setModel(provider, modelId);
			if (!response.success) {
				toast({ variant: "error", title: t("modelPicker.failed"), message: response.error });
				return;
			}
			// The response carries the sidecar's live model. Applying it here covers
			// the switch that emits no model_changed at all — re-picking the current
			// model is a server-side no-op, so the event channel can never heal a
			// stale label.
			if (tabId) applyModelInfo(response.data, tabId);
			// Compaction rewrote the transcript — rehydrate so the chat and the
			// context bar reflect the compacted session, not just the new model.
			if (overContext) await hydrateSession();
			close();
		} catch (cause) {
			toast({ variant: "error", title: t("modelPicker.failed"), message: String(cause) });
		} finally {
			setSwitching(null);
		}
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		if (isImeKeyEvent(event)) return;
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				setActiveIndex(index => Math.min(index + 1, flatOptions.length - 1));
				break;
			case "ArrowUp":
				event.preventDefault();
				setActiveIndex(index => Math.max(index - 1, 0));
				break;
			case "Home":
				event.preventDefault();
				setActiveIndex(0);
				break;
			case "End":
				event.preventDefault();
				setActiveIndex(Math.max(0, flatOptions.length - 1));
				break;
			case "Enter": {
				event.preventDefault();
				const option = flatOptions[activeIndex];
				if (option) void select(option.provider, option.modelId);
				break;
			}
		}
	};

	// role="listbox" only when option rows actually render (loading / error /
	// empty states are plain status blocks, not listbox children).
	const showOptions = !error && !loading && visibleModels.length > 0;
	const openOllama = () => {
		close();
		openProviders();
	};

	return (
		<Modal
			ariaLabel={t("modelPicker.searchLabel")}
			bodyClassName="flex flex-col p-0"
			chromeless
			onClose={close}
			open={open}
			placement="top"
			size="picker"
		>
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="flex shrink-0 flex-col gap-2.5 border-b border-(--omp-border-muted) px-3.5 py-2.5">
					<div className="flex items-center gap-2.5">
						<Search className="shrink-0 text-(--omp-dim)" size={14} />
						<input
							aria-activedescendant={flatOptions.length > 0 ? `${listboxId}-option-${activeIndex}` : undefined}
							aria-controls={listboxId}
							aria-label={t("modelPicker.searchLabel")}
							className="min-w-0 flex-1 bg-transparent text-sm text-(--omp-text) placeholder:text-(--omp-dim) focus:outline-none"
							onChange={event => setQuery(event.target.value)}
							onKeyDown={onKeyDown}
							placeholder={t("modelPicker.placeholder")}
							ref={inputRef}
							value={query}
						/>
						<kbd className="omp-kbd shrink-0 font-medium text-(--omp-muted)">esc</kbd>
					</div>
					<div className="flex items-center gap-2">
						{filters.length > 1 && (
							<div aria-label={t("modelPicker.filter.aria")} className="flex flex-wrap gap-2" role="group">
								{filters.map(value => (
									<Tag key={value} onClick={() => setFilter(value)} selected={value === activeFilter}>
										{t(FILTER_LABEL_KEYS[value])}
									</Tag>
								))}
							</div>
						)}
						{!loading && !error && (
							<span className="ml-auto shrink-0 font-mono text-omp-sm text-(--omp-muted)">
								{t("modelPicker.count", {
									count: flatOptions.length,
									plural: flatOptions.length === 1 ? "" : "s",
								})}
							</span>
						)}
					</div>
				</div>
				<div
					className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-2"
					id={listboxId}
					ref={listRef}
					role={showOptions ? "listbox" : undefined}
				>
					{error ? (
						<div className="flex flex-col items-center gap-3 py-10">
							<span className="text-xs text-[var(--omp-error)]">{error}</span>
							<span className="text-omp-xs text-[var(--omp-dim)]">{t("modelPicker.notRespondingHint")}</span>
							<button
								type="button"
								className="rounded-md border border-[var(--omp-border-muted)] px-3 py-1 text-omp-sm font-medium text-[var(--omp-text)] hover:bg-[var(--omp-selected-bg)]"
								onClick={() => void load(true, t("modelPicker.stillNotResponding"))}
								disabled={!sidecarReady}
								title={!sidecarReady ? t("modelPicker.notConnected") : undefined}
							>
								{t("modelPicker.retry")}
							</button>
						</div>
					) : loading ? (
						<div className="flex items-center justify-center gap-2 py-10">
							<Spinner size="sm" />
							<span className="text-xs text-(--omp-dim)">{t("modelPicker.loading")}</span>
						</div>
					) : availableModels.length === 0 ? (
						<div className="flex flex-col items-center gap-3 py-10" data-model-picker-empty>
							<span className="text-xs text-(--omp-dim)">{t("modelPicker.emptyLocal")}</span>
							<Button onClick={openOllama} size="sm" variant="secondary">
								{t("modelPicker.openOllama")}
							</Button>
						</div>
					) : visibleModels.length === 0 ? (
						<div className="py-10 text-center text-xs text-(--omp-dim)">
							{query.trim().length > 0
								? t("modelPicker.noMatch", { query })
								: t("modelPicker.count", { count: 0, plural: "s" })}
						</div>
					) : (
						visibleModels.map((model, optionIndex) => {
							const isCurrent = current?.provider === model.provider && current.id === model.id;
							const key = `${model.provider}/${model.id}`;
							const isActive = optionIndex === activeIndex;
							const over = !isCurrent && isOverContext(model);
							return (
								<button
									aria-selected={isCurrent}
									className={`flex min-h-[58px] w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors ${
										isActive ? "bg-(--omp-selected-bg)" : "hover:bg-(--omp-bg-tertiary)"
									}`}
									data-option-index={optionIndex}
									disabled={switching !== null || !sidecarReady}
									title={!sidecarReady ? t("modelPicker.notConnected") : undefined}
									id={`${listboxId}-option-${optionIndex}`}
									key={key}
									onClick={() => void select(model.provider, model.id)}
									onMouseEnter={() => setActiveIndex(optionIndex)}
									role="option"
									type="button"
								>
									<span aria-hidden="true" className={isCurrent ? TILE_CURRENT : TILE_OTHER}>
										<Cpu size={15} />
									</span>
									<div className="flex min-w-0 flex-1 flex-col gap-0.5">
										<div className="flex min-w-0 items-center gap-2">
											<span
												className={`truncate text-omp-lg font-semibold ${isCurrent ? "text-(--omp-accent)" : over ? "text-(--omp-dim)" : "text-(--omp-text)"}`}
											>
												{model.name || model.id}
											</span>
											{model.isRecommended && (
												<Badge className="px-1.5 text-omp-xxs leading-3" variant="success">
													{t("modelPicker.badge.recommended")}
												</Badge>
											)}
											{model.isNew && (
												<Badge className="px-1.5 text-omp-xxs leading-3" variant="info">
													{t("modelPicker.badge.new")}
												</Badge>
											)}
											{model.isBeta && (
												<Badge className="px-1.5 text-omp-xxs leading-3" variant="warning">
													{t("modelPicker.badge.beta")}
												</Badge>
											)}
										</div>
										{((model.name && model.name !== model.id) || model.description) && (
											<span className="truncate text-omp-sm text-(--omp-muted)" title={model.description}>
												{[model.name && model.name !== model.id ? model.id : null, model.description]
													.filter(Boolean)
													.join(" · ")}
											</span>
										)}
									</div>
									{model.int != null && Number.isFinite(model.int) && (
										<span className="shrink-0 font-mono text-omp-sm text-(--omp-muted)">
											{t("modelPicker.intelligence", { value: Math.round(model.int) })}
										</span>
									)}
									{model.tps != null && Number.isFinite(model.tps) && model.tps > 0 && (
										<span className="shrink-0 font-mono text-omp-sm font-medium text-(--omp-text)">
											{t("modelPicker.speed", {
												value: model.tps >= 10 ? Math.round(model.tps) : model.tps.toFixed(1),
											})}
										</span>
									)}
									{over && (
										<span
											className="flex shrink-0 items-center gap-1 text-(--omp-warning)"
											title={t("modelPicker.overContextHint", {
												current: formatTokens(contextUsage?.tokens),
												limit: formatTokens(model.contextWindow),
											})}
										>
											<TriangleAlert size={12} />
											<span className="text-omp-xxs font-medium">{t("modelPicker.overContext")}</span>
										</span>
									)}
									{switching === key && <Spinner size="sm" />}
									{isCurrent && <Check className="shrink-0 text-(--omp-accent)" size={16} />}
								</button>
							);
						})
					)}
				</div>
				<div
					className="flex shrink-0 items-center gap-2 border-t border-(--omp-border-muted) bg-(--omp-bg-secondary) py-2.5 pr-3 pl-4" // surface-ok: sunken picker footer
					data-model-picker-footer
				>
					<span className="min-w-0 flex-1 text-omp-sm text-(--omp-muted)">{t("modelPicker.footer.hint")}</span>
					<Button onClick={openOllama} size="sm" variant="secondary">
						{t("modelPicker.openOllama")}
					</Button>
				</div>
			</div>
		</Modal>
	);
}
