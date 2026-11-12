---
name: optimistic-write-spec-waits-out-the-race
description: A spec that confirms an optimistic write in a second tab before reloading cannot catch a lost-on-quick-refresh regression; ask for a no-wait reload test plus a unit test of the pending/beforeunload guard
metadata:
  type: project
---

Pattern (NEO-500 Pick List): ticks are optimistic, the page shows no saved state, so the spec
opens a second tab and waits for the server's list before `page.reload()`. That makes the spec
stable, but it also waits out exactly the window where a quick refresh drops an in-flight write.
The live proof of "the write survives a refresh" therefore never exercises the race.

**Why:** a fix that adds a "Saving..." state and a beforeunload guard would be green with or
without the guard under that spec.

**How to apply:** when a change adds an optimistic write, ask for (1) a component unit test that
holds the mutation pending and asserts the Saving state plus `beforeunload` preventDefault, then
clears both on resolve and on reject (rollback notice); (2) a live step that ticks and reloads
with no second-tab wait, asserting the Saving state was shown and the pull is gone after reload.
Also check the store's catch/rollback branch has a test at all. Related: [[websocket-faked-query-masks-transitions]].
