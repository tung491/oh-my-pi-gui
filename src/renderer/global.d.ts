import type { OmpApi, QuickEntryBarApi } from "../shared/ipc-types";

declare global {
	interface Window {
		omp: OmpApi;
		/** Present only in the quick-entry bar page, which never gets `omp`. */
		ompQuickEntry?: QuickEntryBarApi;
	}
}
