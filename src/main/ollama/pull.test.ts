import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { closedPortUrl, type FakeOllama, sendJson, startFakeOllama } from "../../../e2e/fake-ollama";
import type { PullProgress } from "../../shared/ollama-types";
import { isValidModelTag, OllamaPuller, PullAggregator } from "./pull";

const TWO_LAYERS = [
	{ status: "pulling manifest" },
	{ status: "pulling aaa", digest: "sha256:aaa" },
	{ status: "pulling aaa", digest: "sha256:aaa", total: 1000, completed: 0 },
	{ status: "pulling aaa", digest: "sha256:aaa", total: 1000, completed: 1500 },
	{ status: "pulling bbb", digest: "sha256:bbb", total: 1000, completed: 500 },
	{ status: "verifying sha256 digest" },
	{ status: "writing manifest" },
	{ status: "success" },
];

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let fake: FakeOllama | undefined;
afterEach(async () => {
	await fake?.close();
	fake = undefined;
});

interface PullRequest {
	body: unknown;
	res: ServerResponse;
	closed: Promise<void>;
}

/** A fake whose /api/pull hands each request to the test to stream by hand. */
async function manualPullServer(): Promise<{ next: () => Promise<PullRequest> }> {
	const queue: PullRequest[] = [];
	const waiters: ((request: PullRequest) => void)[] = [];
	fake = await startFakeOllama((_req, res, body) => {
		const closed = new Promise<void>(resolve => res.on("close", () => resolve()));
		res.writeHead(200, { "content-type": "application/x-ndjson" });
		const request = { body: JSON.parse(body), res, closed };
		const waiter = waiters.shift();
		if (waiter) waiter(request);
		else queue.push(request);
	});
	return {
		next: () => {
			const queued = queue.shift();
			return queued ? Promise.resolve(queued) : new Promise(resolve => waiters.push(resolve));
		},
	};
}

function line(res: ServerResponse, value: unknown): void {
	res.write(`${JSON.stringify(value)}\n`);
}

describe("PullAggregator", () => {
	it("stays indeterminate until a size is known, clamps, and caps at 99 until success", () => {
		const aggregator = new PullAggregator("qwen3:4b");
		const percents = TWO_LAYERS.map(row => aggregator.apply(row).percent);
		expect(percents).toEqual([-1, -1, 0, 99, 75, 75, 75, 100]);
		expect(aggregator.frame()).toEqual({
			tag: "qwen3:4b",
			status: "success",
			completed: 1500,
			total: 2000,
			percent: 100,
			done: true,
		});
	});

	it("turns an error line into an error frame", () => {
		const frame = new PullAggregator("x").apply({ error: "pull model manifest: file does not exist" });
		expect(frame).toMatchObject({ done: false, error: "pull model manifest: file does not exist" });
	});
});

