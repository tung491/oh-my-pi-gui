/**
 * Language switcher: compact globe button that toggles the UI between
 * English and Tiếng Việt. Reads and persists the active language through useLang()
 * (localStorage LANG_KEY inside I18nProvider), so no extra wiring is needed —
 * mount it anywhere under the provider. Rendered label shows the CURRENT
 * language autonym ("EN" / "VI"), matching OS-language-picker convention.
 *
 * Mount points (wired by the shell owner): TitleBar trailing icon row and the
 * Settings window GUI tab.
 */

import { Globe } from "lucide-react";
import { useCallback } from "react";
import { cx } from "../../lib/format";
import { type Lang, translateForLang, useLang, useT } from "../../lib/i18n";
import { toast } from "../../stores/toast";

export type LangSwitcherTone = "default" | "onDark";

export interface LangSwitcherProps {
	className?: string;
	/** `onDark` swaps to the sidebar tokens so the control reads on navy chrome. */
	tone?: LangSwitcherTone;
}

const TONE_CLASSES: Record<LangSwitcherTone, string> = {
	default: "text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]",
	onDark:
		"text-[var(--omp-sidebar-muted)] hover:bg-[var(--omp-sidebar-item-hover)] hover:text-[var(--omp-sidebar-text)]",
};

/**
 * Switches the interface language at once. The assistant reads the language
 * only when it starts, so a note in the new language says when it follows;
 * the sidecar is not restarted, which would cut off a running task.
 */
export function useSwitchLanguage(): (next: Lang) => void {
	const { setLang } = useLang();
	return useCallback(
		(next: Lang) => {
			setLang(next);
			toast({ variant: "info", message: translateForLang(next, "lang.assistantNextLaunch") });
		},
		[setLang],
	);
}

export function LangSwitcher({ className, tone = "default" }: LangSwitcherProps) {
	const { lang } = useLang();
	const switchLanguage = useSwitchLanguage();
	const t = useT();
	const next = lang === "en" ? "vi" : "en";
	return (
		<button
			type="button"
			onClick={() => switchLanguage(next)}
			title={t("lang.switch")}
			aria-label={t("lang.switch")}
			className={cx(
				"no-drag omp-pressable flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-omp-md font-medium",
				TONE_CLASSES[tone],
				className,
			)}
			data-tone={tone}
		>
			<Globe size={16} />
			<span>{lang === "en" ? "EN" : "VI"}</span>
		</button>
	);
}
