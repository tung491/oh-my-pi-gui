/**
 * Settings → Agent advanced → Tab hibernation: the opt-in toggle and its idle
 * time. Main parses the stored value again before the pool sees it, so this
 * form only has to keep the user's draft sensible.
 */
import { useEffect, useState } from "react";
import {
	DEFAULT_TAB_HIBERNATION,
	parseTabHibernationPref,
	TAB_HIBERNATION_MAX_MINUTES,
	TAB_HIBERNATION_MIN_MINUTES,
	TAB_HIBERNATION_PREF_KEY,
	type TabHibernationPref,
} from "../../../shared/tab-hibernation";
import { saveGuiPreference } from "../../lib/display-preferences";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { toast } from "../../stores/toast";
import { Input } from "../common";
import { Section } from "./editors/Section";
import { Toggle } from "./editors/Toggle";

export function TabHibernationSection({ open }: { open: boolean }) {
	const t = useT();
	const [pref, setPref] = useState<TabHibernationPref>({ ...DEFAULT_TAB_HIBERNATION });
	const [minutesDraft, setMinutesDraft] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setMinutesDraft(null);
		void window.omp.prefs
			.get(TAB_HIBERNATION_PREF_KEY)
			.then(raw => {
				if (!cancelled) setPref(parseTabHibernationPref(raw));
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [open]);

	const save = async (next: TabHibernationPref) => {
		setSaving(true);
		await saveGuiPreference(TAB_HIBERNATION_PREF_KEY, next, () => setPref(next));
		setSaving(false);
	};

	const commitMinutes = () => {
		if (minutesDraft === null) return;
		const parsed = Number(minutesDraft);
		setMinutesDraft(null);
		if (
			minutesDraft.trim() === "" ||
			!Number.isFinite(parsed) ||
			parsed < TAB_HIBERNATION_MIN_MINUTES ||
			parsed > TAB_HIBERNATION_MAX_MINUTES
		) {
			toast({
				variant: "warning",
				message: t("settings.gui.hibernationMinutesRange", {
					min: TAB_HIBERNATION_MIN_MINUTES,
					max: TAB_HIBERNATION_MAX_MINUTES,
				}),
			});
			return;
		}
		const next = parseTabHibernationPref({ ...pref, idleMinutes: parsed });
		if (next.idleMinutes !== pref.idleMinutes) void save(next);
	};

	return (
		<Section id="setting-gui-hibernation" title={t("settings.gui.hibernation")}>
			<Toggle
				checked={pref.enabled}
				description={t("settings.gui.hibernationDesc")}
				disabled={saving}
				label={t("settings.gui.hibernationToggle")}
				onChange={enabled => void save({ ...pref, enabled })}
			/>
			<label className="mt-2 block px-2">
				<span className="mb-1 block text-xs font-medium text-(--omp-text)">
					{t("settings.gui.hibernationMinutes")}
				</span>
				<div className="w-40">
					<Input
						disabled={saving}
						max={TAB_HIBERNATION_MAX_MINUTES}
						min={TAB_HIBERNATION_MIN_MINUTES}
						onBlur={commitMinutes}
						onChange={event => setMinutesDraft(event.target.value)}
						onKeyDown={event => {
							if (isImeKeyEvent(event)) return;
							if (event.key === "Enter") event.currentTarget.blur();
						}}
						type="number"
						value={minutesDraft ?? String(pref.idleMinutes)}
					/>
				</div>
			</label>
		</Section>
	);
}
