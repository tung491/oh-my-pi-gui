/**
 * The Sai ATLAS brand artwork: the compact lockup or the app-icon tile. Both
 * tones render, and styles/components.css shows the one for the surface
 * underneath — page surfaces follow `data-theme`, sidebar surfaces follow
 * `data-sidebar-scheme` (lib/themes.ts). The files are `<img>`s rather than
 * inline SVG because the artwork reuses fixed gradient ids.
 */
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";

export interface SaiAtlasLogoProps {
	/** The wordmark lockup, or the square app icon. */
	kind: "lockup" | "icon";
	/** The surface the logo sits on, which picks the tone. */
	surface: "page" | "sidebar";
	/** Height in px; the width follows the artwork's aspect ratio. */
	height: number;
	className?: string;
	"data-assistant-avatar"?: string;
}

export function SaiAtlasLogo({
	kind,
	surface,
	height,
	className,
	"data-assistant-avatar": assistantAvatar,
}: SaiAtlasLogoProps) {
	const t = useT();
	const alt = kind === "lockup" ? t("brand.name") : "";
	return (
		<span
			aria-hidden={kind === "icon" ? "true" : undefined}
			className={cx("inline-flex shrink-0", className)}
			data-assistant-avatar={assistantAvatar}
			data-logo-surface={surface}
		>
			<img
				alt={alt}
				className="w-auto"
				data-logo-tone="dark"
				src={`./brand/sai-atlas-${kind}-on-dark.svg`}
				style={{ height }}
			/>
			<img
				alt={alt}
				className="w-auto"
				data-logo-tone="light"
				src={`./brand/sai-atlas-${kind}-on-light.svg`}
				style={{ height }}
			/>
		</span>
	);
}
