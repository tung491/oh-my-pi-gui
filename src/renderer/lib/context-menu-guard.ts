/**
 * Suppresses WebKitGTK's default context menu outside editable content: no
 * menu for plain content; the native menu, with spelling suggestions, still
 * opens over an input, a textarea, contenteditable or an element opting back
 * in with `data-native-context-menu`.
 */

const EDITABLE_SELECTOR = "input, textarea, [contenteditable], [data-native-context-menu]";

/** Installs the guard on `doc`; call the returned remover to detach it. */
export function installContextMenuGuard(doc: Document): () => void {
	const onContextMenu = (event: MouseEvent): void => {
		const target = event.target;
		if (target instanceof Element && target.closest(EDITABLE_SELECTOR)) return;
		event.preventDefault();
	};
	doc.addEventListener("contextmenu", onContextMenu);
	return () => doc.removeEventListener("contextmenu", onContextMenu);
}
