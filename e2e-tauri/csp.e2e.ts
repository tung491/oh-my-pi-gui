/**
 * Tauri-only: the Content-Security-Policy reaches the renderer. Only the
 * embedded-assets build counts here. `bun run dev:tauri` serves the page from
 * Vite, outside the Tauri protocol that adds the header, and
 * `vite.tauri.config.ts` strips the meta CSP, so a dev run has no CSP at all.
 */
import { browser, expect } from "@wdio/globals";
import { awaitBridge } from "./session";

interface Violation {
	effectiveDirective: string;
	blockedURI: string;
}

describe("content security policy", () => {
	it("the renderer runs under the Tauri CSP", async () => {
		// The policy is a property of the page; the sidecar plays no part.
		await awaitBridge(browser);

		const fetchRejected = await browser.execute(async () => {
			try {
				await fetch("https://example.com/");
				return false;
			} catch {
				return true;
			}
		});
		expect(fetchRejected).toBe(true);

		const violation = await browser.execute(
			() =>
				new Promise<Violation | null>(resolve => {
					const timer = setTimeout(() => resolve(null), 5_000);
					document.addEventListener(
						"securitypolicyviolation",
						event => {
							clearTimeout(timer);
							resolve({ effectiveDirective: event.effectiveDirective, blockedURI: event.blockedURI });
						},
						{ once: true },
					);
					const image = document.createElement("img");
					image.src = "https://example.com/x.png";
					document.body.appendChild(image);
				}),
		);
		expect(violation).not.toBeNull();
		expect(violation?.effectiveDirective).toBe("img-src");
		expect(violation?.blockedURI).toBe("https://example.com/x.png");
	});
});
