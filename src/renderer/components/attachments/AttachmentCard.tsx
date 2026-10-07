import { X } from "lucide-react";
import type { ReactElement } from "react";
import { useT } from "../../lib/i18n";
import { type FileKind, fileKindStyle } from "./file-kind";
import { PdfThumbnail, PreviewSpinner } from "./PdfThumbnail";

export interface AttachmentCardProps {
	name: string;
	kind: FileKind;
	/** Absolute path on disk; the card's tooltip and the PDF thumbnail's source. */
	path?: string;
	/** Data URL for images. */
	preview?: string;
	/** Present in the composer only; the transcript's cards cannot be removed. */
	onRemove?: () => void;
	/** The file is still being read: the preview area shows a spinner. */
	loading?: boolean;
}

function KindTile({ kind }: { kind: FileKind }) {
	const { icon: Icon, color } = fileKindStyle(kind);
	return (
		<div className="flex h-full w-full items-center justify-center bg-(--omp-bg-tertiary)">
			<Icon size={36} strokeWidth={1.5} aria-hidden style={{ color }} />
		</div>
	);
}

function KindBadge({ kind }: { kind: FileKind }) {
	const { icon: Icon, color, outlined } = fileKindStyle(kind);
	return (
		<span
			aria-hidden
			className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border"
			style={
				outlined
					? { borderColor: color, color }
					: { borderColor: color, backgroundColor: color, color: "var(--omp-bg-primary)" }
			}
		>
			<Icon size={14} strokeWidth={2} />
		</span>
	);
}

function CardPreview({
	kind,
	path,
	preview,
	loading,
}: Pick<AttachmentCardProps, "kind" | "path" | "preview" | "loading">) {
	if (loading) return <PreviewSpinner />;
	if (kind === "image" && preview) {
		return <img src={preview} alt="" draggable={false} className="h-full w-full object-cover" />;
	}
	if (kind === "pdf" && path) return <PdfThumbnail path={path} fallback={<KindTile kind="pdf" />} />;
	return <KindTile kind={kind} />;
}

/** One attached file: a preview above a footer with its type badge and name. */
export function AttachmentCard({ name, kind, path, preview, onRemove, loading }: AttachmentCardProps): ReactElement {
	const t = useT();
	return (
		<figure
			role="listitem"
			title={path ?? name}
			className="group relative m-0 flex h-[140px] w-[186px] shrink-0 flex-col overflow-hidden rounded-xl border border-(--omp-border-muted) bg-(--omp-bg-secondary) shadow-(--omp-shadow-sm)"
		>
			<div className="h-[93px] w-full shrink-0 overflow-hidden border-b border-(--omp-border-muted)">
				<CardPreview kind={kind} path={path} preview={preview} loading={loading} />
			</div>
			<figcaption className="flex min-w-0 flex-1 items-center gap-2 px-2.5">
				<KindBadge kind={kind} />
				<span className="min-w-0 flex-1 truncate text-omp-sm text-(--omp-text)">{name}</span>
			</figcaption>
			{onRemove && (
				<button
					type="button"
					aria-label={t("input.attachment.remove", { name })}
					title={t("input.attachment.remove", { name })}
					onClick={onRemove}
					className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-(--omp-border) bg-(--omp-bg-elevated) text-(--omp-text) opacity-0 shadow-(--omp-shadow-sm) transition-opacity hover:bg-(--omp-bg-tertiary) focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
				>
					<X size={13} aria-hidden />
				</button>
			)}
		</figure>
	);
}
