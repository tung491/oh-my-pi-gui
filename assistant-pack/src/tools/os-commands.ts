// The four SAI OS tools: system_status, diagnose, open_item and os_setting. Every command is a
// fixed argv array from a closed list, run without a shell; nothing the model sends becomes a
// command name, and only checked values (a path, an app id, a panel, a number) become arguments.
import { execFile as nodeExecFile, spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { expandHome, isInsideDir, PlainError } from "../office/output";
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
	/** `SAI_ATLAS_LANG`: the language of the approval sentences. */
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
	label: string;
	argv: readonly string[];
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

export const SETTINGS_PANELS = [
	"network",
	"bluetooth",
	"display",
	"sound",
	"printers",
	"power",
	"keyboard",
	"notifications",
	"themes",
] as const;

const OS_SETTINGS = ["dark_mode", "night_light", "do_not_disturb", "volume", "text_size"] as const;
type OsSetting = (typeof OS_SETTINGS)[number];

const COMMAND_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_LINES = 12;
const MAX_OUTPUT_CHARS = 1_200;
const ONLY_SAI_OS = "This works only on SAI OS.";
const NOT_AVAILABLE = "This is not available on this computer.";
const DOCUMENTS_ONLY = "I can only open documents and pictures.";

const df = (path: string): readonly string[] => ["df", "-h", "--output=target,size,avail,pcent", path];

const CHECKS: Record<DiagnoseArea, readonly Check[]> = {
	network: [
		{ label: "Connection", argv: ["nmcli", "-t", "-f", "STATE,CONNECTIVITY", "general"] },
		{ label: "Wi-Fi radio", argv: ["nmcli", "-t", "-f", "WIFI", "radio"] },
		{ label: "Devices", argv: ["nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device"] },
	],
	sound: [
		{ label: "Default output", argv: ["pactl", "get-default-sink"] },
		{ label: "Volume", argv: ["pactl", "get-sink-volume", "@DEFAULT_SINK@"] },
		{ label: "Muted", argv: ["pactl", "get-sink-mute", "@DEFAULT_SINK@"] },
	],
	printer: [
		{ label: "Printers", argv: ["lpstat", "-p", "-d"] },
		{ label: "Waiting print jobs", argv: ["lpstat", "-o"] },
	],
	storage: [
		{ label: "Home disk", argv: df("/home") },
		{ label: "System disk", argv: df("/") },
	],
	performance: [
		{ label: "Running time and load", argv: ["uptime"] },
		{ label: "Memory", argv: ["free", "-h"] },
		{ label: "Busiest programs", argv: ["ps", "-eo", "comm,%cpu,%mem", "--sort=-%cpu"] },
	],
	bluetooth: [
		{ label: "Bluetooth radio", argv: ["rfkill", "list", "bluetooth"] },
		{ label: "Bluetooth adapter", argv: ["bluetoothctl", "show"] },
	],
	display: [
		{ label: "Screens", argv: ["xrandr", "--listmonitors"] },
		{ label: "Colour scheme", argv: ["gsettings", "get", "org.x.apps.portal", "color-scheme"] },
		{
			label: "Night light",
			argv: ["gsettings", "get", "org.cinnamon.settings-daemon.plugins.color", "night-light-enabled"],
		},
		{ label: "Text size", argv: ["gsettings", "get", "org.cinnamon.desktop.interface", "text-scaling-factor"] },
	],
	typing: [
		{ label: "Input method setting", argv: ["im-config", "-m"] },
		{ label: "IBus running", argv: ["pgrep", "-l", "-x", "ibus-daemon"] },
		{ label: "Fcitx running", argv: ["pgrep", "-l", "-x", "fcitx5"] },
	],
	updates: [{ label: "Waiting updates", argv: ["apt", "list", "--upgradable"] }],
};

const FIXES: Record<DiagnoseArea, string> = {
	network: "open_item settings network",
	sound: "os_setting volume; open_item settings sound",
	printer: "open_item settings printers",
	storage: "open_item folder (to show the person a folder in their home folder)",
	performance: "open_item app gnome-system-monitor",
	bluetooth: "open_item settings bluetooth",
	display: "os_setting dark_mode, night_light or text_size; open_item settings display",
	typing: "open_item settings keyboard",
	updates: "open_item app mintupdate",
};

/** Read-only checks of the overall system; the battery is looked up separately through upower. */
export const STATUS_CHECKS: readonly Check[] = [
	{ label: "Disk", argv: ["df", "-h", "--output=target,avail,pcent", "/home"] },
	{ label: "Memory", argv: ["free", "-h"] },
	{ label: "Network", argv: ["nmcli", "-t", "-f", "STATE", "general"] },
	{ label: "Printers", argv: ["lpstat", "-p", "-d"] },
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
				return ["gsettings", "set", "org.x.apps.portal", "color-scheme", value ? "prefer-dark" : "default"];
			}
			if (setting === "night_light") {
				return [
					"gsettings",
					"set",
					"org.cinnamon.settings-daemon.plugins.color",
					"night-light-enabled",
					String(value),
				];
			}
			return ["gsettings", "set", "org.cinnamon.desktop.notifications", "display-notifications", String(!value)];
		case "volume":
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
				throw new ArgumentError("The volume must be a number from 0 to 100.");
			}
			return ["pactl", "set-sink-volume", "@DEFAULT_SINK@", `${Math.round(value)}%`];
		case "text_size":
			if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 2) {
				throw new ArgumentError("The text size must be a number from 1.0 to 2.0.");
			}
			return ["gsettings", "set", "org.cinnamon.desktop.interface", "text-scaling-factor", String(value)];
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
			if (!path) throw new PlainError("I could not find that file or folder.");
			if (!isInsideDir(path, context.home)) {
				throw new PlainError("I can only open files and folders in your home folder.");
			}
			const stats = statSync(path);
			if (kind === "folder") {
				if (!stats.isDirectory()) throw new PlainError("That is not a folder.");
				return ["xdg-open", path];
			}
			if (!stats.isFile()) throw new PlainError("That is not a file.");
			const ext = extname(path).slice(1).toLowerCase();
			if (!(OPENABLE as readonly string[]).includes(ext) || (stats.mode & 0o111) !== 0) {
				throw new PlainError(DOCUMENTS_ONLY);
			}
			return ["xdg-open", path];
		}
		case "app": {
			const desktop = systemDesktopEntry(value.trim().replace(/\.desktop$/, ""), context.applicationsDir);
			if (!desktop) throw new PlainError("I could not find that app.");
			if (!existsSync(context.gioPath)) throw new PlainError(NOT_AVAILABLE);
			return [context.gioPath, "launch", desktop];
		}
		case "settings":
			if (!isPanel(value.trim())) {
				throw new PlainError(`I can only open these settings: ${SETTINGS_PANELS.join(", ")}.`);
			}
			return ["cinnamon-settings", value.trim()];
		default:
			throw new ArgumentError("I can only open a file, a folder, an app or a settings panel.");
	}
}

