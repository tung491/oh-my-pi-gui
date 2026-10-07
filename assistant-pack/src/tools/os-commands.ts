// The four SAI OS tools: system_status, diagnose, open_item and os_setting. Every command is a
// fixed argv array from a closed list, run without a shell; nothing the model sends becomes a
// command name, and only checked values (a path, an app id, a panel, a number) become arguments.
import { execFile as nodeExecFile, spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { expandHome, inLanguage, isInsideDir, PlainError, type PlainText } from "../office/output";
import { ArgumentError, asRecord, type PackTool, type ToolResult, textResult } from "./types";

/** Runs a short read or set command and resolves with its output; rejects on failure or timeout. */
export type ExecFile = (
	file: string,
	args: readonly string[],
	options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

/** Starts a program that keeps running on its own (a document viewer, a settings window). */
export type Launch = (file: string, args: readonly string[]) => Promise<void>;

export interface OsEnv {
	platform: NodeJS.Platform;
	home: string;
	/** `SAI_ATLAS_LANG`: the language of the approval, result and error sentences; English unless `vi`. */
	lang: string;
	/** System-wide .desktop files; the person's own folder is never consulted. */
	applicationsDir: string;
	/**
	 * GLib's `gio`, which launches a .desktop file by its absolute path. Launchers that take an
	 * app id resolve it through the person's own applications folder first, so none is used.
	 */
	gioPath: string;
	execFile: ExecFile;
	launch: Launch;
}

export interface Check {
	/** Shown in front of the command output, in the session language; the output itself stays as printed. */
	label: PlainText;
	argv: readonly string[];
	/** Keeps only the output lines that match, for a command that prints far more than the answer. */
	keep?: RegExp;
}

export const DIAGNOSE_AREAS = [
	"network",
	"sound",
	"printer",
	"storage",
	"performance",
	"bluetooth",
	"display",
	"typing",
	"updates",
] as const;
export type DiagnoseArea = (typeof DIAGNOSE_AREAS)[number];

export const OPENABLE = [
	"docx",
	"xlsx",
	"pptx",
	"odt",
	"ods",
	"odp",
	"pdf",
	"txt",
	"md",
	"csv",
	"png",
	"jpg",
	"jpeg",
	"webp",
] as const;

/** GNOME Settings panel ids, each opened as `gnome-control-center <panel>`; `background` is the Appearance page. */
export const SETTINGS_PANELS = [
	"network",
	"wifi",
	"bluetooth",
	"display",
	"sound",
	"printers",
	"power",
	"keyboard",
	"notifications",
	"background",
] as const;

const OS_SETTINGS = ["dark_mode", "night_light", "do_not_disturb", "volume", "text_size"] as const;
type OsSetting = (typeof OS_SETTINGS)[number];

const COMMAND_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_LINES = 12;
const MAX_OUTPUT_CHARS = 1_200;
const ONLY_SAI_OS: PlainText = { en: "This works only on SAI OS.", vi: "Tính năng này chỉ dùng được trên SAI OS." };
const NOT_AVAILABLE: PlainText = {
	en: "This is not available on this computer.",
	vi: "Máy tính này không có tính năng này.",
};
const DOCUMENTS_ONLY: PlainText = {
	en: "I can only open documents and pictures.",
	vi: "Tôi chỉ mở được tài liệu và hình ảnh.",
};
const PATH_NOT_FOUND: PlainText = {
	en: "I could not find that file or folder.",
	vi: "Tôi không tìm thấy tệp hoặc thư mục đó.",
};
const HOME_ONLY: PlainText = {
	en: "I can only open files and folders in your home folder.",
	vi: "Tôi chỉ mở được tệp và thư mục trong thư mục nhà của bạn.",
};
const NOT_A_FOLDER: PlainText = { en: "That is not a folder.", vi: "Đó không phải là thư mục." };
const NOT_A_FILE: PlainText = { en: "That is not a file.", vi: "Đó không phải là tệp." };
const APP_NOT_FOUND: PlainText = { en: "I could not find that app.", vi: "Tôi không tìm thấy ứng dụng đó." };
const OPEN_FAILED: PlainText = { en: "I could not open it.", vi: "Tôi không mở được mục này." };
const SETTING_FAILED: PlainText = {
	en: "I could not change that setting.",
	vi: "Tôi không thay đổi được cài đặt đó.",
};
const UNEXPECTED: PlainText = {
	en: "Something went wrong on this computer.",
	vi: "Đã có lỗi trên máy tính này.",
};
const OPENED: PlainText = { en: "Opened.", vi: "Đã mở." };
/** Words around the label of a check whose command printed nothing or does not exist. */
const NOTHING_FOUND: PlainText = { en: "nothing found", vi: "không tìm thấy gì" };
const UNAVAILABLE: PlainText = { en: "not available", vi: "không có trên máy này" };
const NO_BATTERY: PlainText = { en: "no battery found", vi: "không tìm thấy pin" };
const BATTERY: PlainText = { en: "Battery", vi: "Pin" };

const df = (path: string): readonly string[] => ["df", "-h", "--output=target,size,avail,pcent", path];

const CHECKS: Record<DiagnoseArea, readonly Check[]> = {
	network: [
		{ label: { en: "Connection", vi: "Kết nối" }, argv: ["nmcli", "-t", "-f", "STATE,CONNECTIVITY", "general"] },
		{ label: { en: "Wi-Fi radio", vi: "Sóng Wi-Fi" }, argv: ["nmcli", "-t", "-f", "WIFI", "radio"] },
		{
			label: { en: "Devices", vi: "Thiết bị" },
			argv: ["nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device"],
		},
	],
	sound: [
		{
			label: { en: "Default output", vi: "Đầu ra mặc định" },
			argv: ["wpctl", "inspect", "@DEFAULT_AUDIO_SINK@"],
			keep: /\bnode\.description\b/,
		},
		// wpctl prints "Volume: 0.34", with " [MUTED]" appended when the output is muted.
		{
			label: { en: "Volume and mute", vi: "Âm lượng và tắt tiếng" },
			argv: ["wpctl", "get-volume", "@DEFAULT_AUDIO_SINK@"],
		},
	],
	printer: [
		{ label: { en: "Printers", vi: "Máy in" }, argv: ["lpstat", "-p", "-d"] },
		{ label: { en: "Waiting print jobs", vi: "Lệnh in đang chờ" }, argv: ["lpstat", "-o"] },
	],
	storage: [
		{ label: { en: "Home disk", vi: "Ổ đĩa thư mục nhà" }, argv: df("/home") },
		{ label: { en: "System disk", vi: "Ổ đĩa hệ thống" }, argv: df("/") },
	],
	performance: [
		{ label: { en: "Running time and load", vi: "Thời gian chạy và mức tải" }, argv: ["uptime"] },
		{ label: { en: "Memory", vi: "Bộ nhớ" }, argv: ["free", "-h"] },
		{
			label: { en: "Busiest programs", vi: "Chương trình bận nhất" },
			argv: ["ps", "-eo", "comm,%cpu,%mem", "--sort=-%cpu"],
		},
	],
	bluetooth: [
		{ label: { en: "Bluetooth radio", vi: "Sóng Bluetooth" }, argv: ["rfkill", "list", "bluetooth"] },
		{ label: { en: "Bluetooth adapter", vi: "Bộ điều hợp Bluetooth" }, argv: ["bluetoothctl", "show"] },
	],
	display: [
		{
			label: {
				en: "Screens (XWayland view, may not list every screen or its real size)",
				vi: "Màn hình (theo XWayland, có thể thiếu màn hình hoặc sai kích thước thật)",
			},
			argv: ["xrandr", "--listmonitors"],
		},
		{
			label: { en: "Colour scheme", vi: "Bảng màu" },
			argv: ["gsettings", "get", "org.gnome.desktop.interface", "color-scheme"],
		},
		{
			label: { en: "Night light", vi: "Ánh sáng ban đêm" },
			argv: ["gsettings", "get", "org.gnome.settings-daemon.plugins.color", "night-light-enabled"],
		},
		{
			label: { en: "Text size", vi: "Cỡ chữ" },
			argv: ["gsettings", "get", "org.gnome.desktop.interface", "text-scaling-factor"],
		},
	],
	typing: [
		{ label: { en: "Input method setting", vi: "Cài đặt bộ gõ" }, argv: ["im-config", "-m"] },
		{ label: { en: "IBus running", vi: "IBus đang chạy" }, argv: ["pgrep", "-l", "-x", "ibus-daemon"] },
		{ label: { en: "Fcitx running", vi: "Fcitx đang chạy" }, argv: ["pgrep", "-l", "-x", "fcitx5"] },
	],
	updates: [{ label: { en: "Waiting updates", vi: "Bản cập nhật đang chờ" }, argv: ["apt", "list", "--upgradable"] }],
};

/** System monitors in order of preference: Resources ships with Ubuntu 26.04, the GNOME one with 24.04. */
const SYSTEM_MONITORS = ["net.nokyan.Resources", "gnome-system-monitor"] as const;

const FIXES: Record<Exclude<DiagnoseArea, "performance">, string> = {
	network: "open_item settings wifi or network",
	sound: "os_setting volume; open_item settings sound",
	printer: "open_item settings printers",
	storage: "open_item folder (to show the person a folder in their home folder)",
	bluetooth: "open_item settings bluetooth",
	display: "os_setting dark_mode, night_light or text_size; open_item settings display or background",
	typing: "open_item settings keyboard",
	updates: "open_item app update-manager",
};

function fixesFor(area: DiagnoseArea, applicationsDir: string): string {
	if (area !== "performance") return FIXES[area];
	const monitor = SYSTEM_MONITORS.find(id => systemDesktopEntry(id, applicationsDir));
	return monitor
		? `open_item app ${monitor}`
		: "none on this computer; tell the person which programs are busiest and suggest closing one";
}

/** Read-only checks of the overall system; the battery is looked up separately through upower. */
export const STATUS_CHECKS: readonly Check[] = [
	{ label: { en: "Disk", vi: "Ổ đĩa" }, argv: ["df", "-h", "--output=target,avail,pcent", "/home"] },
	{ label: { en: "Memory", vi: "Bộ nhớ" }, argv: ["free", "-h"] },
	{ label: { en: "Network", vi: "Mạng" }, argv: ["nmcli", "-t", "-f", "STATE", "general"] },
	{ label: { en: "Printers", vi: "Máy in" }, argv: ["lpstat", "-p", "-d"] },
];

export function diagnoseChecks(area: DiagnoseArea): readonly Check[] {
	return CHECKS[area];
}

function isOsSetting(value: unknown): value is OsSetting {
	return typeof value === "string" && (OS_SETTINGS as readonly string[]).includes(value);
}

function isArea(value: unknown): value is DiagnoseArea {
	return typeof value === "string" && (DIAGNOSE_AREAS as readonly string[]).includes(value);
}

function isPanel(value: unknown): value is (typeof SETTINGS_PANELS)[number] {
	return typeof value === "string" && (SETTINGS_PANELS as readonly string[]).includes(value);
}

/** The one argv that changes `setting` to `value`; throws on anything outside the closed list. */
export function buildOsSettingArgv(setting: unknown, value: unknown): string[] {
	if (!isOsSetting(setting)) {
		throw new ArgumentError("I can change only dark mode, night light, do not disturb, volume and text size.");
	}
	switch (setting) {
		case "dark_mode":
		case "night_light":
		case "do_not_disturb":
			if (typeof value !== "boolean") throw new ArgumentError("This setting needs true or false.");
			if (setting === "dark_mode") {
				return [
					"gsettings",
					"set",
					"org.gnome.desktop.interface",
					"color-scheme",
					value ? "prefer-dark" : "default",
				];
			}
			if (setting === "night_light") {
				return [
					"gsettings",
					"set",
					"org.gnome.settings-daemon.plugins.color",
					"night-light-enabled",
					String(value),
				];
			}
			// GNOME's Do Not Disturb is the inverse of showing notification banners.
			return ["gsettings", "set", "org.gnome.desktop.notifications", "show-banners", String(!value)];
		case "volume":
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
				throw new ArgumentError("The volume must be a number from 0 to 100.");
			}
			return ["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", `${Math.round(value)}%`];
		case "text_size":
			if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 2) {
				throw new ArgumentError("The text size must be a number from 1.0 to 2.0.");
			}
			return ["gsettings", "set", "org.gnome.desktop.interface", "text-scaling-factor", String(value)];
	}
}

