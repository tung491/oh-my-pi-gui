/**
 * Mac bundle config contract. Every mac variant ships its own electron-builder
 * file, so a key the built Info.plist depends on can exist in one and be missing
 * in another — which is how `omp://` deep links came to be dead code in every
 * installed build.
 */
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { type PlistObject, parsePlistFile, savePlistFile } from "app-builder-lib/out/util/plist";
import { UUID } from "builder-util-runtime";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { APP_ID, PRODUCT_NAME } from "../shared/product";
import { type MacInstallerArchitecture, selectMacInstaller } from "./updater-state";

interface BuilderConfig {
	appId?: string;
	productName?: string;
	afterPack?: string;
	extraResources?: { from: string; to: string }[];
	protocols?: { name: string; schemes?: string[] }[];
	mac?: { icon?: string; artifactName?: string; minimumSystemVersion?: string; extendInfo?: Record<string, unknown> };
	win?: { target?: { target?: string; arch?: string[] }[] };
	nsis?: { guid?: string; shortcutName?: string; artifactName?: string };
	portable?: { artifactName?: string };
	electronLanguages?: string[];
	linux?: unknown;
	extraMetadata?: { name?: string; productName?: string };
	publish?: { provider?: string; owner?: string; repo?: string };
}

const PACKAGE_ROOT = path.join(__dirname, "..", "..");
const require = createRequire(import.meta.url);

type AfterPackHook = (context: {
	electronPlatformName: string;
	appOutDir: string;
	packager: { appInfo: { productFilename: string } };
}) => Promise<void>;

const PRIVACY_KEYS = [
	"NSMicrophoneUsageDescription",
	"NSCameraUsageDescription",
	"NSBluetoothAlwaysUsageDescription",
	"NSBluetoothPeripheralUsageDescription",
];

function builderConfigs(): { file: string; config: BuilderConfig }[] {
	return fs
		.readdirSync(PACKAGE_ROOT)
		.filter(name => /^electron-builder.*\.yml$/.test(name))
		.map(file => ({
			file,
			config: parse(fs.readFileSync(path.join(PACKAGE_ROOT, file), "utf8")) as BuilderConfig,
		}));
}

function macConfigs(): { file: string; config: BuilderConfig }[] {
	return builderConfigs().filter(entry => entry.config.mac);
}

/** Gitignored local variants: every guard below still checks them when present, but none is required. */
const LOCAL_ONLY_CONFIGS = new Set(["electron-builder.trial.yml"]);

