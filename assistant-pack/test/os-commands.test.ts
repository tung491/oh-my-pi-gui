import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildOpenItemArgv,
	buildOsSettingArgv,
	createOsTools,
	DIAGNOSE_AREAS,
	diagnoseChecks,
	type ExecFile,
	type Launch,
	type OsEnv,
	STATUS_CHECKS,
} from "../src/tools/os-commands";
import type { PackTool, ToolResult } from "../src/tools/types";

let home: string;
let apps: string;
let outside: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "sai-atlas-oshome-"));
	apps = mkdtempSync(join(tmpdir(), "sai-atlas-apps-"));
	outside = mkdtempSync(join(tmpdir(), "sai-atlas-outside-"));
});

afterEach(() => {
	for (const dir of [home, apps, outside]) rmSync(dir, { recursive: true, force: true });
});

interface Call {
	file: string;
	args: readonly string[];
}

function recorder(answer: (call: Call) => string | Error = () => "ok\n"): {
	exec: ExecFile;
	launch: Launch;
	calls: Call[];
} {
	const calls: Call[] = [];
	const exec: ExecFile = async (file, args) => {
		const call = { file, args: [...args] };
		calls.push(call);
		const result = answer(call);
		if (result instanceof Error) throw result;
		return { stdout: result, stderr: "" };
	};
	const launch: Launch = async (file, args) => {
		const call = { file, args: [...args] };
		calls.push(call);
		const result = answer(call);
		if (result instanceof Error) throw result;
	};
	return { exec, launch, calls };
}

function enoent(): Error {
	return Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
}

function env(overrides: Partial<OsEnv> = {}): OsEnv {
	return {
		platform: "linux",
		home,
		lang: "en",
		applicationsDir: apps,
		execFile: recorder().exec,
		launch: recorder().launch,
		...overrides,
	};
}

function tool(name: string, overrides: Partial<OsEnv> = {}): PackTool {
	const found = createOsTools(env(overrides)).find(definition => definition.name === name);
	if (!found) throw new Error(`no tool ${name}`);
	return found;
}

function text(result: ToolResult): string {
	return result.content.map(part => part.text).join("");
}

function reason(definition: PackTool, args: unknown): string | undefined {
	if (typeof definition.approval !== "function") throw new Error("static approval");
	const decision = definition.approval(args);
	expect(decision.tier).toBe("exec");
	return decision.reason;
}

describe("buildOsSettingArgv", () => {
	it("maps each setting to one fixed argv", () => {
		expect(buildOsSettingArgv("dark_mode", true)).toEqual([
			"gsettings",
			"set",
			"org.x.apps.portal",
			"color-scheme",
			"prefer-dark",
		]);
		expect(buildOsSettingArgv("dark_mode", false)).toEqual([
			"gsettings",
			"set",
			"org.x.apps.portal",
			"color-scheme",
			"default",
		]);
		expect(buildOsSettingArgv("night_light", true)).toEqual([
			"gsettings",
			"set",
			"org.cinnamon.settings-daemon.plugins.color",
			"night-light-enabled",
			"true",
		]);
		expect(buildOsSettingArgv("do_not_disturb", true)).toEqual([
			"gsettings",
			"set",
			"org.cinnamon.desktop.notifications",
			"display-notifications",
			"false",
		]);
		expect(buildOsSettingArgv("volume", 40)).toEqual(["pactl", "set-sink-volume", "@DEFAULT_SINK@", "40%"]);
		expect(buildOsSettingArgv("text_size", 1.25)).toEqual([
			"gsettings",
			"set",
			"org.cinnamon.desktop.interface",
			"text-scaling-factor",
			"1.25",
		]);
	});

	it.each([
		["volume", 150],
		["volume", -1],
		["volume", true],
		["text_size", 2.5],
		["text_size", 0.5],
		["dark_mode", "yes"],
		["night_light", 1],
		["wallpaper", true],
	])("refuses %s = %j", (setting, value) => {
		expect(() => buildOsSettingArgv(setting, value)).toThrow();
	});
});

