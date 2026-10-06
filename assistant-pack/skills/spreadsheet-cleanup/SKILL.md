---
name: spreadsheet-cleanup
description: Clean up a messy spreadsheet (.xlsx, .xls, .ods or .csv) into a tidy copy saved in Documents > Sai ATLAS
---
Use this skill when the person wants a spreadsheet tidied: extra spaces, empty or repeated rows, numbers stored as text, or a totals row.
Accepted files: .xlsx, .xls, .ods and .csv. The person's own file is never changed; a cleaned copy is made.

1. Call the `office_clean` tool once. Set `file` to the file path on the `User:` line at the end of the message, copied exactly.
   If there is no such line, set `file` to the path the person named, copied exactly.
   Optional settings:
   - `sheet` to clean only the sheet with that name;
   - `totals` set to true to add a totals row;
   - `decimal` set to comma when the decimal mark in the numbers is a comma, or dot when it is a dot. Leave it out when unsure.
2. The tool answers with one JSON line. Tell the person the file name from it, what was cleaned, and that they can open the file from the card.

If the tool reports a problem, tell the person in plain words. Never guess another path.
