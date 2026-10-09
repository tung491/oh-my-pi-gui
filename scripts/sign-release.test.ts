import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildRelease } from "./release-feeds";
import {
	assertOutsideRepository,
	checkOpenSslVersion,
	DEFAULT_TRUSTED,
	ED25519_SPKI_LENGTH,
	ED25519_SPKI_PREFIX,
	fingerprint,
	fingerprintRows,
	ML_DSA_65_SPKI_LENGTH,
	ML_DSA_65_SPKI_PREFIX,
	parseTrusted,
	pemText,
	signingKeyset,
	type TrustedFile,
} from "./sign-release";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A base64 key with the given DER prefix, padded with random bytes up to `length`. */
function fakeKey(prefixHex: string, length: number): string {
	const prefix = Buffer.from(prefixHex, "hex");
	return Buffer.concat([prefix, randomBytes(length - prefix.length)]).toString("base64");
}

function fakeEntry(id: string): { id: string; mlDsa65: string; ed25519: string } {
	return {
		id,
		mlDsa65: fakeKey(ML_DSA_65_SPKI_PREFIX, ML_DSA_65_SPKI_LENGTH),
		ed25519: fakeKey(ED25519_SPKI_PREFIX, ED25519_SPKI_LENGTH),
	};
}

function trustedText(keysets: unknown[], retiredSigners?: unknown[]): string {
	return JSON.stringify(retiredSigners === undefined ? { keysets } : { keysets, retiredSigners });
}

