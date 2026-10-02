import { describe, expect, it } from "vitest";
import { gpuNameFromInfo, type HardwareDeps, parseNvidiaSmi, readMachine } from "./hardware";

const GIB = 1024 ** 3;

function deps(over: Partial<HardwareDeps>): Partial<HardwareDeps> {
	return {
		platform: "linux",
		arch: "x64",
		totalmem: () => 32 * GIB,
		nvidiaSmi: async () => null,
		gpuInfo: async () => null,
		timeoutMs: 50,
		...over,
	};
}

const never = <T>() => new Promise<T>(() => {});

describe("parseNvidiaSmi", () => {
	it("reads name and MiB, picking the largest card", () => {
		expect(parseNvidiaSmi("NVIDIA GeForce RTX 3060, 12288\nNVIDIA RTX A6000, 49140\n")).toEqual({
			name: "NVIDIA RTX A6000",
			vramBytes: 49140 * 1024 * 1024,
		});
	});

	it("ignores junk", () => {
		expect(parseNvidiaSmi("")).toBeNull();
		expect(parseNvidiaSmi("NVIDIA-SMI has failed\n, 12\nGPU, [N/A]")).toBeNull();
	});
});

describe("gpuNameFromInfo", () => {
	it("prefers the active device string", () => {
		const info = { gpuDevice: [{ deviceString: "Intel UHD" }, { active: true, deviceString: "AMD Radeon" }] };
		expect(gpuNameFromInfo(info)).toBe("AMD Radeon");
	});

	it("falls back to the GL renderer", () => {
		expect(gpuNameFromInfo({ gpuDevice: [{}], auxAttributes: { glRenderer: "ANGLE (Apple M2)" } })).toBe(
			"ANGLE (Apple M2)",
		);
	});

	it("returns null for unexpected shapes", () => {
		expect(gpuNameFromInfo(null)).toBeNull();
		expect(gpuNameFromInfo({ gpuDevice: "x" })).toBeNull();
	});
});

describe("readMachine", () => {
	it("uses nvidia-smi VRAM on Linux", async () => {
		const machine = await readMachine(deps({ nvidiaSmi: async () => "NVIDIA GeForce RTX 4090, 24564\n" }));
		expect(machine).toEqual({
			ramBytes: 32 * GIB,
			vramBytes: 24564 * 1024 * 1024,
			gpuName: "NVIDIA GeForce RTX 4090",
			unifiedMemory: false,
		});
	});

	it("falls back to the GPU name without VRAM when nvidia-smi is missing", async () => {
		const machine = await readMachine(
			deps({ gpuInfo: async () => ({ gpuDevice: [{ deviceString: "Intel Iris" }] }) }),
		);
		expect(machine).toEqual({ ramBytes: 32 * GIB, vramBytes: null, gpuName: "Intel Iris", unifiedMemory: false });
	});

	it("marks Apple Silicon as unified memory and skips nvidia-smi", async () => {
		let asked = false;
		const machine = await readMachine(
			deps({
				platform: "darwin",
				arch: "arm64",
				nvidiaSmi: async () => {
					asked = true;
					return "X, 1";
				},
			}),
		);
		expect(asked).toBe(false);
		expect(machine).toMatchObject({ vramBytes: null, unifiedMemory: true });
	});

	it("survives probes that hang or throw", async () => {
		const started = Date.now();
		const machine = await readMachine(
			deps({
				nvidiaSmi: () => never<string | null>(),
				gpuInfo: async () => {
					throw new Error("gpu process crashed");
				},
			}),
		);
		expect(machine).toEqual({ ramBytes: 32 * GIB, vramBytes: null, gpuName: null, unifiedMemory: false });
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("returns null when RAM is unreadable", async () => {
		expect(
			await readMachine(
				deps({
					totalmem: () => {
						throw new Error("EPERM");
					},
				}),
			),
		).toBeNull();
		expect(await readMachine(deps({ totalmem: () => 0 }))).toBeNull();
	});
});
