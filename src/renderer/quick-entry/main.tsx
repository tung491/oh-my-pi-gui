import "@boot";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../lib/i18n";
import { QuickEntryBar } from "./QuickEntryBar";
import "../styles/global.css";
import "../styles/theme-dark.css";
import "../styles/theme-light.css";
import "../styles/components.css";

const api = window.ompQuickEntry;
if (!api) throw new Error("Quick entry bar loaded without window.ompQuickEntry; check src/renderer/boot/boot-tauri.ts");
const container = document.getElementById("root");
if (!container) throw new Error("Quick entry root container #root not found");

createRoot(container).render(
	<I18nProvider>
		<QuickEntryBar api={api} />
	</I18nProvider>,
);
