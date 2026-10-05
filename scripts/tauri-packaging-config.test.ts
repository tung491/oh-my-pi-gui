/**
 * Tauri packaging contract: the identity, sandbox, sidecar placement, update
 * feeds and installer hooks every Tauri bundle must keep. The Electron
 * equivalents live in src/main/packaging-config.test.ts.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type PlistObject, parsePlistFile } from "app-builder-lib/out/util/plist";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { APP_ID, PRODUCT_NAME } from "../src/shared/product";
import { COMPAT_SYMLINKS, DESKTOP_ENTRY_ID, finalizeDeb } from "../src-tauri/linux/finalize-deb";
import { MAC_UPDATE_FLOOR } from "./mac-update-floor";
import { assetNames, darwinReleaseFor } from "./release-feeds";
import { SIDECAR_SOURCES, stagedSidecarPath } from "./stage-tauri-sidecar";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAURI = path.join(ROOT, "src-tauri");

type Json = Record<string, unknown>;

interface TauriConfig {
	productName?: string;
	identifier?: string;
	mainBinaryName?: string;
	version?: string;
	build?: { features?: string[] };
	app?: {
		enableGTKAppId?: boolean;
		withGlobalTauri?: boolean;
		security?: { csp?: string; dangerousDisableAssetCspModification?: boolean | string[] };
	};
	plugins?: { "deep-link"?: { desktop?: { schemes?: string[] }; mobile?: unknown[] } };
	bundle?: {
		active?: boolean;
		targets?: string[];
		externalBin?: string[];
		resources?: Record<string, string> | string[];
		macOS?: { minimumSystemVersion?: string; signingIdentity?: string; entitlements?: string };
		windows?: { nsis?: { installMode?: string; installerHooks?: string } };
		linux?: { deb?: { depends?: string[]; desktopTemplate?: string; files?: Record<string, string> } };
	};
}

function readJson<T = Json>(relative: string): T {
	return JSON.parse(fs.readFileSync(path.join(ROOT, relative), "utf8")) as T;
}

const base = (): TauriConfig => readJson("src-tauri/tauri.conf.json");
const platform = (os: "linux" | "macos" | "windows"): TauriConfig => readJson(`src-tauri/tauri.${os}.conf.json`);
const overlay = (os: "linux" | "macos" | "windows"): TauriConfig => readJson(`src-tauri/${os}/sidecar.conf.json`);

/** RFC 7396 merge, as tauri-cli applies the platform file and then each `--config` overlay. */
function merge(target: Json, patch: Json): Json {
	const out: Json = { ...target };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete out[key];
		else if (
			typeof value === "object" &&
			!Array.isArray(value) &&
			typeof out[key] === "object" &&
			!Array.isArray(out[key])
		) {
			out[key] = merge(out[key] as Json, value as Json);
		} else out[key] = value;
	}
	return out;
}

/** The configuration a `package:tauri:*` build of `os` bundles with. */
function bundled(os: "linux" | "macos" | "windows"): TauriConfig {
	return merge(merge(base() as Json, platform(os) as Json), overlay(os) as Json) as TauriConfig;
}

const scripts = (): Record<string, string> => readJson<{ scripts: Record<string, string> }>("package.json").scripts;
const packageScripts = () => Object.entries(scripts()).filter(([name]) => name.startsWith("package:tauri:"));

function filesUnder(directory: string): string[] {
	if (!fs.existsSync(directory)) return [];
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
		const full = path.join(directory, entry.name);
		return entry.isDirectory() ? filesUnder(full) : [full];
	});
}

/** Every packaging input: the four configs, the overlays and every file under the per-OS dirs. */
function packagingFiles(): string[] {
	return [
		...[
			"tauri.conf.json",
			"tauri.linux.conf.json",
			"tauri.macos.conf.json",
			"tauri.windows.conf.json",
			"Info.plist",
		].map(name => path.join(TAURI, name)),
		...["linux", "macos", "windows"].flatMap(dir => filesUnder(path.join(TAURI, dir))),
	];
}

/** The deb's (and, through the shared data tree, the AppImage's) desktop entry template. */
function desktopTemplate(): string {
	const template = platform("linux").bundle?.linux?.deb?.desktopTemplate;
	if (!template) throw new Error("tauri.linux.conf.json sets no bundle.linux.deb.desktopTemplate");
	return fs.readFileSync(path.join(TAURI, template), "utf8");
}

