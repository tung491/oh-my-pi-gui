import { describe, expect, it } from "vitest";
import type { LaunchPlatform } from "../shared/launchable-path";
import { type OpenPathFs, openPathTarget } from "./open-path-target";

interface Entry {
	real?: string;
	isFile: boolean;
	mode: number;
}

/** A fake filesystem: each key is a path as requested; `real` is where it resolves (symlinks, dot segments, short names). */
function fakeFs(entries: Record<string, Entry>): OpenPathFs {
	const byReal = new Map<string, Entry>();
	for (const [requested, entry] of Object.entries(entries)) byReal.set(entry.real ?? requested, entry);
	return {
		realpath: async path => {
			const entry = entries[path];
			if (!entry) throw new Error(`ENOENT: ${path}`);
			return entry.real ?? path;
		},
		stat: async path => {
			const entry = byReal.get(path);
			if (!entry) throw new Error(`ENOENT: ${path}`);
			return { isFile: () => entry.isFile, mode: entry.mode };
		},
	};
}

const text = { isFile: true, mode: 0o100644 };
const bundle = { isFile: false, mode: 0o40755 };

async function decide(path: string, entries: Record<string, Entry>, platform: LaunchPlatform = "mac") {
	return openPathTarget(path, platform, fakeFs(entries));
}

describe("openPathTarget", () => {
	it("opens an ordinary file at its resolved path", async () => {
		expect(await decide("/repo/src/App.tsx", { "/repo/src/App.tsx": text })).toEqual({
			action: "open",
			path: "/repo/src/App.tsx",
		});
	});

	it("reports a missing path instead of deciding", async () => {
		expect(await decide("/repo/gone.txt", {})).toBeNull();
	});

	it.each(["/repo/Evil.app/", "/repo/Evil.app/.", "/repo/Evil.app/Contents/.."])(
		"reveals the bundle %s even when a separator or dot segment hides its name",
		async requested => {
			expect(await decide(requested, { [requested]: { ...bundle, real: "/repo/Evil.app" } })).toEqual({
				action: "reveal",
				path: "/repo/Evil.app",
			});
		},
	);

	it("reveals a harmless-looking symlink whose target is a launcher", async () => {
		const decision = await decide("/repo/NOTES.md", { "/repo/NOTES.md": { ...text, real: "/repo/.x/run.terminal" } });
		expect(decision?.action).toBe("reveal");
	});

	it("reveals a symlink to an application bundle", async () => {
		const decision = await decide("/repo/docs", { "/repo/docs": { ...bundle, real: "/repo/.x/Evil.app" } });
		expect(decision?.action).toBe("reveal");
	});

	it("reveals a launcher named by the requested path even when it resolves elsewhere", async () => {
		const decision = await decide(
			"/repo/deploy.sh",
			{ "/repo/deploy.sh": { ...text, real: "/repo/.x/notes" } },
			"linux",
		);
		expect(decision?.action).toBe("reveal");
	});

	it("reveals a Windows short name that resolves to a launcher", async () => {
		const decision = await decide(
			"C:\\repo\\X~1.LIB",
			{ "C:\\repo\\X~1.LIB": { ...text, real: "C:\\repo\\x.library-ms" } },
			"windows",
		);
		expect(decision?.action).toBe("reveal");
	});

	it("reveals an executable file on macOS", async () => {
		const decision = await decide("/repo/tool", { "/repo/tool": { isFile: true, mode: 0o100755 } });
		expect(decision?.action).toBe("reveal");
	});
});
