---
name: external-lookup-determinism-for-e2e
description: Jason's chosen shape for making a third-party enrichment lookup (Wikidata/ESPN) deterministic in E2E — recorded answers at the lookup-input boundary, never bulk-deciding no-match rows
metadata:
  type: project
---

For a live third-party lookup that makes the E2E seed nondeterministic, the accepted remedy (NEO-289, 2026-09-20) is a recorded-answer layer at the lookup-INPUT boundary (kind + sport id + normalised name), gated on `TESTING_RESET_SECRET` presence plus an explicit flag mirrored onto the preview by `e2e.yml`; a miss falls through to live, a recorded `null` is a real answer.

**Why:** Jason rejected "let the bulk decide no-match rows" because it leaves an enrichment data gap in the fixture; and he wants one small flow to keep exercising a genuinely live lookup so the lane stays proven. Recording at SPARQL-text level was rejected because query refactors would invalidate fixtures.

**How to apply:** Any future plan touching enrichment determinism (or a new external source in `runEntityReviewLookup`) extends that layer rather than adding a second mechanism; the capture is an armed `internalAction` run with `npx convex run` (no `--identity`), never a UI button. Note `decideAllRemaining` already takes `status: "error"` rows — a "parked no-match players" diagnosis is usually drain time, not parking.
