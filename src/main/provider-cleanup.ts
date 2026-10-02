/**
 * One-time removal of non-Ollama providers from the agent's `models.yml`.
 *
 * The file is copied to `<name>.bak-<YYYYMMDD-HHmmss>` next to itself before
 * anything is deleted, and the copy's size is checked against the source, so
 * a user (or support) can always restore the previous config by copying the
 * backup back. Running again once only allowed providers remain is a no-op
 * that writes no backup.
 *
 * Everything here is synchronous on purpose: concurrent IPC calls from
 * several windows then run one after another on main's event loop, so the
 * second call already sees the cleaned file instead of racing the first.
 */
import { constants, copyFileSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IpcMain } from "electron";
import { parseDocument } from "yaml";
import { IPC_COMMANDS } from "../shared/ipc-types";
import type { ProviderConfigCleanupResult } from "../shared/ollama-types";
import { isAllowedProvider } from "../shared/provider-policy";
import { listModelsProviders, modelsPath } from "./models-config";

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/** Local-time `YYYYMMDD-HHmmss`, the suffix of a backup file name. */
export function backupStamp(date: Date): string {
	return (
		`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
		`-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
	);
}

/**
 * Copy `file` next to itself, refusing to overwrite an existing backup, and
 * confirm the copy holds exactly the bytes the edit was computed from before
 * the caller destroys anything.
 */
function backUp(file: string, expectedBytes: number, now: Date): string {
	const backupPath = `${file}.bak-${backupStamp(now)}`;
	copyFileSync(file, backupPath, constants.COPYFILE_EXCL);
	const backupBytes = statSync(backupPath).size;
	if (backupBytes !== expectedBytes) {
		rmSync(backupPath, { force: true });
		throw new Error(
			`Backup of ${file} is incomplete (${backupBytes} of ${expectedBytes} bytes); nothing was removed.`,
		);
	}
	return backupPath;
}

/**
 * Render `source` with `ids` removed from its `providers` map, or throw when
 * the document cannot be edited in place (invalid YAML, `providers` written as
 * an alias, an entry the edit did not find).
 *
 * Built-in ids are removed too: an override such as `providers.anthropic`
 * must go, and only this migration may remove it.
 */
function renderWithout(file: string, source: string, ids: readonly string[]): string {
	const doc = parseDocument(source);
	if (doc.errors.length > 0) throw new Error(`${file}: ${doc.errors[0]?.message ?? "invalid YAML"}`);
	for (const id of ids) {
		let deleted: boolean;
		try {
			deleted = doc.deleteIn(["providers", id]);
		} catch (error) {
			throw new Error(`${file}: cannot remove provider "${id}": ${(error as Error).message}`);
		}
		if (!deleted) throw new Error(`${file}: cannot remove provider "${id}"; edit the file by hand.`);
	}
	return String(doc);
}

/**
 * Replace `file` in one atomic write (temp file + rename), so the agent's
 * live-reload watcher never sees a half-written config.
 */
function writeAtomic(file: string, text: string): void {
	const tmp = `${file}.tmp-cleanup-${process.pid}`;
	try {
		writeFileSync(tmp, text, "utf8");
		renameSync(tmp, file);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

/**
 * Back up `models.yml` and delete every provider outside the allow-list
 * (an `ollama` entry stays). Everything that can fail on the content — parse,
 * edit, render — runs before the backup, so a file this migration cannot
 * clean is neither backed up nor rewritten.
 */
export function cleanConfig(now: Date = new Date()): ProviderConfigCleanupResult {
	// Throws on invalid YAML, so a broken file is never backed up and rewritten.
	const removed = listModelsProviders()
		.map(provider => provider.id)
		.filter(id => !isAllowedProvider(id));
	if (removed.length === 0) return { backupPath: null, removed: [] };

	const file = modelsPath();
	const source = readFileSync(file, "utf8");
	const cleaned = renderWithout(file, source, removed);
	const backupPath = backUp(file, Buffer.byteLength(source, "utf8"), now);
	writeAtomic(file, cleaned);
	return { backupPath, removed };
}

/** Wire the renderer's `providerCleanup.cleanConfig()` to {@link cleanConfig}. */
export function registerProviderCleanupIpc(ipcMain: Pick<IpcMain, "handle">): void {
	ipcMain.handle(IPC_COMMANDS.PROVIDER_CLEANUP_CONFIG, (): ProviderConfigCleanupResult => cleanConfig());
}
