/**
 * Multi-line editor surface for an extension `editor` request. Split out of
 * ExtensionDialog so CodeMirror downloads with the first editor request
 * instead of with every window's startup bundle.
 */
import { json } from "@codemirror/lang-json";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import type { ExtensionUIRequest } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { Button, Modal } from "../common";

function looksLikeJson(text: string): boolean {
	const trimmed = text.trim();
	return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

export function ExtensionEditorDialog({
	request,
	onValue,
	onCancel,
}: {
	request: Extract<ExtensionUIRequest, { method: "editor" }>;
	onValue: (value: string) => void;
	onCancel: () => void;
}) {
	const t = useT();
	const hostRef = useRef<HTMLDivElement>(null);
	const valueRef = useRef(request.prefill ?? "");

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		// The editor view is rebuilt per request — resync the submit ref so text
		// left over from a previous request can't leak into this one's value.
		valueRef.current = request.prefill ?? "";
		const view = new EditorView({
			doc: request.prefill ?? "",
			extensions: [
				EditorView.lineWrapping,
				...(looksLikeJson(request.prefill ?? "") ? [json()] : []),
				EditorView.theme({
					"&": {
						backgroundColor: "var(--omp-code-bg)",
						color: "var(--omp-text)",
						fontSize: "12px",
						height: "100%",
					},
					"&.cm-focused": { outline: "none" },
					".cm-content": { fontFamily: "var(--font-mono, monospace)", padding: "8px 0" },
					".cm-line": { padding: "0 10px" },
					".cm-cursor": { borderLeftColor: "var(--omp-accent)" },
					".cm-selectionBackground": { backgroundColor: "var(--omp-selected-bg) !important" },
					".cm-gutters": {
						backgroundColor: "transparent",
						borderRight: "1px solid var(--omp-border-muted)",
						color: "var(--omp-dim)",
					},
				}),
				EditorView.updateListener.of(update => {
					if (update.docChanged) valueRef.current = update.state.doc.toString();
				}),
			],
			parent: host,
		});
		view.focus();
		return () => view.destroy();
	}, [request.prefill]);

	return (
		<Modal bodyClassName="p-0" onClose={onCancel} open size="lg" title={request.title}>
			<div className="flex h-[55vh] flex-col">
				<div className="min-h-0 flex-1 overflow-hidden border-b border-(--omp-border-muted)" ref={hostRef} />
				<div className="flex items-center justify-end gap-2 p-3">
					<Button onClick={onCancel} size="sm" variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button onClick={() => onValue(valueRef.current)} size="sm" variant="primary">
						{t("extDialog.submit")}
					</Button>
				</div>
			</div>
		</Modal>
	);
}
