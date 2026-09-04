---
name: e2e-pick-selector-modes
description: run-e2e-smoke.sh treats a BARE selector as a TAG, not a flow name — a flow file name needs the name: prefix or it silently matches nothing
metadata:
  type: reference
---

`npm run test:e2e:pick -- <selector>` parses the selector by PREFIX
(`run-e2e-smoke.sh`, the `case "$SELECTOR"` block):

| form | mode |
|---|---|
| `name:a,b` | file-path substrings (OR) — **this is what you want for a flow file** |
| `tag:x` / bare `x` | tag match (**the default — a bare flow name matches nothing**) |
| `grep:re` or `/re/` | regex over flow paths |
| `setup` | the setup track only |
| empty | every non-util, non-wip, non-setup flow |

A bare flow name fails with `No flows matched selector "<x>" in .maestro/flows/`
— it was read as a tag. Costs a whole conch acquire/release cycle to discover,
so always write `name:`:

```bash
npm run test:e2e:pick -- "name:checklist-fetch-wizard-skip-not-a-person"
```

`name:` mode still resolves the full prerequisite closure (Phase-0
`worker-bootstrap` runs first), and it excludes `util`-tagged flows from the
match, so `name:util-drill-to-custom` selects nothing — drive a util through the
parent flow that calls it.

Related: [[speaking-conch-run-serialization]],
[[local-vite-serves-one-worktree]].
