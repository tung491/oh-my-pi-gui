/**
 * Sign and verify the Linux release files with the OpenSSL CLI.
 *
 *   bun --no-install scripts/sign-release.ts [--trusted <file>] --keys <dir> --keyset <id> [--keyset <id>] <release dir>
 *   bun --no-install scripts/sign-release.ts --verify --tag v<version> [--trusted <file>]... <release dir>
 *   bun --no-install scripts/sign-release.ts --fingerprints [--trusted <file>]
 *
 * This file runs in the keyed CI job, so it imports only `node:` modules and parses the feed with
 * Bun's built-in YAML parser. Nothing from npm may be imported here.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const ML_DSA_65_SPKI_PREFIX = "308207b2300b0609608648016503040312038207a100";
export const ED25519_SPKI_PREFIX = "302a300506032b6570032100";
export const ML_DSA_65_SPKI_LENGTH = 1974;
export const ED25519_SPKI_LENGTH = 44;
export const ML_DSA_65_SIGNATURE_LENGTH = 3309;
export const ED25519_SIGNATURE_LENGTH = 64;
export const SIGNED_FILES = ["latest-linux.yml", "SHA512SUMS"] as const;
/** Relative to the repository root. */
export const DEFAULT_TRUSTED = "src-tauri/src/updater/release-keys.json";

export type Algorithm = "mldsa65" | "ed25519";

export interface Keyset {
	id: string;
	mlDsa65: Buffer;
	ed25519: Buffer;
}

