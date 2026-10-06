/**
 * SESSION_OPEN_NEW_WINDOW decision logic, extracted from ipc.ts so its
 * contracts are testable without an Electron runtime:
 * - a session file already attached to a tab focuses its owner window;
 * - a chat-stamped session file is refused with `kind-mismatch`, since an
 *   assistant session cannot resume it, and no window opens;
 * - otherwise a new window opens on the session (`false` at the pool cap).
 * The new window always runs an assistant session, so no kind is passed on.
 */
import type { IpcSessionOpenNewWindowPayload, IpcSessionOpenNewWindowResult, SessionKind } from "../shared/ipc-types";
import type { SidecarPool } from "./sidecar-pool";

export type OpenInNewWindowDeps = {
	sidecarPool: Pick<SidecarPool, "sessionOwner" | "atCap">;
	sessionIndex: { kindFor(sessionPath: string): Promise<SessionKind> };
	/** Focus a window by id; false when it is gone. */
	focusWindow: (winId: number) => boolean;
	/** Open a window on `cwd` that will show `sessionPath`; false when none opened. */
	spawnWindow: (cwd: string, sessionPath: string | undefined) => boolean;
	/** The calling window's cwd, falling back to the app's initial cwd. */
	callerCwd: () => string;
};

export async function openSessionInNewWindow(
	deps: OpenInNewWindowDeps,
	payload: IpcSessionOpenNewWindowPayload,
): Promise<IpcSessionOpenNewWindowResult> {
	const sessionPath =
		typeof payload?.sessionPath === "string" && payload.sessionPath ? payload.sessionPath : undefined;
	if (sessionPath) {
		const owner = deps.sidecarPool.sessionOwner(sessionPath);
		if (owner && deps.focusWindow(owner.winId)) return true;
		if ((await deps.sessionIndex.kindFor(sessionPath)) === "chat") return { refusal: "kind-mismatch" };
	}
	if (deps.sidecarPool.atCap) return false;
	const cwd = typeof payload?.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : deps.callerCwd();
	return deps.spawnWindow(cwd, sessionPath);
}
