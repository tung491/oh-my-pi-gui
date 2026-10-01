/**
 * Filter chip: a toggle button whose `aria-pressed` mirrors `selected`. The
 * caller owns the selection and flips it from `onClick`.
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/format";

export interface TagProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed"> {
	selected: boolean;
	children: ReactNode;
}

export function Tag({ selected, type, className, children, ...rest }: TagProps) {
	return (
		<button
			{...rest}
			aria-pressed={selected}
			className={cx(
				"inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm border px-2.5 py-[5px] text-omp-md font-medium disabled:cursor-not-allowed disabled:opacity-45",
				selected
					? "border-(--omp-accent) bg-(--omp-selected-bg) text-(--omp-accent)"
					: "border-(--omp-border) bg-(--omp-bg-elevated) text-(--omp-text) hover:bg-(--omp-bg-secondary)",
				className,
			)}
			type={type ?? "button"}
		>
			{children}
		</button>
	);
}
