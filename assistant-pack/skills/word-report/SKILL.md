---
name: word-report
description: Turn notes, a draft or a request into a finished Word report (.docx) saved in Documents > Sai ATLAS
---
Use this skill when the person wants a Word document: a report, meeting minutes, a letter or a summary.

1. If the person names a file, open it with the `read` tool first. Use its text, never just its name or path.
2. Call the `office_report` tool once. Put the whole report in `markdown`, written in the person's language:
   - one line starting with `#` for the title;
   - a line starting with `##` for each section;
   - short paragraphs;
   - a line starting with `-` for each list item;
   - tables with `|` between the columns.
   Add `name` only when the person asked for a file name.
3. The tool answers with one JSON line. Tell the person the file name from it and that they can open the file from the card.

If the tool reports a problem, tell the person in plain words, fix the input once and call the tool again.
