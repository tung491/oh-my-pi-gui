/**
 * Post-processing of an egress-audit recording: turns the raw connect() lines
 * of egress-app.txt (the app and its children, in the container) and
 * egress-ollama.txt (the host's Ollama daemon, when the user recorded it) into
 * one row per (process, destination host:port, action), the action taken from
 * timeline.tsv by timestamp.
 *
 *   bun egress-report.ts <evidence dir>
 *
 * Writes egress-rows.tsv and egress-rows.md into the evidence dir. IPs are
 * named from dns-snapshot.tsv (the allowed and expected hosts, resolved by
 * egress-audit.sh before and after the session) and, failing that, from a
 * reverse lookup. Process names come from the ps snapshots the session took
 * after every action (ps/*.txt: thread id -> process), else from the thread
 * name strace printed. AF_UNIX connections are local IPC, not egress: they are
 * summarized per socket path, not listed as rows.
 *
 * The "suggested" column applies the plan's rule mechanically; the auditor's
 * verdict in the egress-audit report is the one that counts. Exit codes: 0
 * written, 2 bad usage or missing input.
 */
import { promises as dns } from "node:dns";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Connect {
	tid: number;
	thread: string;
	time: number;
	family: string;
	host: string;
	port: number | null;
	result: string;
	source: "app" | "ollama";
}

interface TimelineEntry {
	action: string;
	start: number;
	end: number;
}

interface Row {
	source: "app" | "ollama";
	process: string;
	destination: string;
	name: string;
	action: string;
	count: number;
	first: number;
	results: Set<string>;
}

const LINE = /^(?:\[pid\s+)?(\d+)(?:<([^>]*)>)?\]?\s+(\d+\.\d+)\s+(.*)$/;
const INET = /sin_port=htons\((\d+)\),\s*sin_addr=inet_addr\("([^"]+)"\)/;
const INET6 = /sin6_port=htons\((\d+)\).*inet_pton\(AF_INET6,\s*"([^"]+)"/;
const UNIX = /sun_path=(@?"[^"]*")/;
const FAMILY = /sa_family=(AF_[A-Z0-9]+)/;
const RESULT = /\)\s*=\s*(.+)$/;
/** Destinations the plan allows, with the action or source they are allowed for. */
const APP_UPDATE_HOSTS = [
	"github.com",
	"objects.githubusercontent.com",
	"api.github.com",
	"release-assets.githubusercontent.com",
];
const OLLAMA_DOWNLOAD_HOSTS = [
	"hf.co",
	"huggingface.co",
	"cdn-lfs.hf.co",
	"cdn-lfs.huggingface.co",
	"cas-bridge.xethub.hf.co",
	"registry.ollama.ai",
];

function usage(message: string): never {
	console.error(message);
	console.error("usage: bun egress-report.ts <evidence dir>");
	process.exit(2);
}

/** Parse one strace file; an `<unfinished ...>` call takes its result from the matching resumed line. */
function parseTrace(file: string, source: "app" | "ollama"): Connect[] {
	const connects: Connect[] = [];
	const pending = new Map<number, Connect>();
	for (const raw of readFileSync(file, "utf8").split("\n")) {
		const match = LINE.exec(raw);
		if (!match) continue;
		const [, tidText, thread = "", timeText, call] = match;
		const tid = Number(tidText);
		if (call.startsWith("<... connect resumed>")) {
			const open = pending.get(tid);
			if (open) {
				open.result = RESULT.exec(call)?.[1]?.trim() ?? "?";
				pending.delete(tid);
			}
			continue;
		}
		// sendto/sendmsg only matter when they carry their own address (UDP without connect, e.g. DNS).
		const datagram = call.startsWith("sendto(") || call.startsWith("sendmsg(");
		if (!call.startsWith("connect(") && !datagram) continue;
		if (datagram && !INET.test(call) && !INET6.test(call)) continue;
		const family = FAMILY.exec(call)?.[1] ?? "?";
		if (family === "AF_UNSPEC") continue;
		let host = "";
		let port: number | null = null;
		const inet = INET.exec(call) ?? INET6.exec(call);
		if (inet) {
			port = Number(inet[1]);
			host = inet[2];
		} else {
			host = UNIX.exec(call)?.[1] ?? call.slice(0, 160);
		}
		const connect: Connect = { tid, thread, time: Number(timeText), family, host, port, result: "?", source };
		if (call.includes("<unfinished ...>")) {
			if (!datagram) pending.set(tid, connect);
		}
		else connect.result = RESULT.exec(call)?.[1]?.trim() ?? "?";
		connects.push(connect);
	}
	return connects;
}

