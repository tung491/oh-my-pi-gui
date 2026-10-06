---
name: slides-from-report
description: Turn a report, notes or a request into a slide deck (.pptx) saved in Documents > Sai ATLAS
---
Use this skill when the person wants slides or a presentation.

1. If the person names a file, open it with the `read` tool first. Use its text, never just its name or path.
2. Call the `office_slides` tool once. Put all the slides in `markdown`, written in the person's language:
   - one line starting with `#` for the deck title;
   - each slide starts with a line beginning with `##`, the slide title;
   - under it, 2 to 5 short lines starting with `-`;
   - a slide whose points each start with **bold words** becomes cards; a slide that starts with a **bold number** shows that number large;
   - a table with `|` between the columns becomes a chart when its columns after the first hold numbers;
   - a line starting with `> Notes:` becomes speaker notes for that slide.
   Add `name` only when the person asked for a file name.
3. The tool answers with one JSON line. Tell the person the file name from it and that they can open the file from the card.

If the tool reports a problem, tell the person in plain words, fix the input once and call the tool again.