/** Resolves a file or folder the model named; undefined when it does not exist. */
function resolveExisting(value: string, home: string): string | undefined {
	try {
		return realpathSync(expandHome(value.trim(), home));
	} catch {
		return undefined;
	}
}

/** The argv that opens one item; throws a plain sentence for anything outside the closed lists. */
export type OpenItemContext = Pick<OsEnv, "home" | "applicationsDir" | "gioPath">;

/** The system-wide .desktop file of an app id, followed through links; undefined when there is none. */
function systemDesktopEntry(id: string, applicationsDir: string): string | undefined {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return undefined;
	const entry = join(applicationsDir, `${id}.desktop`);
	if (!isInsideDir(entry, applicationsDir)) return undefined;
	const real = realpathSync(entry);
	return statSync(real).isFile() ? real : undefined;
}

export function buildOpenItemArgv(item: { kind: unknown; value: unknown }, context: OpenItemContext): string[] {
	const { kind, value } = item;
	if (typeof value !== "string" || value.trim() === "") throw new ArgumentError("Tell me what to open.");
	switch (kind) {
		case "file":
		case "folder": {
			const path = resolveExisting(value, context.home);
			if (!path) throw new PlainError(PATH_NOT_FOUND);
			if (!isInsideDir(path, context.home)) {
				throw new PlainError(HOME_ONLY);
			}
			const stats = statSync(path);
			if (kind === "folder") {
				if (!stats.isDirectory()) throw new PlainError(NOT_A_FOLDER);
				return ["xdg-open", path];
			}
			if (!stats.isFile()) throw new PlainError(NOT_A_FILE);
			const ext = extname(path).slice(1).toLowerCase();
			if (!(OPENABLE as readonly string[]).includes(ext) || (stats.mode & 0o111) !== 0) {
				throw new PlainError(DOCUMENTS_ONLY);
			}
			return ["xdg-open", path];
		}
		case "app": {
			const desktop = systemDesktopEntry(value.trim().replace(/\.desktop$/, ""), context.applicationsDir);
			if (!desktop) throw new PlainError(APP_NOT_FOUND);
			if (!existsSync(context.gioPath)) throw new PlainError(NOT_AVAILABLE);
			return [context.gioPath, "launch", desktop];
		}
		case "settings":
			if (!isPanel(value.trim())) {
				throw new PlainError({
					en: `I can only open these settings: ${SETTINGS_PANELS.join(", ")}.`,
					vi: `Tôi chỉ mở được các mục cài đặt sau: ${SETTINGS_PANELS.map(panel => PANEL_NAMES[panel].vi).join(", ")}.`,
				});
			}
			return ["gnome-control-center", value.trim()];
		default:
			throw new ArgumentError("I can only open a file, a folder, an app or a settings panel.");
	}
}