describe("buildOpenItemArgv", () => {
	const open = (kind: string, value: string) => buildOpenItemArgv({ kind, value }, { home, applicationsDir: apps });

	it("opens a document or a folder in the home folder with xdg-open", () => {
		writeFileSync(join(home, "report.docx"), "x");
		mkdirSync(join(home, "Documents"));
		expect(open("file", "~/report.docx")).toEqual(["xdg-open", join(home, "report.docx")]);
		expect(open("folder", join(home, "Documents"))).toEqual(["xdg-open", join(home, "Documents")]);
	});

	it("refuses a file outside the home folder", () => {
		expect(() => open("file", "/etc/passwd")).toThrow();
	});

	it("refuses a symlink in the home folder that points outside it", () => {
		writeFileSync(join(outside, "secret.pdf"), "x");
		symlinkSync(join(outside, "secret.pdf"), join(home, "link.pdf"));
		expect(() => open("file", "~/link.pdf")).toThrow();
	});

	it.each(["x.sh", "x.desktop", "x.html"])("refuses ~/%s", name => {
		writeFileSync(join(home, name), "x");
		expect(() => open("file", `~/${name}`)).toThrow("I can only open documents and pictures.");
	});

	it("refuses an executable document", () => {
		writeFileSync(join(home, "run.pdf"), "x");
		chmodSync(join(home, "run.pdf"), 0o755);
		expect(() => open("file", "~/run.pdf")).toThrow("I can only open documents and pictures.");
	});

	it("refuses a folder given as a file and a file given as a folder", () => {
		mkdirSync(join(home, "Pictures"));
		writeFileSync(join(home, "a.txt"), "x");
		expect(() => open("file", "~/Pictures")).toThrow();
		expect(() => open("folder", "~/a.txt")).toThrow();
	});

	it("launches only apps installed system-wide", () => {
		mkdirSync(join(home, ".local", "share", "applications"), { recursive: true });
		writeFileSync(join(home, ".local", "share", "applications", "calc.desktop"), "[Desktop Entry]");
		expect(() => open("app", "calc")).toThrow();
		writeFileSync(join(apps, "org.gnome.Calculator.desktop"), "[Desktop Entry]");
		expect(open("app", "org.gnome.Calculator")).toEqual(["gtk-launch", "org.gnome.Calculator"]);
		expect(open("app", "org.gnome.Calculator.desktop")).toEqual(["gtk-launch", "org.gnome.Calculator"]);
		expect(() => open("app", "../org.gnome.Calculator")).toThrow();
	});

	it("opens only the listed settings panels", () => {
		expect(open("settings", "sound")).toEqual(["cinnamon-settings", "sound"]);
		expect(() => open("settings", "rm")).toThrow();
		expect(() => open("printer", "x")).toThrow();
	});
});

