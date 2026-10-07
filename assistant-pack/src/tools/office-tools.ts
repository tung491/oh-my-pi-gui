// office_report, office_slides and office_clean: check the arguments, build the file in-process
// and save it as a new file under Documents > Sai ATLAS. No shell is involved.
import { homedir } from "node:os";
import { basename, extname } from "node:path";
import { cleanWorkbook, type Decimal, type RunFile } from "../office/clean";
import {
	defaultRunXdgUserDir,
	ensureOutputDir,
	expandHome,
	type OfficeKind,
	PlainError,
	type PlainText,
	resultLine,
	safeBaseName,
	throwIfStopped,
	writeUnique,
} from "../office/output";
import { buildReport } from "../office/report";
import { buildSlides } from "../office/slides";
import {
	ArgumentError,
	asRecord,
	type JsonSchema,
	type PackExtensionApi,
	type PackTool,
	type ToolResult,
	textResult,
} from "./types";

export interface OfficeEnv {
	home: string;
	platform: NodeJS.Platform;
	runXdgUserDir: () => string;
	/** `SAI_ATLAS_LANG`: picks the decimal mark, the checks and the default file names; English unless `vi`. */
	lang: string;
	/** Runs LibreOffice for .xls and .ods input; the real `execFile` when absent. */
	convert?: RunFile;
}

export function defaultOfficeEnv(): OfficeEnv {
	return {
		home: process.env.HOME || homedir(),
		platform: process.platform,
		runXdgUserDir: defaultRunXdgUserDir,
		lang: process.env.SAI_ATLAS_LANG === "vi" ? "vi" : "en",
	};
}

const MARKDOWN_RULES =
	"Write the content in Markdown: one line starting with # for the title, a line starting with ## for each section, " +
	"short paragraphs, a line starting with - for each list item, and tables with | between the columns.";
const READ_FIRST = "If the content is in a file, read the file first and pass its text, not its path.";
const OUTPUT_RULE =
	"The file is saved in Documents > Sai ATLAS and never replaces a file that is already there. " +
	"The result is one JSON line with the saved file, its kind and a short check of what was built.";

const DOCUMENT_PARAMS: JsonSchema = {
	type: "object",
	properties: {
		markdown: { type: "string", description: "The whole content as Markdown text, in the person's language." },
		title: { type: "string", description: "The title. Leave it out to use the # line of the Markdown." },
		name: {
			type: "string",
			description: "File name without extension. Only when the person asked for a file name.",
		},
	},
	required: ["markdown"],
	additionalProperties: false,
};

const CLEAN_PARAMS: JsonSchema = {
	type: "object",
	properties: {
		file: { type: "string", description: "The path of the person's spreadsheet, copied exactly." },
		sheet: { type: "string", description: "Clean only the sheet with this name. Leave it out to clean every sheet." },
		totals: { type: "boolean", description: "true to add a totals row under each sheet." },
		decimal: {
			type: "string",
			enum: ["comma", "dot"],
			description:
				"The decimal mark in the numbers: comma when the decimal mark is a comma, dot when it is a dot. " +
				"Leave it out to follow the app language.",
		},
	},
	required: ["file"],
	additionalProperties: false,
};

/** File names the tools choose themselves; all valid on Linux, macOS and Windows. */
const NAMES = {
	en: { report: "Report", slides: "Slides", document: "Document", cleaned: "(cleaned)" },
	vi: { report: "Báo cáo", slides: "Bài trình chiếu", document: "Tài liệu", cleaned: "(đã làm sạch)" },
} as const;

function namesFor(lang: string): (typeof NAMES)[keyof typeof NAMES] {
	return lang === "vi" ? NAMES.vi : NAMES.en;
}

const PATH_PREFIX = /^(\/|~\/|\.\/|\.\.\/)/;
const PATH_SUFFIX = /\.(md|txt|docx|pdf)$/i;
const SAVE_FAILED: PlainText = {
	en: "I could not save the file in the Sai ATLAS folder.",
	vi: "Tôi không lưu được tệp vào thư mục Sai ATLAS.",
};
/** The markdown builds in-process inside the agent, so one call stays small. */
const MAX_MARKDOWN_BYTES = 1024 * 1024;
const UNEXPECTED = new PlainError({
	en: "Something went wrong while making the file.",
	vi: "Đã có lỗi khi tạo tệp.",
});

function optionalString(args: Record<string, unknown>, key: string, message: string): string | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new ArgumentError(message);
	return value.trim() === "" ? undefined : value;
}

function requiredString(args: Record<string, unknown>, key: string, missing: string, wrongType: string): string {
	if (args[key] !== undefined && args[key] !== null && typeof args[key] !== "string")
		throw new ArgumentError(wrongType);
	const value = optionalString(args, key, wrongType);
	if (value === undefined) throw new ArgumentError(missing);
	return value;
}

/** True when the "Markdown" is only a file path: the model skipped reading the file. */
function isOnlyAPath(markdown: string): boolean {
	const trimmed = markdown.trim();
	return !trimmed.includes("\n") && (PATH_PREFIX.test(trimmed) || PATH_SUFFIX.test(trimmed));
}

