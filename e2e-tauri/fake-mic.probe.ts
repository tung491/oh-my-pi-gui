/**
 * Audio probe for a packaged Linux build: microphone capture and audio
 * playback through WebKit's GStreamer backend, with the web-process sandbox on.
 * Opt-in, because it needs an audio server and a source that carries signal:
 *
 *   OMP_E2E_FAKE_MIC=1 OMP_GUI_TEST_APP=<installed sai-atlas or extracted AppRun> \
 *     node node_modules/@wdio/cli/bin/wdio.js run wdio.packaged.conf.ts
 *
 * The environment must provide a PulseAudio-compatible server (pipewire-pulse
 * on Ubuntu desktops) whose default source plays a tone, plus a sink for the
 * AudioContext destination; scripts/tauri-deb-smoke/fake-mic.sh sets that up
 * in a container. The capture path is the one dictation takes (getUserMedia
 * with its constraints into an AudioContext pulled through a silent gain to
 * the destination), minus speech-to-text; playback is how spoken replies play
 * (a WAV blob in an audio element). OMP_E2E_FAKE_MIC_APP_LOG, when set, takes
 * the app's stdout and stderr (with GST_DEBUG set, GStreamer's log). The file
 * name keeps it out of the default wdio run.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { browser, expect } from "@wdio/globals";
import { environOf, pgrepFull, procInfo, webProcesses } from "./outside";
import { launch, type PreparedLaunch, until } from "./session";

const executablePath = process.env.OMP_GUI_TEST_APP;
const enabled = process.env.OMP_E2E_FAKE_MIC === "1";
const appLog = process.env.OMP_E2E_FAKE_MIC_APP_LOG;
/** A tone at the source reads far above this; silence or no PCM reads 0. */
const MIN_RMS = 0.01;

interface CaptureResult {
	inputsBefore: number;
	inputs: number;
	labels: string[];
	state: string;
	sampleRate: number;
	rms: number;
	/** Not `error`: WebDriver reads a script result with an `error` key as a protocol error. */
	failure?: string;
}

interface PlaybackResult {
	ended: boolean;
	duration: number;
	/** Not `error`: WebDriver reads a script result with an `error` key as a protocol error. */
	failure?: string;
}

function app(): string {
	if (!executablePath) throw new Error("OMP_GUI_TEST_APP is not set");
	return executablePath;
}

/** The shell process of the launch: started with its profile, not the sidecar supervisor. */
function shellPid(launched: PreparedLaunch): number {
	const pids = pgrepFull(`--user-data-dir=${launched.desktop}`).filter(pid => {
		const info = procInfo(pid);
		return info !== null && info.comm === "sai-atlas" && !info.cmdline.includes("--omp-supervise");
	});
	if (pids.length !== 1) throw new Error(`expected one app process for the profile, found ${JSON.stringify(pids)}`);
	return pids[0];
}

/** Switch to the first window that loaded the app's renderer. */
async function appWindow(): Promise<void> {
	const found = await until(
		async () => {
			for (const handle of await browser.getWindowHandles()) {
				await browser.switchToWindow(handle);
				if (await browser.execute(() => window.omp != null).catch(() => false)) return handle;
			}
			return null;
		},
		handle => handle !== null,
		{ timeout: 60_000, interval: 250 },
	);
	if (!found) throw new Error("no app window loaded the renderer");
}

/** Pulse sink inputs, when pactl is installed; evidence only. */
function sinkInputs(): string {
	const result = spawnSync("pactl", ["list", "sink-inputs", "short"], { encoding: "utf8" });
	return result.error ? `pactl unavailable: ${result.error.message}` : result.stdout.trim();
}

