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
import { useT } from "../../lib/i18n";
import { Badge, type BadgeVariant, Button, Modal } from "../common";

const APPROVAL_TITLE_PREFIX = "Allow tool: ";
const REASON_PREFIX = "Reason: ";
const PATH_PREFIX = "Path: ";

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

function approvalSentence(
	parsed: ParsedApprovalTitle,
	toolName: string,
	t: (key: string, params?: Record<string, string>) => string,
): string {
	const reason = parsed.reason?.trim();
	if (REASON_TOOLS.has(parsed.toolName) && reason) return reason;
	if (parsed.toolName === "write" && parsed.path?.trim()) {
		return t("approval.sentence.write", { path: normalizePosixPath(parsed.path.trim()) });
	}
	const actionKey = OFFICE_ACTION_KEYS[parsed.toolName];
	return t("approval.sentence.generic", { action: actionKey ? t(actionKey) : toolName });
}

/** Tier badge: read=green, write=yellow, exec=red (default tier is exec). */
function tierFor(toolName: string): { key: string; variant: BadgeVariant } {
	if (READ_TOOLS.has(toolName)) return { key: "approval.tier.read", variant: "success" };
	if (WRITE_TOOLS.has(toolName)) return { key: "approval.tier.write", variant: "warning" };
	return { key: "approval.tier.exec", variant: "error" };
}

export function ApprovalDialog({
	request,
	onRespond,
}: {
	request: ApprovalSelect;
	onRespond: (response: ApprovalResponse) => void;
}) {
	const t = useT();
	const parsed = useMemo(() => parseApprovalTitle(request.title), [request.title]);
	const toolName = parsed.toolName || t("approval.unknownTool");
	const sentence = approvalSentence(parsed, toolName, t);
	const body = parsed.details.trim();

	const tier = tierFor(toolName);
	const deny = () => onRespond({ value: "Deny" });

	return (
		<Modal onClose={deny} open size="md" title={t("approval.title")}>
			<div className="flex flex-col">
				<p data-approval-sentence className="text-omp-xl leading-relaxed text-(--omp-text) break-words">
					{sentence}
				</p>
				<div className="mt-3 flex items-center gap-2.5">
					<ShieldAlert className="shrink-0 text-(--omp-warning)" size={16} />
					<span className="min-w-0 flex-1 truncate font-mono text-omp-sm text-(--omp-muted)">{toolName}</span>
					<Badge dot variant={tier.variant}>
						{t(tier.key)}
					</Badge>
				</div>
				{body ? (
					<details className="mt-2 rounded-md border border-(--omp-border-muted) bg-(--omp-code-bg)">
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
