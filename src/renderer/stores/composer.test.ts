import { describe, expect, it } from "vitest";
import { createComposerStore } from "./composer";

describe("composer documents", () => {
	it("starts with no documents and takes a value or an updater", () => {
		const store = createComposerStore();
		expect(store.getState().documents).toEqual([]);

		store.getState().setDocuments([{ path: "/a/x.pdf", name: "x.pdf" }]);
		store.getState().setDocuments(current => [...current, { path: "/a/y.docx", name: "y.docx" }]);

		expect(store.getState().documents).toEqual([
			{ path: "/a/x.pdf", name: "x.pdf" },
			{ path: "/a/y.docx", name: "y.docx" },
		]);
	});

	it("clears documents with the rest of the composer on reset", () => {
		const store = createComposerStore();
		store.getState().setDraft("hi");
		store.getState().setDocuments([{ path: "/a/x.pdf", name: "x.pdf" }]);

		store.getState().reset();

		expect(store.getState().draft).toBe("");
		expect(store.getState().documents).toEqual([]);
	});
});
