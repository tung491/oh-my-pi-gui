/**
 * Finish the AppImage tauri-bundler wrote, so the WebKitGTK web-process sandbox
 * can start from it.
 *
 * tauri-bundler's linuxdeploy GTK plugin runs `sed -i "s|/usr|././|g"` over the
 * bundled `usr/lib/libwebkit2gtk-4.1.so.0`, and no bundler option turns that off.
 * AppRun starts the app with its working directory at `$APPDIR/usr`, so WebKit
 * then looks for `bwrap` and `xdg-dbus-proxy` as `././/bin/…` and binds the
 * AppDir's `usr/lib` over `/lib` inside the sandbox, and the app aborts with
 * "Failed to spawn child process ././/bin/bwrap". The sandbox is always on and
 * `bwrap` must be the host's `/usr/bin/bwrap` (the only one AppArmor lets
 * create user namespaces on Ubuntu 24.04+), so it cannot be bundled.
 *
 * The fix reverts every relocated string in the bundled library (keeping its
 * bytes otherwise, including linuxdeploy's `$ORIGIN` RUNPATH) and relocates
 * only the WebKit helper directory again, so `WebKitWebProcess`,
 * `WebKitNetworkProcess` and the injected bundle still come from the AppImage
 * while `bwrap`, `xdg-dbus-proxy` and the sandbox bind paths come from the host.
 *
 *   bun src-tauri/linux/finalize-appimage.ts <bundle/appimage directory>
 *
 * Each AppImage's squashfs is unpacked with `unsquashfs` (squashfs-tools; no
 * FUSE needed), patched, and packed again with a pinned appimagetool on the
 * original AppImage's own runtime, under the same file name. The runtime's own
 * `--appimage-extract` is not used: it creates every directory 0700 with the
 * extraction time, which the repack would then record. The repacked file has a
 * new size and hash, so release feeds must be written after this step
 * (`scripts/release-feeds.ts` reads the bundle directory after
 * `package:tauri:linux`).
 *
 * Before repacking, every ELF file in the AppDir is checked against the glibc
 * floor (`glibc-floor.ts`): linuxdeploy bundles the build host's libraries, so
 * an AppImage built on a distro newer than Ubuntu 24.04 is refused here.
 *
 * The AppImage also carries a curated GStreamer plugin set (tauri-bundler's
 * `bundleMediaFramework`, fed from the build image's staged plugin directory),
 * built against the GStreamer core linuxdeploy bundles; WebKit needs it for
 * microphone capture and audio playback, and the host's plugins cannot load
 * into the bundled core. `assertMediaFramework` refuses an AppImage whose
 * plugin set differs from `BUNDLED_GSTREAMER_PLUGINS`, that lacks the libpulse
 * client or the plugin scanner, or that bundles glibc's own `libc`/`libmvec`
 * or libpipewire (the sandbox cannot reach the PipeWire socket).
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
	statSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertGlibcFloor, regularFilesUnder } from "./glibc-floor";

/** The bundled library the GTK plugin relocates, relative to the AppDir. */
export const WEBKIT_LIBRARY = "usr/lib/libwebkit2gtk-4.1.so.0";

/** What the GTK plugin writes in place of every `/usr`. */
const RELOCATED = "././";
const SYSTEM_PREFIX = "/usr";
/** WebKit's helper directory; its two compiled-in uses are PKGLIBEXECDIR and the injected-bundle path. */
const HELPER_DIR = "/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1";
const BUNDLED_HELPER_DIR = `${RELOCATED}${HELPER_DIR.slice(SYSTEM_PREFIX.length)}`;
const HELPER_DIR_USES = 2;

/**
 * The GStreamer plugins the AppImage bundles, and nothing else: capture through
 * the PulseAudio socket (pulsesrc via the pulse device provider) into an
 * AudioContext (WebKit feeds a track to WebAudio through deinterleave) with a
 * pulsesink destination, and `<audio>` playback of WAV.
 * scripts/tauri-linux-build/Dockerfile stages exactly these.
 */
export const BUNDLED_GSTREAMER_PLUGINS: readonly string[] = [
	"libgstapp.so",
	"libgstaudioconvert.so",
	"libgstaudioresample.so",
	"libgstautodetect.so",
	"libgstcoreelements.so",
	"libgstinterleave.so",
	"libgstplayback.so",
	"libgstpulseaudio.so",
	"libgsttypefindfunctions.so",
	"libgstvolume.so",
	"libgstwavparse.so",
];

