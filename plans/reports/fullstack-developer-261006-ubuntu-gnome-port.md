# Ubuntu GNOME port of the computer-help tools

Status: DONE_WITH_CONCERNS. Commit `17e2be7` on `rebrand/ubuntu-gnome` (worktree `/home/tung491/WORK/worktrees/rebrand-gnome`, cut from tag `rebrand-wave-c` = `6e5ce4b`). Not merged, tagged or pushed. All gates exit 0.

The concern: the first `--auto` run of the check script changed one of the user's settings for about 4 seconds. The bug came from the old script, and the setting has been restored. The "Incident" section below has the details.

## Files

- `assistant-pack/src/tools/os-commands.ts`: the GNOME argv, the `keep` line filter on `Check`, and `fixesFor()` (picks the installed system monitor).
- `assistant-pack/test/os-commands.test.ts`: GNOME argv tables for every setting, panel and diagnose area, plus new cases.
- `assistant-pack/skills/sai-os-helpdesk/SKILL.md`: GNOME Settings paths.
- `plans/261005-0812-everyday-work-rebrand/tools/sai-os-check.sh`: rewritten. It lives in the main checkout's untracked `plans/`, so it is not part of the commit.
- `assistant-pack/system-prompt.md`: no change needed. It had no Cinnamon or Mint wording.

## Old → new argv

| Tool / value | Cinnamon (old) | Ubuntu GNOME (new) |
|---|---|---|
| `os_setting dark_mode` true/false | `gsettings set org.x.apps.portal color-scheme prefer-dark\|default` | `gsettings set org.gnome.desktop.interface color-scheme prefer-dark\|default` |
| `os_setting night_light` | `gsettings set org.cinnamon.settings-daemon.plugins.color night-light-enabled true\|false` | `gsettings set org.gnome.settings-daemon.plugins.color night-light-enabled true\|false` |
| `os_setting do_not_disturb` true/false | `gsettings set org.cinnamon.desktop.notifications display-notifications false\|true` | `gsettings set org.gnome.desktop.notifications show-banners false\|true` |
| `os_setting volume` n | `pactl set-sink-volume @DEFAULT_SINK@ n%` | `wpctl set-volume @DEFAULT_AUDIO_SINK@ n%` (`wpctl set-volume --help` lists the form `VOL[%][-/+]`) |
| `os_setting text_size` x | `gsettings set org.cinnamon.desktop.interface text-scaling-factor x` | `gsettings set org.gnome.desktop.interface text-scaling-factor x` |
| `open_item settings` | `cinnamon-settings <panel>`: network, bluetooth, display, sound, printers, power, keyboard, notifications, themes | `gnome-control-center <panel>`: network, **wifi**, bluetooth, display, sound, printers, power, keyboard, notifications, **background** (Appearance) |
| diagnose sound | `pactl get-default-sink`; `pactl get-sink-volume @DEFAULT_SINK@`; `pactl get-sink-mute @DEFAULT_SINK@` | `wpctl inspect @DEFAULT_AUDIO_SINK@`, keeping only the `node.description` line; `wpctl get-volume @DEFAULT_AUDIO_SINK@` (label "Volume and mute", which shows `[MUTED]` when muted) |
| diagnose display | `xrandr --listmonitors` ("Screens"); `gsettings get org.x.apps.portal color-scheme`; `org.cinnamon...` night light and text size | `xrandr --listmonitors` labelled "Screens (XWayland view, may not list every screen or its real size)"; `gsettings get org.gnome.desktop.interface color-scheme`; `org.gnome.settings-daemon.plugins.color night-light-enabled`; `org.gnome.desktop.interface text-scaling-factor` |
| performance fix hint | `open_item app gnome-system-monitor` | `open_item app net.nokyan.Resources` when its system `.desktop` exists, else `gnome-system-monitor`, else no app (the model is told to name the busiest programs) |
| updates fix hint | `open_item app mintupdate` | `open_item app update-manager` |
| network / display hints | `settings network` / `settings display` | `settings wifi or network` / `settings display or background` |
| unchanged | — | nmcli, lpstat, df, uptime, free, ps, rfkill, bluetoothctl, upower, im-config, pgrep, apt; `gio launch /usr/share/applications/<id>.desktop` with its realpath checks |

