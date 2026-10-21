---
name: parallel-builders-share-the-scratchpad
description: Parallel builder agents in one session share ONE scratchpad dir and often the same spare Vite port — keep scripts/output in a per-agent subdir and start your own Vite on an unusual port
metadata:
  type: reference
---

When the coordinator fans out several builders (NEO-350: five prototypes at
once), every agent gets the SAME session scratchpad path. A generic name such
as `scratchpad/shoot.mjs` or `d0.png` is overwritten by a sibling within
minutes, and running "your" script then runs theirs: NEO-350 p4 ran p3's
screenshot script, which wrote a stray `mob/` folder into the worktree root.

**How to apply:**
- Put everything in `scratchpad/<your-area>/` (e.g. `scratchpad/p4/`) and
  `cat` a script's first lines before re-running it if you left it a while.
- A spare Vite port can already be bound by a sibling's server on the same
  worktree (`--strictPort` fails; lsof shows it). It serves your files too,
  but it can vanish mid-run; start your own on an unusual port instead.
- After a visual pass, `git status --short` the worktree root for folders
  you did not mean to create, and remove only the ones you made.

Related: [[static-markup-visual-check]], [[gates-in-a-shared-worktree]].
