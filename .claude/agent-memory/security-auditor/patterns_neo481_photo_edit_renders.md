---
name: patterns-neo481-photo-edit-renders
description: NEO-481 hand photo edits — per-object paid-call caps bound spend but not concurrency; renders scheduled with runAfter bypass the capacity-pinned fast workpool; stored-mode bytes come from client-PUT R2 objects; undo paired by equal `since` toggles forever
metadata:
  type: project
---

Audit rules that came out of the NEO-481 photo editor (scan edits re-read with
Vision + Anthropic; copy edits re-render a stored photo):

- **A per-object cap is a spend bound, not a rate or concurrency bound.**
  `placeholderImages.edits` (10 per scan) ties paid calls to upload volume, but
  a user with one finished 1000-image job can reserve one render per image at
  once. Ask for a per-owner hourly cap AND a per-owner in-flight cap whenever a
  public save schedules paid or heavy work.
- **`ctx.scheduler.runAfter(0, renderAction)` bypasses the fast workpool.** That
  pool's `maxParallelism` is pinned to the FAST Cloud Run instance ceiling;
  anything that calls the same service outside it can fill the service and
  429 other users' `/process-entry` calls. Grep every new `callX` to a
  preprocess service for whether it runs inside a pool. (A shared FIFO pool has
  the opposite trap: head-of-line, see [[patterns-neo299-shared-pool-warmups]].)
- **Stored copy photos are client-PUT bytes.** Hand uploads go to R2 via signed
  PUT; Convex checks byte size only, never pixels. A server route that takes a
  "stored 1600 px photo" must apply its own pixel ceiling sized to that
  contract, not the 65 MP scan ceiling.
- **Undo paired by an equal timestamp is a toggle.** `undoEditedPhoto` finds the
  replaced row by `since === edited.since` and stamps both rows with one new
  `since`, so undoing the restored row flips back, with no cap, and each flip
  queues a listing refresh. Prefer an explicit `replacesPhotoId` link cleared
  on undo.
- What held: every key built from server rows (counter-allocated version with a
  positive-int segment check, server-minted tokens, `expectToken` checked
  against the live row before the R2 read); client-visible errors are fixed
  copy (`failureWords`), raw service detail only reaches Convex logs; edit rows
  refused by `pendingUpload`/`commitUpload` so a client cannot finish one.

Related: [[patterns-neo170-workpool-pipeline]], [[patterns-neo149-zip-ingest]],
[[patterns-wikidata-pool-abuse-surface]].
