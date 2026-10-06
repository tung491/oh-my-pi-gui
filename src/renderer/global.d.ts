/** Set by the Tauri shell's initialization script (`bridge::bootstrap_script`) before any page script runs. */
interface OmpBootstrap {
	/** Node's platform names, as `process.platform` reported them in Electron. */
	platform: "darwin" | "win32" | "linux";
	version: string;
	windowKind: "main" | "quick-entry";
	/** The user's home folder; empty when the shell could not tell. */
	homeDir: string;
	winId: number;
}

interface Window {
	omp: import("../shared/ipc-types").OmpApi;
	/** Present only in the quick-entry bar page, which never gets `omp`. */
	ompQuickEntry?: import("../shared/ipc-types").QuickEntryBarApi;
	/** Present only in the Tauri shell. */
	__OMP_BOOTSTRAP__?: OmpBootstrap;
}

/** Shell-specific boot module, aliased per build in vite.renderer.shared.ts. */
declare module "@boot";