describe("product identity", () => {
	it("names the product and app id the core and the Electron build use", () => {
		expect(base().identifier).toBe(APP_ID);
		expect(base().identifier).toBe("vn.io.vif.saiatlas");
		expect(base().productName).toBe(PRODUCT_NAME);
		expect(base().productName).toBe("Sai ATLAS");
		// The version comes from package.json, which the release bumps.
		expect(base().version).toBe("../package.json");
	});

	it("keeps the crate version equal to package.json's", () => {
		// Runtime-log lines written before the Tauri context exists (helper modes,
		// the install child) report the crate version, so the release bumps both.
		const cargo = fs.readFileSync(path.join(TAURI, "Cargo.toml"), "utf8");
		const crateVersion = cargo.match(/^\[package\]\n(?:[^[\n].*\n|\n)*?version = "([^"]+)"$/m)?.[1];
		expect(crateVersion).toBe(readJson<{ version: string }>("package.json").version);
	});

	it("registers the omp deep-link scheme", () => {
		expect(base().plugins?.["deep-link"]?.desktop?.schemes).toEqual(["omp"]);
		expect(base().plugins?.["deep-link"]?.mobile).toEqual([]);
		expect(desktopTemplate()).toMatch(/^MimeType=x-scheme-handler\/omp;$/m);
	});

	it("names the Linux binary and package sai-atlas", () => {
		expect(base().mainBinaryName).toBe("sai-atlas");
		// tauri-bundler writes `Package:` as the kebab-cased product name.
		expect(PRODUCT_NAME.toLowerCase().replace(/\s+/g, "-")).toBe("sai-atlas");
		expect(desktopTemplate()).toMatch(/^Exec=sai-atlas %U$/m);
	});

	it("enableGTKAppId is true", () => {
		expect(base().app?.enableGTKAppId).toBe(true);
	});

	it("the desktop template sets StartupWMClass to the identifier", () => {
		const template = desktopTemplate();
		expect(platform("linux").bundle?.linux?.deb?.desktopTemplate).toBe("linux/vn.io.vif.saiatlas.desktop");
		expect(template).toMatch(new RegExp(`^StartupWMClass=${APP_ID.replaceAll(".", "\\.")}$`, "m"));
		expect(template).toMatch(/^Name=Sai ATLAS$/m);
		expect(template.match(/^\[Desktop Entry\]$/gm)).toHaveLength(1);
	});

	it("bundles for every target and names the asset files the updaters look for", () => {
		expect(base().bundle?.active).toBe(true);
		expect(platform("linux").bundle?.targets).toEqual(["appimage", "deb"]);
		expect(platform("macos").bundle?.targets).toEqual(["dmg", "app"]);
		expect(platform("windows").bundle?.targets).toEqual(["nsis"]);
		expect(assetNames("1.0.0")).toMatchObject({
			macArm64Dmg: "Sai-ATLAS-1.0.0-arm64.dmg",
			macX64Dmg: "Sai-ATLAS-1.0.0.dmg",
			macArm64Zip: "Sai-ATLAS-1.0.0-arm64.zip",
			macX64Zip: "Sai-ATLAS-1.0.0.zip",
			bridgeArm64Dmg: "omp-1.0.0-arm64.dmg",
			bridgeX64Dmg: "omp-1.0.0.dmg",
		});
		// The Rust updater selects the same DMG names.
		const state = fs.readFileSync(path.join(TAURI, "src/updater/state.rs"), "utf8");
		expect(state).toContain('"Sai-ATLAS-{version}-arm64.dmg"');
		expect(state).toContain('"Sai-ATLAS-{version}.dmg"');
	});
});

