import { describe, expect, it } from "vitest";
import {
	checkParity,
	collectRawTestNames,
	collectTestNames,
	normalizeTestName,
	rustTestFunctions,
} from "./check-test-parity";

const TS_SOURCE = `
describe("thing", () => {
	it("skips the volume root, which is what a Finder launch reports as cwd", () => {});
	test('keeps the caller\\'s order', async () => {});
	it.each([
		["a", 1],
		["b", (2)],
	])("rejects %s", (input, n) => {});
	it.each\`
		a | b
		\${1} | \${"x)"}
	\`("accepts $a", () => {});
	it("same", () => {});
	it("same", () => {});
	it.skip("skipped one", () => {});
	const limit = 3; // it("not a test")
	expect(it).toBe(it);
});
`;

const RUST_SOURCE = `
pub fn production(input: &str) -> bool { input.is_empty() }

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn skips_the_volume_root_which_is_what_a_finder_launch_reports_as_cwd() {
		assert!(production(""));
	}

	#[tokio::test]
	async fn keeps_the_caller_s_order() {
		let value = "}";
		assert_eq!(value, "}");
	}

	#[test]
	fn rejects_s_cases() {
		for input in ["a", "b"] { assert!(!production(input)); }
	}

	#[test]
	fn accepts_a_cases() {
		assert!(true);
	}

	#[test]
	fn same() { assert!(true); }

	#[test]
	fn same_2() { println!("no assertion here"); }
}

#[cfg(all(test, target_os = "linux"))]
mod linux_tests {
	#[test]
	fn skipped_one() { assert!(true); }
}
`;

describe("collectRawTestNames", () => {
	it("collects it and test titles including it.each tables", () => {
		expect(collectRawTestNames(TS_SOURCE)).toEqual([
			"skips the volume root, which is what a Finder launch reports as cwd",
			"keeps the caller\\'s order",
			"rejects %s cases",
			"accepts $a cases",
			"same",
			"same",
			"skipped one",
		]);
	});
});

describe("normalizeTestName", () => {
	it("lowercases, replaces runs of non-alphanumerics and trims", () => {
		expect(normalizeTestName("keeps the directory every 0.9.x release derived from package.json name")).toBe(
			"keeps_the_directory_every_0_9_x_release_derived_from_package_json_name",
		);
		expect(normalizeTestName("lets an explicit --user-data-dir win")).toBe("lets_an_explicit_user_data_dir_win");
		expect(normalizeTestName("  weird!! ")).toBe("weird");
	});
});

describe("collectTestNames", () => {
	it("normalizes and numbers duplicates", () => {
		expect(collectTestNames(TS_SOURCE)).toEqual([
			"skips_the_volume_root_which_is_what_a_finder_launch_reports_as_cwd",
			"keeps_the_caller_s_order",
			"rejects_s_cases",
			"accepts_a_cases",
			"same",
			"same_2",
			"skipped_one",
		]);
	});
});

describe("rustTestFunctions", () => {
	it("finds functions only inside cfg(test) modules with their bodies", () => {
		const functions = rustTestFunctions(RUST_SOURCE);
		expect([...functions.keys()].sort()).toEqual(
			[
				"accepts_a_cases",
				"keeps_the_caller_s_order",
				"rejects_s_cases",
				"same",
				"same_2",
				"skipped_one",
				"skips_the_volume_root_which_is_what_a_finder_launch_reports_as_cwd",
			].sort(),
		);
		expect(functions.has("production")).toBe(false);
		expect(functions.get("keeps_the_caller_s_order")).toContain('assert_eq!(value, "}")');
	});
});

describe("checkParity", () => {
	it("reports missing twins and twins without an assert", () => {
		const sources: Record<string, string> = { "a.test.ts": TS_SOURCE, "a.rs": RUST_SOURCE };
		const misses = checkParity([{ ts: "a.test.ts", rust: "a.rs" }], file => sources[file] ?? "");
		expect(misses).toEqual([{ ts: "a.test.ts", rust: "a.rs", name: "same_2", reason: "no-assert" }]);
		const empty = checkParity([{ ts: "a.test.ts", rust: "a.rs" }], file =>
			file === "a.rs" ? "" : (sources[file] ?? ""),
		);
		expect(empty).toHaveLength(7);
		expect(empty.every(miss => miss.reason === "missing")).toBe(true);
	});
});
