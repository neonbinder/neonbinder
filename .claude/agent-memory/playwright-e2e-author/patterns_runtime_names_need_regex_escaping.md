---
name: runtime-names-need-regex-escaping
description: A name read at run time (a marketplace label, a server-composed set name) must not go into a regex locator raw — pass a string with exact:true, or escape metacharacters once
metadata:
  type: reference
---

A run-time name that carries `(`, `)`, `+`, `?`, `.`, `|`, `[`, `]`, `^` or `*`
(marketplace labels carry all of these, e.g. "Topps Stars (Bronze)") silently
breaks the moment it is interpolated into a REGEX locator: `new RegExp(name)` makes
a capture group and matches nothing.

In Playwright prefer the form that needs no escaping:
- `getByText(name, { exact: true })` / `getByRole("option", { name, exact: true })`
  take the string literally;
- to combine with other text, build the regex from an escaped string:
  `new RegExp(\`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\`)`;
- a substring match (the default for a string) is already literal, but remember
  the substring trap: a name that prefixes another also matches it (GUIDE
  "Locators: names, substrings and scope").

A name read with `textContent()` goes into inputs raw (`fill(name)`) and into
locators as a string, never as an unescaped pattern. When reading from a list,
pair the read with the same row's own button so the two agree by construction.