export interface TrustedFile {
	keysets: Keyset[];
	retiredSigners: Keyset[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const TAG_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
const ALGORITHMS: ReadonlyArray<{ name: Algorithm; label: string }> = [
	{ name: "mldsa65", label: "ML-DSA-65" },
	{ name: "ed25519", label: "Ed25519" },
];

/** Throws unless `openssl version` output names OpenSSL 3.5.5 or later (the library's version when it is printed). */
export function checkOpenSslVersion(output: string): void {
	const library = /Library:\s*OpenSSL\s+(\d+)\.(\d+)\.(\d+)/.exec(output);
	const cli = /^OpenSSL\s+(\d+)\.(\d+)\.(\d+)/.exec(output.trim());
	const found = library ?? cli;
	if (!found) throw new Error(`OpenSSL 3.5.5 or later is required, found: ${output.trim() || "no version output"}`);
	const version = [Number(found[1]), Number(found[2]), Number(found[3])] as const;
	const minimum = [3, 5, 5] as const;
	for (let index = 0; index < 3; index++) {
		const have = version[index] as number;
		const need = minimum[index] as number;
		if (have > need) return;
		if (have < need) throw new Error(`OpenSSL 3.5.5 or later is required, found ${version.join(".")}`);
	}
}

function decodeKey(value: unknown, where: string, prefixHex: string, length: number): Buffer {
	if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
		throw new Error(`${where} is not base64`);
	}
	const der = Buffer.from(value, "base64");
	if (der.toString("base64") !== value) throw new Error(`${where} is not canonical base64`);
	if (der.length !== length) throw new Error(`${where} is ${der.length} bytes, expected ${length}`);
	if (!der.subarray(0, prefixHex.length / 2).equals(Buffer.from(prefixHex, "hex"))) {
		throw new Error(`${where} does not start with the expected SPKI prefix`);
	}
	return der;
}

function parseKeysetList(value: unknown, list: string, seen: Set<string>): Keyset[] {
	if (!Array.isArray(value)) throw new Error(`${list} must be an array`);
	return value.map((entry: unknown, index) => {
		const where = `${list}[${index}]`;
		if (typeof entry !== "object" || entry === null) throw new Error(`${where} must be an object`);
		const record = entry as Record<string, unknown>;
		const id = record.id;
		if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error(`${where}.id is not a valid keyset id`);
		if (seen.has(id)) throw new Error(`keyset id ${id} appears more than once`);
		seen.add(id);
		return {
			id,
			mlDsa65: decodeKey(record.mlDsa65, `${where}.mlDsa65`, ML_DSA_65_SPKI_PREFIX, ML_DSA_65_SPKI_LENGTH),
			ed25519: decodeKey(record.ed25519, `${where}.ed25519`, ED25519_SPKI_PREFIX, ED25519_SPKI_LENGTH),
		};
	});
}

/** Parse and validate a trusted-keys file; throws an Error naming the first problem. */
export function parseTrusted(text: string): TrustedFile {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		throw new Error(`trusted keys file is not JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof json !== "object" || json === null) throw new Error("trusted keys file must be an object");
	const record = json as Record<string, unknown>;
	const seen = new Set<string>();
	const keysets = parseKeysetList(record.keysets, "keysets", seen);
	if (keysets.length === 0) throw new Error("keysets must not be empty");
	const retiredSigners = parseKeysetList(record.retiredSigners, "retiredSigners", seen);
	return { keysets, retiredSigners };
}

/** The keyset `id` from `keysets` or `retiredSigners`; throws when it is in neither. */
export function signingKeyset(trusted: TrustedFile, id: string): Keyset {
	const found = [...trusted.keysets, ...trusted.retiredSigners].find(keyset => keyset.id === id);
	if (!found) throw new Error(`keyset ${id} is in neither keysets nor retiredSigners of the trusted keys file`);
	return found;
}

function resolveExisting(target: string): string {
	let current = path.resolve(target);
	const rest: string[] = [];
	while (!existsSync(current)) {
		const parent = path.dirname(current);
		if (parent === current) break;
		rest.unshift(path.basename(current));
		current = parent;
	}
	return path.join(realpathSync(current), ...rest);
}

/** Throws when `dir` is the repository root or inside it, so a private key can never be committed by accident. */
export function assertOutsideRepository(dir: string, root: string = ROOT): void {
	const relative = path.relative(resolveExisting(root), resolveExisting(dir));
	if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
		throw new Error(`${dir} is inside the repository; keep private keys outside it`);
	}
}

export function signatureName(file: string, id: string, algorithm: Algorithm): string {
	return `${file}.${id}.${algorithm}.sig`;
}

export function pemName(id: string, algorithm: Algorithm): string {
	return `sai-atlas-release-${id}-${algorithm}.pem`;
}

export function pemText(der: Buffer): string {
	const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
	return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

/** Lowercase hex SHA-256 of the SPKI DER. */
export function fingerprint(der: Buffer): string {
	return createHash("sha256").update(der).digest("hex");
}

export function fingerprintRows(trusted: TrustedFile): string[] {
	return [...trusted.keysets, ...trusted.retiredSigners].flatMap(keyset => [
		`${keyset.id}  ML-DSA-65  ${fingerprint(keyset.mlDsa65)}`,
		`${keyset.id}  Ed25519  ${fingerprint(keyset.ed25519)}`,
	]);
}

interface Options {
	verify: boolean;
	fingerprints: boolean;
	tag?: string;
	keys?: string;
	keysets: string[];
	trusted: string[];
	positional: string[];
}

const USAGE = [
	"usage:",
	"  sign-release.ts [--trusted <file>] --keys <dir> --keyset <id> [--keyset <id>] <release dir>",
	"  sign-release.ts --verify --tag v<version> [--trusted <file>]... <release dir>",
	"  sign-release.ts --fingerprints [--trusted <file>]",
].join("\n");

function parseArgs(argv: string[]): Options {
	const options: Options = { verify: false, fingerprints: false, keysets: [], trusted: [], positional: [] };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] as string;
		const value = (): string => {
			const next = argv[++index];
			if (next === undefined) throw new Error(`${arg} needs a value`);
			return next;
		};
		switch (arg) {
			case "--verify":
				options.verify = true;
				break;
			case "--fingerprints":
				options.fingerprints = true;
				break;
			case "--tag":
				options.tag = value();
				break;
			case "--keys":
				options.keys = value();
				break;
			case "--keyset":
				options.keysets.push(value());
				break;
			case "--trusted":
				options.trusted.push(value());
				break;
			default:
				if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
				options.positional.push(arg);
		}
	}
	return options;
}

function opensslVersion(): void {
	let output: string;
	try {
		output = execFileSync("openssl", ["version"], { encoding: "utf8" });
	} catch (error) {
		throw new Error(`cannot run openssl: ${error instanceof Error ? error.message : String(error)}`);
	}
	checkOpenSslVersion(output);
}

function loadTrusted(file: string): TrustedFile {
	try {
		return parseTrusted(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** True when OpenSSL accepts `signatureFile` over `file` for the SPKI DER `der`. */
function opensslVerifies(der: Buffer, file: string, signatureFile: string): boolean {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "sign-release-pub-"));
	try {
		const derFile = path.join(tmp, "key.der");
		writeFileSync(derFile, der);
		const result = spawnSync(
			"openssl",
			[
				"pkeyutl",
				"-verify",
				"-rawin",
				"-pubin",
				"-keyform",
				"DER",
				"-inkey",
				derFile,
				"-in",
				file,
				"-sigfile",
				signatureFile,
			],
			{ stdio: "ignore" },
		);
		return result.status === 0;
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

function publicKey(keyset: Keyset, algorithm: Algorithm): Buffer {
	return algorithm === "mldsa65" ? keyset.mlDsa65 : keyset.ed25519;
}

function signatureLength(algorithm: Algorithm): number {
	return algorithm === "mldsa65" ? ML_DSA_65_SIGNATURE_LENGTH : ED25519_SIGNATURE_LENGTH;
}

/** Why `signatureFile` is not a valid signature of `file` by `keyset`, or undefined when it is. */
function signatureProblem(
	keyset: Keyset,
	algorithm: Algorithm,
	file: string,
	signatureFile: string,
): string | undefined {
	if (!existsSync(signatureFile)) return `${path.basename(signatureFile)} is missing`;
	const size = statSync(signatureFile).size;
	if (size !== signatureLength(algorithm)) {
		return `${path.basename(signatureFile)} is ${size} bytes, expected ${signatureLength(algorithm)}`;
	}
	if (!opensslVerifies(publicKey(keyset, algorithm), file, signatureFile)) {
		return `${path.basename(signatureFile)} does not verify`;
	}
	return undefined;
}

function sign(options: Options): void {
	opensslVersion();
	if (options.trusted.length > 1) throw new Error("signing takes one --trusted file");
	const defaultTrusted = path.join(ROOT, DEFAULT_TRUSTED);
	const trustedFile = options.trusted[0] ?? defaultTrusted;
	const trusted = loadTrusted(trustedFile);
	// The workflow passes the tag's copy of the key file, which matches this checkout's on a real release.
	if (!existsSync(defaultTrusted) || !readFileSync(trustedFile).equals(readFileSync(defaultTrusted))) {
		console.error("signing for test keys; no release build trusts them");
	}
	if (!options.keys) throw new Error("--keys is required");
	assertOutsideRepository(options.keys);
	const [dir, ...extra] = options.positional;
	if (!dir || extra.length > 0) throw new Error("expected exactly one release directory");
	for (const name of SIGNED_FILES) {
		if (!existsSync(path.join(dir, name))) throw new Error(`${dir} has no ${name}`);
	}
	if (options.keysets.length === 0) throw new Error("--keyset is required");
	const keysets = options.keysets.map(id => signingKeyset(trusted, id));
	const keyFiles = keysets.flatMap(keyset =>
		ALGORITHMS.map(({ name }) => ({
			keyset,
			algorithm: name,
			key: path.join(options.keys as string, `${keyset.id}-${name}.key`),
		})),
	);
	for (const { key } of keyFiles) if (!existsSync(key)) throw new Error(`missing private key file ${key}`);

	const written: string[] = [];
	try {
		for (const { keyset, algorithm, key } of keyFiles) {
			for (const file of SIGNED_FILES) {
				const out = path.join(dir, signatureName(file, keyset.id, algorithm));
				written.push(out);
				execFileSync(
					"openssl",
					["pkeyutl", "-sign", "-rawin", "-inkey", key, "-in", path.join(dir, file), "-out", out],
					{
						stdio: ["inherit", "inherit", "inherit"],
					},
				);
			}
		}
		for (const keyset of keysets) {
			for (const { name } of ALGORITHMS) {
				const pem = path.join(dir, pemName(keyset.id, name));
				written.push(pem);
				writeFileSync(pem, pemText(publicKey(keyset, name)));
			}
		}
		for (const { keyset, algorithm } of keyFiles) {
			for (const file of SIGNED_FILES) {
				const problem = signatureProblem(
					keyset,
					algorithm,
					path.join(dir, file),
					path.join(dir, signatureName(file, keyset.id, algorithm)),
				);
				if (problem) throw new Error(`self-check failed for keyset ${keyset.id}: ${problem}`);
			}
		}
	} catch (error) {
		for (const file of written) rmSync(file, { force: true });
		throw error;
	}
	for (const keyset of keysets) console.log(`signed with keyset ${keyset.id}`);
}

function sha512(file: string, encoding: "hex" | "base64"): string {
	return createHash("sha512").update(readFileSync(file)).digest(encoding);
}

function fail(message: string): never {
	throw new Error(message);
}

function verify(options: Options): void {
	opensslVersion();
	const tag = options.tag ?? fail("--tag is required");
	if (!TAG_PATTERN.test(tag)) fail(`${tag} is not a v<semver> tag`);
	const version = tag.slice(1);
	const [dir, ...extra] = options.positional;
	if (!dir || extra.length > 0) fail("expected exactly one release directory");
	const trustedFiles = options.trusted.length > 0 ? options.trusted : [path.join(ROOT, DEFAULT_TRUSTED)];
	if (trustedFiles.length > 2) fail("at most two --trusted files are supported");
	const trustedList = trustedFiles.map(loadTrusted);
	const ok = (message: string) => console.log(`ok ${message}`);

	const feedPath = path.join(dir, "latest-linux.yml");
	const sumsPath = path.join(dir, "SHA512SUMS");
	for (const file of [feedPath, sumsPath]) if (!existsSync(file)) fail(`${path.basename(file)} is missing`);

	const feedText = readFileSync(feedPath, "utf8");
	if (feedText.split("\n")[0] !== `version: ${version}`)
		fail(`latest-linux.yml does not start with "version: ${version}"`);
	ok(`latest-linux.yml starts with version: ${version}`);

	if (typeof Bun === "undefined") fail("verify mode needs Bun for its YAML parser; run it with bun");
	const feed = Bun.YAML.parse(feedText) as { files?: Array<{ url?: unknown; sha512?: unknown }> } | null;
	const entries = feed?.files;
	if (!Array.isArray(entries) || entries.length === 0) fail("latest-linux.yml lists no files");
	const feedNames = new Set<string>();
	for (const entry of entries) {
		const url = entry?.url;
		if (typeof url !== "string" || !url.includes(version))
			fail(`feed file ${String(url)} does not carry version ${version}`);
		if (url.includes("/") || url.includes("\\")) fail(`feed file ${url} is not a plain file name`);
		const file = path.join(dir, url);
		if (!existsSync(file)) fail(`feed file ${url} is not in the directory`);
		if (entry.sha512 !== sha512(file, "base64")) fail(`feed sha512 of ${url} does not match the file`);
		feedNames.add(url);
	}
	ok("feed files carry the version and their SHA-512 matches");

	const sumsNames = new Set<string>();
	const sumsLines = readFileSync(sumsPath, "utf8")
		.split("\n")
		.filter(line => line !== "");
	if (sumsLines.length === 0) fail("SHA512SUMS is empty");
	for (const line of sumsLines) {
		const match = /^([0-9a-f]{128}) {2}([^/\\\n]+)$/.exec(line);
		if (!match) fail(`SHA512SUMS has a malformed line: ${line}`);
		const name = match[2] as string;
		const file = path.join(dir, name);
		if (!existsSync(file)) fail(`SHA512SUMS lists ${name}, which is not in the directory`);
		if (sha512(file, "hex") !== match[1]) fail(`SHA512SUMS digest of ${name} does not match the file`);
		sumsNames.add(name);
	}
	ok("SHA512SUMS digests match");

	for (const [index, trusted] of trustedList.entries()) {
		const label = trustedFiles[index] as string;
		const reasons: string[] = [];
		const signer = trusted.keysets.find(keyset => {
			for (const { name } of ALGORITHMS) {
				for (const file of SIGNED_FILES) {
					const problem = signatureProblem(
						keyset,
						name,
						path.join(dir, file),
						path.join(dir, signatureName(file, keyset.id, name)),
					);
					if (problem) {
						reasons.push(`${keyset.id}: ${problem}`);
						return false;
					}
				}
			}
			return true;
		});
		if (!signer) fail(`no keyset of ${label} signed both files with both algorithms (${reasons.join("; ")})`);
		ok(`keyset ${signer.id} of ${label} signed latest-linux.yml and SHA512SUMS with ML-DSA-65 and Ed25519`);
	}

	const first = trustedList[0] as TrustedFile;
	const known = [...first.keysets, ...first.retiredSigners];
	for (const name of readdirSync(dir)) {
		if (name.endsWith(".sig")) {
			const signed = SIGNED_FILES.find(file => name.startsWith(`${file}.`));
			const match = signed
				? /^([a-z0-9][a-z0-9-]{0,31})\.(mldsa65|ed25519)\.sig$/.exec(name.slice(signed.length + 1))
				: null;
			const keyset = match ? known.find(candidate => candidate.id === match[1]) : undefined;
			if (!signed || !match || !keyset) fail(`unexpected signature file ${name}`);
			const algorithm = match[2] as Algorithm;
			const problem = signatureProblem(keyset, algorithm, path.join(dir, signed), path.join(dir, name));
			if (problem) fail(problem);
		} else if (name.endsWith(".pem")) {
			const match = /^sai-atlas-release-(.+)-(mldsa65|ed25519)\.pem$/.exec(name);
			const keyset = match ? known.find(candidate => candidate.id === match[1]) : undefined;
			if (!match || !keyset) fail(`unexpected key file ${name}`);
			if (readFileSync(path.join(dir, name), "utf8") !== pemText(publicKey(keyset, match[2] as Algorithm))) {
				fail(`${name} does not match the trusted keys`);
			}
		} else if (name.endsWith(".deb") || name.endsWith(".AppImage")) {
			if (!sumsNames.has(name) && !feedNames.has(name)) fail(`unexpected package ${name}`);
		}
	}
	ok("every signature, key file and package in the directory is accounted for");
}

if (import.meta.main) {
	try {
		const options = parseArgs(process.argv.slice(2));
		if (options.fingerprints) {
			const file = options.trusted[0] ?? path.join(ROOT, DEFAULT_TRUSTED);
			for (const row of fingerprintRows(loadTrusted(file))) console.log(row);
		} else if (options.verify) {
			verify(options);
		} else if (options.keys !== undefined) {
			sign(options);
		} else {
			console.error(USAGE);
			process.exit(2);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
