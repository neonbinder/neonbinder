---
name: patterns-placeholder-real-intake-specs
description: NEO-529 — placeholder pipeline specs drop fixtures on the real /print/placeholders zone through support/placeholder-intake.ts; cap recovery via Recent runs, afterEach tidy on a second page, ESM path trap, shared node_modules trap
metadata:
  type: pattern
---

- Enter with `signIn("/print/placeholders")`, gate on heading "Upload your cards" (LAUNCH_GATE), then
  `startPlaceholderBatch(page, placeholderScans(set, { backFirst }))`. One `setInputFiles` call keeps the order;
  `intakeDropzone(page)` is the same drop zone label on this page. The run view ("Your cards") and the
  "Uploaded N of N images." line appear only after the LAST photo is up.
- Active-batch cap (2) recovery goes through the page: "Recent runs" region, rows holding the exact text
  `running`, open the link, Discard this batch / Discard it / "You discarded this batch.", `goBack()`. To exercise the
  branch, leave two batches open by loading `/print/placeholders` (no jobId) and dropping twice (a drop on an OPEN run joins it).
- A tidy must not run on the spec's own page: the failure screenshot and `error-context.md` are taken after `afterEach`.
  Reopen `?jobId=<from page.url()>` on `page.context().newPage()`, wait for `Discard this batch` OR the finished/stopped
  heading (`discard.or(finished)`), discard only in the first state; annotate (not throw) when the body already failed.
- Support modules are ESM under Playwright: `__dirname` is undefined; use `fileURLToPath(new URL("../../public/", import.meta.url))`.
- The 12-starts-an-hour rate limit counts every start (red proofs included). On your OWN deployment `npx convex env set
  MAX_JOB_STARTS_PER_WINDOW 60` lifts it for a heavy local session; never on shared dev.
- A worktree whose `apps/web/node_modules` is a symlink to a stale checkout can lack `@playwright/test` and carry an old
  convex CLI (`--include-values` unknown, so agent-convex.sh's env copy fails). Clone a current worktree's node_modules (`cp -cR`).
- The first fast-path batch of a cold local session can leave one photo "Processing" at the 7 s mark ("Reading your cards — 5 of 6 done"); an
  immediate rerun was green. Thin headroom, report it, never raise the wait.
