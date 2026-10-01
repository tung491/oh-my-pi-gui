/**
 * Ordered step rail for multi-step flows. It sits on a `--omp-btn-primary-bg`
 * surface the caller paints; the current step inverts that primary pair, which
 * keeps it readable and distinct in every theme.
 */

import { cx } from "../../lib/format";

export interface StepListProps {
	/** Step labels, in order. */
	steps: readonly string[];
	/** Index of the current step. */
	current: number;
	/** Accessible name of the step navigation. */
	ariaLabel: string;
	className?: string;
}

export function StepList({ steps, current, ariaLabel, className }: StepListProps) {
	return (
		<nav aria-label={ariaLabel} className={className}>
			<ol className="flex flex-col gap-1">
				{steps.map((step, index) => {
					const active = index === current;
					return (
						<li
							aria-current={active ? "step" : undefined}
							className={cx(
								"rounded-md px-3 py-2 text-omp-md",
								active
									? "bg-(--omp-btn-primary-text) font-semibold text-(--omp-btn-primary-bg)"
									: "text-(--omp-btn-primary-text)",
							)}
							key={index}
						>
							{step}
						</li>
					);
				})}
			</ol>
		</nav>
	);
}
