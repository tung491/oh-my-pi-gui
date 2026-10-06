/**
 * Tool-approval dialog. The sidecar routes tool approval through a plain
 * `select` extension-UI request with exactly ["Approve", "Deny"] options and
 * a title of the form "Allow tool: <name>\n[Reason: <reason>\n]<details>".
 * This component leads with one plain sentence saying what will happen, then
 * the tool name with its capability tier, and keeps the raw request one click
 * down. Deny (or closing the dialog) answers confirmed:false.
 */

import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useMemo } from "react";
import type { ExtensionUIRequest } from "../../../shared/rpc-types";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { Badge, type BadgeVariant, Button, Modal } from "../common";

const APPROVAL_TITLE_PREFIX = "Allow tool: ";
const REASON_PREFIX = "Reason: ";
const PATH_PREFIX = "Path: ";
const CONTENT_LINE = "Content:";
/** The marker omp appends to a value it cut at 2000 characters (`truncateForPrompt`). */
const ELIDED_MARKER = /\[…\d+ch elided…\]$/;
/** C0/C1 controls and the Unicode line and paragraph separators. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/** Spaces omp rewrites to an ASCII space before resolving a path (`normalizeUnicodeSpaces`). */
const UNICODE_SPACE = /[\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000\ufeff]/;

type ApprovalSelect = Extract<ExtensionUIRequest, { method: "select" }>;

export type ApprovalResponse = { value: string } | { confirmed: boolean } | { cancelled: true };

export function isApprovalRequest(request: ExtensionUIRequest): request is ApprovalSelect {
	return (
		request.method === "select" &&
		request.options.length === 2 &&
		request.options[0] === "Approve" &&
		request.options[1] === "Deny" &&
		request.title.startsWith(APPROVAL_TITLE_PREFIX)
	);
}

const READ_TOOLS = new Set([
	"read",
	"grep",
	"glob",
	"ls",
	"find",
	"lsp",
	"web_search",
	"inspect_image",
	"recall",
	"get_branch_messages",
	"diagnose",
	"system_status",
]);

const WRITE_TOOLS = new Set([
	"edit",
	"write",
	"ast_edit",
	"apply_patch",
	"memory_edit",
	"retain",
	"reflect",
	"learn",
	"manage_skill",
	"set_session_name",
	"todo",
	"goal",
	"office_report",
	"office_slides",
	"office_clean",
]);

/** Tools whose request carries a reason the pack writes in the session language. */
const REASON_TOOLS = new Set(["open_item", "os_setting"]);

/** Locale keys of the office tools' action phrases. */
const OFFICE_ACTION_KEYS: Record<string, string> = {
	office_report: "approval.action.officeReport",
	office_slides: "approval.action.officeSlides",
	office_clean: "approval.action.officeClean",
};

export interface ParsedApprovalTitle {
	toolName: string;
	reason?: string;
	path?: string;
	/** Every line after the first, verbatim. */
	details: string;
}

export function parseApprovalTitle(title: string): ParsedApprovalTitle {
	const [first = "", ...rest] = title.split("\n");
	const toolName = (
		first.startsWith(APPROVAL_TITLE_PREFIX) ? first.slice(APPROVAL_TITLE_PREFIX.length) : first
	).trim();
	const lineValue = (prefix: string) => rest.find(line => line.startsWith(prefix))?.slice(prefix.length);
	return { toolName, reason: lineValue(REASON_PREFIX), path: lineValue(PATH_PREFIX), details: rest.join("\n") };
}

/** Resolves `.` and `..` segments so the dialog names the file that will really be written. */
export function normalizePosixPath(path: string): string {
	const absolute = path.startsWith("/");
	const segments: string[] = [];
	for (const segment of path.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (segments.length > 0 && segments.at(-1) !== "..") segments.pop();
			else if (!absolute) segments.push("..");
			continue;
		}
		segments.push(segment);
	}
	const joined = segments.join("/");
	return absolute ? `/${joined}` : joined || ".";
}

/** Where a pack session resolves relative and `~` paths. */
export interface WriteLocation {
	/** The session's working folder; empty when unknown. */
	cwd: string;
	/** The user's home folder; empty when unknown. */
	homeDir: string;
}

/**
 * Resolves a path the way omp's `resolveToCwd` does for the shapes a model
 * writes (`expandPath` in `tools/path-utils.ts`): a stray leading `:`, an `@`
 * before `/` or `~`, `~` for the home folder, and relative paths against the
 * session folder. Any other shape omp rewrites (URLs, hashline wrappers,
 * Unicode spaces, Windows forms) returns null, as does an absolute path with a
 * `..` segment or a path that needs a folder the renderer does not know.
 */
function resolveLikeAgent(raw: string, where: WriteLocation): string | null {
	let path = /^:(?=[/~]|\.\.?\/)/.test(raw) ? raw.slice(1) : raw;
	if (path.startsWith("@")) {
		const rest = path.slice(1);
		if (rest.startsWith("/") || rest === "~" || rest.startsWith("~/")) path = rest;
	}
	if (path === "" || /^\/+$/.test(path) || path.startsWith("[") || path.includes("://") || path.includes("\\")) {
		return null;
	}
	if (UNICODE_SPACE.test(path)) return null;
	if (path.startsWith("~")) {
		if (!where.homeDir.startsWith("/")) return null;
		// `~` alone, `~/x`, and `~x` (joined under the home folder, as omp does).
		path = path === "~" ? where.homeDir : `${where.homeDir}/${path.slice(path.startsWith("~/") ? 2 : 1)}`;
	}
	// omp hands an absolute path to the system unchanged, which resolves each
	// `..` after following symlinks, so a lexical reading could name another
	// folder. Relative paths are resolved lexically by omp too.
	if (path.startsWith("/") && path.split("/").includes("..")) return null;
	if (!path.startsWith("/")) {
		if (!where.cwd.startsWith("/")) return null;
		path = `${where.cwd}/${path}`;
	}
	return normalizePosixPath(path);
}

