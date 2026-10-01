/**
 * Segmented single-choice control: a sunken track of toggle buttons whose
 * `aria-pressed` reflects the selected value. `tone="onDark"` reads on the
 * navy sidebar.
 */

import type { ReactNode } from "react";
import { cx } from "../../lib/format";

export type SegmentedControlTone = "default" | "onDark";

export interface SegmentedOption<T extends string> {
	value: T;
	label: ReactNode;
	/** Tooltip, e.g. the option's longer description. */
	title?: string;
	/** Icon element rendered before the label. */
	icon?: ReactNode;
}

export interface SegmentedControlProps<T extends string> {
	value: T;
	onChange: (value: T) => void;
	options: readonly SegmentedOption<T>[];
	/** Accessible name of the group. */
	ariaLabel: string;
	tone?: SegmentedControlTone;
	className?: string;
}

const TRACK_CLASSES: Record<SegmentedControlTone, string> = {
	default: "border-(--omp-border-muted) bg-(--omp-bg-secondary)", // surface-ok: segmented track
	onDark: "border-(--omp-sidebar-border) bg-(--omp-sidebar-item-hover)",
};

const ACTIVE_CLASSES: Record<SegmentedControlTone, string> = {
	default: "bg-(--omp-bg-elevated) text-(--omp-accent) shadow-(--omp-shadow-sm)",
	onDark: "bg-(--omp-sidebar-item-active) text-(--omp-sidebar-text)",
};

const IDLE_CLASSES: Record<SegmentedControlTone, string> = {
	default: "text-(--omp-muted) hover:text-(--omp-text)",
	onDark: "text-(--omp-sidebar-muted) hover:text-(--omp-sidebar-text)",
};

export function SegmentedControl<T extends string>({
	value,
	onChange,
	options,
	ariaLabel,
	tone = "default",
	className,
}: SegmentedControlProps<T>) {
	return (
		<div
			aria-label={ariaLabel}
			className={cx("inline-flex items-center gap-0.5 rounded-lg border p-[3px]", TRACK_CLASSES[tone], className)}
			role="group"
		>
			{options.map(option => {
				const active = option.value === value;
				return (
					<button
						aria-pressed={active}
						className={cx(
							"inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-omp-md font-medium",
							active ? ACTIVE_CLASSES[tone] : IDLE_CLASSES[tone],
						)}
						key={option.value}
						onClick={() => onChange(option.value)}
						title={option.title}
						type="button"
					>
						{option.icon}
						{option.label}
					</button>
				);
			})}
		</div>
	);
}
