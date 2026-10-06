import { describe, expect, it, vi } from "vitest";
import { en } from "../../locales/en";
import { runStarter, STARTERS, type Starter, type StarterDeps, startersFor } from "./starters";

function starter(id: Starter["id"]): Starter {
	const found = STARTERS.find(entry => entry.id === id);
	if (!found) throw new Error(`starter ${id} missing`);
	return found;
}

function deps(dialogResult: string[] | null) {
	const showOpenDialog = vi.fn<StarterDeps["showOpenDialog"]>(async () => dialogResult);
	const send = vi.fn<StarterDeps["send"]>();
	const warn = vi.fn<StarterDeps["warn"]>();
	const t = (key: string) => en[key] ?? key;
	return { showOpenDialog, send, warn, t };
}

describe("starter cards", () => {
	it("lists the four everyday jobs with their skills, filters and platform", () => {
		expect(STARTERS.map(({ id, skill, filters, linuxOnly }) => ({ id, skill, filters, linuxOnly }))).toEqual([
			{
				id: "word-report",
				skill: "word-report",
				filters: [{ name: "Documents", extensions: ["md", "txt", "docx", "pdf"] }],
				linuxOnly: false,
			},
			{
				id: "spreadsheet-cleanup",
				skill: "spreadsheet-cleanup",
				filters: [{ name: "Spreadsheets", extensions: ["xlsx", "xls", "ods", "csv"] }],
				linuxOnly: false,
			},
			{
				id: "slides-from-report",
				skill: "slides-from-report",
				filters: [{ name: "Documents", extensions: ["docx", "md", "txt", "pdf"] }],
				linuxOnly: false,
			},
			{ id: "helpdesk", skill: "sai-os-helpdesk", filters: undefined, linuxOnly: true },
		]);
	});

	it("offers the helpdesk only on Linux", () => {
		expect(startersFor("linux").map(entry => entry.id)).toEqual([
			"word-report",
			"spreadsheet-cleanup",
			"slides-from-report",
			"helpdesk",
		]);
		expect(startersFor("darwin").map(entry => entry.id)).toEqual([
			"word-report",
			"spreadsheet-cleanup",
			"slides-from-report",
		]);
	});

	it("sends nothing when the file dialog is cancelled", async () => {
		for (const result of [null, []]) {
			const d = deps(result);
			await runStarter(starter("word-report"), d);
			expect(d.showOpenDialog).toHaveBeenCalledWith([
				{ name: "Documents", extensions: ["md", "txt", "docx", "pdf"] },
			]);
			expect(d.send).not.toHaveBeenCalled();
		}
	});

	it("runs the starter's skill on the chosen file", async () => {
		const d = deps(["/home/u/notes.md"]);
		await runStarter(starter("word-report"), d);
		expect(d.send).toHaveBeenCalledTimes(1);
		expect(d.send).toHaveBeenCalledWith("/skill:word-report '/home/u/notes.md'");
	});

	it("quotes a chosen file whose name has an apostrophe", async () => {
		const d = deps(["/home/u/Bob's notes.docx"]);
		await runStarter(starter("word-report"), d);
		expect(d.send).toHaveBeenCalledWith(`/skill:word-report "/home/u/Bob's notes.docx"`);
	});

	it("refuses a chosen file whose name holds a line break", async () => {
		const d = deps(["/home/u/notes.md\n../../x.md"]);
		await runStarter(starter("word-report"), d);
		expect(d.send).not.toHaveBeenCalled();
		expect(d.warn).toHaveBeenCalledWith(en["input.attach.unusualName"]);
	});

	it("starts the helpdesk without a file dialog, in the session language", async () => {
		const d = deps(["/never/used"]);
		await runStarter(starter("helpdesk"), d);
		expect(d.showOpenDialog).toHaveBeenCalledTimes(0);
		expect(d.send).toHaveBeenCalledWith("/skill:sai-os-helpdesk I need help with my computer.");
	});
});
