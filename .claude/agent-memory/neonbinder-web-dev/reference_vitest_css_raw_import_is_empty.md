---
name: vitest-css-raw-import-is-empty
description: In apps/web's vitest, importing a .css file (even with ?raw) yields an empty string; read stylesheets with readFileSync(join(__dirname, ...)), not import.meta.url
metadata:
  type: reference
---

`import css from "@/app/theme.css?raw"` compiles and returns `""` under vitest
(CSS is stubbed whatever the query), so a test that parses a stylesheet passes
or fails on nothing. `?raw` on non-CSS files (`index.html?raw`,
`src/main.tsx?raw`) does return the text.

Read stylesheets from disk: `readFileSync(join(__dirname, "../../app/theme.css"), "utf8")`
(the pattern `SetSelector.focus.test.tsx` uses for main.tsx). In the
happy-dom `components` project `new URL(rel, import.meta.url)` is not a file
URL, so `readFileSync(new URL(...))` throws "The URL must be of scheme file".

**How to apply:** any unit test that checks CSS (a token mirror, a selector
that must exist): fs + `__dirname`, and assert the file is non-empty first.
