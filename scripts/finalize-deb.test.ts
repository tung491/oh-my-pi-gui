import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertPackageControl,
	CONTROL_MEMBERS,
	DEB_DEPENDS,
	DEB_RECOMMENDS,
	finalizeDeb,
	parseControlFields,
	rewriteTrayDependency,
	TRAY_ALTERNATION,
	TRAY_DEPENDENCY,
} from "../src-tauri/linux/finalize-deb";

/** Depends as tauri-cli writes it: the configured entries, then the tray library, WebKitGTK and GTK. */
const BUNDLER_DEPENDS = DEB_DEPENDS.replace(TRAY_ALTERNATION, TRAY_DEPENDENCY);

function control(depends = BUNDLER_DEPENDS, extra: string[] = [`Recommends: ${DEB_RECOMMENDS}`]): string {
	return [
		"Package: sai-atlas",
		"Version: 1.0.0",
		"Architecture: amd64",
		"Maintainer: test",
		`Depends: ${depends}`,
		...extra,
		"Description: test",
		" long description",
		"",
	].join("\n");
}

const fields = (text: string) => parseControlFields(text);

describe("rewriteTrayDependency", () => {
	it("replaces the bundler's tray package with the alternation and keeps the rest in order", () => {
		const rewritten = rewriteTrayDependency(control());
		expect(fields(rewritten).get("depends")).toBe(DEB_DEPENDS);
		expect(rewritten.replace(DEB_DEPENDS, BUNDLER_DEPENDS)).toBe(control());
	});

	it("leaves Recommends and every other field alone", () => {
		const rewritten = fields(rewriteTrayDependency(control(BUNDLER_DEPENDS, [`Recommends: ${TRAY_DEPENDENCY}-dev`])));
		expect(rewritten.get("recommends")).toBe(`${TRAY_DEPENDENCY}-dev`);
		expect(rewritten.get("package")).toBe("sai-atlas");
	});

	it("refuses a control file without Depends", () => {
		expect(() => rewriteTrayDependency("Package: sai-atlas\nDescription: test\n")).toThrow(/no Depends/);
	});

	it("refuses a Depends that does not name the Ayatana package exactly once", () => {
		// A build host with only libappindicator makes tauri-cli add libappindicator3-1 instead.
		expect(() => rewriteTrayDependency(control("bubblewrap, libappindicator3-1, libgtk-3-0"))).toThrow(
			/name libayatana-appindicator3-1 once, found: bubblewrap, libappindicator3-1, libgtk-3-0/,
		);
		expect(() => rewriteTrayDependency(control(`${TRAY_DEPENDENCY}, ${TRAY_DEPENDENCY}`))).toThrow(/once/);
		// Already rewritten: the alternation is not the bundler's token.
		expect(() => rewriteTrayDependency(control(DEB_DEPENDS))).toThrow(/once/);
	});
});

describe("parseControlFields", () => {
	it("reads fields case-insensitively and folds continuation lines into the field before them", () => {
		const parsed = fields("package: sai-atlas\nDescription: short\n long\n .\n more\nDepends: a, b | c\n");
		expect(parsed.get("package")).toBe("sai-atlas");
		expect(parsed.get("description")).toBe("short\n long\n .\n more");
		expect(parsed.get("depends")).toBe("a, b | c");
	});
});

