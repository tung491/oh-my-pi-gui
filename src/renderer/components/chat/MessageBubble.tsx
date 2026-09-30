import { Archive, Bot, Check, Copy, FileText, GitBranch, RotateCcw, Terminal, User } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useEffect, useRef, useState } from "react";
import type { AgentMessage, ImageContent, MessageContent, ToolCallContent } from "../../../shared/rpc-types";
import { AnsiText, hasAnsi } from "../../lib/ansi";
import { copyText, cx, formatClock, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import { forkSessionFromMessageInNewTab, isRenderableMessageText, retryLastTurn } from "../../lib/messages";
import { extractModelMentions, type ModelMentionChip } from "../../lib/model-mentions";
import { PREVIEW_SCROLL_LG } from "../../lib/preview";
import { useTabRpc } from "../../lib/tab-rpc";
import { useSessionStore } from "../../stores/session";
import { useRuntimeTabId, withSessionRuntime } from "../../stores/session-runtime-context";
import { toast } from "../../stores/toast";
import { toolEntryKey } from "../../stores/tools";
import { IconButton, SaiAtlasLogo } from "../common";
import { type RunningIndicator, ToolCard } from "../tools/ToolCard";
import { CustomMessageCard, isCustomMessageCardType } from "./CustomMessageCard";
import { ThinkingBlock } from "./ThinkingBlock";
import { UsageRow } from "./UsageRow";

export interface MessageBubbleProps {
	message: AgentMessage;
	/** Suppress per-message footer/padding inside an expanded Process group. */
	compact?: boolean;
	/** The timeline or process group can own the one animated running state. */
	runningIndicator?: RunningIndicator;
	/** Opening assistant emoji projected onto this user turn. */
	reaction?: string;
	/** The pane's last finished assistant turn: offer Retry (re-send the last user message). */
	retryable?: boolean;
}

const COMPACTION_METHOD_KEYS: Record<string, string> = {
	remote: "chat.context.compactionMethod.remote",
	soft: "chat.context.compactionMethod.soft",
	handoff: "chat.context.compactionMethod.handoff",
	snapcompact: "chat.context.compactionMethod.snapcompact",
	shake: "chat.context.compactionMethod.shake",
};

function InlineImage({ image }: { image: ImageContent }) {
	const t = useT();
	const src = `data:${image.mimeType};base64,${image.data}`;
	return (
		<img
			src={src}
			alt={t("chat.attachedImage")}
			className="my-1 max-h-48 max-w-64 rounded-md border border-[var(--omp-border-muted)] object-contain"
		/>
	);
}

/** ToolCard subscribes to the tools store itself, so the tool result lands inline. */
function ToolCardWithResult({ call, runningIndicator }: { call: ToolCallContent; runningIndicator: RunningIndicator }) {
	return (
		<ToolCard
			toolCallId={toolEntryKey(call)}
			toolName={call.name}
			args={call.arguments}
			runningIndicator={runningIndicator}
		/>
	);
}

const FILE_PREVIEW_CHARS = 12_000;
/**
 * How long an acknowledged Retry stays disabled waiting for its turn to start.
 * The sidecar acks `prompt` before the turn's agent_start reaches the pane, so
 * the guard holds until streaming begins; this bounds it for a send that never
 * starts a turn.
 */
const RETRY_STREAM_GRACE_MS = 5_000;

function ExecutionBubble({ message }: { message: AgentMessage }) {
	const t = useT();
	const rpc = useTabRpc();
	// Local placeholder appended by the composer while an `$` eval is in flight
	// (InputArea): offers abortEval; the hydrated transcript record replaces it
	// on completion, mirroring the bash flow.
	const running = message.running === true;
	const [abortSent, setAbortSent] = useState(false);
	const python = message.role === "pythonExecution";
	const input = python ? message.code : message.command;
	const status = running
		? t("chat.exec.running")
		: message.cancelled
			? t("chat.exec.cancelled")
			: message.exitCode == null
				? t("chat.exec.finished")
				: t("chat.exec.exit", { code: message.exitCode });
	const failed = !running && (message.cancelled || (message.exitCode != null && message.exitCode !== 0));

	return (
		<div className="omp-execution-turn omp-fade-up px-6 py-4">
			<div className="omp-transcript-content overflow-hidden rounded-[10px] border border-[var(--omp-border-muted)] bg-[var(--omp-code-bg)] shadow-[var(--omp-shadow-sm)]">
				<div className="flex items-center gap-2 border-b border-[var(--omp-border-muted)] px-3.5 py-2">
					<Terminal className="text-[var(--omp-status-path)]" size={13} />
					<span className="text-omp-sm font-semibold text-[var(--omp-text)]">
						{python ? t("chat.exec.python") : t("chat.exec.shell")}
					</span>
					<span
						className="ml-auto rounded-full px-2 py-0.5 font-mono text-omp-xxs font-medium tracking-wide"
						style={{
							background: running
								? "var(--omp-info-dim)"
								: failed
									? "var(--omp-error-dim)"
									: "var(--omp-success-dim)",
							color: running ? "var(--omp-info)" : failed ? "var(--omp-error)" : "var(--omp-success)",
						}}
					>
						{status}
					</span>
					{running && (
						<button
							type="button"
							disabled={abortSent}
							title={t("common.cancel")}
							onClick={() => {
								setAbortSent(true);
								void rpc.abortEval();
							}}
							className="omp-pressable flex items-center rounded-full px-2 py-0.5 text-omp-xxs font-medium tracking-wide text-[var(--omp-error)] hover:bg-[var(--omp-error-dim)] disabled:opacity-50"
						>
							{t("common.cancel")}
						</button>
					)}
				</div>
				{input && (
					<pre className="border-b border-[var(--omp-border-muted)] px-3.5 py-2.5 font-mono text-omp-sm leading-[1.6] break-words whitespace-pre-wrap text-[var(--omp-status-path)]">
						{python ? input : `$ ${input}`}
					</pre>
				)}
				{!running && (
					<pre
						className={cx(
							"px-3.5 py-2.5 font-mono text-omp-sm leading-[1.6] break-words whitespace-pre-wrap text-[var(--omp-tool-output)]",
							PREVIEW_SCROLL_LG,
						)}
					>
						{message.output && hasAnsi(message.output) ? (
							<AnsiText text={message.output} />
						) : (
							message.output || t("chat.exec.noOutput")
						)}
						{message.truncated ? `\n${t("chat.exec.truncated")}` : ""}
					</pre>
				)}
			</div>
		</div>
	);
}

function ContextBubble({ message }: { message: AgentMessage }) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const isFiles = message.role === "fileMention";
	const compactionMethodKey = message.method ? COMPACTION_METHOD_KEYS[message.method] : undefined;
	const compactionMethod = message.method
		? compactionMethodKey
			? t(compactionMethodKey)
			: message.method
		: undefined;
	const label =
		message.role === "compactionSummary"
			? compactionMethod && message.tokensBefore !== undefined && message.tokensAfter !== undefined
				? t("chat.context.compactedByFromTo", {
						method: compactionMethod,
						before: formatTokens(message.tokensBefore),
						after: formatTokens(message.tokensAfter),
					})
				: compactionMethod
					? t("chat.context.compactedBy", { method: compactionMethod })
					: message.tokensBefore
						? t("chat.context.compactedFrom", { tokens: message.tokensBefore.toLocaleString() })
						: t("chat.context.compacted")
			: message.role === "branchSummary"
				? t("chat.context.branchSummary")
				: t("chat.context.referencedFiles");

	return (
		<div className="omp-context-turn omp-fade-up px-6 py-3">
			<div className="omp-transcript-content rounded-[10px] border border-[var(--omp-border-muted)] px-3.5 py-3">
				<div className="mb-2 flex items-center gap-1.5 text-omp-xs font-bold tracking-[0.12em] text-[var(--omp-status-context)] uppercase">
					{isFiles ? <FileText size={12} /> : <Archive size={12} />}
					{label}
				</div>
				{isFiles ? (
					<div className="space-y-1.5">
						{(message.files ?? []).map(file => (
							<details
								className="overflow-hidden rounded-lg border border-[var(--omp-border-muted)] bg-[var(--omp-code-bg)]"
								key={file.path}
							>
								<summary className="cursor-pointer px-3 py-2 font-mono text-omp-sm text-[var(--omp-status-path)]">
									{file.path}
									{file.skippedReason ? ` — ${file.skippedReason}` : ""}
								</summary>
								<pre
									className={cx(
										"border-t border-[var(--omp-border-muted)] px-3 py-2.5 font-mono text-omp-xs leading-[1.6] break-words whitespace-pre-wrap text-[var(--omp-tool-output)]",
										PREVIEW_SCROLL_LG,
									)}
								>
									{file.content.slice(0, FILE_PREVIEW_CHARS)}
									{file.content.length > FILE_PREVIEW_CHARS ? `\n${t("chat.context.previewTruncated")}` : ""}
								</pre>
							</details>
						))}
					</div>
				) : (
					<>
						{message.shortSummary && <MarkdownRenderer content={message.shortSummary} />}
						{typeof message.warning === "string" && (
							<p role="status" className="text-omp-md text-(--omp-warning)">
								{message.warning}
							</p>
						)}
						<details onToggle={event => setExpanded(event.currentTarget.open)}>
							<summary className="cursor-pointer py-2 text-omp-md text-(--omp-muted)">
								{t("chat.context.details")}
							</summary>
							{expanded && (
								<div className={PREVIEW_SCROLL_LG}>
									<MarkdownRenderer content={message.summary ?? ""} />
								</div>
							)}
						</details>
					</>
				)}
			</div>
		</div>
	);
}