describe("sign-release helpers", () => {
	it("accepts OpenSSL 3.5.5 and later", () => {
		expect(() => checkOpenSslVersion("OpenSSL 3.5.5 27 Jan 2026 (Library: OpenSSL 3.5.5 27 Jan 2026)")).not.toThrow();
		expect(() => checkOpenSslVersion("OpenSSL 3.6.0 1 Oct 2025")).not.toThrow();
	});

	it("refuses older OpenSSL, LibreSSL and a newer CLI on an older library", () => {
		for (const output of [
			"OpenSSL 3.5.4 30 Sep 2025",
			"OpenSSL 3.0.13 30 Jan 2024",
			"LibreSSL 3.3.6",
			"OpenSSL 3.5.5 27 Jan 2026 (Library: OpenSSL 3.5.4 30 Sep 2025)",
		]) {
			expect(() => checkOpenSslVersion(output), output).toThrow();
		}
	});

	it("rejects malformed trusted files", () => {
		const good = fakeEntry("a");
		const bad: Array<[string, string]> = [
			["an uppercase id", trustedText([{ ...good, id: "A" }], [])],
			["an id of 33 characters", trustedText([{ ...good, id: "a".repeat(33) }], [])],
			["a key that is not base64", trustedText([{ ...good, mlDsa65: "not base64 !!" }], [])],
			[
				"an ML-DSA-65 key of 1973 bytes",
				trustedText([{ ...good, mlDsa65: fakeKey(ML_DSA_65_SPKI_PREFIX, ML_DSA_65_SPKI_LENGTH - 1) }], []),
			],
			["an Ed25519 key in the ML-DSA-65 field", trustedText([{ ...good, mlDsa65: good.ed25519 }], [])],
			["a duplicate id", trustedText([good, fakeEntry("a")], [])],
			["an id in both lists", trustedText([good], [fakeEntry("a")])],
			["no keysets", trustedText([], [])],
			["a missing retiredSigners", trustedText([good])],
		];
		for (const [label, text] of bad) expect(() => parseTrusted(text), label).toThrow();
		expect(() => parseTrusted(trustedText([good, fakeEntry("b")], []))).not.toThrow();
	});

	it("refuses a keyset in neither list and accepts a retired signer", () => {
		const trusted = parseTrusted(trustedText([fakeEntry("a"), fakeEntry("b")], [fakeEntry("old")]));
		expect(signingKeyset(trusted, "a").id).toBe("a");
		expect(signingKeyset(trusted, "old").id).toBe("old");
		expect(() => signingKeyset(trusted, "zzz")).toThrow(/zzz/);
	});

	it("refuses a keys directory inside the repository", () => {
		expect(() => assertOutsideRepository(path.join(ROOT, "tmp-keys"))).toThrow();
		expect(() => assertOutsideRepository(os.tmpdir())).not.toThrow();
	});

	it("writes PEM text that round-trips to the same DER", () => {
		const { publicKey } = generateKeyPairSync("ed25519");
		const der = publicKey.export({ type: "spki", format: "der" });
		const roundTrip = createPublicKey(pemText(der)).export({ type: "spki", format: "der" });
		expect(roundTrip.equals(der)).toBe(true);
		const text = pemText(randomBytes(ML_DSA_65_SPKI_LENGTH));
		const lines = text.split("\n");
		expect(lines[0]).toBe("-----BEGIN PUBLIC KEY-----");
		expect(lines[lines.length - 2]).toBe("-----END PUBLIC KEY-----");
		expect(lines[lines.length - 1]).toBe("");
		for (const line of lines.slice(1, -2)) expect(line.length).toBeLessThanOrEqual(64);
	});

	it("prints a SHA-256 fingerprint of each key", () => {
		const trusted: TrustedFile = parseTrusted(trustedText([fakeEntry("a")], [fakeEntry("old")]));
		const rows = fingerprintRows(trusted);
		expect(rows).toHaveLength(4);
		const [a, old] = [trusted.keysets[0], trusted.retiredSigners[0]];
		const hex = (der: Buffer) => createHash("sha256").update(der).digest("hex");
		expect(rows).toEqual([
			`a  ML-DSA-65  ${hex(a?.mlDsa65 as Buffer)}`,
			`a  Ed25519  ${hex(a?.ed25519 as Buffer)}`,
			`old  ML-DSA-65  ${hex(old?.mlDsa65 as Buffer)}`,
			`old  Ed25519  ${hex(old?.ed25519 as Buffer)}`,
		]);
		expect(fingerprint(a?.ed25519 as Buffer)).toBe(hex(a?.ed25519 as Buffer));
	});

	it("imports only node: modules", () => {
		const source = readFileSync(path.join(ROOT, "scripts/sign-release.ts"), "utf8");
		const specifiers = [
			...[...source.matchAll(/from\s+["']([^"']+)["']/g)].map(match => match[1] as string),
			...[...source.matchAll(/import\(\s*["']([^"']+)["']/g)].map(match => match[1] as string),
		];
		expect(specifiers.length).toBeGreaterThan(0);
		for (const specifier of specifiers) expect(specifier.startsWith("node:"), specifier).toBe(true);
	});
});

const scratch: string[] = [];

afterAll(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
	scratch.push(dir);
	return dir;
}

function openSslReady(): boolean {
	try {
		checkOpenSslVersion(execFileSync("openssl", ["version"], { encoding: "utf8" }));
		return true;
	} catch {
		return false;
	}
}

interface TestKeyset {
	id: string;
	mlDsa65: Buffer;
	ed25519: Buffer;
}

/** Generate one keyset's private keys into `keysDir` and return its public keys. */
function makeKeyset(keysDir: string, id: string): TestKeyset {
	const mlDsaKey = path.join(keysDir, `${id}-mldsa65.key`);
	const edKey = path.join(keysDir, `${id}-ed25519.key`);
	execFileSync("openssl", ["genpkey", "-algorithm", "ML-DSA-65", "-out", mlDsaKey]);
	execFileSync("openssl", ["genpkey", "-algorithm", "ED25519", "-out", edKey]);
	const spki = (key: string) => execFileSync("openssl", ["pkey", "-in", key, "-pubout", "-outform", "DER"]);
	return { id, mlDsa65: spki(mlDsaKey), ed25519: spki(edKey) };
}

function writeTrusted(file: string, keysets: TestKeyset[], retired: TestKeyset[] = []): void {
	const encode = (keyset: TestKeyset) => ({
		id: keyset.id,
		mlDsa65: keyset.mlDsa65.toString("base64"),
		ed25519: keyset.ed25519.toString("base64"),
	});
	writeFileSync(file, JSON.stringify({ keysets: keysets.map(encode), retiredSigners: retired.map(encode) }));
}

/** A fresh release directory for version 1.2.3 holding a Linux feed, SHA512SUMS and both packages. */
async function release(): Promise<string> {
	const base = tempDir("sign-release-rel-");
	const linux = path.join(base, "bundle");
	mkdirSync(path.join(linux, "appimage"), { recursive: true });
	mkdirSync(path.join(linux, "deb"), { recursive: true });
	writeFileSync(path.join(linux, "appimage/Sai ATLAS_1.2.3_amd64.AppImage"), "appimage bytes");
	writeFileSync(path.join(linux, "deb/Sai ATLAS_1.2.3_amd64.deb"), "deb bytes");
	const dir = path.join(base, "out");
	await buildRelease({ version: "1.2.3", outDir: dir, linux });
	return dir;
}

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
	return spawnSync("bun", ["--no-install", "scripts/sign-release.ts", ...args], { cwd: ROOT, encoding: "utf8" });
}

