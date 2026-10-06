// The slice of omp's extension API the pack uses. Parameters are plain JSON Schema objects,
// which omp accepts for extension tools, so the bundle imports nothing from omp at runtime.

export type JsonSchema = Record<string, unknown>;

export type ToolTier = "read" | "write" | "exec";

/** A static tier, or a function of the arguments whose `reason` becomes the approval text. */
export type ToolApproval = ToolTier | ((args: unknown) => { tier: ToolTier; reason?: string });

export interface ToolResult {
	content: { type: "text"; text: string }[];
	isError?: boolean;
}

export interface PackTool {
	name: string;
	label: string;
	description: string;
	parameters: JsonSchema;
	approval: ToolApproval;
	/** Extension tools default to deferred loading; "essential" keeps each one in the top-level tool list. */
	loadMode: "essential";
	execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<ToolResult>;
}

export interface PackExtensionApi {
	registerTool(tool: PackTool): void;
}

/** A bad argument, reported to the model as a fixed plain sentence. */
export class ArgumentError extends Error {}

export function textResult(text: string, isError = false): ToolResult {
	return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

export function asRecord(params: unknown): Record<string, unknown> {
	if (typeof params !== "object" || params === null || Array.isArray(params)) {
		throw new ArgumentError("The tool needs its arguments.");
	}
	return params as Record<string, unknown>;
}
