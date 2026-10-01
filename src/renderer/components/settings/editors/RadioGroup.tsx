/**
 * RadioGroup component: a styled radio button group with label and optional description.
 * Used in settings pages for single-choice configuration options (`compact`, the
 * default) and as larger selectable cards (`card`) in onboarding.
 */

import type { ReactNode } from "react";

export function RadioGroup<T extends string>({
	value,
	onChange,
	options,
	name,
	label,
	variant = "compact",
}: {
	value: T;
	onChange: (value: T) => void;
	options: { value: T; label: string; description?: string; badge?: ReactNode }[];
	name: string;
	/** Accessible name of the group. */
	label?: string;
	variant?: "compact" | "card";
}) {
	const card = variant === "card";
	return (
		<div aria-label={label} className={card ? "space-y-2" : "space-y-1"} role="radiogroup">
			{options.map(option => {
				const selected = value === option.value;
				const optionLabel = (
					<span
						className={
							card
								? "block text-omp-lg font-medium text-(--omp-text)"
								: "block text-xs font-medium text-(--omp-text)"
						}
					>
						{option.label}
					</span>
				);
				return (
					<label
						className={
							card
								? `flex cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-3 transition-colors ${
										selected
											? "border-(--omp-accent) bg-(--omp-selected-bg)"
											: "border-(--omp-border) hover:bg-(--omp-bg-secondary)"
									}`
								: `flex cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-2 transition-colors ${
										selected
											? "border-(--omp-border-accent) bg-[color-mix(in_srgb,var(--omp-link)_8%,transparent)]"
											: "border-(--omp-border-muted) hover:bg-(--omp-bg-tertiary)"
									}`
						}
						key={option.value}
					>
						<input
							checked={selected}
							className={
								card ? "mt-0.5 size-[18px] shrink-0 accent-(--omp-accent)" : "mt-0.5 accent-(--omp-accent)"
							}
							name={name}
							onChange={() => onChange(option.value)}
							type="radio"
						/>
						<span className="min-w-0">
							{option.badge ? (
								<span className="flex flex-wrap items-center gap-2">
									{optionLabel}
									{option.badge}
								</span>
							) : (
								optionLabel
							)}
							{option.description && (
								<span
									className={
										card
											? "mt-0.5 block text-omp-md leading-snug text-(--omp-muted)"
											: "mt-0.5 block text-omp-sm leading-snug text-(--omp-muted)"
									}
								>
									{option.description}
								</span>
							)}
						</span>
					</label>
				);
			})}
		</div>
	);
}