function parseTimeline(file: string): TimelineEntry[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.slice(1)
		.filter(Boolean)
		.map(line => {
			const [action, start, end] = line.split("\t");
			return { action, start: Number(start), end: Number(end) };
		})
		.sort((a, b) => a.start - b.start);
}

/** The action whose window holds `time`, else the gap it fell in. */
function actionAt(timeline: TimelineEntry[], time: number): string {
	const inside = timeline.filter(entry => time >= entry.start && time <= entry.end);
	if (inside.length > 0) return inside.map(entry => entry.action).join("+");
	const before = timeline.filter(entry => entry.end < time).at(-1);
	const after = timeline.find(entry => entry.start > time);
	if (!before) return `before ${after?.action ?? "the session"}`;
	if (!after) return `after ${before.action}`;
	return `between ${before.action} and ${after.action}`;
}

/** Thread id -> "pid args (parent ppid)" from the ps snapshots (`pid ppid lwp args`). */
function processNames(dir: string): Map<number, string> {
	const names = new Map<number, string>();
	const psDir = join(dir, "ps");
	if (!existsSync(psDir)) return names;
	for (const file of readdirSync(psDir).sort()) {
		for (const line of readFileSync(join(psDir, file), "utf8").split("\n")) {
			const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
			if (!match) continue;
			const [, pid, ppid, lwp, args] = match;
			if (!names.has(Number(lwp))) names.set(Number(lwp), `${pid} ${args.slice(0, 80)} (parent ${ppid})`);
		}
	}
	return names;
}

/** IP -> host names from dns-snapshot.tsv (`host<TAB>ip` per line). */
function snapshotNames(file: string): Map<string, Set<string>> {
	const names = new Map<string, Set<string>>();
	if (!existsSync(file)) return names;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		const [host, ip] = line.split("\t");
		if (!host || !ip) continue;
		if (!names.has(ip)) names.set(ip, new Set());
		names.get(ip)?.add(host);
	}
	return names;
}

function isLoopback(ip: string): boolean {
	return ip.startsWith("127.") || ip === "::1" || ip === "0.0.0.0" || ip === "::ffff:127.0.0.1";
}

async function nameOf(ip: string, port: number | null, snapshot: Map<string, Set<string>>): Promise<string> {
	if (ip.startsWith("192.0.2.")) return "TEST-NET-1 tripwire (a seeded MCP server or extension ran)";
	if (port === 53) return "DNS resolver (a name lookup)";
	if (isLoopback(ip)) return port === 11434 ? "Ollama on loopback" : "loopback";
	const known = snapshot.get(ip);
	// getaddrinfo connects a UDP socket to port 0 to sort a lookup's answers; no packet is sent.
	const probe = port === 0 ? " [port-0 address-sorting probe after a name lookup; no packet sent]" : "";
	if (known) return `${[...known].join(", ")}${probe}`;
	try {
		const reverse = await dns.reverse(ip);
		if (reverse.length > 0) return `${reverse.join(", ")} (reverse lookup)${probe}`;
	} catch {
		// no PTR record
	}
	return `(unresolved)${probe}`;
}

function suggest(row: Row): string {
	const names = row.name
		.replace(/ \[port-0 .*\]$/, "")
		.split(/,\s*/)
		.map(name => name.replace(/ \(reverse lookup\)$/, ""));
	if (row.name === "Ollama on loopback" || row.name === "loopback") return row.source === "app" ? "allowed" : "check";
	if (row.name.startsWith("DNS resolver")) return "check: a name lookup (see the next connect of this thread)";
	if (row.name.startsWith("TEST-NET-1")) return "NOT ALLOWED";
	if (row.destination.endsWith(":0"))
		return "check: the process looked this name up (no packet to it); see its DNS row";
	const matches = (hosts: string[]) =>
		names.some(name => hosts.some(host => name === host || name.endsWith(`.${host}`)));
	if (row.source === "app" && row.action === "update-check" && matches(APP_UPDATE_HOSTS)) return "allowed";
	if (row.source === "ollama" && matches(OLLAMA_DOWNLOAD_HOSTS)) return "allowed if a model download ran";
	return "NOT ALLOWED (unless the auditor names it as an allowed host)";
}