describe("mac bundle configs", () => {
	const configs = macConfigs();

	it("sees every builder variant sitting in the package root", () => {
		// The guards below iterate this list, so discovery is itself a contract: a
		// fourth variant must not slip past them unnoticed.
		expect(
			configs
				.map(entry => entry.file)
				.filter(file => !LOCAL_ONLY_CONFIGS.has(file))
				.sort()
				.join(","),
		).toBe("electron-builder.x64.yml,electron-builder.yml");
	});

	it("registers the omp:// scheme that src/main/deep-link.ts handles", () => {
		for (const { file, config } of configs) {
			const schemes = (config.protocols ?? []).flatMap(protocol => protocol.schemes ?? []);
			expect(schemes, `${file} ships no URL scheme`).toContain("omp");
		}
	});

	it("ships the assistant pack beside the sidecar", () => {
		// The main process loads the pack from `dirname(omp)/assistant-pack` and
		// refuses to spawn without it.
		for (const { file, config } of configs) {
			expect(config.extraResources, file).toContainEqual({ from: "resources/assistant-pack", to: "assistant-pack" });
		}
	});

	it("names the app in every privacy prompt the bundle can trigger", () => {
		for (const { file, config } of configs) {
			const info = config.mac?.extendInfo ?? {};
			for (const key of PRIVACY_KEYS) {
				const value = info[key];
				// Electron's own default reads "This app needs access to the camera":
				// a prompt that names no product and claims a capability Sai ATLAS never uses.
				const namesApp = typeof value === "string" && /\bSai ATLAS\b/.test(value);
				expect(namesApp, `${file} → ${key}`).toBe(true);
			}
		}
	});

	it("ships an explicit transport policy that leaves ATS on and excepts loopback", () => {
		for (const { file, config } of configs) {
			const info = config.mac?.extendInfo ?? {};
			// A stray NSAllowsArbitraryLoads in any variant turns TLS enforcement
			// off app-wide; the local Ollama server is the only cleartext origin, and
			// it is loopback. Pin both halves instead of trusting the default.
			expect(info.NSAppTransportSecurity, `${file} declares no transport policy`).toMatchObject({
				NSAllowsArbitraryLoads: false,
				NSAllowsLocalNetworking: true,
			});
		}
	});

	it("restores ATS in the completed bundle after electron-builder enables arbitrary loads", async () => {
		const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-bundle-policy-"));
		const plistPath = path.join(directory, `${PRODUCT_NAME}.app`, "Contents", "Info.plist");
		const loopback = { NSExceptionAllowsInsecureHTTPLoads: true };
		const original: PlistObject = {
			CFBundleIdentifier: APP_ID,
			CFBundleURLTypes: [{ CFBundleURLSchemes: ["omp"] }],
			NSAppTransportSecurity: {
				NSAllowsArbitraryLoads: true,
				NSAllowsLocalNetworking: true,
				NSExceptionDomains: { localhost: loopback, "127.0.0.1": loopback },
			},
		};
		try {
			await fs.promises.mkdir(path.dirname(plistPath), { recursive: true });
			for (const { file, config } of configs) {
				await savePlistFile(plistPath, original);
				const hookPath = config.afterPack;
				expect(hookPath, `${file} declares no afterPack policy hook`).toBe("scripts/after-pack.cjs");
				if (!hookPath) continue;
				const afterPack = require(path.resolve(PACKAGE_ROOT, hookPath)).afterPack as AfterPackHook;
				await afterPack({
					electronPlatformName: "darwin",
					appOutDir: directory,
					packager: { appInfo: { productFilename: PRODUCT_NAME } },
				});
				expect(await parsePlistFile(plistPath), `${file} leaves arbitrary loads enabled in the bundle`).toEqual({
					...original,
					NSAppTransportSecurity: {
						NSAllowsArbitraryLoads: false,
						NSAllowsLocalNetworking: true,
						NSExceptionDomains: { localhost: loopback, "127.0.0.1": loopback },
					},
				});
			}
		} finally {
			await fs.promises.rm(directory, { recursive: true, force: true });
		}
	});
});

describe("Windows package config", () => {
	it("ships a Windows sidecar and both x64 installer targets", () => {
		const file = "electron-builder.win.yml";
		const config = parse(fs.readFileSync(path.join(PACKAGE_ROOT, file), "utf8")) as BuilderConfig;
		expect(
			config.protocols?.flatMap(protocol => protocol.schemes ?? []),
			`${file} ships no URL scheme`,
		).toContain("omp");
		expect(config.extraResources).toContainEqual({ from: "resources/omp.exe", to: "omp.exe" });
		expect(config.win?.target).toEqual([
			{ target: "nsis", arch: ["x64"] },
			{ target: "portable", arch: ["x64"] },
		]);
	});

	it("keeps a Chromium locale pak the renderer can load", () => {
		// Windows paks are named locales/en-US.pak; a bare "en" filter strips all
		// of them and the sandboxed renderer crashes at startup (blank window).
		const file = "electron-builder.win.yml";
		const config = parse(fs.readFileSync(path.join(PACKAGE_ROOT, file), "utf8")) as BuilderConfig;
		expect(config.electronLanguages).toContain("en-US");
	});
});

/**
 * electron-builder derives the NSIS GUID as
 * `UUID.v5(appId, UUID.parse("50e065bc-3134-11e6-9bab-38c9862bdaf3"))` (NsisTarget.js) —
 * with the namespace parsed, not passed as a string, which yields another id.
 * This is that GUID for the old appId `sh.omp.gui`: pinned so the installer
 * finds an existing omp install and upgrades it in place. Never change it.
 */
const OMP_NSIS_GUID = "9d72fc94-91dd-54d1-8fda-3b6e5e8d23f2";

/** Expands electron-builder's `${macro}` placeholders in an artifact file name. */
function artifactFile(pattern: string | undefined, macros: Record<string, string>): string | undefined {
	return pattern?.replace(/\$\{(\w+)\}/g, (placeholder, key: string) => macros[key] ?? placeholder);
}

