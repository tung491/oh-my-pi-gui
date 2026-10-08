import { describe, expect, it } from "vitest";
import { sanitizeExternalUrl } from "./external-url";

describe("sanitizeExternalUrl", () => {
	it("allows http https and mailto urls", () => {
		expect(sanitizeExternalUrl("https://a.b/x?attach=1#y")).toBe("https://a.b/x?attach=1#y");
		expect(sanitizeExternalUrl("http://a.b")).toBe("http://a.b");
		expect(sanitizeExternalUrl("mailto:a@b.c")).toBe("mailto:a@b.c");
	});

	it("refuses file javascript and data urls", () => {
		expect(sanitizeExternalUrl("file:///etc/passwd")).toBeNull();
		expect(sanitizeExternalUrl("javascript:alert(1)")).toBeNull();
		expect(sanitizeExternalUrl("data:text/html,x")).toBeNull();
		expect(sanitizeExternalUrl("")).toBeNull();
		expect(sanitizeExternalUrl(42)).toBeNull();
	});

	it("keeps only subject body cc and bcc in mailto links", () => {
		expect(
			sanitizeExternalUrl(
				"mailto:a@b.c?subject=Hi%20there&to=x@y.z&body=Line&cc=c@d.e&bcc=f@g.h&in-reply-to=1#frag",
			),
		).toBe("mailto:a@b.c?subject=Hi%20there&body=Line&cc=c@d.e&bcc=f@g.h");
		expect(sanitizeExternalUrl("mailto:a@b.c?to=x@y.z&&")).toBe("mailto:a@b.c");
	});

	it("drops attach parameters from mailto links", () => {
		expect(sanitizeExternalUrl("mailto:a@b.c?attach=/etc/passwd&subject=x")).toBe("mailto:a@b.c?subject=x");
		expect(sanitizeExternalUrl("mailto:a@b.c?Attachment=%2Fetc%2Fpasswd")).toBe("mailto:a@b.c");
		expect(sanitizeExternalUrl("mailto:a@b.c?%61ttach=/etc/passwd&body")).toBe("mailto:a@b.c?body");
	});

	it("matches mailto parameter names case-insensitively", () => {
		expect(sanitizeExternalUrl("MAILTO:a@b.c?SUBJECT=x&Body=y&%63c=z&ATTACH=w")).toBe(
			"mailto:a@b.c?SUBJECT=x&Body=y&%63c=z",
		);
		expect(sanitizeExternalUrl("mailto:a@b.c?%zzsubject=x")).toBe("mailto:a@b.c");
	});

	it("refuses mailto links that hide a query in the address", () => {
		expect(sanitizeExternalUrl("mailto:a@b.c%3Fattach=/etc/passwd")).toBeNull();
		expect(sanitizeExternalUrl("mailto:a@b.c%3fsubject=x")).toBeNull();
	});
});
