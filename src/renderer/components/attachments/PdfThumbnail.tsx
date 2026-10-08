import { Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { renderPdfThumbnail } from "../../lib/pdf-thumbnail";

type ThumbnailState = { status: "loading" } | { status: "ready"; url: string } | { status: "failed" };

export interface PdfThumbnailProps {
	path: string;
	/** Shown when the first page cannot be rendered. */
	fallback: ReactNode;
}

/** Page 1 of the PDF at `path`, with a spinner while it renders and `fallback` when it cannot. */
export function PdfThumbnail({ path, fallback }: PdfThumbnailProps) {
	const t = useT();
	const [state, setState] = useState<ThumbnailState>({ status: "loading" });

	useEffect(() => {
		let live = true;
		setState({ status: "loading" });
		renderPdfThumbnail(path).then(
			url => {
				if (live) setState({ status: "ready", url });
			},
			(error: unknown) => {
				console.warn("PDF thumbnail failed", path, error);
				if (live) setState({ status: "failed" });
			},
		);
		return () => {
			live = false;
		};
	}, [path]);

	if (state.status === "ready") {
		return <img src={state.url} alt="" draggable={false} className="h-full w-full object-cover object-top" />;
	}
	if (state.status === "failed") {
		return (
			<>
				{fallback}
				<span className="sr-only">{t("input.attachment.previewFailed")}</span>
			</>
		);
	}
	return <PreviewSpinner />;
}

/** The preview area while a card's preview is still loading. */
export function PreviewSpinner() {
	const t = useT();
	return (
		<div
			role="status"
			aria-label={t("input.attachment.loading")}
			className="flex h-full w-full items-center justify-center bg-(--omp-bg-tertiary)" // surface-ok: thumbnail tile inside an elevated card
		>
			<Loader2 size={18} aria-hidden className="animate-spin text-(--omp-dim)" />
		</div>
	);
}