Approval sentences for the new panels are "Open Wi-Fi settings" / "Mở cài đặt Wi-Fi" and "Open appearance settings" / "Mở cài đặt giao diện".

## Red → green

Red: I updated the tests first, against the unchanged Cinnamon implementation. `bunx vitest run assistant-pack/test/os-commands.test.ts` reported 20 failed and 37 passed (57). The failing cases:

```
   × buildOpenItemArgv > opens only the listed GNOME Settings panels 1ms
   × buildOsSettingArgv > maps dark_mode = false to one fixed GNOME argv 1ms
   × buildOsSettingArgv > maps dark_mode = true to one fixed GNOME argv 7ms
   × buildOsSettingArgv > maps do_not_disturb = false to one fixed GNOME argv 0ms
   × buildOsSettingArgv > maps do_not_disturb = true to one fixed GNOME argv 0ms
   × buildOsSettingArgv > maps night_light = false to one fixed GNOME argv 1ms
   × buildOsSettingArgv > maps night_light = true to one fixed GNOME argv 0ms
   × buildOsSettingArgv > maps text_size = 1.25 to one fixed GNOME argv 0ms
   × buildOsSettingArgv > maps volume = 0 to one fixed GNOME argv 0ms
   × buildOsSettingArgv > maps volume = 40 to one fixed GNOME argv 0ms
   × buildOsSettingArgv > maps volume = 99.6 to one fixed GNOME argv 0ms
   × diagnose > labels the screen list as the XWayland view so it is not over-trusted 0ms
   × diagnose > offers the system monitor that is installed, preferring Resources 1ms
   × diagnose > offers the Ubuntu updater for updates 1ms
   × diagnose > reads the sound device name and the mute state through wpctl 4ms
   × diagnose > runs the GNOME checks for display 1ms
   × diagnose > runs the GNOME checks for sound 0ms
   × os_setting and open_item > ask for approval with a plain sentence in the session language 1ms
   × os_setting and open_item > change a setting through its argv and report it 1ms
   × os_setting and open_item > open a document and a settings panel without waiting for them to close 1ms
```

The new test "says plainly that an app is missing" passed while the suite was red. It was already correct, because `isInsideDir` returns false for a missing entry. It stays as a guard.

Green: after the change, the same file ran 57 of 57. The full suite ran 2043 passed and 5 skipped.

## Live verification (this laptop: Ubuntu 26.04.1, GNOME Shell 50.1, Wayland)

A Bun script imported `buildOsSettingArgv`, `diagnoseChecks`, `SETTINGS_PANELS` and `createOsTools` from the worktree. It ran every `os_setting` argv with the value the setting already had and every diagnose and status argv as-is, and it matched each panel against `gnome-control-center --list`. No Settings window was opened.

