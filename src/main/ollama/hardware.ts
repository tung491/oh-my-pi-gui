/**
 * What this machine has for running a local model: RAM always, GPU memory
 * best effort. Every GPU probe is raced against a timeout and never throws.
 */
import { execFile } from "node:child_process";
import os from "node:os";
import type { MachineFacts } from "../../shared/ollama-types";

export const HARDWARE_PROBE_TIMEOUT_MS = 2_000;
const MIB = 1024 * 1024;

export interface NvidiaGpu {
	name: string;
	vramBytes: number;
}

export interface HardwareDeps {
	platform: NodeJS.Platform;
	arch: string;
	totalmem(): number;
	/** Raw `nvidia-smi` CSV, or null when it is missing or failed. */
	nvidiaSmi(timeoutMs: number): Promise<string | null>;
	/** Electron's `app.getGPUInfo("complete")`; injected so this module stays Electron-free. */
	gpuInfo(): Promise<unknown>;
	timeoutMs: number;
}

function runNvidiaSmi(timeoutMs: number): Promise<string | null> {
	return new Promise(resolve => {
		execFile(
			"nvidia-smi",
			["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
			{ timeout: timeoutMs, windowsHide: true },
			(error, stdout) => resolve(error ? null : stdout),
		);
	});
}

const defaultDeps: HardwareDeps = {
	platform: process.platform,
	arch: process.arch,
	totalmem: () => os.totalmem(),
	nvidiaSmi: runNvidiaSmi,
	gpuInfo: async () => null,
	timeoutMs: HARDWARE_PROBE_TIMEOUT_MS,
};

/** Resolve `task`, or `fallback` when it rejects or outlives `timeoutMs`. */
async function settle<T>(task: () => Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<T>(resolve => {
		timer = setTimeout(() => resolve(fallback), timeoutMs);
	});
	try {
		return await Promise.race([task().catch(() => fallback), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** `name, MiB` per line; picks the card with the most memory (the one a model is sized against). */
export function parseNvidiaSmi(stdout: string): NvidiaGpu | null {
	let best: NvidiaGpu | null = null;
	for (const line of stdout.split(/\r?\n/)) {
		const comma = line.lastIndexOf(",");
		if (comma <= 0) continue;
		const name = line.slice(0, comma).trim();
		const mib = Number(line.slice(comma + 1).trim());
		if (!name || !Number.isFinite(mib) || mib <= 0) continue;
		const gpu = { name, vramBytes: Math.round(mib * MIB) };
		if (!best || gpu.vramBytes > best.vramBytes) best = gpu;
	}
	return best;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function nonEmpty(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** GPU name from Chromium's GPU info: the active device's string, else the GL renderer. */
export function gpuNameFromInfo(info: unknown): string | null {
	if (!isRecord(info)) return null;
	if (Array.isArray(info.gpuDevice)) {
		const devices = info.gpuDevice.filter(isRecord);
		const device = devices.find(d => d.active === true) ?? devices[0];
		const name = device ? nonEmpty(device.deviceString) : null;
		if (name) return name;
	}
	return isRecord(info.auxAttributes) ? nonEmpty(info.auxAttributes.glRenderer) : null;
}

/** Machine facts for model sizing, or null when RAM itself cannot be read. Never rejects. */
export async function readMachine(overrides: Partial<HardwareDeps> = {}): Promise<MachineFacts | null> {
	const deps = { ...defaultDeps, ...overrides };
	let ramBytes: number;
	try {
		ramBytes = deps.totalmem();
	} catch {
		return null;
	}
	if (!Number.isFinite(ramBytes) || ramBytes <= 0) return null;

	const unifiedMemory = deps.platform === "darwin" && deps.arch === "arm64";
	if (!unifiedMemory && (deps.platform === "linux" || deps.platform === "win32")) {
		const csv = await settle(() => deps.nvidiaSmi(deps.timeoutMs), null, deps.timeoutMs);
		const gpu = csv ? parseNvidiaSmi(csv) : null;
		if (gpu) return { ramBytes, vramBytes: gpu.vramBytes, gpuName: gpu.name, unifiedMemory: false };
	}
	const info = await settle(() => deps.gpuInfo(), null, deps.timeoutMs);
	return { ramBytes, vramBytes: null, gpuName: gpuNameFromInfo(info), unifiedMemory };
}
