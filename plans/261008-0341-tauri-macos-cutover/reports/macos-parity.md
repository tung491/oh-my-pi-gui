# macOS parity

macOS bundle layout (Contents/MacOS/omp, Contents/Resources/assistant-pack): PASS
macOS sidecar entitlements (allow-jit, allow-unsigned-executable-memory, disable-library-validation; no audio-input): PASS
macOS app entitlements (audio-input only): PASS
macOS app signature (Identifier=vn.io.vif.saiatlas, adhoc,runtime; codesign --verify --strict --deep): PASS
macOS omp URL scheme in Info.plist: PASS
macOS pack check against the bundled re-signed sidecar: PASS
macOS first launch starts a supervised sidecar with the bundled pack: PASS
macOS bundle layout: PASS
macOS app signature: PASS
macOS app entitlements: PASS
macOS sidecar entitlements: PASS
macOS info plist: PASS
macOS pack check: PASS
macOS boots a supervised sidecar: PASS
macOS single instance per profile: PASS
macOS hard kill leaves nothing: PASS (before the macOS supervisor port; the escaped-tool case is not covered yet)
## Phase 4

macOS supervisor kill -9 of the GUI ends supervisor, omp and escaped tool (unit): PASS
macOS supervisor parent watch with the control channel held open (unit): PASS
macOS escaped tool dies when omp exits on its own (unit): PASS
macOS system proxy from scutil --proxy (parser): PASS
macOS GPU name and RAM for Ollama sizing (live on this Mac): PASS
## Phase 5

macOS single instance per profile: covered by smoke case (the lock is `/tmp/<identifier>_si.sock`, keyed on the per-profile identifier; host log fact 4)

Every NEEDS-HUMAN row below runs against the packaged arm64 app under `src-tauri/target/` with a throwaway profile: `P=$(mktemp -d); PI_CODING_AGENT_DIR="$P/agent" "<app>/Contents/MacOS/sai-atlas" --user-data-dir="$P/profile"` (or `open -n "<app>" --env PI_CODING_AGENT_DIR="$P/agent" --args --user-data-dir="$P/profile"` where the row needs LaunchServices). The steps follow each row.

macOS dictation with the TCC prompt: NEEDS-HUMAN
  steps: in a chat, click the microphone button; macOS asks for microphone access naming Sai ATLAS; allow; speak a sentence; the transcript appears in the input. Deny on a second profile after `tccutil reset Microphone vn.io.vif.saiatlas`: the app shows its permission error, no crash.
macOS quick entry over a full-screen app: NEEDS-HUMAN
  steps: put another app (Safari) in full screen, press the quick-entry chord (Control+Shift+Space by default); the bar appears over the full-screen app on that Space without switching Spaces; type a prompt and press Return; the chat window receives the prompt and comes forward.
macOS quick entry hidden from Mission Control: NEEDS-HUMAN
  steps: open the bar, press F3 (Mission Control) and then ⌘` with the app active: the bar is not shown as a window in Mission Control and ⌘` never cycles to it; switch to another desktop with Control+→ while the bar is open: it follows to that Space.
macOS cmd-W in the bar leaves the main window open: NEEDS-HUMAN
  steps: with a chat window open, open the bar and press ⇧⌘W, ⌘N and ⌘,: the chat window stays open, no new session or window opens and Settings does not open; ⌘A, ⌘C, ⌘V and ⌘Z still edit the bar's text; with the bar open click the tray icon and pick New session: the chat window receives it.
macOS global chord: NEEDS-HUMAN
  steps: with another app frontmost, press the quick-entry chord: the bar opens and has keyboard focus; press Escape: it hides and the other app keeps focus.
macOS tray click and menu: NEEDS-HUMAN
  steps: the menu-bar icon shows the Sai ATLAS mark; click it: the tray menu opens; New session, Show / Hide, switching project, language toggle and Quit each act on the chat window.
macOS notification: NEEDS-HUMAN
  steps: start a long turn, switch to another app; when the turn ends a macOS notification from Sai ATLAS appears (allow notifications on first prompt); clicking it brings the chat window forward.
macOS omp link cold and warm: NEEDS-HUMAN
  steps: with the app quit, run `open "omp://..."` (a session or prompt link from the README): the app launches and handles it; with the app running, run it again: the running instance handles it and no second process starts (`pgrep -fl "<app>/Contents/MacOS/sai-atlas"` lists one).
macOS open a folder with open -a: NEEDS-HUMAN
  steps: `open -a "<app>" ~/some-project` with the app quit, then again while it runs: a chat window opens in that folder each time.
macOS settings toggle persists across relaunch: NEEDS-HUMAN
  steps: open Settings, flip one toggle (for example the theme or fast mode), quit with ⌘Q, relaunch with the same profile: the toggle keeps its new value.
macOS quit guard: NEEDS-HUMAN
  steps: start a turn that runs a while, press ⌘Q: the working-sessions dialog appears; Keep working leaves the app running; ⌘Q again and Quit anyway exits, and `pgrep -fl "omp --mode rpc-ui"` prints nothing from this run. Repeat once after opening and dismissing the quick-entry bar, quitting with ⌘Q and once with the tray's Quit: each exits without a new `~/Library/Logs/DiagnosticReports/sai-atlas-*.ips`.
macOS window menu bring all to front: NEEDS-HUMAN
  steps: open two chat windows, click another app's window so they are behind it, choose Window > Bring All to Front: both chat windows come in front; Window > Zoom toggles the window's size.
macOS update DMG revealed in Finder: NEEDS-HUMAN
  steps: with an update feed offering a newer version, let the updater download it and choose its reveal action: Finder opens with the downloaded DMG selected.
macOS Ollama window shows memory and GPU: NEEDS-HUMAN
  steps: open the Ollama window: it shows this Mac's RAM (matching `sysctl -n hw.memsize`) and the GPU name from `system_profiler SPDisplaysDataType`.
macOS WKWebView visual pass: NEEDS-HUMAN
  steps: walk the chat, Settings, Agent hub, Providers and quick-entry views in light and dark mode: fonts, scrollbars, blur and icons render as on Linux, with no layout breakage, unstyled controls or console errors in Web Inspector.
