---
name: vitest-console-hidden-in-passing-tests
description: In apps/web's vitest run, console.log from a PASSING test prints nothing (not even a "stdout |" block); for a throwaway probe test, appendFileSync to a scratchpad file instead
metadata:
  type: reference
---

Observed 2026-10-09 (vitest 4.1, `npx vitest run <file>`): a throwaway
`components/**/zz*.test.tsx` whose four tests all passed printed no
console output at all — grep for the logged keywords came back empty and
the full captured output held only the summary. Rather than chase the
reporter config, log with `appendFileSync("<scratchpad>/log.txt", …)`
from `node:fs` and `cat` the file after the run.

**How to apply:** when you need to SEE values from a component under
happy-dom (a live-region's text, an aria-describedby chain, focus after a
re-render) without writing a real test, copy the neighbouring test file's
harness into a temp `*.test.tsx` under a collected glob, log to a file,
run it, then delete the temp file and confirm `git status` is clean.
A test that FAILS still shows its assertion diff normally, so an
`expect` is the other option.