describe("sidecar placement", () => {
	it("macOS and Windows configs ship binaries/omp as externalBin", () => {
		expect(bundled("macos").bundle?.externalBin).toEqual(["binaries/omp"]);
		expect(bundled("windows").bundle?.externalBin).toEqual(["binaries/omp"]);
		expect(bundled("macos").bundle?.resources).toBeUndefined();
		expect(bundled("windows").bundle?.resources).toBeUndefined();
	});

	it("the Linux config ships the sidecar as the omp resource and sets no externalBin", () => {
		// Installs as /usr/lib/Sai ATLAS/omp (deb) and $APPDIR/usr/lib/Sai ATLAS/omp
		// (AppImage), where paths::resolve_bundled_omp looks, never on PATH.
		expect(bundled("linux").bundle?.resources).toEqual({ "binaries/omp-x86_64-unknown-linux-gnu": "omp" });
		expect(bundled("linux").bundle?.externalBin).toBeUndefined();
		expect(stagedSidecarPath("x86_64-unknown-linux-gnu")).toBe("src-tauri/binaries/omp-x86_64-unknown-linux-gnu");
	});

	it("tauri.conf.json and the platform configs declare no externalBin or resources, so cargo builds never need a staged sidecar", () => {
		// tauri-build copies both at compile time and fails when the file is missing.
		for (const config of [base(), platform("linux"), platform("macos"), platform("windows")]) {
			expect(config.bundle?.externalBin).toBeUndefined();
			expect(config.bundle?.resources).toBeUndefined();
		}
	});

	it("every package:tauri script stages the matching triple and passes the matching overlay", () => {
		const expected: Record<string, [string, string]> = {
			"package:tauri:linux": ["x86_64-unknown-linux-gnu", "src-tauri/linux/sidecar.conf.json"],
			"package:tauri:mac:arm64": ["aarch64-apple-darwin", "src-tauri/macos/sidecar.conf.json"],
			"package:tauri:mac:x64": ["x86_64-apple-darwin", "src-tauri/macos/sidecar.conf.json"],
			"package:tauri:win": ["x86_64-pc-windows-msvc", "src-tauri/windows/sidecar.conf.json"],
		};
		expect(
			packageScripts()
				.map(([name]) => name)
				.sort(),
		).toEqual(Object.keys(expected).sort());
		for (const [name, [triple, overlayPath]] of Object.entries(expected)) {
			const script = scripts()[name] ?? "";
			expect(script, name).toContain(`bun scripts/stage-tauri-sidecar.ts ${triple} &&`);
			expect(script, name).toContain(`cargo tauri build --target ${triple} --config ${overlayPath}`);
			expect(script, name).toContain("source scripts/rust-pins.env");
			expect(SIDECAR_SOURCES[triple], name).toBeDefined();
		}
	});
});

describe("renderer security", () => {
	it("CSP policy equals the meta CSP in src/renderer/index.html", () => {
		const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
		const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
		expect(meta).toBeDefined();
		expect(base().app?.security?.csp).toBe(meta);
	});

	it("only style-src skips asset CSP modification", () => {
		expect(base().app?.security?.dangerousDisableAssetCspModification).toEqual(["style-src"]);
	});

	it("withGlobalTauri is false", () => {
		expect(base().app?.withGlobalTauri).toBe(false);
	});

	it("capabilities grant only the omp bridge commands", () => {
		const capabilities = fs.readdirSync(path.join(TAURI, "capabilities")).sort();
		expect(capabilities).toEqual(["main.json", "quick-entry.json"]);
		const main = readJson<{ windows: string[]; permissions: string[] }>("src-tauri/capabilities/main.json");
		expect(main.windows).toEqual(["main-*"]);
		expect(main.permissions).toEqual(["allow-omp-invoke", "allow-omp-attach"]);
	});

	it("the quick-entry capability grants only its commands", () => {
		const quick = readJson<{ windows: string[]; permissions: string[] }>("src-tauri/capabilities/quick-entry.json");
		expect(quick.windows).toEqual(["quick-entry"]);
		expect(quick.permissions).toEqual(["allow-omp-quick-entry-invoke", "allow-omp-attach"]);
	});

	it("keeps the Linux renderer sandboxed: no --no-sandbox anywhere in packaging", () => {
		for (const file of packagingFiles()) {
			expect(fs.readFileSync(file, "utf8"), path.relative(ROOT, file)).not.toContain("--no-sandbox");
		}
		for (const [name, script] of packageScripts()) expect(script, name).not.toContain("--no-sandbox");
	});

	it("no bundle or package script enables e2e-hooks", () => {
		for (const os of ["linux", "macos", "windows"] as const)
			expect(bundled(os).build?.features ?? []).not.toContain("e2e-hooks");
		for (const file of packagingFiles()) {
			expect(fs.readFileSync(file, "utf8"), path.relative(ROOT, file)).not.toContain("e2e-hooks");
		}
		for (const [name, script] of Object.entries(scripts())) {
			if (/tauri build|cargo tauri|package/.test(script) || name.startsWith("package")) {
				expect(script, name).not.toContain("e2e-hooks");
			}
		}
	});

	it("no package or release script sets SAI_ATLAS_UPDATE_BASE", () => {
		for (const [name, script] of Object.entries(scripts()))
			expect(script, name).not.toContain("SAI_ATLAS_UPDATE_BASE");
		for (const file of [
			...packagingFiles(),
			path.join(ROOT, "scripts/release-feeds.ts"),
			path.join(ROOT, "scripts/stage-tauri-sidecar.ts"),
			path.join(ROOT, ".github/workflows/ci.yml"),
		]) {
			expect(fs.readFileSync(file, "utf8"), path.relative(ROOT, file)).not.toContain("SAI_ATLAS_UPDATE_BASE");
		}
	});
});

