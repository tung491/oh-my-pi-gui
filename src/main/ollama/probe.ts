/**
 * Is the local Ollama daemon answering, and if not, is it installed? The
 * stopped/absent split follows sai-welcome (`welcome/backend/ollama.go`).
 */
import { execFile } from "node:child_process";
import { constants, existsSync, promises as fsp } from "node:fs";
import { delimiter, join } from "node:path";
import type { OllamaRemedyId, OllamaState, OllamaStatus } from "../../shared/ollama-types";
import { spawnPath } from "../shell-env";
import { resolveOllamaBaseUrl } from "./base-url";

export const PROBE_TIMEOUT_MS = 1_500;
const SYSTEMCTL_TIMEOUT_MS = 1_000;

/** The installation checks behind the stopped/absent decision; injectable for tests. */
export interface InstallChecks {
	/** `systemctl cat ollama.service` succeeds. */
	systemdUnit(): Promise<boolean>;
	/** An executable named `name` is on the login-shell PATH (`which`). */
	onPath(name: string): Promise<boolean>;
	exists(path: string): boolean;
}

export interface ProbeOptions {
	baseUrl?: string;
	platform?: NodeJS.Platform;
	checks?: InstallChecks;
	timeoutMs?: number;
	/** Windows `%LOCALAPPDATA%`; defaults to the process env. */
	localAppData?: string;
}

async function isExecutable(path: string): Promise<boolean> {
	try {
		await fsp.access(path, constants.X_OK);
		return (await fsp.stat(path)).isFile();
	} catch {
		return false;
	}
}

export const defaultInstallChecks: InstallChecks = {
	systemdUnit: () =>
		new Promise(resolve => {
			execFile("systemctl", ["cat", "ollama.service"], { timeout: SYSTEMCTL_TIMEOUT_MS }, error =>
				resolve(error === null),
			);
		}),
	onPath: async name => {
		const dirs = (await spawnPath()).split(delimiter).filter(Boolean);
		for (const dir of dirs) {
			if (await isExecutable(join(dir, name))) return true;
		}
		return false;
	},
	exists: path => existsSync(path),
};

export interface InstallFacts {
	installed: boolean;
	/** Linux only: an `ollama.service` unit exists, so `systemctl start` can work. */
	systemdUnit: boolean;
}

/** Whether Ollama is installed though not answering, and how it was installed. */
export async function detectOllamaInstall(
	platform: NodeJS.Platform,
	checks: InstallChecks,
	localAppData: string | undefined,
): Promise<InstallFacts> {
	switch (platform) {
		case "linux": {
			const systemdUnit = await checks.systemdUnit();
			return { installed: systemdUnit || (await checks.onPath("ollama")), systemdUnit };
		}
		case "darwin":
			return {
				installed: checks.exists("/Applications/Ollama.app") || (await checks.onPath("ollama")),
				systemdUnit: false,
			};
		case "win32":
			return {
				installed: localAppData ? checks.exists(join(localAppData, "Programs", "Ollama", "ollama.exe")) : false,
				systemdUnit: false,
			};
		default:
			return { installed: await checks.onPath("ollama"), systemdUnit: false };
	}
}

/** Whether Ollama is installed though not answering. */
export async function isOllamaInstalled(
	platform: NodeJS.Platform,
	checks: InstallChecks,
	localAppData: string | undefined,
): Promise<boolean> {
	return (await detectOllamaInstall(platform, checks, localAppData)).installed;
}

/**
 * The one-click fix for a state, Linux only. Starting needs the systemd unit:
 * a binary or tarball install on PATH has none, and `systemctl start` could
 * only fail after asking for the root password, so it gets no button.
 */
export function remedyFor(state: OllamaState, platform: NodeJS.Platform, systemdUnit: boolean): OllamaRemedyId | null {
	if (platform !== "linux") return null;
	if (state === "stopped") return systemdUnit ? "linux-start" : null;
	if (state === "absent") return "linux-install";
	return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
	const response = await fetch(url, { signal });
	if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
	return response.json();
}

/** Tag names from `/api/tags` (`{ models: [{ name }] }`); rows without a string name are skipped. */
export function parseTags(body: unknown): string[] {
	if (!isRecord(body) || !Array.isArray(body.models)) throw new Error("/api/tags returned an unexpected shape");
	const tags: string[] = [];
	for (const row of body.models) {
		if (isRecord(row) && typeof row.name === "string" && row.name.length > 0) tags.push(row.name);
	}
	return tags;
}

export function faultText(error: unknown): string {
	if (error instanceof Error) {
		const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
		return `${error.message}${cause}`;
	}
	return String(error);
}

/** Probe `/api/version` and `/api/tags`; never rejects. */
export async function probeOllama(options: ProbeOptions = {}): Promise<OllamaStatus> {
	const platform = options.platform ?? process.platform;
	const baseUrl = options.baseUrl ?? (await resolveOllamaBaseUrl());
	const signal = AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS);
	try {
		const [version, tags] = await Promise.all([
			getJson(`${baseUrl}/api/version`, signal),
			getJson(`${baseUrl}/api/tags`, signal),
		]);
		const installedTags = parseTags(tags);
		return {
			state: "ok",
			baseUrl,
			version: isRecord(version) && typeof version.version === "string" ? version.version : undefined,
			modelCount: installedTags.length,
			installedTags,
			platform,
			remedy: null,
		};
	} catch (error) {
		let facts: InstallFacts = { installed: false, systemdUnit: false };
		try {
			facts = await detectOllamaInstall(
				platform,
				options.checks ?? defaultInstallChecks,
				options.localAppData ?? process.env.LOCALAPPDATA,
			);
		} catch (checkError) {
			console.warn(`[ollama] install check failed: ${faultText(checkError)}`);
		}
		const state: OllamaState = facts.installed ? "stopped" : "absent";
		return {
			state,
			baseUrl,
			modelCount: 0,
			installedTags: [],
			platform,
			remedy: remedyFor(state, platform, facts.systemdUnit),
			fault: faultText(error),
		};
	}
}
