---
name: write-tool-turns-unicode-escapes-into-chars
description: Writing source that contains a JS unicode escape (e.g. "￿" as a range-query sentinel) can land the literal character in the file instead of the escape; grep the written file and fix it
metadata:
  type: reference
---

NEO-358 (2026-10-23): a prefix-range query used `prefix + "￿"` as the
upper bound. After writing the file, the escape had become the literal
U+FFFF character, which is invisible in most views and easy to mangle in later
edits.

**How to apply:** after writing a file that should contain a `\u` escape,
grep for the escape text (`grep -n '\\uffff' file`). If it is missing,
rewrite the line, or build the sentinel with `String.fromCharCode(0xffff)`
so the source is plain ASCII.
