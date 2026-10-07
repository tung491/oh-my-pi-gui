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

export type OfficeToolName = keyof typeof OFFICE_TOOL_KINDS;

export function isOfficeTool(name: string): name is OfficeToolName {
	return Object.hasOwn(OFFICE_TOOL_KINDS, name);
}

/**
 * Locale keys of the plain words shown instead of an office tool's id: the
 * output card's title and the approval dialog's action phrase. The raw id is
 * meaningless to the people these tools are for, so neither surface prints it.
 */
export const OFFICE_TOOL_TEXT: Readonly<Record<OfficeToolName, { title: string; action: string }>> = {
	office_report: { title: "tools.office.title.report", action: "approval.action.officeReport" },
	office_slides: { title: "tools.office.title.slides", action: "approval.action.officeSlides" },
	office_clean: { title: "tools.office.title.clean", action: "approval.action.officeClean" },
};
