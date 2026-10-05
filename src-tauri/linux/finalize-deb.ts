/**
 * Finish the .deb tauri-bundler wrote, for the three facts its config cannot express:
 *
 * - The desktop entry is named after the app id (`vn.io.vif.saiatlas.desktop`,
 *   the Wayland app_id and the name the Electron package installed). The bundler
 *   always writes `<productName>.desktop`, and `deb.files` can only add files, so
 *   a rename here is the only way to ship exactly one launcher entry.
 * - `/opt/Sai ATLAS/sai-atlas` stays as a dpkg-owned symlink to
 *   `/usr/bin/sai-atlas`, because the 0.9.x Electron deb updater relaunches its
 *   old executable path after `dpkg -i`. The bundler archives symlinks as copies
 *   of their targets, so it cannot carry one.
 * - The tray library is the alternation `libayatana-appindicator3-1 |
 *   libappindicator3-1`. tauri-cli adds only the Ayatana package, but the
 *   tray's loader (`libappindicator-sys`) opens either library, and a 0.9.x
 *   Electron install may carry `libappindicator3-1`, which Ubuntu's Ayatana
 *   package conflicts with: a single-package Depends would make the Electron
 *   updater's `apt-get install -f` swap them, or remove this package.
 *
 *   bun src-tauri/linux/finalize-deb.ts <bundle/deb directory>
 *
 * The package is unpacked with `dpkg-deb -R`, changed, given fresh md5sums and
 * rebuilt with `dpkg-deb --root-owner-group -Zgzip -b` (gzip like the bundler)
 * under the same file name. Every ELF file in the package is checked against
 * the glibc floor (`glibc-floor.ts`) first, and the rebuilt package's control
 * fields are checked before it replaces the original: exactly `DEB_DEPENDS`
 * and `DEB_RECOMMENDS`, no `Pre-Depends`, and no maintainer scripts. The
 * released Electron updater installs this package with `dpkg -i` and then
 * `apt-get install -f -y`, which removes the package when a dependency cannot
 * be installed, so every extra hard dependency is a way to lose the app.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { APP_ID } from "../../src/shared/product";
import { assertGlibcFloor } from "./glibc-floor";

/** The desktop entry's file name: the app id, which is also the Wayland app_id and StartupWMClass. */
export const DESKTOP_ENTRY_ID = `${APP_ID}.desktop`;

/** Symlinks the package owns, by path inside the package, with their absolute targets. */
export const COMPAT_SYMLINKS: Readonly<Record<string, string>> = {
	"opt/Sai ATLAS/sai-atlas": "/usr/bin/sai-atlas",
};

/** The tray library tauri-cli adds to Depends, and the alternation that replaces it. */
export const TRAY_DEPENDENCY = "libayatana-appindicator3-1";
export const TRAY_ALTERNATION = "libayatana-appindicator3-1 | libappindicator3-1";

/**
 * The finished package's Depends: the configured `deb.depends`, then what
 * tauri-cli appends (the tray library, WebKitGTK, GTK), in the bundler's order.
 * Only what the app cannot start without.
 */
export const DEB_DEPENDS = `bubblewrap, xdg-dbus-proxy, ${TRAY_ALTERNATION}, libwebkit2gtk-4.1-0, libgtk-3-0`;

/** The finished package's Recommends: the configured `deb.recommends`, which the app runs without. */
export const DEB_RECOMMENDS = "desktop-file-utils, xdg-utils, gstreamer1.0-plugins-good, gstreamer1.0-pipewire";

/** The only control-archive members the package may carry: no maintainer scripts, triggers or conffiles. */
export const CONTROL_MEMBERS: readonly string[] = ["control", "md5sums"];

function dpkgDeb(args: string[]): void {
	const result = spawnSync("dpkg-deb", args, { stdio: "inherit" });
	if (result.error) throw new Error(`dpkg-deb is required to finish the .deb: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`dpkg-deb ${args[0]} failed with status ${result.status}`);
}

function dpkgDebOutput(args: string[]): string {
	const result = spawnSync("dpkg-deb", args, { encoding: "utf8" });
	if (result.error) throw new Error(`dpkg-deb is required to finish the .deb: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`dpkg-deb ${args[0]} failed with status ${result.status}: ${result.stderr.trim()}`);
	return result.stdout;
}

/**
 * Replace tauri-cli's single tray package in the control file's Depends with
 * `TRAY_ALTERNATION`. Throws unless Depends names it exactly once, so a
 * bundler that stops adding it, or adds another tray package, fails the build.
 */
export function rewriteTrayDependency(control: string): string {
	const lines = control.split("\n");
	const index = lines.findIndex(line => /^Depends:/i.test(line));
	if (index === -1) throw new Error("the control file has no Depends field");
	const entries = (lines[index] as string)
		.replace(/^Depends:/i, "")
		.split(",")
		.map(entry => entry.trim());
	const matches = entries.filter(entry => entry === TRAY_DEPENDENCY).length;
	if (matches !== 1) {
		throw new Error(`expected Depends to name ${TRAY_DEPENDENCY} once, found: ${entries.join(", ")}`);
	}
	lines[index] = `Depends: ${entries.map(entry => (entry === TRAY_DEPENDENCY ? TRAY_ALTERNATION : entry)).join(", ")}`;
	return lines.join("\n");
}

/** Parse `dpkg-deb -f` output (deb822: continuation lines start with whitespace) into fields by lower-cased name. */
export function parseControlFields(output: string): Map<string, string> {
	const fields = new Map<string, string>();
	let current: string | undefined;
	for (const line of output.split("\n")) {
		if (/^[ \t]/.test(line)) {
			if (current !== undefined) fields.set(current, `${fields.get(current)}\n${line}`);
			continue;
		}
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		current = line.slice(0, colon).trim().toLowerCase();
		fields.set(current, line.slice(colon + 1).trim());
	}
	return fields;
}