describe("OllamaPuller", () => {
	it("streams a two-layer pull and resolves with the success frame", async () => {
		fake = await startFakeOllama((req, res, body) => {
			if (req.url !== "/api/pull") return sendJson(res, {}, 404);
			expect(JSON.parse(body)).toEqual({ model: "qwen3:4b", stream: true });
			res.writeHead(200, { "content-type": "application/x-ndjson" });
			const text = TWO_LAYERS.map(row => JSON.stringify(row)).join("\n");
			// Split mid-line so the reader has to buffer across chunks.
			const cut = Math.floor(text.length / 2);
			res.write(text.slice(0, cut));
			setTimeout(() => res.end(text.slice(cut)), 20);
		});
		const url = fake.url;
		const frames: PullProgress[] = [];
		const puller = new OllamaPuller({ baseUrl: async () => url, intervalMs: 0 });
		const final = await puller.pull("qwen3:4b", frame => frames.push(frame));
		expect(final).toMatchObject({ status: "success", done: true, percent: 100, completed: 1500, total: 2000 });
		expect(frames.map(frame => frame.percent)).toEqual([-1, -1, 0, 99, 75, 75, 75, 100]);
		expect(puller.activeTag).toBeNull();
	});

	it("throttles progress but sends the terminal frame at once", async () => {
		fake = await startFakeOllama((_req, res) => {
			res.writeHead(200);
			for (let i = 1; i <= 50; i++) line(res, { status: "pulling a", digest: "a", total: 100, completed: i });
			setTimeout(() => res.end(`${JSON.stringify({ status: "success" })}\n`), 30);
		});
		const url = fake.url;
		const frames: PullProgress[] = [];
		const puller = new OllamaPuller({ baseUrl: async () => url, intervalMs: 100 });
		const started = Date.now();
		const final = await puller.pull("qwen3:4b", frame => frames.push(frame));
		expect(final.done).toBe(true);
		expect(frames.length).toBeLessThan(5);
		expect(frames.at(-1)).toEqual(final);
		expect(Date.now() - started).toBeLessThan(100);
	});

	it("cancels mid-stream, resolves with the last frame and emits nothing after", async () => {
		const server = await manualPullServer();
		const url = fake?.url ?? "";
		const frames: PullProgress[] = [];
		const puller = new OllamaPuller({ baseUrl: async () => url, intervalMs: 0 });
		const pending = puller.pull("qwen3:8b", frame => frames.push(frame));
		const request = await server.next();
		line(request.res, { status: "pulling aaa", digest: "aaa", total: 1000, completed: 250 });
		while (frames.length === 0) await delay(5);

		puller.cancel();
		const final = await pending;
		expect(final).toEqual({
			tag: "qwen3:8b",
			status: "pulling aaa",
			completed: 250,
			total: 1000,
			percent: 25,
			done: false,
		});
		await request.closed;
		await delay(30);
		expect(frames).toHaveLength(1);
		expect(puller.activeTag).toBeNull();

		// Pulling again starts a fresh request (Ollama resumes from its kept layers).
		const again = puller.pull("qwen3:8b");
		const second = await server.next();
		expect(second.body).toEqual({ model: "qwen3:8b", stream: true });
		second.res.end(`${JSON.stringify({ status: "success" })}\n`);
		expect((await again).done).toBe(true);
	});

	it("rejects a different tag with a busy frame and attaches the same tag", async () => {
		const server = await manualPullServer();
		const url = fake?.url ?? "";
		const puller = new OllamaPuller({ baseUrl: async () => url, intervalMs: 0 });
		const first = puller.pull("qwen3:4b");
		const request = await server.next();

		const busy = await puller.pull("qwen3:14b");
		expect(busy).toEqual({
			tag: "qwen3:14b",
			status: "busy",
			completed: 0,
			total: 0,
			percent: -1,
			done: false,
			error: expect.stringContaining("qwen3:4b"),
		});

		const joinedFrames: PullProgress[] = [];
		const joined = puller.pull("qwen3:4b", frame => joinedFrames.push(frame));
		expect(joined).toBe(first);
		request.res.end(`${JSON.stringify({ status: "success" })}\n`);
		const [a, b] = await Promise.all([first, joined]);
		expect(a).toEqual(b);
		expect(a.done).toBe(true);
		expect(joinedFrames.at(-1)).toEqual(a);
	});

	it("resolves an error line as a final error frame", async () => {
		fake = await startFakeOllama((_req, res) => {
			res.writeHead(200);
			line(res, { status: "pulling manifest" });
			line(res, { error: "pull model manifest: file does not exist" });
			// Leave the stream open: the error alone must end the pull.
		});
		const url = fake.url;
		const frames: PullProgress[] = [];
		const final = await new OllamaPuller({ baseUrl: async () => url, intervalMs: 0 }).pull("nope:1b", frame =>
			frames.push(frame),
		);
		expect(final).toMatchObject({ done: false, error: "pull model manifest: file does not exist" });
		expect(frames.at(-1)).toEqual(final);
	});

	it("resolves an HTTP error status with Ollama's message", async () => {
		fake = await startFakeOllama((_req, res) => sendJson(res, { error: "model is required" }, 400));
		const url = fake.url;
		const final = await new OllamaPuller({ baseUrl: async () => url }).pull("qwen3:4b");
		expect(final.error).toBe("model is required");
	});

	it("resolves a refused connection as an error frame", async () => {
		const url = await closedPortUrl();
		const final = await new OllamaPuller({ baseUrl: async () => url }).pull("qwen3:4b");
		expect(final.done).toBe(false);
		expect(final.error).toBeTruthy();
	});

	it("reports a stream that ends without success", async () => {
		fake = await startFakeOllama((_req, res) => {
			res.writeHead(200);
			res.end(`${JSON.stringify({ status: "pulling a", digest: "a", total: 10, completed: 5 })}\n`);
		});
		const url = fake.url;
		const final = await new OllamaPuller({ baseUrl: async () => url }).pull("qwen3:4b");
		expect(final).toMatchObject({ percent: 50, done: false, error: expect.any(String) });
	});

	it("refuses an invalid tag without a request", async () => {
		const final = await new OllamaPuller({ baseUrl: async () => "http://127.0.0.1:1" }).pull("; rm -rf /");
		expect(final.error).toBeTruthy();
	});
});

describe("isValidModelTag", () => {
	it("accepts ollama references and rejects anything else", () => {
		for (const tag of ["qwen3:4b", "gpt-oss:20b", "library/qwen3:latest", "hf.co/org/model:Q4_K_M"]) {
			expect(isValidModelTag(tag)).toBe(true);
		}
		for (const tag of ["", " qwen3", "-x", "a b", "x;y", 42, null, "a".repeat(201)]) {
			expect(isValidModelTag(tag)).toBe(false);
		}
	});
});
