import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcResponse } from "../../shared/rpc-types";
import { useToastStore } from "../stores/toast";
import { loginProvider } from "./provider-login";

/** Echo the key (and the provider name, when given) so asserts name the exact string used. */
function t(key: string, params?: Record<string, string | number>): string {
	return params?.provider === undefined ? key : `${key}:${params.provider}`;
}

function loginRpc(answer: () => Promise<RpcResponse>) {
	return { login: vi.fn((_providerId: string) => answer()) };
}

afterEach(() => {
	useToastStore.setState({ toasts: [] });
});

describe("loginProvider", () => {
	it("reloads before announcing a successful login", async () => {
		const rpc = loginRpc(async () => ({ type: "response", command: "login", success: true }));
		let toastsDuringReload = -1;
		const reload = vi.fn(async () => {
			toastsDuringReload = useToastStore.getState().toasts.length;
		});

		const result = await loginProvider(rpc, "anthropic", "Anthropic", t, reload);

		expect(result).toBe(true);
		expect(rpc.login).toHaveBeenCalledTimes(1);
		expect(rpc.login).toHaveBeenCalledWith("anthropic");
		expect(reload).toHaveBeenCalledTimes(1);
		expect(toastsDuringReload).toBe(0);
		const toasts = useToastStore.getState().toasts;
		expect(toasts).toHaveLength(1);
		expect(toasts[0]).toMatchObject({ variant: "success", message: "providers.loginSuccess:Anthropic" });
	});

	it("reports a refused login without reloading", async () => {
		const rpc = loginRpc(async () => ({ type: "response", command: "login", success: false, error: "x" }));
		const reload = vi.fn(async () => {});

		const result = await loginProvider(rpc, "anthropic", "Anthropic", t, reload);

		expect(result).toBe(false);
		expect(reload).not.toHaveBeenCalled();
		const toasts = useToastStore.getState().toasts;
		expect(toasts).toHaveLength(1);
		expect(toasts[0]).toMatchObject({ variant: "error", title: "providers.loginFailed", message: "x" });
	});

	it("turns a thrown login into an error toast", async () => {
		const rpc = loginRpc(async () => {
			throw new Error("socket closed");
		});
		const reload = vi.fn(async () => {});

		const result = await loginProvider(rpc, "anthropic", "Anthropic", t, reload);

		expect(result).toBe(false);
		expect(reload).not.toHaveBeenCalled();
		const toasts = useToastStore.getState().toasts;
		expect(toasts).toHaveLength(1);
		expect(toasts[0]).toMatchObject({
			variant: "error",
			title: "providers.loginFailed",
			message: "Error: socket closed",
		});
	});
});
