---
name: runtime-names-need-regex-escaping
description: A name read at run time with copyTextFrom (a marketplace label, a server-composed set name) goes back into `text:` as a FULL-match REGEX — escape its metacharacters once in an evalScript, without `$` or braces (they collide with Maestro's `${}` interpolation)
metadata:
  type: reference
---

`copyTextFrom` → `${output.X = maestro.copiedText.trim()}` → `text: ${output.X}`
silently breaks the moment the copied string carries `(`, `)`, `+`, `?`, `.`,
`|`, `[`, `]`, `^` or `*`: `text:` (and `id:`) are FULL-match regexes on the
pinned CLI, so "Topps Stars (Bronze)" becomes a pattern with a capture group
and matches nothing. Marketplace labels carry all of these.

The idiom (YAML single-quoted, so backslashes are literal; `\\` in the file
is one backslash in JS):

```yaml
- copyTextFrom:
    id: 'Name for ".*"'
- evalScript: '${output.CREATED = maestro.copiedText.trim()}'
- evalScript: '${output.CREATED_RE = output.CREATED.replace(/[\^\[\]()*+?.|]/g, function (c) { return "\\" + c; })}'
- inputText: ${output.CREATED}          # the raw text goes into inputs
- tapOn:
    text: ${output.CREATED_RE}          # the escaped one into matchers
    below:
      id: "Search sets"
```

- Leave `$`, `{` and `}` OUT of the character class: they collide with the
  `${…}` interpolation Maestro runs over the whole string before the JS
  engine sees it (braces inside a function BODY are fine — util-paused
  platforms proves that — but a `{` inside a regex class is a different
  parse). Neither appears in a set name in practice.
- Verify with the offline parse harness ([[offline-flow-parse-harness]]);
  the parse succeeds and the command prints as an `EvalScriptCommand`.
- `copyTextFrom` takes the FIRST match in hierarchy order, so a wildcard
  `id:` reads the first row of a list — pair it with the same row's button
  (`Create set from ".*"`) and the two agree by construction.
