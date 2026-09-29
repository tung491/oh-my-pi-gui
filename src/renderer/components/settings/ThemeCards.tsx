/**
 * Preview cards for the three first-party theme choices on the GUI settings
 * page: VIF Light, VIF Navy, and following the OS. Choosing a card applies and
 * saves the selection the same way the theme picker does; the picker button
 * beside the cards still reaches every other named theme, and while one of
 * those is saved no card is pressed.
 */

import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import {
	applyThemeByName,
	getPersistedThemeSelection,
	resolveTokenColor,
	THEMES,
	type ThemeName,
	type ThemeSelection,
} from "../../lib/themes";
import { useUiStore } from "../../stores/ui";

type ThemeCardId = "light" | "dark" | "system";

interface ThemeCard {
	id: ThemeCardId;
	labelKey: string;
	/** Themes previewed on the card; "system" shows both it can resolve to. */
	previews: readonly ThemeName[];
}

const THEME_CARDS: readonly ThemeCard[] = [
	{ id: "light", labelKey: "themePicker.theme.light.label", previews: ["light"] },
	{ id: "dark", labelKey: "themePicker.theme.dark.label", previews: ["dark"] },
	{ id: "system", labelKey: "themePicker.system", previews: ["light", "dark"] },
];

export function ThemeCards() {
	const t = useT();
	// null until the saved selection is read; a click before then wins.
	const [selection, setSelection] = useState<ThemeSelection | null>(null);

	useEffect(() => {
		let cancelled = false;
		void getPersistedThemeSelection().then(saved => {
			if (!cancelled) setSelection(current => current ?? saved);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const choose = (id: ThemeCardId) => {
		applyThemeByName(id);
		useUiStore.getState().setTheme(id === "system" ? "system" : THEMES[id].scheme);
		setSelection(id);
	};

	return (
		<div aria-label={t("settings.gui.themeCards")} className="mb-3 grid grid-cols-3 gap-3" role="group">
			{THEME_CARDS.map(card => {
				const pressed = selection === card.id;
				return (
					<button
						aria-pressed={pressed}
						className={cx(
							"flex min-w-0 flex-col gap-2.5 rounded-md border bg-(--omp-bg-elevated) p-2 pb-2.5 text-left",
							pressed
								? "border-(--omp-accent) shadow-[0_0_0_4px_var(--omp-accent-glow)]"
								: "border-(--omp-border) hover:border-(--omp-border-accent)",
						)}
						key={card.id}
						onClick={() => choose(card.id)}
						type="button"
					>
						<span
							aria-hidden="true"
							className="flex h-[76px] overflow-hidden rounded-sm border border-(--omp-border-muted)"
						>
							{card.previews.map(name => (
								<span className="flex min-w-0 flex-1" key={name}>
									<span
										className="w-[26%] shrink-0"
										style={{ background: resolveTokenColor(THEMES[name], "--omp-sidebar-bg") }}
									/>
									<span
										className="min-w-0 flex-1"
										style={{ background: resolveTokenColor(THEMES[name], "--omp-bg-primary") }}
									/>
								</span>
							))}
						</span>
						<span className="flex items-center gap-2 px-1">
							<span className="min-w-0 flex-1 truncate text-omp-md font-semibold text-(--omp-text)">
								{t(card.labelKey)}
							</span>
							<span
								aria-hidden="true"
								className={cx(
									"flex size-[18px] shrink-0 items-center justify-center rounded-full",
									pressed ? "bg-(--omp-brand) text-(--omp-btn-primary-text)" : "border border-(--omp-border)",
								)}
							>
								{pressed && <Check size={11} strokeWidth={3} />}
							</span>
						</span>
					</button>
				);
			})}
		</div>
	);
}