/** Where linuxdeploy's gstreamer plugin puts the plugins and their scanner, relative to the AppDir. */
export const GSTREAMER_PLUGIN_DIR = "usr/lib/gstreamer-1.0";
export const GSTREAMER_SCANNER = "usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner";
/** The PulseAudio client the pulseaudio plugin links; the second linuxdeploy pass deploys it. */
export const PULSE_CLIENT = "usr/lib/libpulse.so.0";
/** glibc's own libraries and libpipewire must stay on the host. */
const FORBIDDEN_LIBRARY = /^lib(?:c|mvec|pipewire-[0-9.]+)\.so(?:\.|$)/;

/** Throw unless the AppDir holds exactly the allowlisted GStreamer plugins and what they need, and no forbidden library. */
export function assertMediaFramework(appDir: string): void {
	const pluginDir = path.join(appDir, GSTREAMER_PLUGIN_DIR);
	if (!existsSync(pluginDir)) {
		throw new Error(
			`${GSTREAMER_PLUGIN_DIR} is missing; the bundler did not run its gstreamer plugin (bundleMediaFramework)`,
		);
	}
	const found = readdirSync(pluginDir).sort();
	const wanted = [...BUNDLED_GSTREAMER_PLUGINS].sort();
	const extra = found.filter(name => !wanted.includes(name));
	const missing = wanted.filter(name => !found.includes(name));
	if (extra.length > 0 || missing.length > 0) {
		throw new Error(
			`${GSTREAMER_PLUGIN_DIR} must hold exactly the allowlisted plugins; ` +
				`missing: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"}`,
		);
	}
	for (const name of found) {
		if (!lstatSync(path.join(pluginDir, name)).isFile())
			throw new Error(`${GSTREAMER_PLUGIN_DIR}/${name} is not a regular file`);
	}
	for (const required of [PULSE_CLIENT, GSTREAMER_SCANNER]) {
		if (!existsSync(path.join(appDir, required))) throw new Error(`${required} is missing from the AppImage`);
	}
	const forbidden = regularFilesUnder(appDir).filter(file => FORBIDDEN_LIBRARY.test(path.basename(file)));
	if (forbidden.length > 0) {
		throw new Error(
			`the AppImage bundles libraries that must come from the host: ${forbidden.map(file => path.relative(appDir, file)).join(", ")}`,
		);
	}
}

/** appimagetool, pinned by release and digest, cached where tauri-bundler caches its own tools. */
export const APPIMAGETOOL = {
	version: "1.9.1",
	url: "https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage",
	sha256: "ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0",
} as const;

/** Replace every non-overlapping `from` with the same-length `to`, left to right; returns the count. */
function replaceAll(bytes: Buffer, from: string, to: string): number {
	const needle = Buffer.from(from, "latin1");
	const replacement = Buffer.from(to, "latin1");
	if (needle.length !== replacement.length) throw new Error(`"${from}" and "${to}" differ in length`);
	let count = 0;
	for (let at = bytes.indexOf(needle); at !== -1; at = bytes.indexOf(needle, at + needle.length)) {
		replacement.copy(bytes, at);
		count++;
	}
	return count;
}

/**
 * Undo the bundler's `/usr` relocation in the bundled libwebkit2gtk bytes and
 * relocate only the helper directory again. Returns a patched copy of the same
 * length; throws when the input does not look like the relocated library.
 */
export function patchWebKitLibrary(input: Uint8Array): Buffer {
	const bytes = Buffer.from(input);
	const reverted = replaceAll(bytes, RELOCATED, SYSTEM_PREFIX);
	if (reverted === 0) throw new Error(`no relocated "${RELOCATED}" strings found; the bundler's GTK plugin changed`);
	if (bytes.includes(RELOCATED)) throw new Error(`"${RELOCATED}" survived reverting the relocation`);
	const helpers = replaceAll(bytes, HELPER_DIR, BUNDLED_HELPER_DIR);
	if (helpers !== HELPER_DIR_USES) {
		throw new Error(`expected ${HELPER_DIR_USES} uses of ${HELPER_DIR}, found ${helpers}`);
	}
	if (bytes.length !== input.length) throw new Error("patching changed the library's length");
	return bytes;
}