/**
 * The absolute file a `write` request saves to, or null when the request
 * cannot be read without doubt: omp prints `Path: <path>` then `Content:`
 * (`formatApprovalDetails` in `tools/write.ts`), so a path that spans lines,
 * hides a second `Content:` line, holds a control character or was cut short
 * could make a one-line reading name the wrong file.
 */
export function resolveWritePath(details: string, where: WriteLocation): string | null {
	const lines = details.split("\n");
	const pathLine = lines.findIndex(line => line.startsWith(PATH_PREFIX));
	if (pathLine === -1 || lines[pathLine + 1] !== CONTENT_LINE) return null;
	if (lines.filter(line => line === CONTENT_LINE).length !== 1) return null;
	const raw = lines[pathLine].slice(PATH_PREFIX.length);
	if (CONTROL_CHARACTER.test(raw) || ELIDED_MARKER.test(raw)) return null;
	return resolveLikeAgent(raw, where);
}

type Translate = (key: string, params?: Record<string, string>) => string;

function approvalSentence(
	parsed: ParsedApprovalTitle,
	toolName: string,
	where: WriteLocation,
	t: Translate,
): { text: string; warning: boolean } {
	const reason = parsed.reason?.trim();
	if (REASON_TOOLS.has(parsed.toolName) && reason) return { text: reason, warning: false };
	if (parsed.toolName === "write") {
		const path = resolveWritePath(parsed.details, where);
		return path
			? { text: t("approval.sentence.write", { path }), warning: false }
			: { text: t("approval.sentence.writeUnclear"), warning: true };
	}
	const actionKey = OFFICE_ACTION_KEYS[parsed.toolName];
	return { text: t("approval.sentence.generic", { action: actionKey ? t(actionKey) : toolName }), warning: false };
}

/** Tier badge: read=green, write=yellow, exec=red (default tier is exec). */
function tierFor(toolName: string): { key: string; variant: BadgeVariant } {
	if (READ_TOOLS.has(toolName)) return { key: "approval.tier.read", variant: "success" };
	if (WRITE_TOOLS.has(toolName)) return { key: "approval.tier.write", variant: "warning" };
	return { key: "approval.tier.exec", variant: "error" };
}

export function ApprovalDialog({
	request,
	cwd,
	homeDir,
	onRespond,
}: {
	request: ApprovalSelect;
	/** The session's working folder, which relative paths resolve against. */
	cwd: string;
	homeDir: string;
	onRespond: (response: ApprovalResponse) => void;
}) {
	const t = useT();
	const parsed = useMemo(() => parseApprovalTitle(request.title), [request.title]);
	const toolName = parsed.toolName || t("approval.unknownTool");
	const sentence = approvalSentence(parsed, toolName, { cwd, homeDir }, t);
	const body = parsed.details.trim();

	const tier = tierFor(toolName);
	const deny = () => onRespond({ value: "Deny" });

	return (
		<Modal onClose={deny} open size="md" title={t("approval.title")}>
			<div className="flex flex-col">
				<p
					data-approval-sentence
					data-approval-warning={sentence.warning ? "" : undefined}
					className={cx(
						"text-omp-xl leading-relaxed break-words",
						sentence.warning ? "font-medium text-(--omp-error)" : "text-(--omp-text)",
					)}
				>
					{sentence.text}
				</p>
				<div className="mt-3 flex items-center gap-2.5">
					<ShieldAlert className="shrink-0 text-(--omp-warning)" size={16} />
					<span className="min-w-0 flex-1 truncate font-mono text-omp-sm text-(--omp-muted)">{toolName}</span>
					<Badge dot variant={tier.variant}>
						{t(tier.key)}
					</Badge>
				</div>
				{body ? (
					<details
						open={sentence.warning}
						className="mt-2 rounded-md border border-(--omp-border-muted) bg-(--omp-code-bg)"
					>
						<summary className="cursor-pointer px-3 py-1.5 text-omp-sm text-(--omp-dim) hover:text-(--omp-text)">
							{t("approval.details")}
						</summary>
						<div className="max-h-[45vh] overflow-y-auto px-3 pb-3">
							<pre className="font-mono text-omp-sm leading-[1.55] break-words whitespace-pre-wrap text-(--omp-muted)">
								{body}
							</pre>
						</div>
					</details>
				) : (
					<span className="mt-2 text-omp-sm text-(--omp-dim) italic">{t("approval.noArgs")}</span>
				)}
				<div className="mt-4 flex items-center justify-between gap-2">
					<span className="text-omp-xs text-(--omp-dim)">{t("approval.waiting")}</span>
					<div className="flex gap-2">
						<Button onClick={deny} size="md" variant="danger">
							{t("approval.deny")}
						</Button>
						<Button
							variant="primary"
							size="md"
							icon={<ShieldCheck size={13} />}
							onClick={() => onRespond({ value: "Approve" })}
						>
							{t("approval.approve")}
						</Button>
					</div>
				</div>
			</div>
		</Modal>
	);
}
