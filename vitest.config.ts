import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Agent tooling checkouts are gitignored and ship their own test files.
		exclude: [...configDefaults.exclude, ".claude/**", ".agentkit/**"],
	},
});