function sha256File(file: string): string {
	const hash = createHash("sha256");
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

function toolsDir(): string {
	const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
	return path.join(cache, "tauri");
}

/** The pinned appimagetool, downloaded on first use and verified on every use. */
async function appimagetool(): Promise<string> {
	const dir = toolsDir();
	const tool = path.join(dir, `appimagetool-${APPIMAGETOOL.version}-x86_64.AppImage`);
	if (existsSync(tool)) {
		const actual = sha256File(tool);
		if (actual !== APPIMAGETOOL.sha256) {
			throw new Error(`${tool} has sha256 ${actual}, expected ${APPIMAGETOOL.sha256}; delete it to download again`);
		}
		return tool;
	}
	const response = await fetch(APPIMAGETOOL.url);
	if (!response.ok) throw new Error(`downloading ${APPIMAGETOOL.url} failed: HTTP ${response.status}`);
	const data = Buffer.from(await response.arrayBuffer());
	const actual = createHash("sha256").update(data).digest("hex");
	if (actual !== APPIMAGETOOL.sha256) {
		throw new Error(`${APPIMAGETOOL.url} has sha256 ${actual}, expected ${APPIMAGETOOL.sha256}`);
	}
	mkdirSync(dir, { recursive: true });
	const partial = `${tool}.partial`;
	writeFileSync(partial, data, { mode: 0o755 });
	renameSync(partial, tool);
	return tool;
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	const result = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (result.error) {
		const hint = command === "unsquashfs" ? " (install squashfs-tools)" : "";
		throw new Error(`${command} could not run${hint}: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`${path.basename(command)} ${args[0]} failed with status ${result.status}\n${result.stderr}`);
	}
	return result.stdout;
}

/** Rewrite `appImagePath` in place with the patched WebKit library, after checking its media framework and glibc floor. */
export async function finalizeAppImage(appImagePath: string): Promise<void> {
	const tool = await appimagetool();
	const source = path.resolve(appImagePath);
	const scratch = mkdtempSync(path.join(path.dirname(source), ".finalize-"));
	try {
		// The bytes before the squashfs image are the AppImage runtime; reuse them as-is.
		const offset = Number(run(source, ["--appimage-offset"], scratch).trim());
		if (!Number.isSafeInteger(offset) || offset <= 0) throw new Error(`${source} reports no squashfs offset`);
		const runtime = path.join(scratch, "runtime");
		const runtimeBytes = Buffer.alloc(offset);
		const fd = openSync(source, "r");
		try {
			if (readSync(fd, runtimeBytes, 0, offset, 0) !== offset)
				throw new Error(`${source} is shorter than its runtime`);
		} finally {
			closeSync(fd);
		}
		writeFileSync(runtime, runtimeBytes);

		const appDir = path.join(scratch, "squashfs-root");
		run("unsquashfs", ["-quiet", "-no-progress", "-offset", String(offset), "-dest", appDir, source], scratch);
		const library = path.join(appDir, WEBKIT_LIBRARY);
		const mode = statSync(library).mode;
		writeFileSync(library, patchWebKitLibrary(readFileSync(library)));
		chmodSync(library, mode);
		assertMediaFramework(appDir);
		assertGlibcFloor(appDir, source);

		const rebuilt = path.join(scratch, path.basename(source));
		run(tool, ["--appimage-extract-and-run", "--no-appstream", "--runtime-file", runtime, appDir, rebuilt], scratch, {
			...process.env,
			ARCH: "x86_64",
		});
		chmodSync(rebuilt, 0o755);
		renameSync(rebuilt, source);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const dir = process.argv[2];
	if (!dir) {
		console.error("usage: bun src-tauri/linux/finalize-appimage.ts <bundle/appimage directory>");
		process.exit(2);
	}
	try {
		const images = readdirSync(dir).filter(name => name.endsWith(".AppImage"));
		if (images.length === 0) throw new Error(`no .AppImage in ${dir}`);
		for (const name of images) {
			const image = path.join(dir, name);
			await finalizeAppImage(image);
			console.log(`finalized ${image}`);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