describe("Linux package", () => {
	const depends = () => platform("linux").bundle?.linux?.deb?.depends ?? [];

	it("deb control names the maintainer, homepage and description of the Electron package", () => {
		// The bundler writes Maintainer from bundle.publisher (Cargo.toml has no authors),
		// Homepage from bundle.homepage and Description from the descriptions.
		const bundle = platform("linux").bundle as TauriConfig["bundle"] & {
			publisher?: string;
			homepage?: string;
			shortDescription?: string;
			longDescription?: string;
		};
		const description = readJson<{ description: string }>("package.json").description;
		expect(bundle?.publisher).toBe("Tung Son Do <dosontung007@gmail.com>");
		expect(bundle?.homepage).toBe("https://github.com/tung491/oh-my-pi-gui");
		expect(bundle?.shortDescription).toBe(description);
		expect(bundle?.longDescription).toBe(description);
	});

	it("deb depends on the sandbox, gstreamer and omp:// registration tools, without the bundler's own entries", () => {
		// WebKit treats a missing bwrap as fatal once its web-process sandbox is on.
		// The deep-link plugin registers omp:// by running update-desktop-database
		// (desktop-file-utils) and xdg-mime (xdg-utils); without them every start logs
		// a failed registration. The bundler appends libwebkit2gtk-4.1-0, libgtk-3-0 and
		// the tray's appindicator itself, so listing them here would duplicate them.
		expect(depends()).toEqual([
			"gstreamer1.0-pipewire",
			"gstreamer1.0-plugins-good",
			"bubblewrap",
			"xdg-dbus-proxy",
			"desktop-file-utils",
			"xdg-utils",
		]);
	});

	it("deb does not depend on gstreamer1.0-plugins-bad", () => {
		// Dictation captures PCM through WebAudio; MediaRecorder stays unused.
		expect(depends()).not.toContain("gstreamer1.0-plugins-bad");
	});

	it("marks the deb install so the updater picks the dpkg path", () => {
		const files = platform("linux").bundle?.linux?.deb?.files ?? {};
		expect(files["/usr/lib/Sai ATLAS/package-type"]).toBe("linux/package-type");
		expect(fs.readFileSync(path.join(TAURI, "linux/package-type"), "utf8").trim()).toBe("deb");
	});

	it("deb ships the /opt compat symlink and one desktop entry named after the app id", () => {
		// The 0.9.x Electron deb updater relaunches /opt/Sai ATLAS/sai-atlas after dpkg -i.
		expect(COMPAT_SYMLINKS).toEqual({ "opt/Sai ATLAS/sai-atlas": "/usr/bin/sai-atlas" });
		expect(DESKTOP_ENTRY_ID).toBe("vn.io.vif.saiatlas.desktop");
		expect(scripts()["package:tauri:linux"]).toMatch(
			/ && bun src-tauri\/linux\/finalize-deb\.ts src-tauri\/target\/x86_64-unknown-linux-gnu\/release\/bundle\/deb( && |$)/,
		);
		// Round-trip a package laid out the way tauri-bundler writes one.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finalize-deb-"));
		try {
			const root = path.join(dir, "root");
			const put = (file: string, contents: string, mode = 0o644) => {
				fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
				fs.writeFileSync(path.join(root, file), contents);
				fs.chmodSync(path.join(root, file), mode);
			};
			put(
				"DEBIAN/control",
				"Package: sai-atlas\nVersion: 1.0.0\nArchitecture: amd64\nMaintainer: test\nDescription: test\n",
			);
			put("usr/bin/sai-atlas", "binary", 0o755);
			put("usr/lib/Sai ATLAS/omp", "sidecar", 0o755);
			put("usr/share/applications/Sai ATLAS.desktop", "[Desktop Entry]\nStartupWMClass=vn.io.vif.saiatlas\n");
			for (const sub of [
				"DEBIAN",
				"usr",
				"usr/bin",
				"usr/lib",
				"usr/lib/Sai ATLAS",
				"usr/share",
				"usr/share/applications",
			]) {
				fs.chmodSync(path.join(root, sub), 0o755);
			}
			const deb = path.join(dir, "Sai ATLAS_1.0.0_amd64.deb");
			expect(spawnSync("dpkg-deb", ["--root-owner-group", "-Zgzip", "-b", root, deb]).status).toBe(0);
			finalizeDeb(deb);
			const listing = spawnSync("dpkg-deb", ["-c", deb], { encoding: "utf8" }).stdout.split("\n");
			const desktopFiles = listing.filter(line => /applications\/[^/]+$/.test(line));
			expect(desktopFiles).toHaveLength(1);
			expect(desktopFiles[0]).toMatch(/usr\/share\/applications\/vn\.io\.vif\.saiatlas\.desktop$/);
			const link = listing.filter(line => line.endsWith("opt/Sai ATLAS/sai-atlas -> /usr/bin/sai-atlas"));
			expect(link).toHaveLength(1);
			expect(link[0]).toMatch(/^l.* root\/root /);
			expect(listing.find(line => line.endsWith("usr/lib/Sai ATLAS/omp"))).toMatch(/^-rwxr-xr-x root\/root /);
			const extracted = path.join(dir, "check");
			expect(spawnSync("dpkg-deb", ["-e", deb, extracted]).status).toBe(0);
			const md5sums = fs.readFileSync(path.join(extracted, "md5sums"), "utf8");
			expect(md5sums).toContain("  usr/share/applications/vn.io.vif.saiatlas.desktop\n");
			expect(md5sums).not.toContain("opt/Sai ATLAS/sai-atlas");
			expect(fs.readFileSync(path.join(extracted, "control"), "utf8")).toContain("Package: sai-atlas");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("the AppImage is finished last so its bundled WebKit finds the host's bwrap and xdg-dbus-proxy", () => {
		// tauri-bundler relocates every /usr in the bundled libwebkit2gtk; without the finalize
		// step the always-on web-process sandbox fails to start from the AppImage.
		expect(scripts()["package:tauri:linux"]).toMatch(
			/ && bun src-tauri\/linux\/finalize-deb\.ts \S+ && bun src-tauri\/linux\/finalize-appimage\.ts src-tauri\/target\/x86_64-unknown-linux-gnu\/release\/bundle\/appimage$/,
		);
	});

	it("no AppArmor profile is bundled", () => {
		// Ubuntu 26.04's bwrap-userns-restrict profile already allows bubblewrap.
		for (const file of packagingFiles()) {
			expect(path.basename(file).toLowerCase(), path.relative(ROOT, file)).not.toContain("apparmor");
			expect(fs.readFileSync(file, "utf8").toLowerCase(), path.relative(ROOT, file)).not.toContain("apparmor.d");
		}
	});
});

describe("Windows installer", () => {
	it("the NSIS hook names the old Electron GUID", () => {
		const nsis = platform("windows").bundle?.windows?.nsis;
		expect(nsis?.installMode).toBe("currentUser");
		expect(nsis?.installerHooks).toBe("windows/hooks.nsh");
		const hooks = fs.readFileSync(path.join(TAURI, "windows/hooks.nsh"), "utf8");
		expect(hooks).toContain("!macro NSIS_HOOK_PREINSTALL");
		expect(hooks).toContain(
			"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\9d72fc94-91dd-54d1-8fda-3b6e5e8d23f2",
		);
		expect(hooks).toMatch(/ReadRegStr \$R0 HKCU .*"QuietUninstallString"/);
		expect(hooks).toMatch(/ReadRegStr \$R0 HKLM .*"QuietUninstallString"/);
		expect(hooks).toContain("ExecWait");
	});
});

describe("macOS bundle", () => {
	const PRIVACY_KEYS = [
		"NSMicrophoneUsageDescription",
		"NSCameraUsageDescription",
		"NSBluetoothAlwaysUsageDescription",
		"NSBluetoothPeripheralUsageDescription",
	];

	it("names the app in every privacy prompt the bundle can trigger", async () => {
		const plist = (await parsePlistFile(path.join(TAURI, "Info.plist"))) as PlistObject;
		for (const key of PRIVACY_KEYS) expect(String(plist[key]), key).toContain(PRODUCT_NAME);
	});

	it("ships an explicit transport policy that leaves ATS on and excepts loopback", async () => {
		const plist = (await parsePlistFile(path.join(TAURI, "Info.plist"))) as PlistObject;
		expect(plist.NSAppTransportSecurity).toEqual({ NSAllowsArbitraryLoads: false, NSAllowsLocalNetworking: true });
	});

	it("signs ad hoc with the app entitlements", () => {
		expect(platform("macos").bundle?.macOS?.signingIdentity).toBe("-");
		expect(platform("macos").bundle?.macOS?.entitlements).toBe("macos/app.entitlements");
	});

	it("app entitlements grant no dyld or library-validation exemption", async () => {
		const app = (await parsePlistFile(path.join(TAURI, "macos/app.entitlements"))) as PlistObject;
		expect(app).toEqual({ "com.apple.security.device.audio-input": true });
		const omp = (await parsePlistFile(path.join(TAURI, "macos/omp.entitlements"))) as PlistObject;
		expect(omp).toEqual({
			"com.apple.security.cs.allow-jit": true,
			"com.apple.security.cs.allow-unsigned-executable-memory": true,
		});
	});

	it("macOS floor matches the update-feed floor", () => {
		const floor = platform("macos").bundle?.macOS?.minimumSystemVersion ?? "";
		expect(floor).toBe("13.3");
		// The feed carries the Darwin release of the same floor, and it clears the release gate.
		const darwin = darwinReleaseFor(floor);
		expect(darwin).toBe("22.4.0");
		const parts = (version: string) => version.split(".").map(Number);
		const [major, minor] = parts(darwin);
		const [floorMajor, floorMinor] = parts(MAC_UPDATE_FLOOR);
		expect((major ?? 0) * 100 + (minor ?? 0)).toBeGreaterThanOrEqual((floorMajor ?? 0) * 100 + (floorMinor ?? 0));
	});
});

describe("Tauri CI job", () => {
	interface Job {
		"runs-on"?: string;
		env?: Record<string, string>;
		steps?: { run?: string; uses?: string; with?: Record<string, string | boolean | number> }[];
	}

	it("builds, lints and tests the Rust core and checks the API snapshots with pinned actions", () => {
		const ci = parseYaml(fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8")) as {
			jobs?: Record<string, Job>;
		};
		const job = ci.jobs?.["tauri-linux"];
		expect(job?.["runs-on"]).toBe("ubuntu-latest");
		expect(job?.env?.CARGO_HOME_BIN).toBe("/home/runner/.cargo/bin");
		const runs = job?.steps?.flatMap(step => (step.run ? [step.run] : [])) ?? [];
		for (const command of [
			"bun install --frozen-lockfile",
			"bun run build:renderer:tauri",
			"cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings",
			"cargo test --manifest-path src-tauri/Cargo.toml --all-features",
			'for parity in src-tauri/contracts/*.parity.json; do bun scripts/check-test-parity.ts "$(basename "$parity" .parity.json)"; done',
			"bash scripts/check-module.sh snapshots",
		]) {
			expect(runs).toContain(command);
		}
		// Diff-based ownership gates need a merge base and fail by design once the
		// cross-module work lands on main, so CI runs only whole-tree checks.
		for (const command of runs) expect(command).not.toContain("merge-base");
		const setup = runs.join("\n");
		for (const needle of [
			"bubblewrap",
			"xdg-dbus-proxy",
			"source scripts/rust-pins.env",
			"$PUBLIC_API_TOOLCHAIN",
			"$CARGO_PUBLIC_API_VERSION",
			'tauri-cli --version "^2" --locked',
		]) {
			expect(setup).toContain(needle);
		}
		const uses = job?.steps?.flatMap(step => (step.uses ? [step.uses] : [])) ?? [];
		for (const action of uses) expect(action).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
		expect(job?.steps?.find(step => step.uses?.startsWith("actions/checkout@"))?.with?.["persist-credentials"]).toBe(
			false,
		);
	});
});
