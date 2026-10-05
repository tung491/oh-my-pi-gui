/**
 * Observing the app from outside, for builds without test hooks (the installed
 * package): processes through /proc, the session bus, the app's windows
 * through the accessibility bus (GNOME Shell refuses its window list to
 * ordinary clients on Wayland), and the Wayland app id from a WAYLAND_DEBUG
 * trace. Linux only; every helper reads, none changes system state.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";

/** The app id every profile's windows carry (`main.rs` sets it with `glib::set_prgname`). */
export const APP_ID = "vn.io.vif.saiatlas";

export interface ProcInfo {
	pid: number;
	/** `/proc/<pid>/comm`: the name, cut at 15 characters by the kernel. */
	comm: string;
	ppid: number;
	/** `Seccomp:` from `/proc/<pid>/status` ("2" = a syscall filter is active). */
	seccomp: string | null;
	/** `NSpid:` — more than one id means the process lives in a nested PID namespace. */
	nspid: number[];
	cmdline: string[];
}

function readText(file: string): string | null {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

/** What /proc says about `pid`, or null once the process is gone. */
export function procInfo(pid: number): ProcInfo | null {
	const status = readText(`/proc/${pid}/status`);
	const comm = readText(`/proc/${pid}/comm`);
	const cmdline = readText(`/proc/${pid}/cmdline`);
	if (status === null || comm === null || cmdline === null) return null;
	const field = (name: string) => status.match(new RegExp(`^${name}:\\s*(.*)$`, "m"))?.[1]?.trim() ?? null;
	return {
		pid,
		comm: comm.trim(),
		ppid: Number(field("PPid") ?? 0),
		seccomp: field("Seccomp"),
		nspid: (field("NSpid") ?? "").split(/\s+/).filter(Boolean).map(Number),
		cmdline: cmdline.split("\0").filter(Boolean),
	};
}

export function alive(pid: number): boolean {
	return procInfo(pid) !== null;
}

/** The environment `pid` started with; empty when it is gone or not readable. */
export function environOf(pid: number): Record<string, string> {
	const text = readText(`/proc/${pid}/environ`) ?? "";
	return Object.fromEntries(
		text
			.split("\0")
			.filter(entry => entry.includes("="))
			.map(entry => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]),
	);
}

function childrenOf(pid: number): number[] {
	const tasks = (() => {
		try {
			return fs.readdirSync(`/proc/${pid}/task`);
		} catch {
			return [];
		}
	})();
	return tasks.flatMap(task =>
		(readText(`/proc/${pid}/task/${task}/children`) ?? "").split(/\s+/).filter(Boolean).map(Number),
	);
}

/** Every process below `pid`, depth first. */
export function descendants(pid: number): ProcInfo[] {
	return childrenOf(pid).flatMap(child => {
		const info = procInfo(child);
		return info ? [info, ...descendants(child)] : [];
	});
}

/** WebKit web processes below the app (comm is `WebKitWebProcess` cut to 15 characters). */
export function webProcesses(pid: number): ProcInfo[] {
	return descendants(pid).filter(info => "WebKitWebProcess".startsWith(info.comm) && info.comm.length >= 12);
}

/** Every process whose full command line contains `pattern` (`pgrep -f`), this one excluded. */
export function pgrepFull(pattern: string): number[] {
	const found = spawnSync("pgrep", ["-f", "--", pattern], { encoding: "utf8" });
	if (found.error) throw new Error(`pgrep failed: ${found.error.message}`);
	return found.stdout
		.split("\n")
		.filter(Boolean)
		.map(Number)
		.filter(pid => pid !== process.pid);
}

/**
 * The shell process for one profile: started from `binary` with that
 * `--user-data-dir`, and not a sidecar supervisor (which runs the same binary).
 */
export function appProcesses(binary: string, desktop: string): number[] {
	const exe = fs.realpathSync(binary);
	return pgrepFull(`--user-data-dir=${desktop}`).filter(pid => {
		const info = procInfo(pid);
		if (!info || info.cmdline.includes("--omp-supervise")) return false;
		try {
			return fs.realpathSync(`/proc/${pid}/exe`) === exe;
		} catch {
			return false;
		}
	});
}

