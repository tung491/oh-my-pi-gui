/**
 * What `system:open-external` hands to the OS: web pages and mail links.
 * Anything else (file:, javascript:, data:, custom handlers) is refused. The
 * agent's `gui_open_url` host tool keeps its own http/https rule.
 * Rust twin: `services::system::sanitize_external_url`.
 */
const WEB_PREFIXES = ["https://", "http://"];
const MAILTO = "mailto:";

/**
 * The mailto header fields passed on. Some mail clients reached through
 * xdg-open have honoured `attach`/`attachment`, so a link in model output
 * could pre-attach a local file; every field but these is dropped.
 */
const MAILTO_FIELDS = new Set(["subject", "body", "cc", "bcc"]);

/**
 * The URL to open, or `null` when it is refused. http and https pass
 * unchanged; a mailto link is rebuilt from its address and its `subject`,
 * `body`, `cc` and `bcc` fields (names matched case-insensitively, after
 * percent-decoding), without its fragment. A mailto address holding an
 * encoded `?` is refused, so a client that decodes it first finds no fields.
 */
export function sanitizeExternalUrl(url: unknown): string | null {
	if (typeof url !== "string") return null;
	const lower = url.toLowerCase();
	if (WEB_PREFIXES.some(prefix => lower.startsWith(prefix))) return url;
	if (!lower.startsWith(MAILTO)) return null;
	const withoutFragment = url.slice(MAILTO.length).split("#", 1)[0] ?? "";
	const query = withoutFragment.indexOf("?");
	const address = query === -1 ? withoutFragment : withoutFragment.slice(0, query);
	if (address.toLowerCase().includes("%3f")) return null;
	const fields =
		query === -1
			? []
			: withoutFragment
					.slice(query + 1)
					.split("&")
					.filter(isKeptMailtoField);
	return fields.length > 0 ? `${MAILTO}${address}?${fields.join("&")}` : `${MAILTO}${address}`;
}

function isKeptMailtoField(field: string): boolean {
	const equals = field.indexOf("=");
	const rawName = equals === -1 ? field : field.slice(0, equals);
	try {
		return MAILTO_FIELDS.has(decodeURIComponent(rawName).toLowerCase());
	} catch {
		// A malformed escape cannot name a kept field.
		return false;
	}
}
