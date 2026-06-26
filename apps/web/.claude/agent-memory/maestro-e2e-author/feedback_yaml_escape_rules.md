---
name: YAML escape sequence rules for Maestro regex patterns
description: Which characters need escaping in YAML double-quoted strings used in Maestro text: matchers
type: feedback
---

## Valid and invalid escape sequences in YAML double-quoted strings

In YAML double-quoted strings, only a small set of backslash escapes are valid:
`\\`, `\"`, `\/` (INVALID in standard YAML!), `\n`, `\r`, `\t`, `\b`, `\f`, `\a`, `\v`,
`\0`, `\xNN`, `\uNNNN`, `\UNNNNNNNN`

**Any other `\X` combination causes a parse error.**

### Common pitfall: regex character classes with parentheses and slashes

| What you want | WRONG (parse error) | CORRECT |
|---|---|---|
| Match `(N)` literally | `".*New Players \([0-9]+\).*"` | `".*New Players [(][0-9]+[)].*"` |
| Match `/N` literally | `".*\/[0-9]+.*"` | `".*/[0-9]+.*"` |

### Rule
Use POSIX bracket expressions `[(]`, `[)]`, `[/]` etc. to match literal special chars
in regex patterns inside YAML double-quoted strings. Never use `\(`, `\)`, or `\/`.

### Why this matters
Maestro text: matchers accept Java-style regexes inside double-quoted YAML strings.
The YAML parser processes escape sequences BEFORE passing the string to the regex engine.
`\(` → YAML parse error (unknown escape char `(`, code 40). The test fails at PARSE time,
not at assertion time.

Confirmed failing: `".*New Players \([0-9]+\).*"` → `found unknown escape character ((40)`
Confirmed working: `".*New Players [(][0-9]+[)].*"` → parses correctly, matches "New Players (5)"
