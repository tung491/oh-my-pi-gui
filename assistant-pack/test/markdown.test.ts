import type { Tokens } from "marked";
import { describe, expect, it } from "vitest";
import { lexMarkdown, resolveTitle } from "../src/office/markdown";

const headingDepths = (tokens: ReturnType<typeof lexMarkdown>) =>
	tokens.filter((token): token is Tokens.Heading => token.type === "heading").map(token => token.depth);

describe("resolveTitle", () => {
	it("lets an explicit title win and keeps the body's # heading", () => {
		const { title, tokens } = resolveTitle("# From the body\n\nText", "Explicit title", "Fallback");
		expect(title).toBe("Explicit title");
		expect(headingDepths(tokens)).toEqual([1]);
	});

	it("takes the first # heading as the title and removes it from the body", () => {
		const { title, tokens } = resolveTitle(
			"Intro\n\n# Báo cáo quý 3\n\n## Phần một\n\n# Second",
			undefined,
			"Fallback",
		);
		expect(title).toBe("Báo cáo quý 3");
		expect(headingDepths(tokens)).toEqual([2, 1]);
	});

	it("uses the fallback when there is no # heading", () => {
		const { title, tokens } = resolveTitle("## Only a section\n\nText", undefined, "Report");
		expect(title).toBe("Report");
		expect(headingDepths(tokens)).toEqual([2]);
	});

	it("treats a blank explicit title as absent", () => {
		expect(resolveTitle("# Heading", "   ", "Fallback").title).toBe("Heading");
	});

	it("keeps inline formatting out of the title text", () => {
		expect(resolveTitle("# The **Q3** _review_", undefined, "Fallback").title).toBe("The Q3 review");
	});
});

describe("lexMarkdown", () => {
	it("turns typed • bullets into list items", () => {
		const tokens = lexMarkdown("Tasks:\n\n• first\n• second\n");
		const list = tokens.find((token): token is Tokens.List => token.type === "list");
		expect(list?.items.map(item => item.text)).toEqual(["first", "second"]);
	});
});
