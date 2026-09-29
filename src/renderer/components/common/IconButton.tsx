/**
 * Square icon-only button. `label` is the accessible name and the default
 * tooltip, so an icon never ships without a name.
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/format";

export type IconButtonVariant = "ghost" | "solid" | "onDark";
export type IconButtonSize = "sm" | "md";

const VARIANT_CLASSES: Record<IconButtonVariant, string> = {
	ghost: "text-(--omp-accent) hover:bg-(--omp-selected-bg)",
	solid: "bg-(--omp-btn-primary-bg) text-(--omp-btn-primary-text) hover:brightness-110 active:brightness-95 disabled:hover:brightness-100",
	onDark: "text-(--omp-sidebar-muted) hover:bg-(--omp-sidebar-item-hover) hover:text-(--omp-sidebar-text)",
};

const SIZE_CLASSES: Record<IconButtonSize, string> = {
	sm: "size-7",
	md: "size-[34px]",
};

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children"> {
	/** Accessible name; also the tooltip unless `title` overrides it. */
	label: string;
	/** Icon element (e.g. a lucide icon). */
	icon: ReactNode;
	variant?: IconButtonVariant;
	size?: IconButtonSize;
}

export function IconButton({
	label,
	icon,
	variant = "ghost",
	size = "md",
	title,
	type,
	className,
	...rest
}: IconButtonProps) {
	return (
		<button
			{...rest}
			aria-label={label}
			className={cx(
				"inline-flex shrink-0 items-center justify-center rounded-md border border-transparent transition-[background-color,color,filter] duration-150 disabled:cursor-not-allowed disabled:opacity-45",
				VARIANT_CLASSES[variant],
				SIZE_CLASSES[size],
				className,
			)}
			data-variant={variant}
			title={title ?? label}
			type={type ?? "button"}
		>
			{icon}
		</button>
	);
}