/** The option block that names each electron-builder target's output file. */
const ARTIFACT_OPTIONS: Record<string, "nsis" | "portable"> = {
	nsis: "nsis",
	portable: "portable",
};

describe("product identity in every builder config", () => {
	const configs = builderConfigs();

	it("names the product and app id the main process uses", () => {
		expect(configs.length).toBeGreaterThanOrEqual(3);
		for (const { file, config } of configs) {
			expect(config.productName, file).toBe(PRODUCT_NAME);
			expect(config.appId, file).toBe(APP_ID);
		}
	});

	it("leaves Linux packaging to the Tauri container build", () => {
		// A bare host build on a newer Ubuntu links past the 24.04 glibc floor, so
		// package:linux is the ubuntu:24.04 container build and no Electron config
		// packages Linux (the default one would ship the macOS arm64 sidecar).
		const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
			scripts: Record<string, string>;
		};
		expect(pkg.scripts["package:linux"]).toBe("bash scripts/tauri-linux-build.sh");
		for (const { file, config } of configs) expect(config.linux, file).toBeUndefined();
	});

	it("names the Linux desktop identity after the app id", () => {
		// Electron uses package.json desktopName as the Wayland app_id when it runs
		// on Linux (dev and the Playwright suite); GNOME needs a reverse-DNS one.
		const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
			desktopName?: string;
		};
		expect(pkg.desktopName).toBe(`${APP_ID}.desktop`);
	});

	it("keeps the old install's NSIS GUID so Windows upgrades in place", () => {
		expect(UUID.v5("sh.omp.gui", UUID.parse("50e065bc-3134-11e6-9bab-38c9862bdaf3"))).toBe(OMP_NSIS_GUID);
		const windows = configs.filter(({ config }) => config.win?.target?.some(target => target.target === "nsis"));
		expect(windows.map(entry => entry.file).sort()).toEqual(["electron-builder.win.yml", "electron-builder.yml"]);
		for (const { file, config } of windows) {
			expect(config.nsis?.guid, file).toBe(OMP_NSIS_GUID);
			expect(config.nsis?.shortcutName, file).toBe(PRODUCT_NAME);
		}
	});

	it("gives every target it builds an explicit file name without spaces", () => {
		for (const { file, config } of configs) {
			const names: [string, string | undefined][] = [];
			if (config.mac) names.push(["mac", config.mac.artifactName]);
			for (const { target } of config.win?.target ?? []) {
				const option = target ? ARTIFACT_OPTIONS[target] : undefined;
				expect(option, `${file} builds an unknown target ${target}`).toBeDefined();
				if (option) names.push([option, config[option]?.artifactName]);
			}
			for (const [option, name] of names) {
				expect(name, `${file} → ${option}.artifactName`).toBeDefined();
				expect(name, `${file} → ${option}.artifactName`).not.toContain(" ");
			}
		}
	});

	it("names the DMGs the updater looks for", () => {
		const byFile = new Map(configs.map(({ file, config }) => [file, config.mac?.artifactName]));
		const variants: [string, MacInstallerArchitecture][] = [
			["electron-builder.yml", "arm64"],
			["electron-builder.x64.yml", "x64"],
		];
		for (const [file, arch] of variants) {
			const name = artifactFile(byFile.get(file), { version: "1.2.3", arch, ext: "dmg" });
			expect(name, `${file} names no DMG`).toBeDefined();
			expect(selectMacInstaller([{ url: name ?? "", sha512: "sha" }], "1.2.3", arch)?.name, file).toBe(name);
		}
	});

	it("converts the PNG app icon for both mac bundles", () => {
		for (const { file, config } of macConfigs()) expect(config.mac?.icon, file).toBe("resources/icon.png");
	});

	it("declares the macOS 13 floor Electron 44 needs in both mac bundles", () => {
		const files = macConfigs().map(({ file, config }) => {
			expect(config.mac?.minimumSystemVersion, file).toBe("13.0");
			return file;
		});
		expect(files).toEqual(expect.arrayContaining(["electron-builder.yml", "electron-builder.x64.yml"]));
	});

	it("leaves the profile path to package.json name", () => {
		// Electron derives userData from productName, then name; src/main/pin-user-data.ts
		// pins the name-derived path, and none of these may start moving it.
		for (const { file, config } of configs) {
			expect(config.extraMetadata?.name, file).toBeUndefined();
			expect(config.extraMetadata?.productName, file).toBeUndefined();
		}
		const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
			name?: string;
			productName?: string;
		};
		expect(pkg.name).toBe("@oh-my-pi/omp-gui");
		expect(pkg.productName).toBeUndefined();
	});
});