const PANEL_NAMES: Record<(typeof SETTINGS_PANELS)[number], { en: string; vi: string }> = {
	network: { en: "network", vi: "mạng" },
	wifi: { en: "Wi-Fi", vi: "Wi-Fi" },
	bluetooth: { en: "Bluetooth", vi: "Bluetooth" },
	display: { en: "display", vi: "màn hình" },
	sound: { en: "sound", vi: "âm thanh" },
	printers: { en: "printer", vi: "máy in" },
	power: { en: "power", vi: "nguồn điện" },
	keyboard: { en: "keyboard", vi: "bàn phím" },
	notifications: { en: "notification", vi: "thông báo" },
	background: { en: "appearance", vi: "giao diện" },
};

const TOGGLE_NAMES: Record<"dark_mode" | "night_light" | "do_not_disturb", { en: string; vi: string }> = {
	dark_mode: { en: "dark mode", vi: "chế độ tối" },
	night_light: { en: "night light", vi: "ánh sáng ban đêm" },
	do_not_disturb: { en: "Do Not Disturb", vi: "chế độ không làm phiền" },
};

/** The plain approval sentence for an os_setting call, in the session language. */
export function osSettingSentence(args: unknown, lang: string): string {
	const vi = lang === "vi";
	try {
		const { setting, value } = asRecord(args);
		buildOsSettingArgv(setting, value);
		if (setting === "volume")
			return vi ? `Đặt âm lượng ${Math.round(Number(value))}%` : `Set the volume to ${Math.round(Number(value))}%`;
		if (setting === "text_size") return vi ? `Đặt cỡ chữ ${value}` : `Set the text size to ${value}`;
		const name = TOGGLE_NAMES[setting as keyof typeof TOGGLE_NAMES];
		if (vi) return `${value ? "Bật" : "Tắt"} ${name.vi}`;
		return `Turn ${value ? "on" : "off"} ${name.en}`;
	} catch {
		return vi ? "Thay đổi cài đặt" : "Change a setting";
	}
}