```
== before {"scheme":"'prefer-dark'","night":"false","banners":"true","text":"1.0","volume":"Volume: 0.34"}
== os_setting, written back with the current value
exit 0  gsettings set org.gnome.desktop.interface color-scheme prefer-dark
exit 0  gsettings set org.gnome.settings-daemon.plugins.color night-light-enabled false
exit 0  gsettings set org.gnome.desktop.notifications show-banners true
exit 0  gsettings set org.gnome.desktop.interface text-scaling-factor 1
exit 0  wpctl set-volume @DEFAULT_AUDIO_SINK@ 34%
== after  {"scheme":"'prefer-dark'","night":"false","banners":"true","text":"1.0","volume":"Volume: 0.34"}
unchanged: true
== settings panels against gnome-control-center --list
listed  network
listed  wifi
listed  bluetooth
listed  display
listed  sound
listed  printers
listed  power
listed  keyboard
listed  notifications
listed  background
== diagnose and status argv (read-only)
exit 0  [network] nmcli -t -f STATE,CONNECTIVITY general
exit 0  [network] nmcli -t -f WIFI radio
exit 0  [network] nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device
exit 0  [sound] wpctl inspect @DEFAULT_AUDIO_SINK@
exit 0  [sound] wpctl get-volume @DEFAULT_AUDIO_SINK@
exit 0  [printer] lpstat -p -d
exit 0  [printer] lpstat -o
exit 0  [storage] df -h --output=target,size,avail,pcent /home
exit 0  [storage] df -h --output=target,size,avail,pcent /
exit 0  [performance] uptime
exit 0  [performance] free -h
exit 0  [performance] ps -eo comm,%cpu,%mem --sort=-%cpu
exit 0  [bluetooth] rfkill list bluetooth
exit 0  [bluetooth] bluetoothctl show
exit 0  [display] xrandr --listmonitors
exit 0  [display] gsettings get org.gnome.desktop.interface color-scheme
exit 0  [display] gsettings get org.gnome.settings-daemon.plugins.color night-light-enabled
exit 0  [display] gsettings get org.gnome.desktop.interface text-scaling-factor
exit 0  [typing] im-config -m
exit 0  [typing] pgrep -l -x ibus-daemon
exit 1  [typing] pgrep -l -x fcitx5
exit 0  [updates] apt list --upgradable
exit 0  [status] df -h --output=target,avail,pcent /home
exit 0  [status] free -h
exit 0  [status] nmcli -t -f STATE general
exit 0  [status] lpstat -p -d
exit 0  [status] upower -e
== diagnose tool output for sound, display and performance
-- sound
Default output: * node.description = "BTD 700 Digital Stereo (IEC958)"
Volume and mute: Volume: 0.34
Fixes you may offer, one at a time and each approved by the person: os_setting volume; open_item settings sound.
-- display
Screens (XWayland view, may not list every screen or its real size): Monitors: 2
 0: +*DP-6 5760/590x3840/400+0+0  DP-6
 1: +HDMI-3 5120/600x2880/330+5760+0  HDMI-3
Colour scheme: 'prefer-dark'
Night light: false
Text size: 1.0
Fixes you may offer, one at a time and each approved by the person: os_setting dark_mode, night_light or text_size; open_item settings display or background.
-- performance
Running time and load: 19:38:48 up 1 day,  5:25,  1 user,  load average: 31.89, 31.57, 27.01
Memory: total        used        free      shared  buff/cache   available
Mem:            60Gi        17Gi        14Gi       994Mi        31Gi        43Gi
Swap:          8.0Gi       7.1Gi       920Mi
Busiest programs: COMMAND         %CPU %MEM
python          1031 14.1
python          1009 14.1
orca-ide        12.3  0.8
brave            6.6  0.2
brave            5.5  0.5
gnome-shell      5.0  0.6
agy              4.5  0.3
brave            3.9  0.9
claude.exe       3.7  0.5
orca-ide         3.6  0.5
brave            3.4  0.9
Fixes you may offer, one at a time and each approved by the person: open_item app net.nokyan.Resources.
-- updates
Waiting updates: Listing...
1password/stable 8.12.40 amd64 [upgradable from: 8.12.38]
alsa-ucm-conf/resolute-updates,resolute-updates 1.2.15.3-1ubuntu1.7 all [upgradable from: 1.2.15.3-1ubuntu1.5]
bluez-cups/resolute-updates 5.85-4ubuntu0.2 amd64 [upgradable from: 5.85-4ubuntu0.1]
bluez-obexd/resolute-updates 5.85-4ubuntu0.2 amd64 [upgradable from: 5.85-4ubuntu0.1]
bluez/resolute-updates 5.85-4ubuntu0.2 amd64 [upgradable from: 5.85-4ubuntu0.1]
bpftool/resolute-updates 7.7.0+7.0.0-38.38 amd64 [upgradable from: 7.7.0+7.0.0-34.34]
brave-browser/stable 1.96.61 amd64 [upgradable from: 1.96.60]
chromium-common/resolute 154.0.8037.92-1xtradeb1.2604.1 amd64 [upgradable from: 154.0.8037.57-1xtradeb1.2604.1]
chromium/resolute 154.0.8037.92-1xtradeb1.2604.1 amd64 [upgradable from: 154.0.8037.57-1xtradeb1.2604.1]
dmidecode/resolute-updates 3.6-2ubuntu1 amd64 [upgradable from: 3.6-2build1]
docker-compose-plugin/resolute 5.6.0-1~ubuntu.26.04~resolute amd64 [upgradable from: 5.5.1-1~ubuntu.26.04~resolute]
Fixes you may offer, one at a time and each approved by the person: open_item app update-manager.
```