/**
 * One finalized message. User messages sit right-aligned; assistant messages
 * render text, thinking, images, and tool cards. Standalone toolResult messages
 * are folded into their matching card through the tools store.
 */
export const MessageBubble = memo(function MessageBubble({
	message,
	compact = false,
	reaction,
	retryable = false,
	runningIndicator = "spinner",
}: MessageBubbleProps) {
	const t = useT();
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const [copied, setCopied] = useState(false);
	const [branching, setBranching] = useState(false);
	const [retrying, setRetrying] = useState(false);
	const retryGraceRef = useRef<number | null>(null);
	const switchPending = useSessionStore(state => state.switchPending !== null);
	// A read-only collab viewer cannot prompt (the composer disables Send the
	// same way), so Retry would only earn a sidecar rejection.
	const collabReadOnly = useSessionStore(state => state.collab?.readOnly === true);
	// Only a bubble with a retry in flight follows the streaming flag; the rest
	// select a constant and never re-render on turn start or end.
	const retriedTurnStarted = useSessionStore(state => retrying && state.isStreaming);
	useEffect(() => {
		if (retriedTurnStarted) setRetrying(false);
	}, [retriedTurnStarted]);
	// The grace timer lives only while the guard is up (and never past unmount).
	useEffect(() => {
		if (!retrying) return;
		return () => {
			if (retryGraceRef.current !== null) window.clearTimeout(retryGraceRef.current);
			retryGraceRef.current = null;
		};
	}, [retrying]);
	if (message.role === "bashExecution" || message.role === "pythonExecution") {
		return <ExecutionBubble message={message} />;
	}
	if (message.role === "branchSummary" || message.role === "compactionSummary" || message.role === "fileMention") {
		return <ContextBubble message={message} />;
	}
	if (message.role === "custom" || message.role === "hookMessage") {
		if (message.display === false) return null;
		// Dedicated cards for the TUI customType set; unknown types fall through
		// to the generic label + content bubble below.
		if (isCustomMessageCardType(message.customType)) {
			return <CustomMessageCard inProcess={compact} message={message} />;
		}
	}
	if (message.role === "toolResult") return null;

	const content: MessageContent[] = Array.isArray(message.content)
		? message.content
		: typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: [];
	const isUser = message.role === "user";
	const isAssistant = message.role === "assistant";
	const isSteering = Boolean(message.steering);
	const timestamp = formatClock(message.timestamp);
	// User delegations (`^provider/model`, persisted as <model …/> tags) render
	// as atomic chips; the raw tags/selectors are stripped from the body text.
	// Computed inline (no hook) because this component early-returns above.
	const userMentions = (() => {
		if (!isUser) return { chips: [] as ModelMentionChip[], blocks: content };
		const chips: ModelMentionChip[] = [];
		const blocks = content.map(block => {
			if (block.type !== "text") return block;
			const extracted = extractModelMentions(block.text);
			chips.push(...extracted.chips);
			return { ...block, text: extracted.body };
		});
		return { chips, blocks };
	})();
	const customLabel =
		message.role === "custom" || message.role === "hookMessage"
			? (message.customType ?? t("chat.extensionMessage"))
			: null;

	const handleCopy = () => {
		const text = content
			.filter((block): block is Extract<MessageContent, { type: "text" }> => block.type === "text")
			.map(block => block.text)
			.join("\n\n");
		void copyText(text).then(ok => {
			if (!ok) return;
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1400);
		});
	};

	const handleBranch = async () => {
		if (branching || switchPending) return;
		setBranching(true);
		try {
			const result = await forkSessionFromMessageInNewTab(message, rpc, tabId);
			if (result === "saved") toast({ variant: "warning", message: t("chat.branchSaved") });
		} catch (cause) {
			toast({ variant: "error", title: t("sessionTree.forkFailed"), message: String(cause) });
		} finally {
			setBranching(false);
		}
	};

	// Re-send this pane's last user message through this pane's client. The
	// store reads in retryLastTurn run before its first await, so the runtime
	// scope keeps them on this pane even when another pane holds focus.
	// The guard stays up past the acknowledgement until the retried turn starts
	// streaming (which hides Retry), so a second click cannot send it twice.
	const handleRetry = () => {
		if (retrying || switchPending || collabReadOnly) return;
		setRetrying(true);
		let sent = true;
		const onEmpty = () => {
			sent = false;
			toast({ variant: "warning", title: t("palette.retryNothing"), message: t("palette.retryNothingDesc") });
		};
		const inPane = <T,>(read: () => T): T => (tabId ? withSessionRuntime(tabId, read) : read());
		void inPane(() => retryLastTurn(onEmpty, rpc)).then(
			() => {
				// Nothing sent, or the turn already started: nothing left to guard.
				if (!sent || inPane(() => useSessionStore.getState().isStreaming)) {
					setRetrying(false);
					return;
				}
				retryGraceRef.current = window.setTimeout(() => setRetrying(false), RETRY_STREAM_GRACE_MS);
			},
			error => {
				toast({ variant: "error", title: t("palette.failed"), message: String(error) });
				setRetrying(false);
			},
		);
	};

	if (isUser) {
		return (
			<div className="omp-user-turn group flex justify-end gap-3 px-6 py-2.5">
				<span
					aria-hidden="true"
					className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-(--omp-selected-bg) text-(--omp-accent)"
					data-user-avatar=""
				>
					<User size={15} />
				</span>
				<div className="omp-transcript-content omp-user-bubble omp-fade-up relative">
					{reaction ? (
						<span
							aria-label={reaction}
							className="absolute -top-2 right-3 z-10 flex h-7 min-w-7 items-center justify-center rounded-full border border-[var(--omp-border)] bg-[var(--omp-bg-elevated)] px-1 text-omp-lg shadow-[var(--omp-shadow-sm)]"
							role="img"
						>
							{reaction}
						</span>
					) : null}
					<div className="omp-user-bubble-layout">
						<span className="omp-user-bubble-author">{t("live.you")}</span>
						<div className="omp-user-bubble-content">
							{isSteering && (
								<div className="mb-1.5 flex items-center gap-1.5 text-omp-xs font-bold uppercase tracking-[0.12em] text-[var(--omp-custom-msg-label)]">
									<span className="h-1 w-1 rounded-full bg-current" />
									{t("chat.steering")}
								</div>
							)}
							{userMentions.chips.length > 0 && (
								<div className="mb-1.5 flex flex-wrap items-center gap-1.5">
									{userMentions.chips.map((chip, chipIndex) => (
										<span
											key={chipIndex}
											title={t("chat.delegatedTo", {
												name: chip.name ?? chip.selector ?? (chip.agent ? `@${chip.agent}` : ""),
											})}
											className="inline-flex items-center gap-1 rounded-full border border-[var(--omp-border-muted)] bg-[var(--omp-selected-bg)] px-2 py-0.5 font-mono text-omp-xxs font-medium text-[var(--omp-accent)]"
										>
											<Bot size={10} />
											{chip.name ?? chip.selector ?? (chip.agent ? `@${chip.agent}` : "")}
										</span>
									))}
								</div>
							)}
							{userMentions.blocks.map((block, i) => {
								if (block.type === "text") {
									return (
										<div key={i} className="text-omp-xl leading-[1.6] text-[var(--omp-text)]">
											<MarkdownRenderer content={block.text} singleDollarTextMath={false} />
										</div>
									);
								}
								if (block.type === "image") {
									return <InlineImage key={i} image={block} />;
								}
								return null;
							})}
						</div>
					</div>
					<div className="omp-user-bubble-actions flex items-center gap-1.5 text-omp-xs tabular-nums text-[var(--omp-dim)]">
						{timestamp && <span className="font-mono">{timestamp}</span>}
						<button
							type="button"
							onClick={handleCopy}
							title={t("chat.copyMessage")}
							className="omp-pressable flex h-7 w-7 items-center justify-center rounded-md text-[var(--omp-dim)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]"
						>
							{copied ? <Check size={13} className="text-[var(--omp-success)]" /> : <Copy size={13} />}
						</button>
						<button
							type="button"
							onClick={() => void handleBranch()}
							disabled={branching || switchPending}
							aria-label={t("chat.branchFromHere")}
							title={t("chat.branchFromHere")}
							className="omp-pressable flex h-7 w-7 items-center justify-center rounded-md text-[var(--omp-dim)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)] disabled:cursor-wait disabled:opacity-50"
						>
							<GitBranch size={13} />
						</button>
					</div>
				</div>
			</div>
		);
	}

	// Assistant / system: render block by block.
	const blocks: ReactNode[] = [];
	let sawNonToolBlock = false;
	for (const block of content) {
		switch (block.type) {
			case "text": {
				if (isRenderableMessageText(block.text)) {
					blocks.push(<MarkdownRenderer key={blocks.length} content={block.text} />);
					sawNonToolBlock = true;
				}
				break;
			}
			case "thinking": {
				if (isRenderableMessageText(block.thinking)) {
					blocks.push(<ThinkingBlock key={blocks.length} text={block.thinking} />);
					sawNonToolBlock = true;
				}
				break;
			}
			case "toolCall": {
				blocks.push(
					<ToolCardWithResult key={toolEntryKey(block)} call={block} runningIndicator={runningIndicator} />,
				);
				break;
			}
			case "image": {
				blocks.push(<InlineImage key={blocks.length} image={block} />);
				sawNonToolBlock = true;
				break;
			}
		}
	}

	if (blocks.length === 0 && !message.errorMessage && !customLabel && !isSteering) return null;

	// Tool-only messages and messages nested inside an expanded Process group
	// don't need the 28px hover footer plus py-3 padding. Tool-only copy would
	// be empty; the Process disclosure owns the grouped chrome and branch point.
	const compactChrome = compact || (!sawNonToolBlock && !message.errorMessage && !customLabel && !isSteering);
	const showHeader = isAssistant && !compactChrome;
	const model = typeof message.model === "string" ? message.model : "";
	const headerMeta = [model, timestamp].filter(Boolean).join(" · ");

	return (
		<div
			className={cx(
				"group flex px-6",
				!compact && "omp-fade-up",
				!compactChrome && "omp-assistant-turn",
				compactChrome && "omp-assistant-turn--compact",
				compactChrome ? "py-1.5" : "py-3",
			)}
		>
			<div className="omp-transcript-content min-w-0">
				{showHeader && (
					<div className="mb-2 flex min-w-0 items-center gap-2">
						<SaiAtlasLogo
							kind="icon"
							surface="page"
							height={28}
							data-assistant-avatar=""
							className="shrink-0 [&>img]:rounded-[22%]"
						/>
						<span className="shrink-0 text-omp-md font-semibold text-(--omp-text)">
							{t("chat.assistantName")}
						</span>
						{headerMeta && (
							<span className="min-w-0 truncate font-mono text-omp-sm text-(--omp-muted)">{headerMeta}</span>
						)}
					</div>
				)}
				{customLabel && (
					<div className="mb-2 text-omp-sm font-bold tracking-[0.1em] text-[var(--omp-status-context)] uppercase">
						{customLabel}
					</div>
				)}
				{isSteering && (
					<div className="mb-2 flex items-center gap-1.5 text-omp-sm font-bold uppercase tracking-[0.1em] text-[var(--omp-custom-msg-label)]">
						<span className="h-1.5 w-1.5 rounded-full bg-current" />
						{t("chat.steeringResponse")}
					</div>
				)}
				{blocks}
				{message.errorMessage && (
					<div className="omp-message-error mt-2 rounded-lg border border-[var(--omp-error)]/35 bg-[var(--omp-error-dim)] px-3.5 py-2.5 text-omp-lg leading-relaxed break-words text-[var(--omp-error)]">
						{message.errorMessage}
					</div>
				)}
				<UsageRow message={message} />
				{!compactChrome && (
					<div className="mt-2 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
						{/* The assistant header already carries the time. */}
						{!showHeader && timestamp && (
							<span className="mr-1 font-mono text-omp-xs tabular-nums text-(--omp-dim)">{timestamp}</span>
						)}
						<IconButton
							icon={copied ? <Check size={14} className="text-(--omp-success)" /> : <Copy size={14} />}
							label={t("chat.copyMessage")}
							onClick={handleCopy}
							size="sm"
							variant="ghost"
						/>
						{retryable && (
							<IconButton
								disabled={retrying || switchPending || collabReadOnly}
								icon={<RotateCcw size={14} />}
								label={t("chat.retryTurn")}
								onClick={handleRetry}
								size="sm"
								variant="ghost"
							/>
						)}
						{isAssistant && (
							<IconButton
								disabled={branching || switchPending}
								icon={<GitBranch size={14} />}
								label={t("chat.branchFromHere")}
								onClick={() => void handleBranch()}
								size="sm"
								variant="ghost"
							/>
						)}
					</div>
				)}
			</div>
		</div>
	);
});
