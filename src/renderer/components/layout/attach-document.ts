/** Wraps a file path in single quotes for a prompt line, as the pack skills expect. */
export function quotePromptPath(path: string): string {
	return `'${path}'`;
}
