/**
 * The VIF mark paired with the "omp" wordmark: the bundled 2x logo raster, a
 * hairline divider in the current text color, and the wordmark in the display
 * face. The raster ships from the renderer public dir, so it loads offline.
 */
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";

export interface VifLogoProps {
	/** Logo height in px; the width follows the raster's aspect ratio. */
	height?: number;
	className?: string;
}

export function VifLogo({ height = 18, className }: VifLogoProps) {
	const t = useT();
	return (
		<span className={cx("inline-flex items-center gap-2", className)}>
			<img src="./vif-logo.png" alt={t("brand.vif")} className="block w-auto shrink-0" style={{ height }} />
			<span aria-hidden="true" className="w-px self-stretch bg-current opacity-30" />
			<span className="font-display font-semibold">{t("brand.wordmark")}</span>
		</span>
	);
}