/** `paths::single_instance_id()` for a non-default profile, plus the plugin's suffix. */
export function singleInstanceBusName(desktop: string): string {
	const digest = createHash("sha256").update(desktop).digest("hex").slice(0, 16);
	return `${APP_ID}.p${digest}.SingleInstance`;
}

function gdbus(args: string[]): string {
	const result = spawnSync("gdbus", ["call", ...args], { encoding: "utf8", timeout: 10_000 });
	if (result.error) throw new Error(`gdbus failed: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`gdbus ${args.join(" ")}: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

function ownerPid(address: string[], name: string): number | null {
	try {
		const reply = gdbus([
			...address,
			"--dest",
			"org.freedesktop.DBus",
			"--object-path",
			"/org/freedesktop/DBus",
			"--method",
			"org.freedesktop.DBus.GetConnectionUnixProcessID",
			name,
		]);
		return Number(reply.match(/uint32 (\d+)/)?.[1] ?? Number.NaN);
	} catch {
		return null;
	}
}

/** The process that owns `name` on the session bus, or null when nobody does. */
export function sessionBusOwner(name: string): number | null {
	return ownerPid(["--session"], name);
}

export interface AppWindow {
	title: string;
	/** On screen now (AT-SPI SHOWING); a hidden window leaves the list instead. */
	showing: boolean;
	active: boolean;
	width: number;
	height: number;
}

const STATE_ACTIVE = 1;
const STATE_SHOWING = 25;

function accessibilityBus(): string[] {
	const reply = gdbus([
		"--session",
		"--dest",
		"org.a11y.Bus",
		"--object-path",
		"/org/a11y/bus",
		"--method",
		"org.a11y.Bus.GetAddress",
	]);
	const address = reply.match(/'([^']+)'/)?.[1];
	if (!address) throw new Error(`no accessibility bus address in ${reply}`);
	return ["--address", address];
}

function children(bus: string[], dest: string, objectPath: string): Array<{ dest: string; path: string }> {
	const reply = gdbus([
		...bus,
		"--dest",
		dest,
		"--object-path",
		objectPath,
		"--method",
		"org.a11y.atspi.Accessible.GetChildren",
	]);
	return [...reply.matchAll(/\('([^']+)', (?:objectpath )?'([^']+)'\)/g)].map(match => ({
		dest: match[1],
		path: match[2],
	}));
}

/** The top-level windows the process `pid` currently shows, from the accessibility tree GTK exports. */
export function appWindows(pid: number): AppWindow[] {
	const bus = accessibilityBus();
	const apps = children(bus, "org.a11y.atspi.Registry", "/org/a11y/atspi/accessible/root").filter(
		app => ownerPid(bus, app.dest) === pid,
	);
	return apps.flatMap(app =>
		children(bus, app.dest, "/org/a11y/atspi/accessible/root").map(frame => {
			const call = (method: string, ...args: string[]) =>
				gdbus([...bus, "--dest", app.dest, "--object-path", frame.path, "--method", method, ...args]);
			const title = call("org.freedesktop.DBus.Properties.Get", "org.a11y.atspi.Accessible", "Name").match(
				/<'(.*)'>/,
			)?.[1];
			const [low] = (call("org.a11y.atspi.Accessible.GetState").match(/uint32 (\d+)/g) ?? []).map(word =>
				Number(word.slice("uint32 ".length)),
			);
			const extents = call("org.a11y.atspi.Component.GetExtents", "0").match(/\((-?\d+), (-?\d+), (\d+), (\d+)\)/);
			const bit = (state: number) => ((low ?? 0) & (1 << state)) !== 0;
			return {
				title: title ?? "",
				showing: bit(STATE_SHOWING),
				active: bit(STATE_ACTIVE),
				width: Number(extents?.[3] ?? 0),
				height: Number(extents?.[4] ?? 0),
			};
		}),
	);
}

/** Every `xdg_toplevel.set_app_id` a WAYLAND_DEBUG=client trace recorded. */
export function waylandAppIds(trace: string): string[] {
	const text = readText(trace) ?? "";
	return [...text.matchAll(/set_app_id\("([^"]*)"\)/g)].map(match => match[1]);
}