function copyDir(source: string): string {
	const target = path.join(tempDir("sign-release-copy-"), "dir");
	mkdirSync(target);
	for (const name of readdirSync(source)) copyFileSync(path.join(source, name), path.join(target, name));
	return target;
}

function flipByte(file: string): void {
	const bytes = readFileSync(file);
	bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 0x01;
	writeFileSync(file, bytes);
}

const SKIP_OPENSSL = "SKIP: OpenSSL older than 3.5.5";

describe("sign-release with OpenSSL", () => {
	it("signs and verifies a release with OpenSSL", { timeout: 60_000 }, async ctx => {
		if (!openSslReady()) {
			console.log(SKIP_OPENSSL);
			ctx.skip();
		}
		const keys = tempDir("sign-release-keys-");
		const a = makeKeyset(keys, "t-a");
		const b = makeKeyset(keys, "t-b");
		const trusted = path.join(tempDir("sign-release-trusted-"), "trusted.json");
		writeTrusted(trusted, [a, b]);
		const dir = await release();
		const before = new Set(readdirSync(dir));
		const signed = cli(["--trusted", trusted, "--keys", keys, "--keyset", "t-a", dir]);
		expect(signed.status, signed.stderr).toBe(0);
		const added = readdirSync(dir).filter(name => !before.has(name));
		expect(added.sort()).toEqual(
			[
				"SHA512SUMS.t-a.ed25519.sig",
				"SHA512SUMS.t-a.mldsa65.sig",
				"latest-linux.yml.t-a.ed25519.sig",
				"latest-linux.yml.t-a.mldsa65.sig",
				"sai-atlas-release-t-a-ed25519.pem",
				"sai-atlas-release-t-a-mldsa65.pem",
			].sort(),
		);
		expect(added.filter(name => name.includes("t-b"))).toEqual([]);
		expect(statSync(path.join(dir, "latest-linux.yml.t-a.mldsa65.sig")).size).toBe(3309);
		expect(statSync(path.join(dir, "latest-linux.yml.t-a.ed25519.sig")).size).toBe(64);
		expect(statSync(path.join(dir, "SHA512SUMS.t-a.mldsa65.sig")).size).toBe(3309);
		expect(statSync(path.join(dir, "SHA512SUMS.t-a.ed25519.sig")).size).toBe(64);
		const verified = cli(["--verify", "--tag", "v1.2.3", "--trusted", trusted, dir]);
		expect(verified.status, verified.stderr).toBe(0);
	});

	it("rejects a tampered feed, a tampered package, a wrong tag, extra files and an unrelated trusted file", {
		timeout: 120_000,
	}, async ctx => {
		if (!openSslReady()) {
			console.log(SKIP_OPENSSL);
			ctx.skip();
		}
		const keys = tempDir("sign-release-keys-");
		const a = makeKeyset(keys, "t-a");
		const other = makeKeyset(keys, "t-x");
		const trustedDir = tempDir("sign-release-trusted-");
		const trusted = path.join(trustedDir, "trusted.json");
		const unrelated = path.join(trustedDir, "unrelated.json");
		writeTrusted(trusted, [a]);
		writeTrusted(unrelated, [other]);
		const signedDir = await release();
		const signed = cli(["--trusted", trusted, "--keys", keys, "--keyset", "t-a", signedDir]);
		expect(signed.status, signed.stderr).toBe(0);
		expect(cli(["--verify", "--tag", "v1.2.3", "--trusted", trusted, copyDir(signedDir)]).status).toBe(0);

		const verify = (dir: string, extra: string[] = [], tag = "v1.2.3") =>
			cli(["--verify", "--tag", tag, "--trusted", trusted, ...extra, dir]);

		const tamperedFeed = copyDir(signedDir);
		flipByte(path.join(tamperedFeed, "latest-linux.yml"));
		expect(verify(tamperedFeed).status, "tampered feed").toBe(1);

		const tamperedPackage = copyDir(signedDir);
		flipByte(path.join(tamperedPackage, "sai-atlas_1.2.3_amd64.deb"));
		expect(verify(tamperedPackage).status, "tampered package").toBe(1);

		expect(verify(copyDir(signedDir), [], "v1.2.4").status, "wrong tag").toBe(1);

		const extraSignature = copyDir(signedDir);
		copyFileSync(
			path.join(extraSignature, "latest-linux.yml.t-a.ed25519.sig"),
			path.join(extraSignature, "latest-linux.yml.t-z.ed25519.sig"),
		);
		expect(verify(extraSignature).status, "extra signature").toBe(1);

		const extraKey = copyDir(signedDir);
		copyFileSync(
			path.join(extraKey, "sai-atlas-release-t-a-ed25519.pem"),
			path.join(extraKey, "sai-atlas-release-t-z-ed25519.pem"),
		);
		expect(verify(extraKey).status, "extra key file").toBe(1);

		const second = cli([
			"--verify",
			"--tag",
			"v1.2.3",
			"--trusted",
			trusted,
			"--trusted",
			unrelated,
			copyDir(signedDir),
		]);
		expect(second.status, "unrelated trusted file").toBe(1);
	});

	it("leaves no signature behind when a key does not match the trusted file", { timeout: 60_000 }, async ctx => {
		if (!openSslReady()) {
			console.log(SKIP_OPENSSL);
			ctx.skip();
		}
		const keys = tempDir("sign-release-keys-");
		makeKeyset(keys, "t-a");
		const mismatched = makeKeyset(tempDir("sign-release-keys-"), "t-a");
		const trusted = path.join(tempDir("sign-release-trusted-"), "trusted.json");
		writeTrusted(trusted, [mismatched]);
		const dir = await release();
		const before = readdirSync(dir).sort();
		const result = cli(["--trusted", trusted, "--keys", keys, "--keyset", "t-a", dir]);
		expect(result.status).toBe(1);
		expect(readdirSync(dir).sort()).toEqual(before);
		expect(readdirSync(dir).filter(name => name.endsWith(".sig") || name.endsWith(".pem"))).toEqual([]);
	});

	it("verifies across a rotation with a retired signer", { timeout: 120_000 }, async ctx => {
		if (!openSslReady()) {
			console.log(SKIP_OPENSSL);
			ctx.skip();
		}
		const keys = tempDir("sign-release-keys-");
		const a = makeKeyset(keys, "t-a");
		const b = makeKeyset(keys, "t-b");
		const c = makeKeyset(keys, "t-c");
		const trustedDir = tempDir("sign-release-trusted-");
		const oldTrusted = path.join(trustedDir, "old.json");
		const newTrusted = path.join(trustedDir, "new.json");
		writeTrusted(oldTrusted, [a, b]);
		writeTrusted(newTrusted, [b, c], [a]);

		const both = await release();
		const dual = cli(["--trusted", newTrusted, "--keys", keys, "--keyset", "t-b", "--keyset", "t-a", both]);
		expect(dual.status, dual.stderr).toBe(0);
		const acrossBoth = cli(["--verify", "--tag", "v1.2.3", "--trusted", newTrusted, "--trusted", oldTrusted, both]);
		expect(acrossBoth.status, acrossBoth.stderr).toBe(0);

		const onlyNew = await release();
		const single = cli(["--trusted", newTrusted, "--keys", keys, "--keyset", "t-c", onlyNew]);
		expect(single.status, single.stderr).toBe(0);
		expect(cli(["--verify", "--tag", "v1.2.3", "--trusted", oldTrusted, onlyNew]).status).toBe(1);
	});
});

