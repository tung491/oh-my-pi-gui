/**
 * Sheet preview for xlsx, xls, ods (bytes) and csv (text): one tab per visible
 * sheet and a capped table of display strings (`sheet-model.ts`).
 *
 * The parse runs in an effect after a yield, never during render, so the shell
 * paints its frame first and a parse failure reaches `onError` outside render.
 * A refresh (new `content`) re-parses in place and keeps the selected sheet by
 * name, falling back to the first sheet when that name is gone.
 */

import { type ReactElement, useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetView, workbookToSheets } from "../../lib/preview/sheet-model";
import { Spinner, Tabs } from "../common";
import type { PreviewRendererProps } from "./renderers";

export default function SheetPreview({ content, onError }: PreviewRendererProps): ReactElement {
	const t = useT();
	const [sheets, setSheets] = useState<SheetView[] | null>(null);
	const [selectedName, setSelectedName] = useState<string | null>(null);
	// The latest `onError` without re-parsing when the parent passes a new function.
	const onErrorRef = useRef(onError);
	useEffect(() => {
		onErrorRef.current = onError;
	});

	useEffect(() => {
		let cancelled = false;
		const timer = setTimeout(() => {
			try {
				const next = workbookToSheets("bytes" in content ? content.bytes : content.text);
				if (!cancelled) setSheets(next);
			} catch (error) {
				if (!cancelled) onErrorRef.current(error);
			}
		}, 0);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [content]);

	if (sheets === null) {
		return (
			<div className="flex items-center p-4">
				<Spinner size="sm" />
			</div>
		);
	}

	const sheet = sheets.find(candidate => candidate.name === selectedName) ?? sheets[0];
	const fileTruncated = "text" in content && content.truncated;
	const sheetTruncated = sheet !== undefined && (sheet.totalRows > SHEET_MAX_ROWS || sheet.totalCols > SHEET_MAX_COLS);
	const width = sheet ? Math.max(0, ...sheet.rows.map(row => row.length)) : 0;

	return (
		<div className="flex min-h-0 flex-col">
			<Tabs
				activeId={sheet?.name ?? ""}
				ariaLabel={t("preview.sheets")}
				className="sticky top-0 z-10 overflow-x-auto bg-(--omp-code-bg) px-2"
				compact
				onChange={setSelectedName}
				tabs={sheets.map(({ name }) => ({ id: name, label: name }))}
			/>
			{(fileTruncated || sheetTruncated) && (
				<div className="flex flex-col gap-1 px-3 pt-2 text-omp-xs text-(--omp-dim)">
					{sheetTruncated && sheet && (
						<p>
							{t("preview.sheetTruncated", {
								rows: Math.min(sheet.totalRows, SHEET_MAX_ROWS),
								cols: Math.min(sheet.totalCols, SHEET_MAX_COLS),
							})}
						</p>
					)}
					{fileTruncated && <p>{t("preview.fileTruncated")}</p>}
				</div>
			)}
			{sheet && (
				<div className="overflow-auto p-3">
					<table className="border-collapse text-omp-sm">
						<tbody>
							{sheet.rows.map((row, r) => (
								<tr key={r}>
									{Array.from({ length: width }, (_, c) => {
										const formula = sheet.formulaCells.has(`${r}:${c}`);
										return (
											<td
												className={`border border-(--omp-border-muted) px-2 py-0.5 whitespace-pre ${
													formula ? "text-(--omp-muted)" : "text-(--omp-text)"
												}`}
												key={c}
												title={formula ? t("preview.formula") : undefined}
											>
												{row[c] ?? ""}
											</td>
										);
									})}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
