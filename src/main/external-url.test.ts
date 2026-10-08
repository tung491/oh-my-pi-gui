import { describe, expect, it } from "vitest";
import { isAllowedExternalUrl } from "./external-url";

describe("isAllowedExternalUrl", () => {
	it("allows http https and mailto urls", () => {
		expect(isAllowedExternalUrl("https://a.b")).toBe(true);
		expect(isAllowedExternalUrl("http://a.b")).toBe(true);
		expect(isAllowedExternalUrl("mailto:a@b.c")).toBe(true);
	});

	it("refuses file javascript and data urls", () => {
		expect(isAllowedExternalUrl("file:///etc/passwd")).toBe(false);
		expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
		expect(isAllowedExternalUrl("data:text/html,x")).toBe(false);
		expect(isAllowedExternalUrl("")).toBe(false);
		expect(isAllowedExternalUrl(42)).toBe(false);
	});
});