const PANEL_NAMES: Record<(typeof SETTINGS_PANELS)[number], { en: string; vi: string }> = {
	network: { en: "network", vi: "mạng" },
	bluetooth: { en: "Bluetooth", vi: "Bluetooth" },
	display: { en: "display", vi: "màn hình" },
	sound: { en: "sound", vi: "âm thanh" },
	printers: { en: "printer", vi: "máy in" },
	power: { en: "power", vi: "nguồn điện" },
	keyboard: { en: "keyboard", vi: "bàn phím" },
	notifications: { en: "notification", vi: "thông báo" },
	themes: { en: "theme", vi: "giao diện" },
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

function clip(output: string): string {
	const lines = output.trim().split("\n").slice(0, MAX_OUTPUT_LINES).join("\n");
	return lines.length > MAX_OUTPUT_CHARS ? `${lines.slice(0, MAX_OUTPUT_CHARS)}…` : lines;
}

/** Runs one read-only check and returns "label: output", never throwing. */
async function runCheck(env: OsEnv, check: Check): Promise<string> {
	const [file, ...args] = check.argv;
	try {
		const { stdout, stderr } = await env.execFile(file, args, { timeout: COMMAND_TIMEOUT_MS });
		const output = clip(stdout || stderr);
		return `${check.label}: ${output || "nothing found"}`;
	} catch (error) {
		if (isEnoent(error)) return `${check.label}: not available`;
		const { stdout, stderr } = error as { stdout?: unknown; stderr?: unknown };
		const output = clip(`${typeof stdout === "string" ? stdout : ""}${typeof stderr === "string" ? stderr : ""}`);
		return `${check.label}: ${output || "nothing found"}`;
	}
}

async function batteryLine(env: OsEnv): Promise<string> {
	let devices: string;
	try {
		devices = (await env.execFile("upower", ["-e"], { timeout: COMMAND_TIMEOUT_MS })).stdout;
	} catch (error) {
		return isEnoent(error) ? "Battery: not available" : "Battery: nothing found";
	}
	const battery = devices
		.split("\n")
		.map(line => line.trim())
		.find(line => /battery/i.test(line));
	if (!battery) return "Battery: no battery found";
	const details = await runCheck(env, { label: "Battery", argv: ["upower", "-i", battery] });
	return details
		.split("\n")
		.filter((line, index) => index === 0 || /percentage|state|time to/i.test(line))
		.join("\n");
}

function guard(env: OsEnv, job: () => Promise<ToolResult>): Promise<ToolResult> {
	if (env.platform !== "linux") return Promise.resolve(textResult(ONLY_SAI_OS, true));
	return job().catch(error => {
		const known = error instanceof PlainError || error instanceof ArgumentError;
		return textResult(known ? error.message : "Something went wrong on this computer.", true);
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
					const fixes = `Fixes you may offer, one at a time and each approved by the person: ${FIXES[area]}.`;
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
						throw new PlainError("I could not open it.");
					}
					return textResult("Opened.");
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
						throw new PlainError("I could not change that setting.");
					}
					return textResult(`Done: ${osSettingSentence(args, "en")}.`);
				}),
		},
	];
}