describe("assertPackageControl", () => {
	const finished = () => fields(rewriteTrayDependency(control()));

	it("accepts the expected Depends and Recommends with only control and md5sums", () => {
		expect(CONTROL_MEMBERS).toEqual(["control", "md5sums"]);
		expect(() => assertPackageControl(finished(), ["md5sums", "control"], "pkg.deb")).not.toThrow();
	});

	it("refuses a soft package moved back into Depends", () => {
		const parsed = fields(control(`${DEB_DEPENDS}, desktop-file-utils`));
		expect(() => assertPackageControl(parsed, CONTROL_MEMBERS, "pkg.deb")).toThrow(
			/pkg\.deb is not safe to ship: Depends is ".*desktop-file-utils", expected/,
		);
	});

	it("refuses a missing or different Recommends", () => {
		expect(() => assertPackageControl(fields(control(DEB_DEPENDS, [])), CONTROL_MEMBERS, "pkg.deb")).toThrow(
			/Recommends is "", expected/,
		);
		const reordered = fields(control(DEB_DEPENDS, ["Recommends: xdg-utils"]));
		expect(() => assertPackageControl(reordered, CONTROL_MEMBERS, "pkg.deb")).toThrow(/Recommends is "xdg-utils"/);
	});

	it("refuses Pre-Depends", () => {
		const parsed = fields(
			control(DEB_DEPENDS, [`Recommends: ${DEB_RECOMMENDS}`, "Pre-Depends: libwebkit2gtk-4.1-0"]),
		);
		expect(() => assertPackageControl(parsed, CONTROL_MEMBERS, "pkg.deb")).toThrow(
			/has Pre-Depends: libwebkit2gtk-4\.1-0/,
		);
	});

	it("refuses maintainer scripts and other control-archive members", () => {
		expect(() => assertPackageControl(finished(), [...CONTROL_MEMBERS, "postinst", "preinst"], "pkg.deb")).toThrow(
			/control archive carries postinst, preinst/,
		);
		expect(() => assertPackageControl(finished(), [...CONTROL_MEMBERS, "triggers"], "pkg.deb")).toThrow(/triggers/);
	});
});

describe("finalizeDeb control checks", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	/** A package laid out the way tauri-bundler writes one, with `controlText` and optional extra control members. */
	function bundlerDeb(controlText: string, members: Record<string, string> = {}): string {
		const dir = mkdtempSync(path.join(os.tmpdir(), "finalize-deb-control-"));
		dirs.push(dir);
		const root = path.join(dir, "root");
		const put = (file: string, contents: string, mode = 0o644) => {
			mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
			writeFileSync(path.join(root, file), contents);
			chmodSync(path.join(root, file), mode);
		};
		put("DEBIAN/control", controlText);
		for (const [name, contents] of Object.entries(members)) put(`DEBIAN/${name}`, contents, 0o755);
		put("usr/bin/sai-atlas", "binary", 0o755);
		put("usr/share/applications/Sai ATLAS.desktop", "[Desktop Entry]\n");
		for (const sub of ["DEBIAN", "usr", "usr/bin", "usr/share", "usr/share/applications"]) {
			chmodSync(path.join(root, sub), 0o755);
		}
		const deb = path.join(dir, "Sai ATLAS_1.0.0_amd64.deb");
		const built = spawnSync("dpkg-deb", ["--root-owner-group", "-Zgzip", "-b", root, deb], { encoding: "utf8" });
		expect(built.status, built.stderr).toBe(0);
		rmSync(root, { recursive: true });
		return deb;
	}

	const field = (deb: string, name: string) =>
		spawnSync("dpkg-deb", ["-f", deb, name], { encoding: "utf8" }).stdout.trim();

	it("ships the alternation, the four Recommends and no Pre-Depends", () => {
		const deb = bundlerDeb(control());
		finalizeDeb(deb);
		expect(field(deb, "Depends")).toBe(DEB_DEPENDS);
		expect(field(deb, "Recommends")).toBe(DEB_RECOMMENDS);
		expect(field(deb, "Pre-Depends")).toBe("");
		expect(readdirSync(path.dirname(deb))).toEqual([path.basename(deb)]);
	});

	it("leaves the bundler's package untouched when the finished one would carry a maintainer script", () => {
		const deb = bundlerDeb(control(), { postinst: "#!/bin/sh\nexit 0\n" });
		const before = readFileSync(deb);
		expect(() => finalizeDeb(deb)).toThrow(/control archive carries postinst/);
		expect(readFileSync(deb).equals(before)).toBe(true);
		expect(readdirSync(path.dirname(deb))).toEqual([path.basename(deb)]);
	});

	it("refuses a package whose configured depends grew a soft dependency", () => {
		const deb = bundlerDeb(control(`desktop-file-utils, ${BUNDLER_DEPENDS}`));
		expect(() => finalizeDeb(deb)).toThrow(/Depends is "desktop-file-utils, bubblewrap/);
	});
});
