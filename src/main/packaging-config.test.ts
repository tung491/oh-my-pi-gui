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
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface BuilderConfig {
	afterPack?: string;
	extraResources?: { from: string; to: string }[];
	protocols?: { name: string; schemes?: string[] }[];
	mac?: { extendInfo?: Record<string, unknown> };
	win?: { target?: { target?: string; arch?: string[] }[] };
	electronLanguages?: string[];
	linux?: {
		executableName?: string;
		maintainer?: string;
		target?: { target?: string; arch?: string[] }[];
		desktop?: { entry?: Record<string, string> };
	};
	appImage?: { executableArgs?: string[] };
	toolsets?: { appimage?: string };
	extraMetadata?: { desktopName?: string; homepage?: string };
	publish?: { provider?: string; owner?: string; repo?: string };
}

const PACKAGE_ROOT = path.join(__dirname, "..", "..");
const require = createRequire(import.meta.url);

type AfterPackHook = (context: { electronPlatformName: string; appOutDir: string }) => Promise<void>;

const PRIVACY_KEYS = [
	"NSMicrophoneUsageDescription",
	"NSCameraUsageDescription",
	"NSBluetoothAlwaysUsageDescription",
	"NSBluetoothPeripheralUsageDescription",
];

function macConfigs(): { file: string; config: BuilderConfig }[] {
	return fs
		.readdirSync(PACKAGE_ROOT)
		.filter(name => /^electron-builder.*\.yml$/.test(name))
		.map(file => ({
			file,
			config: parse(fs.readFileSync(path.join(PACKAGE_ROOT, file), "utf8")) as BuilderConfig,
		}))
		.filter(entry => entry.config.mac);
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

	it("names the app in every privacy prompt the bundle can trigger", () => {
		for (const { file, config } of configs) {
			const info = config.mac?.extendInfo ?? {};
			for (const key of PRIVACY_KEYS) {
				const value = info[key];
				// Electron's own default reads "This app needs access to the camera":
				// a prompt that names no product and claims a capability omp never uses.
				const namesApp = typeof value === "string" && /\bomp\b/.test(value);
				expect(namesApp, `${file} → ${key}`).toBe(true);
			}
		}
	});

	it("ships an explicit transport policy that leaves ATS on and excepts loopback", () => {
		for (const { file, config } of configs) {
			const info = config.mac?.extendInfo ?? {};
			// A stray NSAllowsArbitraryLoads in any variant turns TLS enforcement
			// off app-wide; the stats server is the only cleartext origin, and it is
			// local. Pin both halves instead of trusting the default.
			expect(info.NSAppTransportSecurity, `${file} declares no transport policy`).toMatchObject({
				NSAllowsArbitraryLoads: false,
				NSAllowsLocalNetworking: true,
			});
		}
	});

	it("restores ATS in the completed bundle after electron-builder enables arbitrary loads", async () => {
		const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-bundle-policy-"));
		const plistPath = path.join(directory, "omp.app", "Contents", "Info.plist");
		const loopback = { NSExceptionAllowsInsecureHTTPLoads: true };
		const original: PlistObject = {
			CFBundleIdentifier: "sh.omp.gui",
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
				await afterPack({ electronPlatformName: "darwin", appOutDir: directory });
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

describe("Linux package config", () => {
	const file = "electron-builder.linux.yml";
	const read = (name: string): BuilderConfig =>
		parse(fs.readFileSync(path.join(PACKAGE_ROOT, name), "utf8")) as BuilderConfig;

	it("ships the Linux sidecar and window icon as bundle resources", () => {
		const config = read(file);
		expect(config.extraResources).toContainEqual({ from: "resources/omp.linux-x64", to: "omp" });
		expect(config.extraResources).toContainEqual({ from: "resources/icon.png", to: "icon.png" });
		expect(
			config.protocols?.flatMap(protocol => protocol.schemes ?? []),
			`${file} ships no URL scheme`,
		).toContain("omp");
	});

	it("builds an x64 AppImage and deb that share one desktop identity", () => {
		const config = read(file);
		expect(config.linux?.target).toEqual([
			{ target: "AppImage", arch: ["x64"] },
			{ target: "deb", arch: ["x64"] },
		]);
		expect(config.linux?.executableName).toBe("omp-gui");
		expect(config.extraMetadata?.desktopName).toBe("omp-gui.desktop");
		// Electron 35 under XWayland names the window class after app.setName("omp").
		expect(config.linux?.desktop?.entry?.StartupWMClass).toBe("omp");
		expect(config.linux?.maintainer).toBe("nornzach <287694139+nornzach@users.noreply.github.com>");
		expect(config.extraMetadata?.homepage).toBe("https://github.com/nornzach/oh-my-pi-gui");
	});

	it("never writes --no-sandbox into the AppImage launch command", () => {
		const config = read(file);
		expect(config.toolsets?.appimage).toBe("1.0.3");
		expect(config.appImage?.executableArgs).toEqual([]);
	});

	it("keeps a Chromium locale pak and the release owner", () => {
		const config = read(file);
		expect(config.electronLanguages).toContain("en-US");
		expect(config.publish).toEqual({ provider: "github", owner: "nornzach", repo: "oh-my-pi-gui" });
	});

	it("packages Linux only through the Linux config", () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
			scripts: Record<string, string>;
		};
		expect(pkg.scripts["package:linux"]).toBe(
			"bun run build && electron-builder --config electron-builder.linux.yml --linux --x64",
		);
		// The default config packages resources/omp, the macOS arm64 sidecar.
		expect(read("electron-builder.yml").linux).toBeUndefined();
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
