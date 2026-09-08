---
name: patterns-set-metadata-admin-gate
description: Set Builder / selectorOptions write mutations are admin-gated via requireAdmin; setSetMetadata stores sourceUrl/tcdbSetId as plain strings (rendered as text, never anchors)
metadata:
  type: project
---

Set Builder metadata writes in `apps/web/convex/selectorOptions.ts` and `setReconciliation.ts` are admin-gated.

**Why:** `setMetadata` (releaseDate, totalCardCount, block, tcdbSetId, sourceUrl) is global set-level data shared across all users — only admins/operators may edit it via the Set Builder.

**How to apply when auditing these surfaces:**
- `setSetMetadata` mutation → first line `await requireAdmin(ctx)`. `requireAdmin` (`convex/auth.ts`) fails closed: throws "Not authenticated" with no identity, "Admin access required" if Clerk JWT custom claim `role !== "admin"`. Role comes from the server-verified JWT, not request body.
- `commitCardChecklist`, `storeReconciledOptions`, `getInsertTreeByVariantType` also call `requireAdmin`.
- `setMetadata.sourceUrl` / `tcdbSetId` are stored as plain optional strings (Convex type-validates only — no eval/interpolation). In `components/SetSelector/SetAttributesPanel.tsx` they render via `<input type="text">` (editable) or `<span>{value}</span>` (read-only) — React-escaped text, NEVER an `<a href>`. Grep confirmed no anchor/href/window.open rendering of sourceUrl anywhere in the web repo. If a future change auto-links sourceUrl, that's an XSS/open-redirect (`javascript:` URI) finding — require sanitization + scheme allowlist (http/https only) + rel="noopener noreferrer".

**Feature-value select guard (NEO-71–74):** `convex/features/deriveCardFeatures.ts` exports `validateFeatureValue(key, value)` — throws a plain `Error` if `key==="league"`/`"era"` and value isn't in the fixed option set (`LEAGUE_OPTIONS`/`ERA_BUCKET_OPTIONS`); no-op for every other key. Called inside `setCardFeature`, `setSelectorOptionFeature`→`materializeSelectorOptionFeature` (also hit by the internal auto-seed in `commitCardChecklist`). All three entrypoints are `requireAdmin`-gated, so it's belt-and-suspenders, not the sole boundary. Throwing (not catching) is the CORRECT failure mode in Convex — it rolls back the mutation transaction atomically, no half-write. Echoed value in the message is the caller's own input (non-sensitive); Convex prod redacts plain-`Error` messages to "Server Error" client-side anyway. Rookie is now a typed-boolean checkbox → existing `updateCard` (`isRookie: v.optional(v.boolean())`, requireAdmin) — no new write path. NOTE: `isRookie` boolean and the `attributes` "RC" token are now two independent sources of truth for the same column (the panel Save OR-merges `attributes.includes("RC") || card.isRookie === true`), intentionally breaking the old "booleans can't drift from token array" invariant; downstream consumers should treat isRookie as OR-tolerant (deriveCardObservedFeatures already does).

**Known gap (pre-existing, not a regression):** `fetchCardChecklist` ACTION has no `requireAdmin` inside its handler (jumps straight to try/catch) — any authenticated user can invoke it. It only reads checklist data via BSC/SL; no credential exposure (creds stay server-side in the browser-service proxy). Flag as informational if revisited, but it is NOT introduced by the TCDB-removal PR.
