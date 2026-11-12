---
name: edit-tool-decodes-unicode-escapes
description: Edit/Write can land `​`-style escapes as the literal characters; a literal U+2028 inside a regex literal is a parse error and invisible chars defeat review
metadata:
  type: reference
---

Writing `​`, `‮`, ` `, `﻿` etc. through the Edit tool landed
the literal (invisible) characters in the file, while `\u0000`-range escapes on
the same line stayed escaped (NEO-509 format-char filter). A literal U+2028
inside a `/[...]/` regex literal is a line terminator, so vite/oxc fails with
PARSE_ERROR; in a test table the chars are invisible and the test reads wrong.

**How to apply:** when a change needs Unicode escapes for format/bidi/zero-width
chars, write them with a Python heredoc using `\\u` (or fix afterwards), then
check with `grep -nP '[\x{200b}-\x{200f}\x{2028}-\x{202e}\x{2060}\x{2066}-\x{2069}\x{feff}]' <files>`
— it must print nothing. Related: [[pin-tests-need-a-bypass-plant]].