const KEYS_NOT_COMMITTED = "SKIP: src-tauri/src/updater/release-keys.json is not committed yet";

describe("committed release keys", () => {
	it("loads the committed release keys", ctx => {
		if (!existsSync(path.join(ROOT, DEFAULT_TRUSTED))) {
			console.log(KEYS_NOT_COMMITTED);
			ctx.skip();
		}
		const trusted = parseTrusted(readFileSync(path.join(ROOT, DEFAULT_TRUSTED), "utf8"));
		expect(trusted.keysets.length).toBeGreaterThanOrEqual(2);
	});

	it("README lists every release-key fingerprint", ctx => {
		if (!existsSync(path.join(ROOT, DEFAULT_TRUSTED))) {
			console.log(KEYS_NOT_COMMITTED);
			ctx.skip();
		}
		const trusted = parseTrusted(readFileSync(path.join(ROOT, DEFAULT_TRUSTED), "utf8"));
		for (const readme of ["README.md", "README.vi.md"]) {
			const text = readFileSync(path.join(ROOT, readme), "utf8");
			for (const row of fingerprintRows(trusted)) {
				const hex = row.slice(row.lastIndexOf(" ") + 1);
				expect(text, `${readme} lists ${row}`).toContain(hex);
			}
		}
	});

	it("keeps a keyset in common with the newest release tag", ctx => {
		const git = (args: string[]) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
		const tags = git(["tag", "--list", "v*"])
			.stdout.split("\n")
			.filter(tag => /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag))
			.sort((left, right) => {
				const a = left.slice(1).split(".").map(Number);
				const b = right.slice(1).split(".").map(Number);
				return (
					(b[0] as number) - (a[0] as number) ||
					(b[1] as number) - (a[1] as number) ||
					(b[2] as number) - (a[2] as number)
				);
			});
		let tagged: string | undefined;
		for (const tag of tags) {
			const shown = git(["show", `${tag}:${DEFAULT_TRUSTED}`]);
			if (shown.status === 0) {
				tagged = shown.stdout;
				break;
			}
		}
		if (tagged === undefined) {
			console.log("SKIP: no release tag holds src-tauri/src/updater/release-keys.json");
			ctx.skip();
			return;
		}
		const keysetsOf = (text: string) =>
			(JSON.parse(text) as { keysets: Array<{ id: string; mlDsa65: string; ed25519: string }> }).keysets;
		const head = keysetsOf(readFileSync(path.join(ROOT, DEFAULT_TRUSTED), "utf8"));
		const shared = keysetsOf(tagged).some(entry =>
			head.some(
				other => other.id === entry.id && other.mlDsa65 === entry.mlDsa65 && other.ed25519 === entry.ed25519,
			),
		);
		expect(shared).toBe(true);
	});

	it("prints fingerprints from a trusted file", () => {
		const file = path.join(tempDir("sign-release-trusted-"), "trusted.json");
		writeFileSync(file, trustedText([fakeEntry("t-a")], []));
		const result = cli(["--fingerprints", "--trusted", file]);
		expect(result.status, result.stderr).toBe(0);
		const rows = result.stdout.trim().split("\n");
		expect(rows).toHaveLength(2);
		for (const row of rows) expect(row).toMatch(/^t-a {2}(ML-DSA-65|Ed25519) {2}[0-9a-f]{64}$/);
	});
});

