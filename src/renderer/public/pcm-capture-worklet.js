/**
 * Dictation capture worklet — runs on the audio thread so it keeps collecting
 * samples through long main-thread tasks (e.g. streaming markdown). Posts
 * each 128-frame render quantum of channel 0 as a Float32Array; the node's
 * `onaudioprocess`/`port.onmessage` consumer in voice.ts appends the blocks
 * in order. Served from the app origin (not bundled as a Vite asset) so it
 * loads under a `script-src 'self'` CSP that blocks `blob:` worklet URLs.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
	process(inputs) {
		const channel = inputs[0]?.[0];
		if (channel && channel.length > 0) {
			this.port.postMessage(channel.slice());
		}
		return true;
	}
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
