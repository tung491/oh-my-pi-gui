import { describe, expect, it } from "vitest";
import { buildSlides } from "../src/office/slides";
import { fixture, zipEntry, zipNames } from "./zip-helpers";

/** Slides the fixture must produce. */
const EXPECTED_SLIDES = 8;

async function build(markdown: string, title?: string) {
	const deck = await buildSlides({ markdown, title, fallbackTitle: "Slides" });
	const names = await zipNames(deck.bytes);
	const slideNames = names
		.filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
		.sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
	const slides = await Promise.all(slideNames.map(name => zipEntry(deck.bytes, name)));
	return { deck, names, slides };
}

function texts(xml: string): string[] {
	return [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(match => match[1]);
}

describe("buildSlides", () => {
	it("builds one slide per shape, splitting the long bullet list", async () => {
		const { slides } = await build(fixture("report-shapes.md"));
		expect(slides).toHaveLength(EXPECTED_SLIDES);
		expect(slides.map(slide => texts(slide)[0])).toEqual([
			"Third quarter review",
			"Sales",
			"Highlights",
			"Orders",
			"Revenue by region",
			"Team contacts",
			"Next steps",
			"Next steps (cont.)",
		]);
	});

	it("draws a numeric table as a native chart and another table as a native table", async () => {
		const { names, slides } = await build(fixture("report-shapes.md"));
		expect(names.filter(name => /^ppt\/charts\/chart\d+\.xml$/.test(name))).toHaveLength(1);
		expect(slides.filter(slide => slide.includes("<a:tbl>"))).toHaveLength(1);
		expect(slides.filter(slide => slide.includes("<p:graphicFrame>") && slide.includes("/chart"))).toHaveLength(1);
	});

	it("puts > Notes: lines into exactly one slide's speaker notes", async () => {
		const { deck, names } = await build(fixture("report-shapes.md"));
		const notes = await Promise.all(
			names
				.filter(name => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))
				.map(name => zipEntry(deck.bytes, name)),
		);
		const withText = notes.filter(xml => texts(xml).some(text => /[A-Za-z]/.test(text)));
		expect(withText).toHaveLength(1);
		expect(texts(withText[0]).join(" ")).toContain("Mention the Da Nang opening");
	});

	it("never sets text below 14 pt", async () => {
		const { deck, names, slides } = await build(fixture("report-shapes.md"));
		const charts = await Promise.all(
			names.filter(name => /^ppt\/charts\/chart\d+\.xml$/.test(name)).map(name => zipEntry(deck.bytes, name)),
		);
		const sizes = [...slides, ...charts].flatMap(xml => [...xml.matchAll(/ sz="(\d+)"/g)].map(m => Number(m[1])));
		expect(sizes.length).toBeGreaterThan(0);
		for (const size of sizes) expect(size).toBeGreaterThanOrEqual(1400);
	});

	it("uses a 16:9 slide size", async () => {
		const { deck } = await build(fixture("report-shapes.md"));
		const presentation = await zipEntry(deck.bytes, "ppt/presentation.xml");
		expect(presentation).toMatch(/<p:sldSz cx="12192000" cy="6858000"/);
	});

	it("names the split slides in its check", async () => {
		const { deck } = await build(fixture("report-shapes.md"));
		expect(deck.check).toContain(`${EXPECTED_SLIDES} slides`);
		expect(deck.check).toContain("split onto 2 slides: Next steps");
	});

	it("uses the first # heading as the title slide without repeating it as a divider", async () => {
		const { slides, deck } = await build("# Plan for 2027\n\n## Goals\n\n- Grow\n- Hire\n");
		expect(deck.title).toBe("Plan for 2027");
		expect(slides).toHaveLength(2);
		expect(slides.filter(slide => texts(slide).includes("Plan for 2027"))).toHaveLength(1);
	});

	it("keeps the body's # heading as a divider when a title is given", async () => {
		const { slides, deck } = await build("# Plan for 2027\n\n## Goals\n\n- Grow\n", "Board deck");
		expect(deck.title).toBe("Board deck");
		expect(slides).toHaveLength(3);
		expect(texts(slides[1])).toContain("Plan for 2027");
	});

	it("lays out cards and a big number from bold lead text", async () => {
		const { slides } = await build(fixture("report-shapes.md"));
		const highlights = slides.find(slide => texts(slide)[0] === "Highlights") ?? "";
		expect(highlights.match(/<p:sp>/g)?.length ?? 0).toBeGreaterThanOrEqual(1 + 3);
		for (const head of ["Revenue up", "New office", "Hiring"]) expect(texts(highlights)).toContain(head);
		const orders = slides.find(slide => texts(slide)[0] === "Orders") ?? "";
		expect(texts(orders)).toContain("42%");
		expect(orders).toMatch(/ sz="(?:[4-9]\d{3}|\d{5})"/);
	});

	it.each(["   ", "Just one line of text", "# Only a title\n\nSome text\n\n- a point"])(
		"refuses Markdown without a slide section: %j",
		async markdown => {
			await expect(buildSlides({ markdown, fallbackTitle: "Slides" })).rejects.toThrow(
				"There are no slides yet. Start each slide with a line beginning with ##.",
			);
		},
	);
});