function save(
	env: OfficeEnv,
	base: string,
	kind: OfficeKind,
	bytes: Uint8Array,
	check: string,
	signal: AbortSignal | undefined,
): ToolResult {
	throwIfStopped(signal);
	let file: string;
	try {
		file = writeUnique(ensureOutputDir(env), base, kind, bytes);
	} catch (error) {
		if (error instanceof PlainError) throw error;
		throw new PlainError(SAVE_FAILED);
	}
	return textResult(resultLine({ file, kind, check }));
}

/**
 * Runs a tool call and turns a failure into an error result: a sentence for the person in the
 * session language, an argument check in English for the model, and never a raw system error.
 */
async function run(lang: string, job: () => Promise<ToolResult>): Promise<ToolResult> {
	try {
		return await job();
	} catch (error) {
		if (error instanceof ArgumentError) return textResult(error.message, true);
		return textResult((error instanceof PlainError ? error : UNEXPECTED).inLanguage(lang), true);
	}
}

function documentTool(env: OfficeEnv, kind: "docx" | "pptx"): PackTool {
	const report = kind === "docx";
	return {
		name: report ? "office_report" : "office_slides",
		label: report ? "Word report" : "Slides",
		description: report
			? `Make a Word document (.docx) from Markdown. ${MARKDOWN_RULES} ${READ_FIRST} ${OUTPUT_RULE}`
			: "Make a slide deck (.pptx) from Markdown. " +
				`${MARKDOWN_RULES} The # line becomes the title slide and each ## section becomes a slide; ` +
				`a section with many points continues on a second slide. ${READ_FIRST} ${OUTPUT_RULE}`,
		parameters: DOCUMENT_PARAMS,
		approval: "write",
		loadMode: "essential",
		execute: (_toolCallId, params, signal) =>
			run(env.lang, async () => {
				throwIfStopped(signal);
				const args = asRecord(params);
				const markdown = requiredString(
					args,
					"markdown",
					"The markdown text is missing.",
					"The markdown must be text.",
				);
				const title = optionalString(args, "title", "The title must be text.");
				const name = optionalString(args, "name", "The file name must be text.");
				if (isOnlyAPath(markdown)) throw new ArgumentError("Read the file first, then pass its text as markdown.");
				if (Buffer.byteLength(markdown) > MAX_MARKDOWN_BYTES) {
					throw new ArgumentError("The text is too long for one file. Split it into smaller parts.");
				}
				const names = namesFor(env.lang);
				const fallbackTitle = name?.trim() || (report ? names.report : names.slides);
				const input = { markdown, title, fallbackTitle, lang: env.lang };
				const built = report ? await buildReport(input) : await buildSlides(input);
				return save(env, safeBaseName(name ?? built.title, names.document), kind, built.bytes, built.check, signal);
			}),
	};
}

function cleanTool(env: OfficeEnv): PackTool {
	return {
		name: "office_clean",
		label: "Clean spreadsheet",
		description:
			"Make a tidy copy of a spreadsheet (.xlsx, .xls, .ods or .csv): trims extra spaces, removes empty and " +
			"duplicate rows, turns numbers stored as text into numbers, keeps phone numbers and ID codes as text, " +
			"and can add a totals row. A Changes sheet lists what was done. The person's own file is never changed. " +
			OUTPUT_RULE,
		parameters: CLEAN_PARAMS,
		approval: "write",
		loadMode: "essential",
		execute: (_toolCallId, params, signal) =>
			run(env.lang, async () => {
				throwIfStopped(signal);
				const args = asRecord(params);
				const file = requiredString(
					args,
					"file",
					"The spreadsheet path is missing.",
					"The spreadsheet path must be text.",
				);
				const sheet = optionalString(args, "sheet", "The sheet name must be text.");
				const totals = args.totals;
				if (totals !== undefined && totals !== null && typeof totals !== "boolean") {
					throw new ArgumentError("Totals must be true or false.");
				}
				const decimal = args.decimal;
				if (decimal !== undefined && decimal !== null && decimal !== "comma" && decimal !== "dot") {
					throw new ArgumentError("The decimal mark must be comma or dot.");
				}
				const inPath = expandHome(file.trim(), env.home);
				const cleaned = await cleanWorkbook(inPath, {
					sheet,
					totals: totals === true,
					decimal: (decimal ?? undefined) as Decimal | undefined,
					lang: env.lang,
					convert: env.convert,
					signal,
				});
				const names = namesFor(env.lang);
				const base = `${safeBaseName(basename(inPath, extname(inPath)), names.document)} ${names.cleaned}`;
				return save(env, base, "xlsx", cleaned.bytes, cleaned.check, signal);
			}),
	};
}

export function createOfficeTools(env: OfficeEnv = defaultOfficeEnv()): PackTool[] {
	return [documentTool(env, "docx"), documentTool(env, "pptx"), cleanTool(env)];
}

export function registerOfficeTools(pi: PackExtensionApi, env: OfficeEnv = defaultOfficeEnv()): void {
	for (const tool of createOfficeTools(env)) pi.registerTool(tool);
}
