/**
 * The strip of what this machine has — memory and graphics — at the top of the
 * welcome screen. While the machine is being read it draws the same two slots
 * as placeholders, so the strip does not change height when the answers land.
 */

import type { MachineFacts as MachineFactsValue } from "../../../shared/ollama-types";
import { useT } from "../../lib/i18n";
import "./welcome-screen.css";

/** Decimal gigabytes with one decimal, as the Ollama library prints sizes. */
export function formatGigabytes(bytes: number): string {
	return `${(bytes / 1e9).toFixed(1)} GB`;
}

export interface MachineFactsProps {
	/** undefined while the machine is being read; null when it could not be read. */
	machine: MachineFactsValue | null | undefined;
}

const FACT_SLOTS = ["memory", "graphics"] as const;

function graphicsFact(machine: MachineFactsValue, t: ReturnType<typeof useT>): string {
	if (machine.gpuName && machine.vramBytes !== null && machine.vramBytes > 0) {
		return t("welcome.fact.graphics", { name: machine.gpuName, size: formatGigabytes(machine.vramBytes) });
	}
	return t("welcome.fact.graphicsNone");
}

export function MachineFacts({ machine }: MachineFactsProps) {
	const t = useT();

	if (machine === undefined) {
		return (
			<div aria-busy="true" className="omp-welcome-facts text-omp-md" data-state="loading">
				{FACT_SLOTS.map(slot => (
					<div className="omp-welcome-fact" data-fact={slot} key={slot}>
						<span aria-hidden="true" className="omp-skeleton omp-welcome-wait" style={{ width: "9rem" }} />
					</div>
				))}
			</div>
		);
	}

	// An unread machine reports nothing: placeholder bars would say answers are still coming.
	if (machine === null) return <div className="omp-welcome-facts text-omp-md" data-state="unread" />;

	return (
		<div className="omp-welcome-facts text-omp-md" data-state="ready">
			<div className="omp-welcome-fact" data-fact="memory">
				{t("welcome.fact.memory", { size: formatGigabytes(machine.ramBytes) })}
			</div>
			<div className="omp-welcome-fact" data-fact="graphics">
				{graphicsFact(machine, t)}
			</div>
		</div>
	);
}
