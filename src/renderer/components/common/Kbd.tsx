/**
 * Keyboard shortcut chip. Decorative: screen readers skip it, so the shortcut
 * must also be reachable through the control's title or label.
 */

import type { ReactNode } from "react";
import { cx } from "../../lib/format";

export interface KbdProps {
	children: ReactNode;
	className?: string;
}

export function Kbd({ children, className }: KbdProps) {
	return (
		<kbd aria-hidden="true" className={cx("omp-kbd", className)}>
			{children}
		</kbd>
	);
}
