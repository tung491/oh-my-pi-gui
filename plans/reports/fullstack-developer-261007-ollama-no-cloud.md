# Ollama no-cloud drop-in for the Linux remedies

Status: done. Commit `aa75fef` on `rebrand/ollama-no-cloud` (worktree `/home/tung491/WORK/worktrees/rebrand-nocloud`), not merged, tagged or pushed.

## Changes

- `src/shared/ollama-types.ts`: `OLLAMA_REMEDY_COMMANDS` is now the full root script of each remedy. It is shown verbatim, and main runs exactly that text as one `pkexec sh -c` call (it used to be display-only text). The install line and the drop-in path are private constants.
- `src/main/ollama/remedy.ts`: both remedies run `pkexec sh -c OLLAMA_REMEDY_COMMANDS[id]`. `INSTALL_LINE` is no longer exported.
- `src-tauri/src/ollama/remedy.rs`: `NO_CLOUD_STEPS` and `remedy_script(id)` build the same text, and `remedy_command` wraps it in `pkexec sh -c`. I compared the two shells' install scripts byte for byte and they match. Timeouts are unchanged (2 min / 15 min).
- `src/renderer/components/onboarding/OllamaRow.tsx`: shows the new sentence (`welcome.ollama.noCloudNote`, `data-note="no-cloud"`) under the command whenever a Linux remedy is offered. This covers the welcome screen and Settings.
- Locales (`en.ts`, `vi.ts`, same keys in both): added `welcome.ollama.noCloudNote`. I also changed `welcome.ollama.remedyUnavailable` to "Run the commands above in a terminal as administrator (after “sudo -s”)", because the shown script now writes to /etc and fails for a normal user.
- `README.md`, `README.vi.md` ("Ollama and your first task" only): added a bullet on `OLLAMA_NO_CLOUD=1` with the manual `sudo systemctl edit ollama.service` steps. The Start Ollama note now says it restarts `ollama.service`.
- No macOS change.

## Privileged command

Before:
- Start: `pkexec systemctl start ollama.service`
- Install: `pkexec sh -c 'curl -fsSL https://ollama.com/install.sh | sh'`

After, start (`pkexec sh -c <script>`, and the screen shows this same script):
```
mkdir -p /etc/systemd/system/ollama.service.d &&
f=/etc/systemd/system/ollama.service.d/sai-atlas.conf &&
s=$(printf '[Service]\nEnvironment="OLLAMA_NO_CLOUD=1"') &&
{ [ "$(cat "$f" 2>/dev/null)" = "$s" ] || printf '%s\n' "$s" > "$f"; } &&
systemctl daemon-reload &&
systemctl restart ollama.service
```
After, install: `curl -fsSL https://ollama.com/install.sh | sh &&` followed by the same lines.

The script is a fixed string with nothing from the user in it, behind one polkit prompt. It writes only `sai-atlas.conf`, and only when that file is missing or its content differs. Each step runs only if the one before succeeded. It uses `restart`, so the setting also reaches a service that install.sh has just started.

## Tests (mirrored by name in both shells)

- One `pkexec sh -c` call, for start and for install.
- Runs exactly the command the screen shows (both ids).
- Spells out the privileged scripts word for word (the same literal in the TS and Rust tests).
- Sandboxed runs. The script runs with the drop-in directory rewritten to a scratch directory, and PATH holds only fake `systemctl`/`curl` plus `sh`, `cat` and `mkdir`. The tests assert the script no longer contains `/etc/`. They check:
  - The drop-in content is exact, and the order is daemon-reload, then restart.
  - Other drop-ins, and an identical `sai-atlas.conf`, keep their content and mtime.
  - A `sai-atlas.conf` with different content is rewritten.
  - When the installer fails, there is no drop-in and no systemctl call.
- Renderer: OllamaRow and FirstRunOnboardingDialog tests check that the shown command is the run script, that it includes the drop-in, and that the note shows on Linux and not on macOS.

## Gates (worktree)

All exit 0: bun install, build:pack, check:types, vitest (208 files passed, 1 skipped), build, biome on touched files, build:renderer:tauri, clippy `-D warnings`, cargo test (769 passed), the parity loop (ollama: 101 tests mirrored), snapshots PASS.

- The first full cargo test run failed one test, `appimage_handover::the_waiter_starts_the_new_image_after_the_old_app_and_its_helper_are_gone` ("did not wait for the helper: 518ms"). It is a timing test in code this change does not touch. Two reruns passed.
- vitest needs the sidecar, so `resources/omp` and `resources/omp.linux-x64` are symlinks to the main checkout's binary. They are gitignored and still in place.

Nothing real was run: no pkexec, /etc, systemd or Ollama service was touched, and no app was launched.

## Unresolved questions

1. Changing the `remedyUnavailable` text was outside the literal brief. I did it because the old "run the command above" advice would now fail without root. Keep or revert?
2. On a system without systemd, the install remedy now fails at `daemon-reload` with systemd's own error. Before, it failed with "still not answering". The outcome is the same (`failed`) and only the message differs.
3. If the drop-in exists with the same text but no trailing newline, the script treats it as up to date and leaves it alone (shell command substitution drops trailing newlines).
