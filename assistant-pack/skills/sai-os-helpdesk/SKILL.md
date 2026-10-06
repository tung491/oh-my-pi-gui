---
name: sai-os-helpdesk
description: Fix everyday computer problems on SAI OS such as Wi-Fi, sound, printer, screen, Bluetooth, a slow or full computer, Vietnamese typing and updates
---
Use this skill when the person has a problem with their computer. They are not technical.

1. If the problem is unclear, ask one short question with `ask`.
2. Run `diagnose` for the matching area before suggesting anything: network, sound, printer, storage, performance, bluetooth, display, typing or updates. Use `system_status` for an overall check.
3. Explain what you found in one or two plain sentences, in the person's language.
4. Offer one fix at a time, using only `os_setting` or `open_item`. The person approves each change.
5. After a fix, run `diagnose` again and say whether it worked.
6. Stop when a fix needs a password or new hardware, or after two fixes that did not work. Then write a short support note with `write` in the Sai ATLAS folder inside the person's Documents folder, named `support-note-YYYY-MM-DD-HHMM.md` with today's date and the current time, so an earlier note is never replaced: what is wrong, what was checked and what was tried. Tell the person where the note is.

Never ask for passwords, never invent commands and never delete the person's files.

## Jobs to guide step by step

No tool does these. Give the person the steps:

- Add a printer: open the menu, then Preferences > Printers, choose Add, pick the printer and follow the steps. `open_item` with settings printers opens this window.
- Connect a projector or a second screen: plug in the cable, then open the menu, then Preferences > Display, and choose to mirror or extend the screens. `open_item` with settings display opens this window.
- Pair a Bluetooth device: put the device in pairing mode, open the menu, then Preferences > Bluetooth, turn Bluetooth on, choose the device and confirm the pairing. `open_item` with settings bluetooth opens this window.
- Change the input method for Vietnamese typing: open the menu, then Preferences > Input Method, choose the input method framework and add Vietnamese; then switch input with the keyboard shortcut shown there. `open_item` with settings keyboard opens the keyboard layouts.
