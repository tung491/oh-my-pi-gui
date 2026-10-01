/**
 * File dialogs start in the folder the window last used: an explicit absolute
 * path still wins, a bare file name joins the remembered folder, and before
 * any folder was used the dialog keeps the OS default.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dialogDirOf, dialogStartPath } from "./dialog-memory";

const last = join("/", "home", "me", "exports");

describe("dialog start path", () => {
	it("keeps an absolute request as it is", () => {
		const requested = join("/", "tmp", "report.html");
		expect(dialogStartPath(last, requested)).toBe(requested);
		expect(dialogStartPath(undefined, requested)).toBe(requested);
	});

	it("puts a bare file name in the last folder used", () => {
		expect(dialogStartPath(last, "session.html")).toBe(join(last, "session.html"));
	});

	it("opens in the last folder when nothing is requested", () => {
		expect(dialogStartPath(last, undefined)).toBe(last);
	});

	it("leaves the OS default before any folder was used", () => {
		expect(dialogStartPath(undefined, "session.html")).toBe("session.html");
		expect(dialogStartPath(undefined, undefined)).toBeUndefined();
	});

	it("remembers the folder that holds the picked file", () => {
		expect(dialogDirOf(join(last, "session.html"))).toBe(last);
	});
});