/**
 * The plain approval sentence for an open_item call. It is built only from what
 * buildOpenItemArgv accepted (files and folders by their full resolved path), so
 * the dialog never repeats model text; anything it refuses gets the generic sentence.
 */
export function openItemSentence(args: unknown, lang: string, context: OpenItemContext): string {
	const vi = lang === "vi";
	const fallback = vi ? "Mở một mục trên máy tính" : "Open something on this computer";
	let argv: string[];
	let kind: unknown;
	try {
		const item = asRecord(args);
		kind = item.kind;
		argv = buildOpenItemArgv({ kind, value: item.value }, context);
	} catch {
		return fallback;
	}
	const target = argv[argv.length - 1] ?? "";
	switch (kind) {
		case "file":
			return vi ? `Mở ${target}` : `Open ${target}`;
		case "folder":
			return vi ? `Mở thư mục ${target}` : `Open the folder ${target}`;
		case "app": {
			const id = basename(target, ".desktop");
			return vi ? `Mở ứng dụng ${id}` : `Open the app ${id}`;
		}
		case "settings":
			return isPanel(target)
				? vi
					? `Mở cài đặt ${PANEL_NAMES[target].vi}`
					: `Open ${PANEL_NAMES[target].en} settings`
				: fallback;
		default:
			return fallback;
	}
}

