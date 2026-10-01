/**
 * One provider login flow for every surface that offers "Sign in": run the
 * sidecar login, refresh the caller's view of the providers, then announce the
 * result. The reload finishes before the success toast so the toast never
 * describes a list the user cannot see yet. Busy state stays with the caller.
 */

import { toast } from "../stores/toast";
import type { useT } from "./i18n";
import type { TabRpc } from "./tab-rpc";

type Translate = ReturnType<typeof useT>;

/** Resolves `true` only when the login succeeded and the reload finished. */
export async function loginProvider(
	rpc: Pick<TabRpc, "login">,
	providerId: string,
	name: string,
	t: Translate,
	reload: () => Promise<void>,
): Promise<boolean> {
	try {
		const res = await rpc.login(providerId);
		if (!res.success) {
			toast({ variant: "error", title: t("providers.loginFailed"), message: res.error });
			return false;
		}
		await reload();
		toast({ variant: "success", message: t("providers.loginSuccess", { provider: name }) });
		return true;
	} catch (cause) {
		toast({ variant: "error", title: t("providers.loginFailed"), message: String(cause) });
		return false;
	}
}
