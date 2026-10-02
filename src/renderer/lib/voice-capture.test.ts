/**
 * Pure helpers behind WebAudio dictation capture. linkedom has no audio
 * stack, so these tests cover only `chooseCaptureBackend` and
 * `concatFloat32` — the DOM-dependent capture/resample/encode path in
 * `recordAndTranscribe` is exercised manually (see the phase's Step 7).
 */

import { describe, expect, it } from "vitest";
import { chooseCaptureBackend, concatFloat32 } from "./voice";

describe("chooseCaptureBackend", () => {
	it("prefers the worklet when the context offers audioWorklet", () => {
		expect(chooseCaptureBackend({ audioWorklet: {} })).toBe("worklet");
	});

	it("falls back to ScriptProcessorNode without audioWorklet", () => {
		expect(chooseCaptureBackend({})).toBe("script-processor");
	});
});

describe("concatFloat32", () => {
	it("concatenates captured blocks in order", () => {
		const result = concatFloat32([new Float32Array([1, 2]), new Float32Array([3, 4, 5])]);
		expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
	});

	it("an empty capture encodes no WAV", () => {
		// recordAndTranscribe gates WAV encoding on `concatFloat32(blocks).length === 0`
		// and returns voice.mic.empty instead — this is that zero-length case.
		const result = concatFloat32([]);
		expect(result.length).toBe(0);
	});
});
