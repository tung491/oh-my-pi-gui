import { useEffect, useRef } from "react";
import { useSessionStore } from "../stores/session";
import { useSidebarPrefs } from "../stores/sidebar-prefs";

/** Persist the session most recently attached by the user. */
export function useSidebarRecency(): void {
	const sessionFile = useSessionStore(state => state.sessionFile);
	const hydrated = useSidebarPrefs(state => state.hydrated);
	const touchSession = useSidebarPrefs(state => state.touchSession);
	const lastSession = useRef<string | null>(null);

	useEffect(() => {
		void useSidebarPrefs.getState().hydrate();
	}, []);

	useEffect(() => {
		if (!hydrated) return;
		if (!sessionFile) {
			lastSession.current = null;
			return;
		}
		if (lastSession.current === sessionFile) return;
		lastSession.current = sessionFile;
		touchSession(sessionFile);
	}, [hydrated, sessionFile, touchSession]);
}