/**
 * The shipped CSP is the only thing between model output and an outbound
 * request, and nothing in the renderer enforces it — so it is read back off the
 * HTML head that actually ships.
 */
describe("renderer content security policy", () => {
	function sources(directive: string): string[] {
		const html = fs.readFileSync(path.join(PACKAGE_ROOT, "src/renderer/index.html"), "utf8");
		const content = /http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"/.exec(html)?.[1];
		if (!content) throw new Error("index.html declares no Content-Security-Policy");
		const entry = content
			.split(";")
			.map(part => part.trim())
			.find(part => part.split(" ")[0] === directive);
		if (!entry) throw new Error(`CSP declares no ${directive}`);
		return entry.split(" ").slice(1);
	}

	it("cannot fetch a remote image for markdown a model wrote", () => {
		// Explicit, not inherited: without img-src the policy falls back to
		// default-src, and a later relaxation there would silently re-open this.
		expect(sources("img-src")).toEqual(["'self'", "data:", "blob:"]);
	});

	it("keeps script execution and network calls inside the app", () => {
		expect(sources("script-src")).toEqual(["'self'"]);
		expect(sources("connect-src")).toEqual(["'self'"]);
	});
});

describe("Linux CI workflow", () => {
	const workflows = path.join(PACKAGE_ROOT, ".github", "workflows");
	interface Workflow {
		jobs?: Record<
			string,
			{
				"runs-on"?: string;
				env?: Record<string, string>;
				steps?: { run?: string; uses?: string; with?: Record<string, string | boolean> }[];
			}
		>;
	}

	it("type-checks, tests and builds a clean clone on ubuntu-latest", () => {
		const ci = parse(fs.readFileSync(path.join(workflows, "ci.yml"), "utf8")) as Workflow;
		const job = ci.jobs?.linux;
		expect(job?.["runs-on"]).toBe("ubuntu-latest");
		expect(job?.steps?.flatMap(step => (step.run ? [step.run] : []))).toEqual([
			"bun install --frozen-lockfile",
			"bun run check:types",
			"bunx vitest run",
			"bun run build",
		]);
		// Actions are pinned to full commit SHAs, and the checkout token is not left on disk.
		const uses = job?.steps?.flatMap(step => (step.uses ? [step.uses] : [])) ?? [];
		expect(uses).toHaveLength(2);
		for (const action of uses) expect(action).toMatch(/^(actions\/checkout|oven-sh\/setup-bun)@[0-9a-f]{40}$/);
		const checkout = job?.steps?.find(step => step.uses?.startsWith("actions/checkout@"));
		expect(checkout?.with?.["persist-credentials"]).toBe(false);
		const setupBun = job?.steps?.find(step => step.uses?.startsWith("oven-sh/setup-bun@"));
		expect(setupBun?.with?.["bun-version"]).toMatch(/^\d+\.\d+\.\d+$/);
		// Tests load electron through electron-store, so the binary must be installed.
		expect(job?.env?.ELECTRON_SKIP_BINARY_DOWNLOAD).toBeUndefined();
	});

	it("leaves Pages deployment to the Pages workflow alone", () => {
		const publishers = fs
			.readdirSync(workflows)
			.filter(name => fs.readFileSync(path.join(workflows, name), "utf8").includes("actions/deploy-pages"));
		expect(publishers).toEqual(["pages.yml"]);
	});
});

describe("renderer pages", () => {
	const csp = (page: string) =>
		fs
			.readFileSync(path.join(PACKAGE_ROOT, "src", "renderer", page), "utf8")
			.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1];

	it("the quick-entry page ships the same content security policy", () => {
		expect(csp("index.html")).toBeDefined();
		expect(csp("quick-entry.html")).toBe(csp("index.html"));
	});
});