interface WorkflowStep {
	name?: string;
	run?: string;
	uses?: string;
}

interface Workflow {
	on: Record<string, { inputs?: Record<string, { required?: boolean }> }>;
	concurrency: { group: string; "cancel-in-progress": boolean };
	jobs: Record<string, { environment?: string; container?: { image?: string }; steps: WorkflowStep[] }>;
}

function workflow(): Workflow {
	return parse(readFileSync(path.join(ROOT, ".github/workflows/sign-release.yml"), "utf8")) as Workflow;
}

function runScripts(flow: Workflow): string[] {
	return Object.values(flow.jobs).flatMap(job =>
		job.steps.flatMap(step => (step.run === undefined ? [] : [step.run])),
	);
}

describe("sign-release workflow", () => {
	it("runs only on workflow_dispatch with the three inputs", () => {
		const flow = workflow();
		expect(Object.keys(flow.on)).toEqual(["workflow_dispatch"]);
		const inputs = flow.on.workflow_dispatch?.inputs ?? {};
		expect(Object.keys(inputs).sort()).toEqual(["feed_sha256", "sums_sha256", "tag"]);
		for (const [name, input] of Object.entries(inputs)) expect(input.required, name).toBe(true);
	});

	it("keeps signing in the release-signing environment without npm code", () => {
		const flow = workflow();
		const jobs = Object.values(flow.jobs);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.environment).toBe("release-signing");
		expect(flow.concurrency.group).toBe(`sign-release-\${{ inputs.tag }}`);
		expect(flow.concurrency["cancel-in-progress"]).toBe(false);
		for (const script of runScripts(flow)) {
			for (const forbidden of ["bun install", "npm ", "bunx", "| bash"]) expect(script).not.toContain(forbidden);
			for (const match of script.matchAll(/\bbun (?!--no-install)/g)) {
				expect.fail(`bun run without --no-install at offset ${match.index}`);
			}
		}
	});

	it("pins every action by commit and the container by digest", () => {
		const flow = workflow();
		for (const job of Object.values(flow.jobs)) {
			expect(job.container?.image).toMatch(/^ubuntu:26\.04@sha256:[0-9a-f]{64}$/);
			for (const step of job.steps) if (step.uses !== undefined) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
		}
	});

	it("never expands an expression inside a run script", () => {
		for (const script of runScripts(workflow())) expect(script).not.toContain("${{");
	});
});
