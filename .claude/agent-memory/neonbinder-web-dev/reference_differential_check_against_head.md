---
name: differential-check-against-head
description: Prove a perf/bounds rewrite of a pure apps/web helper changes no answer by running HEAD's copy and the new one side by side on random inputs under tsx
metadata:
  type: reference
---

When an audit asks for a bound or speed-up that must keep "behaviour identical for all existing tests", existing tests are rarely enough. A differential run is cheap:

1. `git show HEAD:apps/web/<path>.ts` into the scratchpad, rewriting relative imports to absolute worktree paths (`sed 's#from "\./#from "<abs>/convex/#; s#from "\.\./#from "<abs>/#'`). Never put the copy in the shared worktree.
2. Symlink the worktree's `node_modules` into that scratch dir so bare imports resolve, write the driver as `.mts` (top-level await is refused in `.ts` under tsx's CJS output), and read each module as `m.fn ?? m.default.fn`: tsx's interop puts a `.ts` module's exports on `.default`.
3. Seeded random inputs (a few thousand cases, several thresholds), `JSON.stringify` both answers, count diffs; then time a worst case on both for the report.

Worked for `pairNamesBySimilarity` and `matchChecklistSections` (0 diffs over 9,000 and 3,000 cases).

**Real checklist files instead of random inputs (NEO-496).** For a `lib/checklists` parser/reader change, copy the whole old `lib/checklists/*.ts` set (only `"../../convex/` needs the absolute rewrite), point one `.mts` driver at either copy through an env var, and run `readChecklistFile` → `readChecklistSections` on the real .xlsx/.pdf with `readPdf: (b) => readPdfLines(b, { pdfjs })` (legacy pdfjs build, see [[pdfjs-6-driver-quirks]]). Dump one JSON line per row (`[section, group, row]`) plus the skipped list and `diff` old vs new: a reason-string change shows as exactly those lines, any row drift shows at once. The real files are untrusted data: pass them as path args, never copy them into the tree. Pair it with a timing assertion in the unit test that the OLD code would fail (check by timing HEAD's copy), or the bound has no regression guard. Related: [[gates-in-a-shared-worktree]].
