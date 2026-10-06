import { describe, expect, it } from "vitest";
import registerPackTools from "../src/tools/index";
import type { PackTool } from "../src/tools/types";

function registered(): PackTool[] {
	const tools: PackTool[] = [];
	registerPackTools({ registerTool: tool => tools.push(tool) });
	return tools;
}

function tierOf(tool: PackTool): string {
	if (typeof tool.approval === "string") return tool.approval;
	return tool.approval({}).tier;
}

describe("the pack's extension module", () => {
	it("registers exactly the seven pack tools", () => {
		expect(
			registered()
				.map(tool => tool.name)
				.sort(),
		).toEqual(
			[
				"diagnose",
				"system_status",
				"open_item",
				"os_setting",
				"office_report",
				"office_slides",
				"office_clean",
			].sort(),
		);
	});

	it("gives every tool its tier and keeps every tool top-level", () => {
		const tiers = Object.fromEntries(registered().map(tool => [tool.name, tierOf(tool)]));
		expect(tiers).toEqual({
			diagnose: "read",
			system_status: "read",
			open_item: "exec",
			os_setting: "exec",
			office_report: "write",
			office_slides: "write",
			office_clean: "write",
		});
		for (const tool of registered()) {
			expect(tool.loadMode).toBe("essential");
			expect(tool.parameters.additionalProperties).toBe(false);
		}
	});
});