function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function keepLines(output: string, keep: RegExp | undefined): string {
	if (!keep) return output;
	return output
		.split("\n")
		.filter(line => keep.test(line))
		.map(line => line.trim())
		.join("\n");
}

function clip(output: string): string {
	const lines = output.trim().split("\n").slice(0, MAX_OUTPUT_LINES).join("\n");
	return lines.length > MAX_OUTPUT_CHARS ? `${lines.slice(0, MAX_OUTPUT_CHARS)}…` : lines;
}

/** Runs one read-only check and returns "label: output", never throwing. */
async function runCheck(env: OsEnv, check: Check): Promise<string> {
	const [file, ...args] = check.argv;
	const label = inLanguage(check.label, env.lang);
	const nothing = inLanguage(NOTHING_FOUND, env.lang);
	try {
		const { stdout, stderr } = await env.execFile(file, args, { timeout: COMMAND_TIMEOUT_MS });
		const output = clip(keepLines(stdout || stderr, check.keep));
		return `${label}: ${output || nothing}`;
	} catch (error) {
		if (isEnoent(error)) return `${label}: ${inLanguage(UNAVAILABLE, env.lang)}`;
		const { stdout, stderr } = error as { stdout?: unknown; stderr?: unknown };
		const output = clip(`${typeof stdout === "string" ? stdout : ""}${typeof stderr === "string" ? stderr : ""}`);
		return `${label}: ${output || nothing}`;
	}
}

async function batteryLine(env: OsEnv): Promise<string> {
	const label = inLanguage(BATTERY, env.lang);
	let devices: string;
	try {
		devices = (await env.execFile("upower", ["-e"], { timeout: COMMAND_TIMEOUT_MS })).stdout;
	} catch (error) {
		return `${label}: ${inLanguage(isEnoent(error) ? UNAVAILABLE : NOTHING_FOUND, env.lang)}`;
	}
	const battery = devices
		.split("\n")
		.map(line => line.trim())
		.find(line => /battery/i.test(line));
	if (!battery) return `${label}: ${inLanguage(NO_BATTERY, env.lang)}`;
	const details = await runCheck(env, { label: BATTERY, argv: ["upower", "-i", battery] });
	return details
		.split("\n")
		.filter((line, index) => index === 0 || /percentage|state|time to/i.test(line))
		.join("\n");
}

/**
 * Runs a tool call on SAI OS only and turns a failure into an error result: a sentence for the
 * person in the session language, an argument check in English for the model, and never a raw
 * system error.
 */
function guard(env: OsEnv, job: () => Promise<ToolResult>): Promise<ToolResult> {
	if (env.platform !== "linux") return Promise.resolve(textResult(inLanguage(ONLY_SAI_OS, env.lang), true));
	return job().catch(error => {
		if (error instanceof ArgumentError) return textResult(error.message, true);
		const plain = error instanceof PlainError ? error.inLanguage(env.lang) : inLanguage(UNEXPECTED, env.lang);
		return textResult(plain, true);
	});
}

const realExecFile: ExecFile = async (file, args, options) => {
	const run = promisify(nodeExecFile);
	const { stdout, stderr } = await run(file, [...args], {
		timeout: options.timeout,
		maxBuffer: 1024 * 1024,
		encoding: "utf8",
		env: { ...process.env, LC_ALL: "C.UTF-8" },
	});
	return { stdout, stderr };
};

const realLaunch: Launch = (file, args) =>
	new Promise((resolve, reject) => {
		const child = spawn(file, [...args], { detached: true, stdio: "ignore" });
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});

