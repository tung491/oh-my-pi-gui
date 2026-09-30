import { ExternalLink, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RpcGitChanges, RpcGitDiff } from "../../../shared/rpc-types";
import { DiffView, diffLineCounts } from "../../lib/diff";
import { basename, cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { currentKeyboardPlatform, type KeyboardPlatform } from "../../lib/keymap";
import type { TabRpc } from "../../lib/tab-rpc";
import { useTabRpc } from "../../lib/tab-rpc";
import { Button, buttonClasses, IconButton, Input } from "../common";
import { PathLink } from "../tools/PathLink";

/**
 * Extensions the OS default handler runs or launches instead of opening for
 * editing: scripts, macOS Terminal/URL/location launchers, Java Web Start, and
 * Python (the py.exe launcher on Windows, Python Launcher on macOS).
 */
const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set([
	".bat",
	".cmd",
	".command",
	".desktop",
	".fileloc",
	".inetloc",
	".jnlp",
	".ps1",
	".py",
	".sh",
	".terminal",
	".tool",
	".vbe",
	".vbs",
	".webloc",
	".wsf",
	".wsh",
]);

/**
 * Extra extensions the Windows shell runs or launches on open: Windows Script
 * Host, HTML applications, windowed Python, Internet shortcuts, MMC snap-ins,
 * Remote Desktop, ClickOnce, Explorer command/library/search-connector files,
 * registry imports, setup information, and scriptlets.
 */
const WINDOWS_SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set([
	".appref-ms",
	".application",
	".hta",
	".inf",
	".js",
	".jse",
	".library-ms",
	".msc",
	".pyw",
	".rdp",
	".reg",
	".scf",
	".sct",
	".searchconnector-ms",
	".url",
	".website",
	".wsc",
]);

/** Whether opening this file with the OS default handler would run it; reads the file name only, never a folder. */
function opensAsProgram(path: string, platform: KeyboardPlatform): boolean {
	const name = basename(path).toLowerCase();
	const dot = name.lastIndexOf(".");
	if (dot < 0) return false;
	const extension = name.slice(dot);
	return SCRIPT_EXTENSIONS.has(extension) || (platform === "windows" && WINDOWS_SCRIPT_EXTENSIONS.has(extension));
}

/** Status tile colors: additions and untracked files read as added, deletions as removed, the rest as accent. */
function statusTileClasses(status: string, selected: boolean): string {
	if (status.includes("A") || status.includes("?")) return "bg-(--omp-diff-added-bg) text-(--omp-diff-added)";
	if (status.includes("D")) return "bg-(--omp-diff-removed-bg) text-(--omp-diff-removed)";
	return selected
		? "border border-(--omp-accent)/30 bg-(--omp-bg-elevated) text-(--omp-accent)"
		: "bg-(--omp-selected-bg) text-(--omp-accent)";
}

export function RepositoryChanges() {
	const t = useT();
	const rpc = useTabRpc();
	const [refresh, setRefresh] = useState(0);
	const [changes, setChanges] = useState<RpcGitChanges | null>(null);
	const [selected, setSelected] = useState("");
	const [preview, setPreview] = useState<RpcGitDiff | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [query, setQuery] = useState("");
	const loadedFor = useRef<TabRpc | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly reloads the checkout.
	useEffect(() => {
		let active = true;
		setLoading(true);
		// A reload is not an initial load: only switching to another session's
		// client wipes the rows, so a failed refresh keeps the last good diff up.
		if (loadedFor.current !== rpc) {
			setChanges(null);
			setSelected("");
		}
		setError(null);
		void Promise.resolve()
			.then(() => rpc.getGitChanges())
			.then(response => {
				if (!active) return;
				if (!response.success) throw new Error(response.error ?? t("rpc.failed"));
				loadedFor.current = rpc;
				setChanges(response.data as RpcGitChanges);
			})
			.catch(cause => {
				if (active) setError(String(cause));
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [rpc, refresh, t]);
	useEffect(() => {
		let active = true;
		setPreview(null);
		if (!selected) return;
		setError(null);
		void Promise.resolve()
			.then(() => rpc.getGitDiff(selected))
			.then(response => {
				if (!active) return;
				if (!response.success) throw new Error(response.error ?? t("rpc.failed"));
				setPreview(response.data as RpcGitDiff);
			})
			.catch(cause => {
				if (active) setError(String(cause));
			});
		return () => {
			active = false;
		};
	}, [rpc, selected, t]);
	const files = changes?.files.filter(file => file.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
	const counts = useMemo(() => (preview?.kind === "text" ? diffLineCounts(preview.diff) : null), [preview]);
	const listed = Boolean(changes?.isRepo && changes.files.length > 0);
	const entry = changes?.files.find(file => file.path === selected);
	// Only a text preview of the selected path proves a regular file inside the
	// checkout: the sidecar reports symlinks, directories, and binaries by kind.
	// A deleted row has nothing on disk, and a row a refresh dropped is stale.
	const previewedText = Boolean(
		changes?.root && entry && !entry.status.includes("D") && preview?.path === selected && preview.kind === "text",
	);
	const runsWhenOpened = previewedText && opensAsProgram(selected, currentKeyboardPlatform());
	const canOpen = previewedText && !runsWhenOpened;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">
				<div className="flex items-start gap-2 text-omp-xs text-(--omp-muted)">
					<p className="flex-1">{t("diffPanel.repositoryScope")}</p>
					<IconButton
						disabled={loading}
						icon={<RefreshCw size={14} />}
						label={t("common.refresh")}
						onClick={() => setRefresh(value => value + 1)}
						size="sm"
					/>
				</div>
				{error && (
					<p role="alert" className="break-words text-omp-sm text-(--omp-error)">
						{error}
					</p>
				)}
				{loading && !changes ? (
					<p>{t("common.loading")}</p>
				) : changes && !changes.isRepo ? (
					<p>{t("diffPanel.notRepo")}</p>
				) : changes?.files.length === 0 ? (
					<p>{t("diffPanel.clean")}</p>
				) : (
					changes && (
						<>
							<div className="relative">
								<Search
									className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-(--omp-dim)"
									size={15}
								/>
								<Input
									aria-label={t("diffPanel.search")}
									className="pl-9"
									onChange={event => setQuery(event.target.value)}
									placeholder={t("diffPanel.search")}
									value={query}
								/>
							</div>
							{changes.truncated && <p role="status">{t("diffPanel.listLimited")}</p>}
							<div className="max-h-48 shrink-0 divide-y divide-(--omp-border-muted) overflow-y-auto rounded-md border border-(--omp-border-muted)">
								{files.map(file => {
									const active = selected === file.path;
									return (
										<button
											type="button"
											key={file.path}
											aria-pressed={active}
											className={cx(
												"flex h-[34px] w-full items-center gap-2.5 px-3 text-left font-mono text-omp-sm",
												active
													? "bg-(--omp-selected-bg) font-medium text-(--omp-text) shadow-[inset_2px_0_0_0_var(--omp-accent)]"
													: "text-(--omp-muted) hover:bg-(--omp-bg-secondary)",
											)}
											onClick={() => setSelected(file.path)}
										>
											<code
												className={cx(
													"flex h-5 min-w-5 shrink-0 items-center justify-center rounded px-1 text-omp-xs font-semibold",
													statusTileClasses(file.status, active),
												)}
											>
												{file.status}
											</code>
											<span className="min-w-0 flex-1 truncate">
												{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
											</span>
										</button>
									);
								})}
								{files.length === 0 && (
									<p className="px-3 py-2 text-omp-sm text-(--omp-muted)">{t("diffPanel.noMatch")}</p>
								)}
							</div>
							{selected && !preview && !error && <p>{t("common.loading")}</p>}
							{preview && (
								<div className="min-w-0 overflow-hidden rounded-md border border-(--omp-border-muted)">
									<div
										className="flex min-h-[34px] items-center gap-2.5 border-b border-(--omp-border-muted) bg-(--omp-bg-secondary) px-3 py-1.5" // surface-ok: sunken diff box header
									>
										<p className="min-w-0 flex-1 break-all font-mono text-omp-sm font-semibold text-(--omp-text)">
											{preview.path}
										</p>
										{counts && (
											<span className="flex shrink-0 gap-2 font-mono text-omp-sm font-semibold">
												<span className="text-(--omp-diff-added)">+{counts.added}</span>
												<span className="text-(--omp-diff-removed)">−{counts.removed}</span>
											</span>
										)}
									</div>
									<div className="py-1.5">
										{preview.kind === "text" ? (
											<DiffView diff={preview.diff} filePath={preview.path} />
										) : (
											<p className="px-3">{t(`diffPanel.kind.${preview.kind}`)}</p>
										)}
									</div>
									{preview.truncated && (
										<p className="px-3 pb-2 text-omp-xs text-(--omp-warning)">
											{t("diffPanel.previewLimited")}
										</p>
									)}
								</div>
							)}
						</>
					)
				)}
			</div>
			{listed && changes && (
				<footer className="flex shrink-0 items-center gap-2 border-t border-(--omp-border-muted) px-3 py-2.5">
					<span className="min-w-0 flex-1 text-omp-xs text-(--omp-muted)">
						{t("diffPanel.filesChanged", {
							count: changes.truncated ? `${changes.files.length}+` : changes.files.length,
							plural: changes.truncated || changes.files.length !== 1 ? "s" : "",
						})}
					</span>
					{canOpen && changes.root ? (
						<PathLink
							className={buttonClasses("secondary", "sm")}
							path={`${changes.root.replace(/[\\/]+$/, "")}/${selected}`}
						>
							<ExternalLink size={14} />
							{t("diffPanel.openInEditor")}
						</PathLink>
					) : (
						<Button
							disabled
							icon={<ExternalLink size={14} />}
							size="sm"
							title={runsWhenOpened ? t("diffPanel.openInEditorScript") : undefined}
							variant="secondary"
						>
							{t("diffPanel.openInEditor")}
						</Button>
					)}
				</footer>
			)}
		</div>
	);
}
