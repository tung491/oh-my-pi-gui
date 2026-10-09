import { afterEach, describe, expect, it } from "vitest";
import { closedPortUrl, type FakeOllama, sendJson, startFakeOllama } from "../../../e2e/fake-ollama";
import { warmModel } from "./warm";

let fake: FakeOllama | undefined;
afterEach(async () => {
	await fake?.close();
	fake = undefined;
});

describe("warmModel", () => {
	it("asks Ollama to load the model with no prompt and a 10m keep-alive", async () => {
		let seen: unknown;
		fake = await startFakeOllama((req, res, body) => {
			seen = { url: req.url, method: req.method, body: JSON.parse(body) };
			sendJson(res, { model: "qwen3:4b", done: true, done_reason: "load" });
		});
		expect(await warmModel(fake.url, "qwen3:4b")).toBe(true);
		expect(seen).toEqual({
			url: "/api/generate",
			method: "POST",
			body: { model: "qwen3:4b", keep_alive: "10m", stream: false },
		});
	});

	it("never rejects on HTTP errors, refused connections or invalid names", async () => {
		fake = await startFakeOllama((_req, res) => sendJson(res, { error: "model not found" }, 404));
		expect(await warmModel(fake.url, "missing:1b")).toBe(false);
		expect(await warmModel(await closedPortUrl(), "qwen3:4b")).toBe(false);
		expect(await warmModel(fake.url, "bad name")).toBe(false);
	});
});
