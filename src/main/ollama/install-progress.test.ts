import { afterEach, describe, expect, it, vi } from "vitest";
import type { OllamaInstallProgress } from "../../shared/ollama-types";
import { createInstallProgressParser, initialInstallProgress, throttleInstallProgress } from "./install-progress";

function frame(stage: string | null, percent: number, done = false): OllamaInstallProgress {
	return { stage, percent, done };
}

/** Every non-null frame `push` returned, in order. */
function feed(chunks: readonly string[]): { frames: OllamaInstallProgress[]; final: OllamaInstallProgress } {
	const parser = createInstallProgressParser();
	const frames: OllamaInstallProgress[] = [];
	for (const chunk of chunks) {
		const next = parser.push(chunk);
		if (next) frames.push(next);
	}
	return { frames, final: parser.final() };
}

describe("createInstallProgressParser", () => {
	it("starts indeterminate with no stage", () => {
		expect(initialInstallProgress()).toEqual(frame(null, -1));
		expect(createInstallProgressParser().final()).toEqual(frame(null, -1, true));
	});

	it.each([
		["a whole stage line", [">>> Installing ollama to /usr/local\n"], [frame("Installing ollama to /usr/local", -1)]],
		[
			"a stage line split mid-line",
			[">>> Install", "ing ollama to /usr", "/local\n"],
			[frame("Installing ollama to /usr/local", -1)],
		],
		["CRLF line ends", [">>> Installing ollama\r\n"], [frame("Installing ollama", -1)]],
		[
			"curl bar frames",
			[">>> Downloading x\n", "\r#=#=#   ", "\r##     10.0%", "\r######    45.2%", "\r##########100.0%\n"],
			[
				frame("Downloading x", -1),
				frame("Downloading x", 10),
				frame("Downloading x", 45),
				frame("Downloading x", 100),
			],
		],
		[
			"a percent split mid-number",
			[">>> Downloading x\n", "\r####  5", "5.3%"],
			[frame("Downloading x", -1), frame("Downloading x", 55)],
		],
		[
			"two downloads in one run",
			[">>> Downloading a\n", "\r#### 80.0%", "\r######## 100.0%\n", ">>> Downloading b\n", "\r## 20.0%"],
			[
				frame("Downloading a", -1),
				frame("Downloading a", 80),
				frame("Downloading a", 100),
				frame("Downloading b", -1),
				frame("Downloading b", 20),
			],
		],
		[
			"unrelated noise",
			["Reading package lists...\n", "\n", "\r#=#=#\r##O#-#\r", "Get:1 http://archive jammy InRelease\n"],
			[],
		],
		[
			"ANSI colouring",
			["\x1b[1m>>> \x1b[0mInstalling ollama\x1b[0m\n", "\r\x1b[32m####  33.3%\x1b[0m"],
			[frame("Installing ollama", -1), frame("Installing ollama", 33)],
		],
	] as const)("reads %s", (_label, chunks, expected) => {
		expect(feed(chunks).frames).toEqual(expected);
	});

	it("reports a frame only when the stage or the whole percent changes", () => {
		const { frames } = feed([
			">>> Downloading x\n",
			"\r## 10.1%",
			"\r## 10.9%",
			// curl ends its bar with a newline whether the download succeeded or failed.
			"\r### 11.0%\n",
			">>> Downloading x\n",
		]);
		expect(frames).toEqual([
			frame("Downloading x", -1),
			frame("Downloading x", 10),
			frame("Downloading x", 11),
			// The same stage again still resets the bar, so it counts as a change.
			frame("Downloading x", -1),
		]);
	});

	it("clamps the percent to 0–100", () => {
		expect(feed([">>> x\n", "\r## 250%"]).frames.at(-1)).toEqual(frame("x", 100));
	});

	it("ends on the last state, reading an unterminated final stage", () => {
		expect(feed([">>> Downloading x\n", "\r## 40.0%"]).final).toEqual(frame("Downloading x", 40, true));
		expect(feed([">>> Enabling service"]).final).toEqual(frame("Enabling service", -1, true));
	});

	it("bounds an unterminated segment and still reads its percent", () => {
		expect(feed([">>> x\n", `\r${"#".repeat(100_000)} 30.0%`]).frames.at(-1)).toEqual(frame("x", 30));
	});
});

describe("throttleInstallProgress", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("sends at most one frame per interval, the latest winning", async () => {
		vi.useFakeTimers();
		const sent: OllamaInstallProgress[] = [];
		const send = throttleInstallProgress(f => sent.push(f), 100);
		send(frame(null, -1));
		send(frame("a", 1));
		send(frame("a", 2));
		expect(sent).toEqual([frame(null, -1)]);
		await vi.advanceTimersByTimeAsync(100);
		expect(sent).toEqual([frame(null, -1), frame("a", 2)]);
		await vi.advanceTimersByTimeAsync(500);
		expect(sent).toHaveLength(2);
	});

	it("flushes the done frame at once and drops the pending one", async () => {
		vi.useFakeTimers();
		const sent: OllamaInstallProgress[] = [];
		const send = throttleInstallProgress(f => sent.push(f), 100);
		send(frame(null, -1));
		send(frame("a", 50));
		send(frame("a", 50, true));
		expect(sent).toEqual([frame(null, -1), frame("a", 50, true)]);
		await vi.advanceTimersByTimeAsync(500);
		expect(sent).toHaveLength(2);
	});
});