`pgrep -l -x fcitx5` exits 1 here because fcitx5 is not running (IBus is). That is the expected "not found" status. The before and after snapshots match, so no setting changed.

## Incident: dark mode flipped for about 4 seconds during the first `--auto` run

The old script's Part 1 loop ran `set -- $spec`, which overwrites `$1`. The later `[ "${1:-}" = "--auto" ]` test therefore never matched, and `--auto` fell through into Part 2. Part 2 set `color-scheme` to `default`. The prompt then failed because there is no `/dev/tty` here, and `set -u` killed the script before it could restore the value. The user's display was in light mode for about 4 seconds until I set `color-scheme` back to `'prefer-dark'` by hand. I then read the other keys and the volume and confirmed they were unchanged (`false`, `1.0`, `true`, `0.34`).

The rewrite fixes this in four ways:
- It saves the mode as `MODE=${1:-}` before any `set --`.
- `ask` no longer dies when `read` fails.
- Part 2 refuses to start without a terminal and exits 1 before changing anything.
- Part 2 saves every original value and restores all of them from an `EXIT` trap, including after Ctrl-C.

I tested Part 2 against stub `gsettings`, `wpctl`, `notify-send` and `gnome-control-center` binaries in the scratchpad. A pseudo-terminal answered y, then n, and then sent Ctrl-C. The trap restored every key and the volume (the final stub state was `'prefer-dark'`, `false`, `true`, `1.0`, `0.34`). A no-terminal run without `--auto` exits 1 with "Part 2 skipped" and leaves the settings unchanged.

I also fixed one more bug. `pgrep -x gnome-control-center` can never match, because process names are cut to 15 characters. The script now uses `pgrep -f`/`pkill -f '^(/usr/bin/)?gnome-control-center( |$)'`, and it closes Settings only when the script opened it.

## `sai-os-check.sh --auto` output (exit 0; a settings snapshot taken before and after is byte-identical)

