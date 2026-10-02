/**
 * Finish the .deb tauri-bundler wrote, for the two facts its config cannot express:
 *
 * - The desktop entry is named after the app id (`vn.io.vif.saiatlas.desktop`,
 *   the Wayland app_id and the name the Electron package installed). The bundler
 *   always writes `<productName>.desktop`, and `deb.files` can only add files, so
 *   a rename here is the only way to ship exactly one launcher entry.
 * - `/opt/Sai ATLAS/sai-atlas` stays as a dpkg-owned symlink to
 *   `/usr/bin/sai-atlas`, because the 0.9.x Electron deb updater relaunches its
 *   old executable path after `dpkg -i`. The bundler archives symlinks as copies
 *   of their targets, so it cannot carry one.
 *
 *   bun src-tauri/linux/finalize-deb.ts <bundle/deb directory>
 *
 * The package is unpacked with `dpkg-deb -R`, changed, given fresh md5sums and
 * rebuilt with `dpkg-deb --root-owner-group -Zgzip -b` (gzip like the bundler)
 * under the same file name.
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
	readSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { APP_ID } from "../../src/shared/product";

/** The desktop entry's file name: the app id, which is also the Wayland app_id and StartupWMClass. */
export const DESKTOP_ENTRY_ID = `${APP_ID}.desktop`;

/** Symlinks the package owns, by path inside the package, with their absolute targets. */
export const COMPAT_SYMLINKS: Readonly<Record<string, string>> = {
	"opt/Sai ATLAS/sai-atlas": "/usr/bin/sai-atlas",
};

function dpkgDeb(args: string[]): void {
	const result = spawnSync("dpkg-deb", args, { stdio: "inherit" });
	if (result.error) throw new Error(`dpkg-deb is required to finish the .deb: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`dpkg-deb ${args[0]} failed with status ${result.status}`);
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

/** Rewrite `debPath` in place with the app-id desktop entry and the compat symlinks. */
export function finalizeDeb(debPath: string): void {
	const scratch = mkdtempSync(path.join(path.dirname(debPath), ".finalize-"));
	try {
		const root = path.join(scratch, "root");
		dpkgDeb(["-R", debPath, root]);

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

		const rebuilt = `${debPath}.tmp`;
		dpkgDeb(["--root-owner-group", "-Zgzip", "-b", root, rebuilt]);
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