export function defaultOsEnv(): OsEnv {
	return {
		platform: process.platform,
		home: process.env.HOME || homedir(),
		lang: process.env.SAI_ATLAS_LANG === "vi" ? "vi" : "en",
		applicationsDir: "/usr/share/applications",
		gioPath: "/usr/bin/gio",
		execFile: realExecFile,
		launch: realLaunch,
	};
}

export function createOsTools(env: OsEnv = defaultOsEnv()): PackTool[] {
	return [
		{
			name: "system_status",
			label: "System status",
			description: "Show free disk space, memory, battery, network state and printers of this computer.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			approval: "read",
			loadMode: "essential",
			execute: () =>
				guard(env, async () => {
					const lines = await Promise.all(STATUS_CHECKS.map(check => runCheck(env, check)));
					lines.splice(2, 0, await batteryLine(env));
					return textResult(lines.join("\n"));
				}),
		},
		{
			name: "diagnose",
			label: "Diagnose",
			description:
				"Run the read-only checks for one problem area of this computer. Returns what was found and which fixes " +
				"may be offered to the person.",
			parameters: {
				type: "object",
				properties: {
					area: { type: "string", enum: [...DIAGNOSE_AREAS], description: "The problem area to check." },
				},
				required: ["area"],
				additionalProperties: false,
			},
			approval: "read",
			loadMode: "essential",
			execute: (_toolCallId, params) =>
				guard(env, async () => {
					const { area } = asRecord(params);
					if (!isArea(area)) throw new ArgumentError(`Choose one of these areas: ${DIAGNOSE_AREAS.join(", ")}.`);
					const findings = await Promise.all(CHECKS[area].map(check => runCheck(env, check)));
					const fixes = `Fixes you may offer, one at a time and each approved by the person: ${fixesFor(area, env.applicationsDir)}.`;
					return textResult([...findings, fixes].join("\n"));
				}),
		},
		{
			name: "open_item",
			label: "Open",
			description:
				"Open a document or picture in the home folder, a folder in the home folder, an installed app, or a " +
				`settings panel (${SETTINGS_PANELS.join(", ")}).`,
			parameters: {
				type: "object",
				properties: {
					kind: { type: "string", enum: ["file", "folder", "app", "settings"], description: "What to open." },
					value: {
						type: "string",
						description: "The file or folder path, the app id, or the settings panel name.",
					},
				},
				required: ["kind", "value"],
				additionalProperties: false,
			},
			approval: args => ({ tier: "exec", reason: openItemSentence(args, env.lang, env) }),
			loadMode: "essential",
			execute: (_toolCallId, params) =>
				guard(env, async () => {
					const args = asRecord(params);
					const [file, ...rest] = buildOpenItemArgv({ kind: args.kind, value: args.value }, env);
					try {
						await env.launch(file, rest);
					} catch (error) {
						if (isEnoent(error)) throw new PlainError(NOT_AVAILABLE);
						throw new PlainError(OPEN_FAILED);
					}
					return textResult(inLanguage(OPENED, env.lang));
				}),
		},
		{
			name: "os_setting",
			label: "Change setting",
			description:
				"Change one setting of this computer: dark_mode, night_light or do_not_disturb (true or false), " +
				"volume (0 to 100) or text_size (1.0 to 2.0).",
			parameters: {
				type: "object",
				properties: {
					setting: { type: "string", enum: [...OS_SETTINGS], description: "The setting to change." },
					value: {
						anyOf: [{ type: "boolean" }, { type: "number" }],
						description:
							"true or false for dark_mode, night_light and do_not_disturb; 0 to 100 for volume; 1.0 to 2.0 for text_size.",
					},
				},
				required: ["setting", "value"],
				additionalProperties: false,
			},
			approval: args => ({ tier: "exec", reason: osSettingSentence(args, env.lang) }),
			loadMode: "essential",
			execute: (_toolCallId, params) =>
				guard(env, async () => {
					const args = asRecord(params);
					const [file, ...rest] = buildOsSettingArgv(args.setting, args.value);
					try {
						await env.execFile(file, rest, { timeout: COMMAND_TIMEOUT_MS });
					} catch (error) {
						if (isEnoent(error)) throw new PlainError(NOT_AVAILABLE);
						throw new PlainError(SETTING_FAILED);
					}
					const done = osSettingSentence(args, env.lang);
					return textResult(env.lang === "vi" ? `Đã xong: ${done}.` : `Done: ${done}.`);
				}),
		},
	];
}