```
== System
PRETTY_NAME="Ubuntu 26.04.1 LTS" desktop=ubuntu:GNOME session=wayland GNOME Shell 50.1
== Part 1: settings keys (written back unchanged)
OK    set org.gnome.desktop.interface color-scheme (unchanged 'prefer-dark'): gsettings set org.gnome.desktop.interface color-scheme 'prefer-dark'
OK    set org.gnome.settings-daemon.plugins.color night-light-enabled (unchanged false): gsettings set org.gnome.settings-daemon.plugins.color night-light-enabled false
OK    set org.gnome.desktop.notifications show-banners (unchanged true): gsettings set org.gnome.desktop.notifications show-banners true
OK    set org.gnome.desktop.interface text-scaling-factor (unchanged 1.0): gsettings set org.gnome.desktop.interface text-scaling-factor 1.0
OK    volume (unchanged 34%): wpctl set-volume @DEFAULT_AUDIO_SINK@ 34%
INFO  muted: no
== Part 1: read-only diagnose commands
OK    Connection: nmcli -t -f STATE,CONNECTIVITY general
OK    Wi-Fi radio: nmcli -t -f WIFI radio
OK    Devices: nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device
OK    Default output: wpctl inspect @DEFAULT_AUDIO_SINK@
INFO  default output: node.description = "BTD 700 Digital Stereo (IEC958)"
OK    Volume and mute: wpctl get-volume @DEFAULT_AUDIO_SINK@
OK    Printers: lpstat -p -d
OK    Waiting print jobs: lpstat -o
OK    Home disk: df -h --output=target,size,avail,pcent /home
OK    System disk: df -h --output=target,size,avail,pcent /
OK    Running time: uptime
OK    Memory: free -h
OK    Busiest programs: ps -eo comm,%cpu,%mem --sort=-%cpu
OK    Bluetooth radio: rfkill list bluetooth
OK    Bluetooth adapter: bluetoothctl show
OK    Screens (XWayland view on Wayland): xrandr --listmonitors
OK    Input method: im-config -m
OK    IBus running: pgrep -l -x ibus-daemon (found)
OK    Fcitx running: pgrep -l -x fcitx5 (not found, exit 1)
OK    Batteries: upower -e
OK    Updates: apt list --upgradable
OK    Network status: nmcli -t -f STATE general
== Part 1: launchers, Settings pages and apps
OK    gio installed
OK    gnome-control-center installed
OK    wpctl installed
OK    gsettings installed
OK    Settings page network listed
OK    Settings page wifi listed
OK    Settings page bluetooth listed
OK    Settings page display listed
OK    Settings page sound listed
OK    Settings page printers listed
OK    Settings page power listed
OK    Settings page keyboard listed
OK    Settings page notifications listed
OK    Settings page background listed
OK    system monitor net.nokyan.Resources.desktop
OK    app update-manager.desktop
== Done (auto). Results: /home/tung491/sai-os-check.txt
```

The results file `~/sai-os-check.txt` that the script writes was removed after each run. No such file existed beforehand.

## Gates (all exit 0, run in the worktree)

| Gate | Result |
|---|---|
| `bun run build:pack` | 0, "assistant pack written to resources/assistant-pack" |
| `bun run check:types` | 0 |
| `bunx vitest run` | 0: 207 files passed, 1 skipped; 2043 tests passed, 5 skipped |
| `bunx biome check` on the touched TS files | 0 (2 files) |
| `bunx biome check assistant-pack` | 0 (22 files) |
| `bun scripts/check-assistant-pack.ts resources/omp.linux-x64 resources/assistant-pack` | 0, `PACK LOAD CHECK: PASS` |
| `bunx vitest run assistant-pack scripts/build-assistant-pack.test.ts` | 0: 12 files passed, 1 skipped; 203 tests passed, 5 skipped |
| `rg -n -i 'cinnamon\|linux mint\|lmde\|mintupdate\|org\.x\.apps\|pactl' assistant-pack` | printed nothing (exit 1 = no match) |

The built `resources/assistant-pack` has no Cinnamon, pactl or `org.x.apps` strings. `gnome-control-center` and `wpctl` appear in `tools.js`.

## Notes

- `SKILL.md` gained a "Connect to Wi-Fi" step. Your brief named "Settings → Wi-Fi" as a GNOME path, and the new `wifi` panel otherwise had no job that pointed to it. The person types the Wi-Fi password themselves. Remove the step if you consider it out of scope.
- Processes: none left behind. The live checks were all short-lived commands, and the Part 2 test used stubs.
- `plan.md` and the phase files were not edited.

## Unresolved questions

1. The night light test in Part 2 changes the screen only inside the night light schedule (the default is sunset to sunrise). In daytime the user may answer "no" even though the command worked. Should Part 2 also switch on `night-light-schedule-automatic=false` with a from/to window covering now? That means two more keys to restore.
2. `text_size` writes `String(value)`, so 1 becomes `1`. gsettings accepted it here (exit 0, read back as `1.0`).
3. `wpctl set-volume` has no upper limit beyond the tool's own 0 to 100 check. Should the argv add `--limit 1.0`? Not needed today, because values above 100 are refused before any command runs.
