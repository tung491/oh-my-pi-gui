import { FileText, FolderOpen, type LucideIcon, Presentation, Sheet } from "lucide-react";
import { resultText, sanitizeToolText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { toast } from "../../stores/toast";
import { GenericRenderer } from "./GenericRenderer";
import type { OfficeKind } from "./office-tools";
import type { ToolRendererProps } from "./ToolCard";

/** The folder the office tools write into (Documents > Sai ATLAS). */
const OUTPUT_FOLDER_NAME = "Sai ATLAS";
const RESULT_KEYS = ["check", "file", "kind"] as const;

const KIND_ICONS: Record<OfficeKind, LucideIcon> = {
	docx: FileText,
	pptx: Presentation,
	xlsx: Sheet,
};

export interface OfficeFile {
	file: string;
	check: string;
}

/**
 * Reads an office tool's success text: one JSON object with exactly `file`,
 * `kind` and `check`. The file must be the kind this tool makes and sit
 * directly in the Sai ATLAS output folder, so the card never offers to open
 * anything else a result might name.
 */
export function parseOfficeResult(text: string, kind: OfficeKind): OfficeFile | null {
	let value: unknown;
	try {
		value = JSON.parse(text.trim());
	} catch {
		return null;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	if (keys.length !== RESULT_KEYS.length || keys.some((key, index) => key !== RESULT_KEYS[index])) return null;
	const { file, kind: resultKind, check } = record;
	if (typeof file !== "string" || typeof resultKind !== "string" || typeof check !== "string") return null;
	if (resultKind !== kind || !file.endsWith(`.${kind}`)) return null;
	if (!file.startsWith("/")) return null;
	const segments = file.split("/");
	if (segments.includes("..")) return null;
	if (segments.at(-2) !== OUTPUT_FOLDER_NAME) return null;
	return { file, check };
}

function baseName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function dirName(path: string): string {
	return path.slice(0, path.lastIndexOf("/"));
}

/** The finished file of an office job, with Open and Show in folder. */
export function OfficeFileRenderer({ kind, ...props }: ToolRendererProps & { kind: OfficeKind }) {
	const t = useT();
	const office = props.isPartial || props.isError ? null : parseOfficeResult(resultText(props.result), kind);
	if (!office) return <GenericRenderer {...props} />;

	const open = async (path: string) => {
		try {
			const result = await window.omp.system.openPath(path);
			if (!result?.ok)
				toast({ variant: "error", title: t("tools.path.openFailed"), message: result?.error || path });
		} catch (cause) {
			toast({
				variant: "error",
				title: t("tools.path.openFailed"),
				message: cause instanceof Error ? cause.message : String(cause),
			});
		}
	};
	const Icon = KIND_ICONS[kind];
	const buttonClass =
		"inline-flex items-center gap-1.5 rounded-lg border border-[var(--omp-border)] px-2.5 py-1 text-omp-sm text-[var(--omp-text)] transition-colors hover:border-[var(--omp-border-accent)] hover:bg-[var(--omp-selected-bg)]";

	return (
		<div data-office-file className="flex items-center gap-3">
			<span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--omp-selected-bg)] text-[var(--omp-accent)]">
				<Icon size={20} />
			</span>
			<div className="min-w-0 flex-1">
				<div className="truncate text-omp-lg font-semibold text-[var(--omp-text)]" title={office.file}>
					{baseName(office.file)}
				</div>
				<div className="truncate text-omp-sm text-[var(--omp-muted)]">{sanitizeToolText(office.check)}</div>
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				<button type="button" className={buttonClass} onClick={() => void open(office.file)}>
					{t("tools.office.open")}
				</button>
				<button type="button" className={buttonClass} onClick={() => void open(dirName(office.file))}>
					<FolderOpen size={14} aria-hidden />
					{t("tools.office.showInFolder")}
				</button>
			</div>
		</div>
	);
}
