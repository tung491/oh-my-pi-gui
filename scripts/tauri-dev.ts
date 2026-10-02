/**
 * Starts the Tauri shell in development against the Vite dev server.
 *
 * Why a script and not `cargo tauri dev` directly: the distro's /usr/bin/cargo
 * shadows rustup's on this machine, every worktree needs its own deterministic
 * dev port so parallel work never collides, and an app run must never touch
 * the user's real profile. The script enforces all three and refuses to start
 * otherwise instead of guessing.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PINS_FILE = path.join(ROOT, "scripts", "rust-pins.env");
const DEFAULT_PORT = 5183;

/** Deterministic dev port per worktree, keyed by the directory name's `tauri-<module>` suffix. */
export const WORKTREE_PORTS: Readonly<Record<string, number>> = {
	foundation: 5183,
	integration: 5183,
	omp: 5184,
	tabs: 5185,
	desktop: 5186,
	services: 5187,
	ollama: 5188,
	updater: 5189,
	renderer: 5190,
};

export const CARGO_TAURI_MISSING =
	'cargo tauri is missing; run ~/.cargo/bin/cargo install tauri-cli --version "^2" --locked';

/** Parse `KEY="value"` / `KEY=value` lines; `$HOME` and `${HOME}` expand from the environment. */
export function readRustPins(text: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const pins: Record<string, string> = {};
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		value = value.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (_match, name: string) => env[name] ?? "");
		pins[key] = value;
	}
	return pins;
}

/** `tauri-<module>` → its port; anything else (the main checkout included) is the integration port. */
export function devPortForWorktree(directoryName: string): number {
	const module = directoryName.replace(/^tauri-/, "");
	return WORKTREE_PORTS[module] ?? DEFAULT_PORT;
}

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

function main(): void {
	const pins = readRustPins(readFileSync(PINS_FILE, "utf8"));
	const cargoBin = process.env.CARGO_HOME_BIN || pins.CARGO_HOME_BIN;
	if (!cargoBin) fail(`CARGO_HOME_BIN is not set in ${PINS_FILE}`);
	const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${cargoBin}${path.delimiter}${process.env.PATH ?? ""}` };

	// Run rustup's cargo by path: any cargo finds `cargo-tauri` through $CARGO_HOME/bin,
	// so a PATH probe would pass even when CARGO_HOME_BIN points nowhere.
	const cargo = path.join(cargoBin, "cargo");
	const probe = spawnSync(cargo, ["tauri", "--version"], { env, encoding: "utf8" });
	if (probe.error || probe.status !== 0 || !probe.stdout.trim().startsWith("tauri-cli 2.")) fail(CARGO_TAURI_MISSING);

	const userDataDir = process.argv.slice(2).find(arg => arg.startsWith("--user-data-dir="));
	if (!userDataDir || userDataDir === "--user-data-dir=") {
		fail(
			"dev:tauri refuses to run against the real profile. Pass a throwaway one:\n" +
				"  bun run dev:tauri -- --user-data-dir=$(mktemp -d)",
		);
	}

	const port = devPortForWorktree(path.basename(ROOT));
	const owner = spawnSync("ss", ["-ltnp", `sport = :${port}`], { encoding: "utf8" });
	const busy =
		owner.status === 0 &&
		owner.stdout
			.split("\n")
			.slice(1)
			.some(line => line.trim().length > 0);
	if (busy) {
		fail(
			`Dev port ${port} is already in use. Stop its owner instead of picking another port:\n${owner.stdout.trim()}`,
		);
	}

	const config = JSON.stringify({
		build: {
			devUrl: `http://localhost:${port}`,
			beforeDevCommand: "bunx vite --config vite.tauri.config.ts",
		},
	});
	const extraArgs = process.argv.slice(2).filter(arg => arg !== userDataDir);
	const result = spawnSync(cargo, ["tauri", "dev", "--config", config, "--", "--", userDataDir, ...extraArgs], {
		cwd: ROOT,
		env: { ...env, OMP_TAURI_DEV_PORT: String(port) },
		stdio: "inherit",
	});
	if (result.error) fail(`cargo tauri dev failed to start: ${result.error.message}`);
	process.exit(result.status ?? 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
