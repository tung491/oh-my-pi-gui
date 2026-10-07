import type { ReactElement, ReactNode } from "react";

/** A horizontally scrolling row of attachment cards. */
export function AttachmentStrip({ children }: { children: ReactNode }): ReactElement {
	return (
		<div role="list" className="flex max-w-full gap-2 overflow-x-auto overflow-y-hidden pb-1">
			{children}
		</div>
	);
}
