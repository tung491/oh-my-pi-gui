import { describe, expect, it } from "vitest";
import { DeepLinkBuffer } from "./deep-link-buffer";

describe("DeepLinkBuffer", () => {
	it("hands a link that arrived before the subscription to the first subscriber", () => {
		const buffer = new DeepLinkBuffer<string>();
		buffer.deliver("omp://session/a");
		const received: string[] = [];
		buffer.subscribe(link => received.push(link));
		expect(received).toEqual(["omp://session/a"]);
	});

	it("keeps only the latest link before anyone subscribes", () => {
		const buffer = new DeepLinkBuffer<string>();
		buffer.deliver("omp://new");
		buffer.deliver("omp://session/b");
		const received: string[] = [];
		buffer.subscribe(link => received.push(link));
		expect(received).toEqual(["omp://session/b"]);
	});

	it("delivers a held link once across an unsubscribe and resubscribe", () => {
		const buffer = new DeepLinkBuffer<string>();
		buffer.deliver("omp://session/a");
		const received: string[] = [];
		const unsubscribe = buffer.subscribe(link => received.push(link));
		unsubscribe();
		buffer.subscribe(link => received.push(link));
		expect(received).toEqual(["omp://session/a"]);
	});

	it("passes later links straight to current subscribers", () => {
		const buffer = new DeepLinkBuffer<string>();
		const received: string[] = [];
		buffer.subscribe(link => received.push(link));
		buffer.deliver("omp://new");
		expect(received).toEqual(["omp://new"]);
	});

	it("holds links again once the last subscriber leaves", () => {
		const buffer = new DeepLinkBuffer<string>();
		const unsubscribe = buffer.subscribe(() => {});
		unsubscribe();
		buffer.deliver("omp://new");
		const received: string[] = [];
		buffer.subscribe(link => received.push(link));
		expect(received).toEqual(["omp://new"]);
	});
});
