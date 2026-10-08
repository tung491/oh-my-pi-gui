/**
 * The schemes `system:open-external` hands to the OS: web pages and mail
 * links. Anything else (file:, javascript:, data:, custom handlers) is
 * refused. The agent's `gui_open_url` host tool keeps its own http/https rule.
 * Rust twin: `services::system::allowed_external_url`.
 */
const ALLOWED_PREFIXES = ["https://", "http://", "mailto:"];

export function isAllowedExternalUrl(url: unknown): url is string {
	return typeof url === "string" && ALLOWED_PREFIXES.some(prefix => url.startsWith(prefix));
}