async function main(): Promise<void> {
	const dir = process.argv[2];
	if (!dir) usage("missing evidence dir");
	const appTrace = join(dir, "egress-app.txt");
	if (!existsSync(appTrace)) usage(`${appTrace} is missing`);
	const ollamaTrace = join(dir, "egress-ollama.txt");
	const connects = [
		...parseTrace(appTrace, "app"),
		...(existsSync(ollamaTrace) ? parseTrace(ollamaTrace, "ollama") : []),
	];
	const timeline = parseTimeline(join(dir, "timeline.tsv"));
	const processes = processNames(dir);
	const snapshot = snapshotNames(join(dir, "dns-snapshot.tsv"));

	const rows = new Map<string, Row>();
	const unix = new Map<string, number>();
	for (const connect of connects) {
		if (connect.family === "AF_UNIX") {
			const key = `${connect.source} ${connect.thread} -> ${connect.host}`;
			unix.set(key, (unix.get(key) ?? 0) + 1);
			continue;
		}
		const owner = processes.get(connect.tid);
		const processLabel =
			connect.source === "ollama"
				? `ollama (host) thread ${connect.tid}<${connect.thread}>`
				: `${owner ?? "(exited before a ps snapshot)"} / thread ${connect.tid}<${connect.thread}>`;
		const destination =
			connect.port === null
				? `${connect.family} ${connect.host}`
				: `${connect.host.includes(":") ? `[${connect.host}]` : connect.host}:${connect.port}`;
		const action = actionAt(timeline, connect.time);
		const key = `${connect.source}\t${processLabel}\t${destination}\t${action}`;
		const row = rows.get(key) ?? {
			source: connect.source,
			process: processLabel,
			destination,
			name: connect.port === null ? connect.family : await nameOf(connect.host, connect.port, snapshot),
			action,
			count: 0,
			first: connect.time,
			results: new Set<string>(),
		};
		row.count++;
		row.results.add(connect.result.replace(/\s*\(.*\)$/, ""));
		rows.set(key, row);
	}

	const sorted = [...rows.values()].sort((a, b) => a.first - b.first);
	const iso = (time: number) => new Date(time * 1000).toISOString();
	const header = [
		"first (UTC)",
		"source",
		"process",
		"destination",
		"name",
		"action",
		"count",
		"results",
		"suggested",
	];
	const cells = sorted.map(row => [
		iso(row.first),
		row.source,
		row.process,
		row.destination,
		row.name,
		row.action,
		String(row.count),
		[...row.results].join(", "),
		suggest(row),
	]);
	writeFileSync(join(dir, "egress-rows.tsv"), `${[header, ...cells].map(cols => cols.join("\t")).join("\n")}\n`);

	const escapeCell = (text: string) => text.replace(/\|/g, "\\|");
	const markdown = [
		`# Egress rows (${new Date().toISOString()})`,
		"",
		`Traces: egress-app.txt (${existsSync(appTrace) ? "present" : "missing"}), egress-ollama.txt (${existsSync(ollamaTrace) ? "present" : "missing"}). Actions in timeline.tsv: ${timeline.map(entry => entry.action).join(", ") || "(none)"}.`,
		"",
		`| ${header.join(" | ")} |`,
		`|${header.map(() => "---").join("|")}|`,
		...cells.map(cols => `| ${cols.map(escapeCell).join(" | ")} |`),
		"",
		"## Per action: loopback rows and rows that leave this computer",
		"",
		...timeline.map(entry => {
			const own = sorted.filter(row => row.action.split("+").includes(entry.action));
			const local = own.filter(row => row.destination.startsWith("127.") || row.destination.startsWith("[::1]"));
			return `- ${entry.action}: ${local.length} loopback, ${own.length - local.length} other`;
		}),
		"",
		"## Local IPC (AF_UNIX), not egress",
		"",
		...[...unix.entries()].sort().map(([key, count]) => `- ${escapeCell(key)}: ${count}`),
		"",
	].join("\n");
	writeFileSync(join(dir, "egress-rows.md"), markdown);
	console.log(`${sorted.length} network rows, ${unix.size} local IPC endpoints -> ${join(dir, "egress-rows.md")}`);
}

await main();