/**
 * Check the control fields and control-archive members of a finished package:
 * Depends and Recommends exactly as expected, no Pre-Depends, nothing but
 * `CONTROL_MEMBERS` in the control archive.
 */
export function assertPackageControl(fields: Map<string, string>, members: readonly string[], debPath: string): void {
	const problems: string[] = [];
	const depends = fields.get("depends");
	if (depends !== DEB_DEPENDS) problems.push(`Depends is "${depends ?? ""}", expected "${DEB_DEPENDS}"`);
	const recommends = fields.get("recommends");
	if (recommends !== DEB_RECOMMENDS) problems.push(`Recommends is "${recommends ?? ""}", expected "${DEB_RECOMMENDS}"`);
	if (fields.has("pre-depends")) problems.push(`it has Pre-Depends: ${fields.get("pre-depends")}`);
	const unexpected = members.filter(member => !CONTROL_MEMBERS.includes(member)).sort();
	if (unexpected.length > 0) problems.push(`its control archive carries ${unexpected.join(", ")}`);
	if (problems.length > 0) throw new Error(`${debPath} is not safe to ship: ${problems.join("; ")}`);
}

/** Read a built package's control fields with `dpkg-deb -f` and its control-archive members with `dpkg-deb -e`. */
function checkBuiltPackage(debPath: string, scratch: string, label: string): void {
	const fields = parseControlFields(dpkgDebOutput(["-f", debPath]));
	const control = path.join(scratch, "control");
	dpkgDeb(["-e", debPath, control]);
	assertPackageControl(fields, readdirSync(control), label);
}

function md5File(file: string): string {
	const hash = createHash("md5");
	const buffer = Buffer.alloc(1024 * 1024);
	const fd = openSync(file, "r");
	try {
		for (;;) {
			const read = readSync(fd, buffer, 0, buffer.length, null);
			if (read === 0) break;
			hash.update(buffer.subarray(0, read));
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

/** Regular files under `root` (no directories, symlinks or DEBIAN/), relative, sorted. */
function regularFiles(root: string, relative = ""): string[] {
	const files: string[] = [];
	for (const name of readdirSync(path.join(root, relative))) {
		const entry = relative ? `${relative}/${name}` : name;
		if (entry === "DEBIAN") continue;
		const stat = lstatSync(path.join(root, entry));
		if (stat.isDirectory()) files.push(...regularFiles(root, entry));
		else if (stat.isFile()) files.push(entry);
	}
	return files.sort();
}

/** Create `dir` and any missing parents under `root` as 0755, whatever the umask. */
function mkdirTree(root: string, dir: string): void {
	let current = root;
	for (const part of dir.split("/")) {
		current = path.join(current, part);
		if (!existsSync(current)) {
			mkdirSync(current);
			chmodSync(current, 0o755);
		}
	}
}

/** Rewrite `debPath` in place with the app-id desktop entry, the compat symlinks and the tray alternation. */
export function finalizeDeb(debPath: string): void {
	const scratch = mkdtempSync(path.join(path.dirname(debPath), ".finalize-"));
	try {
		const root = path.join(scratch, "root");
		dpkgDeb(["-R", debPath, root]);
		assertGlibcFloor(root, debPath);

		const controlFile = path.join(root, "DEBIAN/control");
		writeFileSync(controlFile, rewriteTrayDependency(readFileSync(controlFile, "utf8")));

		const applications = path.join(root, "usr/share/applications");
		const entries = readdirSync(applications).filter(name => name.endsWith(".desktop"));
		if (entries.length !== 1) throw new Error(`expected one desktop entry in ${debPath}, found: ${entries.join(", ")}`);
		const entry = entries[0] as string;
		if (entry !== DESKTOP_ENTRY_ID) renameSync(path.join(applications, entry), path.join(applications, DESKTOP_ENTRY_ID));

		for (const [link, target] of Object.entries(COMPAT_SYMLINKS)) {
			const resolved = path.join(root, target);
			if (!existsSync(resolved) || !lstatSync(resolved).isFile()) throw new Error(`${target} is missing from ${debPath}`);
			const linkPath = path.join(root, link);
			if (existsSync(linkPath)) throw new Error(`${link} already exists in ${debPath}`);
			mkdirTree(root, path.dirname(link));
			symlinkSync(target, linkPath);
		}

		const md5sums = regularFiles(root).map(file => `${md5File(path.join(root, file))}  ${file}\n`);
		writeFileSync(path.join(root, "DEBIAN/md5sums"), md5sums.join(""));

		// Built inside the scratch directory, so a package that fails the check is removed with it.
		const rebuilt = path.join(scratch, "rebuilt.deb");
		dpkgDeb(["--root-owner-group", "-Zgzip", "-b", root, rebuilt]);
		checkBuiltPackage(rebuilt, scratch, debPath);
		renameSync(rebuilt, debPath);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const dir = process.argv[2];
	if (!dir) {
		console.error("usage: bun src-tauri/linux/finalize-deb.ts <bundle/deb directory>");
		process.exit(2);
	}
	try {
		const debs = readdirSync(dir).filter(name => name.endsWith(".deb"));
		if (debs.length !== 1) throw new Error(`expected exactly one .deb in ${dir}, found ${debs.length}`);
		const deb = path.join(dir, debs[0] as string);
		finalizeDeb(deb);
		console.log(`finalized ${deb}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
