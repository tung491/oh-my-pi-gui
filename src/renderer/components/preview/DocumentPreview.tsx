/**
 * Read-only preview of one target in the Files drawer. Works out the kind,
 * reads through the matching channel with the target's own tab (text, markdown
 * and csv through `fs:read`, images through `fs:read-image`, the rest through
 * `fs:read-document`), checks the signature, bounds ZIP files by their real
 * inflated size, and hands rich kinds to the injectable renderers.
 *
 * Refresh is event-driven: a finished write to this file re-reads with the
 * last `ifChanged` stamp and re-renders the same renderer instance in place.
 * Nothing polls; the header's Reload bumps `reloadToken` for a full re-read.
 */

import { type ReactElement, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { IpcFsReadDocumentStamp } from "../../../shared/ipc-types";
import { useT } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import { readDocumentBytes } from "../../lib/preview/document-bytes";
import { expectedSignatures, type PreviewKind, previewKindOf } from "../../lib/preview/document-kind";
import { inspectZip } from "../../lib/preview/zip-guard";
import type { PreviewTarget } from "../../stores/ui";
import { PanelErrorBoundary, Spinner } from "../common";
import { subscribeFileWrites, writeMatchesPreview } from "./file-writes";
import { DEFAULT_PREVIEW_RENDERERS, type PreviewContent, type PreviewRenderers } from "./renderers";

/** docx and sheets parse on the main thread; above this they show "too large". */
export const PREVIEW_PARSE_MAX_BYTES = 10 * 1024 * 1024;
const TEXT_MAX_BYTES = 200_000;
const CSV_MAX_BYTES = 2_000_000;
/** `fs:read-image`'s size refusal, the same text in both shells. */
const IMAGE_TOO_LARGE = "Image too large";

type RichKind = "pdf" | "docx" | "pptx" | "sheet" | "csv";
type ByteKind = "pdf" | "docx" | "pptx" | "sheet";
type ErrorReason = "unsupported" | "too-large" | "failed";
type TextNotice = { key: "filesPanel.binary" } | { key: "filesPanel.readFailed"; error: string };

type PreviewState =
	| { status: "loading" }
	| { status: "text"; content: string; truncated: boolean; markdown: boolean; notice: TextNotice | null }
	| { status: "image"; dataUrl: string }
	| { status: "rich"; content: PreviewContent }
	| { status: "error"; reason: ErrorReason };

/** What one read produced. `state: null` keeps what is on screen (an unchanged file). */
interface ReadOutcome {
	state: PreviewState | null;
	/** Size and mtime of a full read, for the next `ifChanged` check. */
	stamp?: IpcFsReadDocumentStamp;
	resolvedPath?: string | null;
}

const LOADING: PreviewState = { status: "loading" };

const ERROR_KEYS: Record<ErrorReason, string> = {
	unsupported: "preview.unsupported",
	"too-large": "preview.tooLarge",
	failed: "preview.failed",
};

function isByteKind(kind: PreviewKind): kind is ByteKind {
	return kind === "pdf" || kind === "docx" || kind === "pptx" || kind === "sheet";
}

function isRichKind(kind: PreviewKind): kind is RichKind {
	return isByteKind(kind) || kind === "csv";
}

function rendererKey(kind: RichKind): ByteKind {
	return kind === "csv" ? "sheet" : kind;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Identity of a target: the boundary and the load effect key on it, never on a version. */
export function previewTargetKey(target: PreviewTarget): string {
	return target.kind === "path" ? `path:${target.tabId ?? ""}:${target.path}` : `image:${target.id}`;
}

function readText(path: string, maxBytes: number, tabId: string | null) {
	return tabId ? window.omp.fs.read(path, maxBytes, tabId) : window.omp.fs.read(path, maxBytes);
}

async function readTextOutcome(path: string, tabId: string | null, markdown: boolean): Promise<ReadOutcome> {
	const text = (content: string, truncated: boolean, notice: TextNotice | null): ReadOutcome => ({
		state: { status: "text", content, truncated, markdown, notice },
	});
	try {
		const result = await readText(path, TEXT_MAX_BYTES, tabId);
		if (!result.ok) return text("", false, { key: "filesPanel.readFailed", error: result.error ?? "unknown" });
		if (result.binary) return text("", false, { key: "filesPanel.binary" });
		return text(result.content, result.truncated, null);
	} catch (error) {
		return text("", false, { key: "filesPanel.readFailed", error: errorText(error) });
	}
}

async function readCsvOutcome(path: string, tabId: string | null): Promise<ReadOutcome> {
	try {
		const result = await readText(path, CSV_MAX_BYTES, tabId);
		if (!result.ok || result.binary) return { state: { status: "error", reason: "failed" } };
		// The text goes to the sheet renderer as a string, never re-encoded.
		return { state: { status: "rich", content: { text: result.content, truncated: result.truncated } } };
	} catch {
		return { state: { status: "error", reason: "failed" } };
	}
}

async function readImageOutcome(path: string, tabId: string | null): Promise<ReadOutcome> {
	try {
		const result = tabId ? await window.omp.fs.readImage(path, tabId) : await window.omp.fs.readImage(path);
		if (result.ok && result.dataUrl) return { state: { status: "image", dataUrl: result.dataUrl } };
		return { state: { status: "error", reason: result.error === IMAGE_TOO_LARGE ? "too-large" : "failed" } };
	} catch {
		return { state: { status: "error", reason: "failed" } };
	}
}

async function readBytesOutcome(
	kind: ByteKind,
	path: string,
	tabId: string | null,
	ifChanged: IpcFsReadDocumentStamp | null,
): Promise<ReadOutcome> {
	const result = await readDocumentBytes(path, tabId, ifChanged ?? undefined);
	if (!result.ok) return { state: { status: "error", reason: result.error === "too-large" ? "too-large" : "failed" } };
	if (result.unchanged) return { state: null, resolvedPath: result.resolvedPath };
	// Every full read moves the stamp, even one refused below: the same bytes
	// would be refused again, so an unchanged file need not be re-read.
	const read = { stamp: { size: result.size, mtimeMs: result.mtimeMs }, resolvedPath: result.resolvedPath };
	const fail = (reason: ErrorReason): ReadOutcome => ({ ...read, state: { status: "error", reason } });
	if (result.signature === null || !expectedSignatures(path).includes(result.signature)) return fail("failed");
	if ((kind === "docx" || kind === "sheet") && result.bytes.length > PREVIEW_PARSE_MAX_BYTES) return fail("too-large");
	if (result.signature === "zip") {
		let verdict: Awaited<ReturnType<typeof inspectZip>>;
		try {
			verdict = await inspectZip(result.bytes);
		} catch {
			return fail("failed");
		}
		if (!verdict.ok) return fail(verdict.reason === "too-large" ? "too-large" : "failed");
	}
	return { ...read, state: { status: "rich", content: { bytes: result.bytes } } };
}

/** Reads a path target through the channel its kind uses. Never rejects. */
async function readOutcome(
	kind: PreviewKind,
	path: string,
	tabId: string | null,
	ifChanged: IpcFsReadDocumentStamp | null,
): Promise<ReadOutcome> {
	switch (kind) {
		case "markdown":
		case "text":
			return readTextOutcome(path, tabId, kind === "markdown");
		case "csv":
			return readCsvOutcome(path, tabId);
		case "image":
			return readImageOutcome(path, tabId);
		case "pdf":
		case "docx":
		case "pptx":
		case "sheet":
			try {
				return await readBytesOutcome(kind, path, tabId, ifChanged);
			} catch {
				return { state: { status: "error", reason: "failed" } };
			}
		case "unsupported":
			return { state: { status: "error", reason: "unsupported" } };
	}
}

export function DocumentPreview({
	target,
	reloadToken,
	renderers = DEFAULT_PREVIEW_RENDERERS,
}: {
	target: PreviewTarget;
	reloadToken: number;
	renderers?: PreviewRenderers;
}): ReactElement {
	const t = useT();
	const key = previewTargetKey(target);
	const path = target.kind === "path" ? target.path : null;
	const tabId = target.kind === "path" ? target.tabId : null;
	const imageDataUrl = target.kind === "image" ? target.dataUrl : null;
	const kind: PreviewKind = path === null ? "image" : previewKindOf(path);

	const [state, setState] = useState<PreviewState>(() =>
		imageDataUrl !== null ? { status: "image", dataUrl: imageDataUrl } : LOADING,
	);
	/** Bumped by every load; a reply for an older number is dropped. */
	const requestRef = useRef(0);
	/** The mode of the read in flight for the current request, if any. */
	const inFlightRef = useRef<"full" | "ifChanged" | null>(null);
	const loadedKeyRef = useRef<string | null>(null);
	const stampRef = useRef<IpcFsReadDocumentStamp | null>(null);
	const resolvedPathRef = useRef<string | null>(null);

	/** Drops whatever read is pending: its reply belongs to an older target. */
	const cancelPending = useCallback(() => {
		requestRef.current += 1;
		inFlightRef.current = null;
	}, []);

	const load = useCallback(
		async (mode: "full" | "ifChanged", showLoading: boolean) => {
			if (path === null) return;
			const request = ++requestRef.current;
			inFlightRef.current = mode;
			if (showLoading) setState(LOADING);
			const outcome = await readOutcome(kind, path, tabId, mode === "ifChanged" ? stampRef.current : null);
			if (request !== requestRef.current) return;
			inFlightRef.current = null;
			if (outcome.stamp) stampRef.current = outcome.stamp;
			if (outcome.resolvedPath !== undefined && outcome.resolvedPath !== null) {
				resolvedPathRef.current = outcome.resolvedPath;
			}
			if (outcome.state) setState(outcome.state);
		},
		[path, tabId, kind],
	);

	// Open, target change and Reload. A Reload while a full read of this same
	// target is still pending is a no-op, so a hung mount does not pile reads.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken is the Reload trigger itself.
	useEffect(() => {
		const sameTarget = loadedKeyRef.current === key;
		if (!sameTarget) {
			loadedKeyRef.current = key;
			stampRef.current = null;
			resolvedPathRef.current = null;
		}
		if (imageDataUrl !== null) {
			cancelPending();
			setState({ status: "image", dataUrl: imageDataUrl });
			return;
		}
		if (kind === "unsupported") {
			cancelPending();
			setState({ status: "error", reason: "unsupported" });
			return;
		}
		if (sameTarget && inFlightRef.current === "full") return;
		void load("full", true);
	}, [key, reloadToken, imageDataUrl, kind, load, cancelPending]);

	// A finished write to this file: byte kinds re-check with the stamp and
	// keep their state when unchanged; text kinds re-read without the spinner.
	useEffect(() => {
		if (path === null || kind === "unsupported") return;
		return subscribeFileWrites(write => {
			if (!writeMatchesPreview(write, { path, tabId }, resolvedPathRef.current)) return;
			void load(isByteKind(kind) ? "ifChanged" : "full", false);
		});
	}, [path, tabId, kind, load]);

	useEffect(() => cancelPending, [cancelPending]);

	const onRendererError = useCallback(() => setState({ status: "error", reason: "failed" }), []);

	let body: ReactElement;
	let shown: PreviewState["status"] = state.status;
	if (state.status === "loading") {
		body = (
			<div className="flex items-center gap-2 p-4">
				<Spinner size="sm" />
				<span className="text-omp-sm text-(--omp-dim)">{t("filesPanel.reading")}</span>
			</div>
		);
	} else if (state.status === "text") {
		const content = state.notice
			? state.notice.key === "filesPanel.readFailed"
				? t("filesPanel.readFailed", { error: state.notice.error })
				: t("filesPanel.binary")
			: state.content;
		body = state.markdown ? (
			<div className="p-4 text-omp-md text-(--omp-text)">
				<MarkdownRenderer content={content} />
				{state.truncated && (
					<div className="mt-3 text-omp-xs text-(--omp-dim)">
						{t("filesPanel.truncated", { kb: TEXT_MAX_BYTES / 1000 })}
					</div>
				)}
			</div>
		) : (
			<pre className="p-3 font-mono text-omp-sm leading-[1.5] break-words whitespace-pre-wrap text-(--omp-text)">
				{content}
				{state.truncated && (
					<span className="text-(--omp-dim)">
						{"\n"}
						{t("filesPanel.truncated", { kb: TEXT_MAX_BYTES / 1000 })}
					</span>
				)}
			</pre>
		);
	} else if (state.status === "image") {
		body = <img src={state.dataUrl} alt="" className="mx-auto max-w-full object-contain p-3" />;
	} else {
		const Renderer = state.status === "rich" && isRichKind(kind) ? renderers[rendererKey(kind)] : undefined;
		if (state.status === "rich" && Renderer && path !== null && isRichKind(kind)) {
			body = (
				<PanelErrorBoundary key={key}>
					<Suspense fallback={<Spinner size="sm" />}>
						<Renderer content={state.content} kind={kind} path={path} onError={onRendererError} />
					</Suspense>
				</PanelErrorBoundary>
			);
		} else {
			const reason: ErrorReason = state.status === "error" ? state.reason : "unsupported";
			shown = "error";
			body = (
				<div className="flex h-full items-center justify-center px-6 py-8 text-center text-omp-sm leading-relaxed text-(--omp-dim)">
					{t(ERROR_KEYS[reason])}
				</div>
			);
		}
	}

	return (
		<div className="h-full min-h-0 overflow-auto" data-preview-kind={kind} data-preview-state={shown}>
			{body}
		</div>
	);
}
