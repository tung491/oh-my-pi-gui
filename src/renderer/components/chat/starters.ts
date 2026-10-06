/**
 * Empty-state starter cards: one per everyday job. A file job asks for the
 * input file, then runs its pack skill on it through the composer's own send
 * path (`/skill:<name> '<path>'`, which RPC mode expands into the skill
 * prompt). The helpdesk job opens no dialog and runs in the main session.
 */

import { isPromptSafePath, quotePromptPath } from "../layout/attach-document";

export interface DialogFilter {
	name: string;
	extensions: string[];
}

export interface Starter {
	id: "word-report" | "spreadsheet-cleanup" | "slides-from-report" | "helpdesk";
	/** Pack skill the card runs. */
	skill: string;
	/** Locale key of the card's label. */
	titleKey: string;
	/** File-dialog filters; absent for a job that takes no file. */
	filters?: DialogFilter[];
	/** SAI OS help only exists for Linux desktops. */
	linuxOnly: boolean;
}

export const STARTERS: readonly Starter[] = [
	{
		id: "word-report",
		skill: "word-report",
		titleKey: "chat.starter.wordReport.title",
		filters: [{ name: "Documents", extensions: ["md", "txt", "docx", "pdf"] }],
		linuxOnly: false,
	},
	{
		id: "spreadsheet-cleanup",
		skill: "spreadsheet-cleanup",
		titleKey: "chat.starter.spreadsheetCleanup.title",
		filters: [{ name: "Spreadsheets", extensions: ["xlsx", "xls", "ods", "csv"] }],
		linuxOnly: false,
	},
	{
		id: "slides-from-report",
		skill: "slides-from-report",
		titleKey: "chat.starter.slidesFromReport.title",
		filters: [{ name: "Documents", extensions: ["docx", "md", "txt", "pdf"] }],
		linuxOnly: false,
	},
	{
		id: "helpdesk",
		skill: "sai-os-helpdesk",
		titleKey: "chat.starter.helpdesk.title",
		linuxOnly: true,
	},
];

/** The cards shown on this host (`window.omp.platform`). */
export function startersFor(platform: string | undefined): Starter[] {
	return STARTERS.filter(starter => !starter.linuxOnly || platform === "linux");
}

export interface StarterDeps {
	showOpenDialog(filters: DialogFilter[]): Promise<string[] | null>;
	/** The composer's Send path. */
	send(text: string): void;
	/** Tells the person why nothing was sent. */
	warn(message: string): void;
	t(key: string): string;
}

export async function runStarter(starter: Starter, deps: StarterDeps): Promise<void> {
	if (!starter.filters) {
		deps.send(`/skill:${starter.skill} ${deps.t("chat.starter.helpdesk.prompt")}`);
		return;
	}
	const paths = await deps.showOpenDialog(starter.filters);
	if (!paths || paths.length === 0) return;
	if (!paths.every(isPromptSafePath)) {
		deps.warn(deps.t("input.attach.unusualName"));
		return;
	}
	deps.send(`/skill:${starter.skill} ${paths.map(quotePromptPath).join(" ")}`);
}
