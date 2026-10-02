/**
 * One-time migration to the Ollama-only provider set: sign out of OAuth
 * providers outside the allow-list, then have main back up `models.yml` and
 * delete every non-Ollama entry. Guarded by a pref so it runs once per
 * profile; any failure before the pref is written retries on the next launch.
 */
import { useEffect, useRef } from "react";
import type { ProviderConfigCleanupResult } from "../../shared/ollama-types";
import { isAllowedProvider } from "../../shared/provider-policy";
import type { ProviderInfo, RpcResponse } from "../../shared/rpc-types";
import { toast } from "../stores/toast";
import { useT } from "./i18n";
import { whenSidecarReady } from "./sidecar-ready";
import { focusedTabRpc } from "./tab-rpc";

/**
 * Dotted on purpose: electron-store reads and writes dotted keys as paths,
 * so this is stored as `{ providers: { cleanupVersion: 1 } }` and
 * `prefs.get(PROVIDER_CLEANUP_PREF)` returns the number again.
 */
export const PROVIDER_CLEANUP_PREF = "providers.cleanupVersion";
export const PROVIDER_CLEANUP_VERSION = 1;

/** How long the notice stays up; it carries a file path the user may want to note. */
const NOTICE_DURATION_MS = 15_000;

export interface ProviderCleanupRpc {
	getProviders(forceRefresh?: boolean): Promise<RpcResponse>;
	logout(providerId: string): Promise<RpcResponse>;
}

export interface ProviderCleanupDeps {
	/** Resolves once the sidecar answers RPCs. */
	waitForReady: () => Promise<void>;
	/** Resolved after `waitForReady`, so it picks the tab that is live by then. */
	rpc: () => ProviderCleanupRpc;
	prefs: {
		get(key: string): Promise<unknown>;
		set(key: string, value: unknown): Promise<void>;
	};
	cleanConfig: () => Promise<ProviderConfigCleanupResult>;
	/** Tell the user what changed; only called when something was. */
	notify: (result: ProviderCleanupOutcome) => void;
	/** Reports a logout that failed and was skipped. */
	warn: (message: string, error: unknown) => void;
}

export interface ProviderCleanupOutcome {
	/** False when an earlier launch already finished the migration. */
	ran: boolean;
	loggedOut: string[];
	removed: string[];
	backupPath: string | null;
}

function isProviderInfo(value: unknown): value is ProviderInfo {
	if (!value || typeof value !== "object") return false;
	const rec = value as Record<string, unknown>;
	return typeof rec.id === "string" && typeof rec.authenticated === "boolean";
}

function providersFrom(response: RpcResponse): ProviderInfo[] {
	if (!response.success) throw new Error(response.error);
	const data = response.data;
	const list = data && typeof data === "object" ? (data as { providers?: unknown }).providers : undefined;
	if (!Array.isArray(list) || !list.every(isProviderInfo)) {
		throw new Error("get_providers returned an unexpected shape");
	}
	return list;
}

/**
 * Run the migration unless the pref says it already finished.
 *
 * Only OAuth logins are signed out: those are the credentials the agent's
 * `logout` RPC can actually remove. API keys that come from environment
 * variables cannot be removed by the GUI at all, and stored API keys are left
 * alone; both stay invisible because every provider surface filters through
 * `provider-policy`.
 *
 * A single failed logout is reported through `warn` and skipped, and the pref
 * is still written: retrying would hit the same refusal on every launch. The
 * pref stays unset only when something the migration depends on throws
 * (reading the pref, the provider list, or `cleanConfig`), so the next launch
 * retries the whole run.
 */
export async function runProviderCleanup(deps: ProviderCleanupDeps): Promise<ProviderCleanupOutcome> {
	if ((await deps.prefs.get(PROVIDER_CLEANUP_PREF)) === PROVIDER_CLEANUP_VERSION) {
		return { ran: false, loggedOut: [], removed: [], backupPath: null };
	}
	await deps.waitForReady();
	const rpc = deps.rpc();
	const providers = providersFrom(await rpc.getProviders(true));
	const targets = providers.filter(
		provider => !isAllowedProvider(provider.id) && provider.authenticated && provider.authKind === "oauth",
	);

	const loggedOut: string[] = [];
	for (const provider of targets) {
		try {
			const response = await rpc.logout(provider.id);
			if (!response.success) throw new Error(response.error);
			loggedOut.push(provider.id);
		} catch (error) {
			deps.warn(`Could not sign out of ${provider.id}`, error);
		}
	}

	const { backupPath, removed } = await deps.cleanConfig();
	await deps.prefs.set(PROVIDER_CLEANUP_PREF, PROVIDER_CLEANUP_VERSION);

	const outcome: ProviderCleanupOutcome = { ran: true, loggedOut, removed, backupPath };
	if (loggedOut.length > 0 || removed.length > 0) deps.notify(outcome);
	return outcome;
}

/** Run the provider cleanup once for this window; dependencies are injectable for tests. */
export function useProviderCleanup(overrides?: Partial<ProviderCleanupDeps>): void {
	const t = useT();
	// The notice is shown after several awaits; read the language current by then.
	const tRef = useRef(t);
	tRef.current = t;
	const started = useRef(false);
	// Captured on the first render only: the migration starts once and must not
	// restart because a caller passed a fresh object.
	const deps = useRef<ProviderCleanupDeps | null>(null);
	deps.current ??= {
		waitForReady: () => whenSidecarReady(window.omp.sidecar.getStatus, window.omp.events.onSidecarStatus),
		rpc: focusedTabRpc,
		prefs: {
			get: key => window.omp.prefs.get(key),
			set: (key, value) => window.omp.prefs.set(key, value),
		},
		cleanConfig: () => window.omp.providerCleanup.cleanConfig(),
		notify: ({ backupPath }) =>
			toast({
				variant: "info",
				// No backup means only sign-outs happened and models.yml is unchanged.
				message:
					backupPath === null
						? tRef.current("providers.cleanup.noticeSignOutOnly")
						: tRef.current("providers.cleanup.notice", { path: backupPath }),
				durationMs: NOTICE_DURATION_MS,
			}),
		warn: (message, error) => console.warn(`[provider-cleanup] ${message}`, error),
		...overrides,
	};

	useEffect(() => {
		if (started.current || !deps.current) return;
		started.current = true;
		const run = deps.current;
		runProviderCleanup(run).catch(error => {
			run.warn("Provider cleanup failed; it will retry on the next launch", error);
		});
	}, []);
}
