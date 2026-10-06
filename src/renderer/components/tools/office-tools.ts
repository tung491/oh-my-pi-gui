/**
 * The pack's office tools and the file kind each one makes. Their card is the
 * way to open the finished file, so it starts expanded and stays out of the
 * compact transcript's "N steps" group.
 */
export const OFFICE_TOOL_KINDS = {
	office_report: "docx",
	office_slides: "pptx",
	office_clean: "xlsx",
} as const;

export type OfficeKind = (typeof OFFICE_TOOL_KINDS)[keyof typeof OFFICE_TOOL_KINDS];

export function isOfficeTool(name: string): name is keyof typeof OFFICE_TOOL_KINDS {
	return Object.hasOwn(OFFICE_TOOL_KINDS, name);
}