describe("diagnose", () => {
	it("runs only the fixed read-only checks of the area", async () => {
		const { exec, calls } = recorder();
		const result = await tool("diagnose", { execFile: exec }).execute("t1", { area: "storage" });
		expect(result.isError).not.toBe(true);
		const allowed = diagnoseChecks("storage").map(check => check.argv);
		expect(calls.length).toBe(allowed.length);
		for (const call of calls) expect(allowed).toContainEqual([call.file, ...call.args]);
		expect(text(result)).toContain("Fixes you may offer");
	});

	it("has checks for every area and never runs a shell", () => {
		for (const area of DIAGNOSE_AREAS) {
			const checks = diagnoseChecks(area);
			expect(checks.length).toBeGreaterThan(0);
			for (const check of checks) {
				expect(["sh", "bash", "dash", "zsh", "env", "sudo", "pkexec"]).not.toContain(check.argv[0]);
				expect(check.argv.join(" ")).not.toMatch(/[|;&<>`$]/);
			}
		}
	});

	it("refuses an unknown area", async () => {
		const result = await tool("diagnose").execute("t1", { area: "kernel" });
		expect(result.isError).toBe(true);
	});

	it("reports a missing command as not available", async () => {
		const { exec } = recorder(() => enoent());
		const result = await tool("diagnose", { execFile: exec }).execute("t1", { area: "printer" });
		expect(text(result)).toContain("not available");
	});
});

describe("system_status", () => {
	it("checks disk, memory, battery, network and printers", async () => {
		const { exec, calls } = recorder(call =>
			call.file === "upower" && call.args[0] === "-e" ? "/org/freedesktop/UPower/devices/battery_BAT0\n" : "fine\n",
		);
		const result = await tool("system_status", { execFile: exec }).execute("t1", {});
		const commands = calls.map(call => [call.file, ...call.args]);
		for (const check of STATUS_CHECKS) expect(commands).toContainEqual(check.argv);
		expect(commands).toContainEqual(["upower", "-i", "/org/freedesktop/UPower/devices/battery_BAT0"]);
		expect(text(result)).toMatch(/Disk/);
	});

	it("says when a command is not available", async () => {
		const { exec } = recorder(call => (call.file === "lpstat" ? enoent() : "fine\n"));
		const result = await tool("system_status", { execFile: exec }).execute("t1", {});
		expect(text(result)).toMatch(/Printers: not available/);
	});
});

describe("os_setting and open_item", () => {
	it("change a setting through its argv and report it", async () => {
		const { exec, calls } = recorder();
		const result = await tool("os_setting", { execFile: exec }).execute("t1", { setting: "volume", value: 30 });
		expect(result.isError).not.toBe(true);
		expect(calls).toEqual([{ file: "pactl", args: ["set-sink-volume", "@DEFAULT_SINK@", "30%"] }]);
	});

	it("refuse a bad value without running anything", async () => {
		const { exec, calls } = recorder();
		const result = await tool("os_setting", { execFile: exec }).execute("t1", { setting: "volume", value: 101 });
		expect(result.isError).toBe(true);
		expect(calls).toEqual([]);
	});

	it("open a document and a settings panel without waiting for them to close", async () => {
		writeFileSync(join(home, "notes.md"), "x");
		const { launch, calls } = recorder();
		const opener = tool("open_item", { launch });
		expect((await opener.execute("t1", { kind: "file", value: "~/notes.md" })).isError).not.toBe(true);
		expect((await opener.execute("t2", { kind: "settings", value: "sound" })).isError).not.toBe(true);
		expect(calls).toEqual([
			{ file: "xdg-open", args: [join(home, "notes.md")] },
			{ file: "cinnamon-settings", args: ["sound"] },
		]);
	});

	it("say plainly when the opener is missing", async () => {
		const { launch } = recorder(() => enoent());
		const result = await tool("open_item", { launch }).execute("t1", { kind: "settings", value: "sound" });
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("This is not available on this computer.");
	});

	it("ask for approval with a plain sentence in the session language", () => {
		expect(reason(tool("os_setting"), { setting: "night_light", value: true })).toBe("Turn on night light");
		expect(reason(tool("os_setting", { lang: "vi" }), { setting: "night_light", value: true })).toBe(
			"Bật ánh sáng ban đêm",
		);
		expect(reason(tool("os_setting"), { setting: "volume", value: 30 })).toBe("Set the volume to 30%");
		writeFileSync(join(home, "notes.md"), "x");
		expect(reason(tool("open_item"), { kind: "file", value: "~/notes.md" })).toBe(`Open ${join(home, "notes.md")}`);
		expect(reason(tool("open_item", { lang: "vi" }), { kind: "settings", value: "sound" })).toBe(
			"Mở cài đặt âm thanh",
		);
		expect(reason(tool("open_item"), null)).toBeTruthy();
	});

	it("work only on SAI OS", async () => {
		for (const definition of createOsTools(env({ platform: "darwin" }))) {
			const result = await definition.execute("t1", {});
			expect(text(result)).toBe("This works only on SAI OS.");
		}
	});
});
