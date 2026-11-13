---
name: zsh-file-list-runs-nothing
description: The Bash tool's shell is zsh, so an unquoted $LIST of test files is ONE argument; vitest matches nothing for it and the run still reports green on whatever else was named
metadata:
  type: reference
---

zsh does not word-split an unquoted parameter. `L=$(tr ' ' '\n' < list.txt)`
then `npx vitest run $L other.test.ts` passes the whole list as a single
filter string; vitest matches no file for it, says nothing, and runs only
`other.test.ts`. The summary is green with a file count far below what was
meant (seen: 32 files instead of 89).

**How to apply:** pipe the list through `xargs npx vitest run …` (or use
`${=L}` in zsh), and always compare the "Test Files N passed" count with the
number of files you meant to run before calling a gate green. Related gate
that lies: [[test-unit-ignores-file-args]].
