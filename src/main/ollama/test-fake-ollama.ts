/**
 * Test-only: a real HTTP server on an ephemeral port standing in for the
 * Ollama daemon. node:http (not Bun.serve) because vitest runs under Node.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeOllama {
	url: string;
	close(): Promise<void>;
}

export type FakeHandler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

export async function startFakeOllama(handler: FakeHandler): Promise<FakeOllama> {
	const server = createServer((req, res) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", chunk => {
			body += chunk;
		});
		req.on("end", () => handler(req, res, body));
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise<void>(resolve => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

/** A loopback URL nothing listens on: bind an ephemeral port, then release it. */
export async function closedPortUrl(): Promise<string> {
	const fake = await startFakeOllama((_req, res) => res.end());
	await fake.close();
	return fake.url;
}

export function sendJson(res: ServerResponse, body: unknown, status = 200): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}