describe("audio through WebKit's GStreamer backend", () => {
	let launched: PreparedLaunch | null = null;

	before(async function () {
		if (!enabled || !executablePath) {
			this.skip();
			return;
		}
		if (appLog) fs.writeFileSync(appLog, "");
		launched = await launch({
			name: "fake-mic",
			binary: app(),
			omp: null,
			noProject: true,
			startInLaunchDir: true,
			env: appLog ? { OMP_E2E_APP_LOG: appLog } : {},
		});
		await appWindow();
	});

	it("captures the tone from the default source in a running AudioContext", async () => {
		const result: CaptureResult = await browser.execute(async () => {
			const countInputs = async () =>
				(await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "audioinput");
			const out: CaptureResult = { inputsBefore: 0, inputs: 0, labels: [], state: "none", sampleRate: 0, rms: 0 };
			try {
				out.inputsBefore = (await countInputs()).length;
			} catch (error) {
				out.failure = `enumerateDevices: ${String(error)}`;
				return out;
			}
			let stream: MediaStream;
			try {
				stream = await navigator.mediaDevices.getUserMedia({
					audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
				});
			} catch (error) {
				out.failure = `getUserMedia: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
				return out;
			}
			const inputs = await countInputs();
			out.inputs = inputs.length;
			out.labels = inputs.map(device => device.label);
			const context = new AudioContext();
			try {
				const source = context.createMediaStreamSource(stream);
				const analyser = context.createAnalyser();
				analyser.fftSize = 2048;
				const silent = context.createGain();
				silent.gain.value = 0;
				source.connect(analyser);
				analyser.connect(silent);
				silent.connect(context.destination);
				if (context.state === "suspended") {
					await Promise.race([context.resume(), new Promise(resolve => setTimeout(resolve, 5_000))]);
				}
				out.state = context.state;
				out.sampleRate = context.sampleRate;
				const samples = new Float32Array(analyser.fftSize);
				const deadline = performance.now() + 1_000;
				while (performance.now() < deadline) {
					await new Promise(resolve => setTimeout(resolve, 50));
					analyser.getFloatTimeDomainData(samples);
					let sum = 0;
					for (const sample of samples) sum += sample * sample;
					out.rms = Math.max(out.rms, Math.sqrt(sum / samples.length));
				}
			} finally {
				for (const track of stream.getTracks()) track.stop();
				await context.close();
			}
			return out;
		});
		console.log(`capture: ${JSON.stringify(result)}`);
		expect(result.failure).toBeUndefined();
		expect(result.inputs).toBeGreaterThanOrEqual(1);
		expect(result.state).toBe("running");
		expect(result.rms).toBeGreaterThan(MIN_RMS);
	}).timeout(120_000);

	it("plays a WAV blob through an audio element to the end", async () => {
		const started: PlaybackResult = await browser.execute(async () => {
			const rate = 48_000;
			const frames = rate;
			const wav = new DataView(new ArrayBuffer(44 + frames * 2));
			const text = (at: number, value: string) => {
				for (let i = 0; i < value.length; i++) wav.setUint8(at + i, value.charCodeAt(i));
			};
			text(0, "RIFF");
			wav.setUint32(4, 36 + frames * 2, true);
			text(8, "WAVE");
			text(12, "fmt ");
			wav.setUint32(16, 16, true);
			wav.setUint16(20, 1, true);
			wav.setUint16(22, 1, true);
			wav.setUint32(24, rate, true);
			wav.setUint32(28, rate * 2, true);
			wav.setUint16(32, 2, true);
			wav.setUint16(34, 16, true);
			text(36, "data");
			wav.setUint32(40, frames * 2, true);
			for (let i = 0; i < frames; i++) {
				wav.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.3 * 32767), true);
			}
			const url = URL.createObjectURL(new Blob([wav.buffer], { type: "audio/wav" }));
			const audio = new Audio(url);
			// NaN (no metadata) would not survive the trip back through WebDriver's JSON.
			const duration = () => (Number.isFinite(audio.duration) ? audio.duration : 0);
			const probe = window as unknown as { __fakeMicPlayback?: Promise<PlaybackResult> };
			probe.__fakeMicPlayback = new Promise<PlaybackResult>(resolve => {
				const timer = setTimeout(() => resolve({ ended: false, duration: duration(), failure: "timeout" }), 10_000);
				audio.onended = () => {
					clearTimeout(timer);
					URL.revokeObjectURL(url);
					resolve({ ended: true, duration: duration() });
				};
				audio.onerror = () => {
					clearTimeout(timer);
					resolve({ ended: false, duration: duration(), failure: `media error ${audio.error?.code}` });
				};
			});
			try {
				await audio.play();
				return { ended: false, duration: duration() };
			} catch (error) {
				return { ended: false, duration: 0, failure: `play: ${String(error)}` };
			}
		});
		expect(started.failure).toBeUndefined();
		console.log(`sink inputs while playing: ${sinkInputs() || "none"}`);
		const result: PlaybackResult = await browser.execute(async () => {
			const probe = window as unknown as { __fakeMicPlayback?: Promise<PlaybackResult> };
			return probe.__fakeMicPlayback ?? { ended: false, duration: 0, failure: "playback never started" };
		});
		console.log(`playback: ${JSON.stringify(result)}`);
		expect(result.failure).toBeUndefined();
		expect(result.ended).toBe(true);
		expect(result.duration).toBeGreaterThan(0.9);
	}).timeout(60_000);

	it("keeps every web process sandboxed with only the audio paths bound in", () => {
		if (!launched) throw new Error("the app did not launch");
		const pid = shellPid(launched);
		expect(environOf(pid).WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS).toBeUndefined();
		const appImage = environOf(pid).APPDIR !== undefined;
		const web = webProcesses(pid);
		expect(web.length).toBeGreaterThan(0);
		for (const content of web) {
			const parent = procInfo(content.ppid)?.comm;
			console.log(
				`web process ${content.pid}: parent=${parent} Seccomp=${content.seccomp} NSpid=${content.nspid.join(" ")}`,
			);
			expect(content.seccomp).toBe("2");
			expect(content.nspid.length).toBeGreaterThan(1);
			expect(parent).toBe("bwrap");
			const mounts = (
				fs.readFileSync(`/proc/${content.pid}/mountinfo`, "utf8").match(/^.*(?:gstreamer|\/pulse).*$/gm) ?? []
			).map(line => line.split(" ").slice(3, 5).join(" "));
			console.log(`web process ${content.pid} audio mounts:\n  ${mounts.join("\n  ")}`);
			// WebKit binds the PulseAudio socket directory; the AppImage's plugin directory and its own registry also.
			expect(mounts.some(mount => mount.includes("/pulse"))).toBe(true);
			if (appImage) expect(mounts.some(mount => mount.includes("/usr/lib/gstreamer-1.0"))).toBe(true);
		}
	});
});
