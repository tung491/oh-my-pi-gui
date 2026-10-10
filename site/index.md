# Sai ATLAS — Private, local AI for your everyday work

Canonical: https://tung491.github.io/sai-atlas/
Last updated: 2026-10-10

The private AI assistant for everyday work on SAI OS.

## Private, local AI for your everyday work.

Write a Word report, clean up a spreadsheet, turn a report into slides, or get help when the computer misbehaves. Sai ATLAS runs on your own computer, answers in English or Vietnamese, and asks before it changes anything.

- [Download for Linux (x64 .deb)](https://github.com/tung491/sai-atlas/releases/latest)
- No account, no sign-in · models run through Ollama on this computer · [All releases](https://github.com/tung491/sai-atlas/releases)

## Word: A finished report from a few lines

Describe the report you need or paste your notes. Sai ATLAS writes it as a Word document with headings, lists and tables, ready to open and edit.

- **Your words, organised.** Rough notes become a clear report with a title, sections and a summary.
- **A real .docx file.** Saved in Documents > Sai ATLAS and opened from the card in the conversation.

## Excel: A messy spreadsheet, cleaned up

Attach an Excel, LibreOffice or CSV spreadsheet. Sai ATLAS makes a tidy copy and tells you what it fixed. Your original file is never changed.

- **The usual mess, fixed.** Extra spaces, empty and repeated rows, and numbers stored as text.
- **Totals when you want them.** Ask for a totals row and it is added under each sheet.

## PowerPoint: Slides from your report

Give Sai ATLAS a report or an outline and it builds a PowerPoint deck: one idea per slide, with short points you can present.

- **From report to deck.** Turn the report it just wrote, or one of your own, into slides.
- **A real .pptx file.** Open it in PowerPoint or LibreOffice Impress and adjust it as you like.

## Computer help on SAI OS: Help when the computer misbehaves

Wi-Fi gone, no sound, the printer will not print, the screen looks wrong, Vietnamese typing stopped working? Tell Sai ATLAS what happened in your own words.

1. **It checks first.** Sai ATLAS looks at the network, sound, printers, the screen, Bluetooth, storage, typing or updates before it suggests anything.
2. **It explains plainly.** You get what it found in one or two sentences, without jargon.
3. **You approve each fix.** It offers one fix at a time and changes nothing until you say yes. When a fix needs more, it writes a short note for whoever helps you next.

## Privacy: Your work stays with you

Your files and conversations stay on this computer. Sai ATLAS goes online only to download models and updates.

1. **A model on your computer.** The AI runs through Ollama on this computer. Sai ATLAS does not use cloud models or an Ollama on another machine.
2. **No account.** There is nothing to sign up for and nothing to sign in to.
3. **Your files stay yours.** New files go to Documents > Sai ATLAS. It never edits or deletes your own files.

## Install: Up and running in a few minutes

Install Ollama from ollama.com, then grab the build for your computer. On first launch Sai ATLAS suggests a model that fits your machine and downloads it for you.

- [Linux x64 .deb](https://github.com/tung491/sai-atlas/releases/latest)
- [Linux x64 AppImage](https://github.com/tung491/sai-atlas/releases/latest)
- [All releases](https://github.com/tung491/sai-atlas/releases)

On Ubuntu 24.04 or later, install the .deb with `sudo apt install ./sai-atlas_<version>_amd64.deb`; the AppImage needs `libwebkit2gtk-4.1-0`. Building from source is described in the [README](https://github.com/tung491/sai-atlas#readme).

## About

Sai ATLAS, the private AI assistant for everyday work on SAI OS. It runs on your computer, built on the open-source omp agent.

- Code: [GUI repo](https://github.com/tung491/sai-atlas) · [Monorepo fork](https://github.com/nornzach/oh-my-pi) · [Upstream omp](https://github.com/can1357/oh-my-pi)
- © 2026 Sai ATLAS contributors · MIT
- Not affiliated with Anthropic, OpenAI, or any model provider.
