---
name: patterns_per_worker_data_isolation
description: "HARD RULE for every flow: the suite runs at parallelism=3 (3 concurrent USERS) and selectorOptions+cardChecklist are GLOBAL (not per-user). So flows must operate on a PER-WORKER CUSTOM set, never edit a shared real set concurrently. Only 2 flows touch real 2024 Topps Chrome, both tagged `isolated`."
---

# Per-worker data isolation (parallelism=3 contention) — HARD RULE

**Why:** the e2e suite runs at `MAESTRO_PARALLELISM=3`, and each worker signs in as a DIFFERENT
test user (`&worker=${WORKER_INDEX}` → `TEST_EMAIL_${worker}`). So 3 flows run as **3 concurrent
real users** against ONE shared Convex preview. But `selectorOptions` (the set catalog: sport→…→set→
variant) and `cardChecklist` are **GLOBAL** — there is NO per-user scoping field (only an optional
`createdByUserId` audit field). So if two flows edit the **same real set** (e.g. "2024 Topps Chrome")
— its `features`/`setMetadata`, or add/delete cards in its checklist — they **stomp each other** and
contend on the same docs (Convex OCC retries → slow mutations → toast/assert timeouts; Virtuoso list
races). This is THE root cause of "a different flow flakes every CI run." Owner's stance: a system
that can't handle 3 concurrent users is broken — so DON'T make 3 users fight over one global record.

## The rule for EVERY flow you write or touch
1. **Default = per-worker CUSTOM set.** Create/use a custom set under **Baseball / 2024** (modern
   baseball, so seeded teams/players stay warm — no re-loading) with a worker/attempt-unique name.
   Do all editing there: metadata edits (`setSetMetadata` works on custom sets), feature edits, card
   CRUD, propagation mechanics, panel collapse/expand/inherited behavior, parallel grouping, etc.
   Custom sets never collide because each worker has its own. (See the existing custom-set flows:
   `cards-custom-subtree-gate`, `custom-entry`, `parallel-grouping-*`, `util-drill-to-custom-set`.)
2. **Never edit a shared REAL set concurrently.** Do not add `inputText`/`Save`/`Toggle`/add-card to
   a real seeded set (Topps Chrome, etc.) unless the flow is `isolated`.
3. **Exactly TWO flows may touch the real "2024 Topps Chrome", and BOTH must be tagged `isolated`**
   (runs serial on the dedicated lane — never concurrent):
   - a **read-only** flow that asserts the **marketplace-derived** data (features the BSC/SportLots
     fetch actually produced) — reads are concurrent-safe but keep it here for clarity;
   - an **add-one-feature** flow that writes a single feature to the real set and verifies it.
   The reason these stay on the real set: marketplace-derived features can only exist on a real set,
   not a user-created custom one.
4. **Reads of a shared set are concurrent-safe; WRITES are not** → any shared-set write goes on the
   `isolated` lane.

## Quick test
Before adding any `inputText`/`tapOn Save`/add-card step, ask: "does this write to a shared real set
that another worker could be editing?" If yes → move it to a per-worker custom set, or make the flow
`isolated`. See [[feedback_no_secrets_via_env.md]] for the other hard authoring rule.

## Custom-set drill specifics (discovered during the Phase 1-3 migration)
- Create a per-worker custom set by inlining the drill: Baseball → 2024 → Topps → tap "Add custom Sets",
  type a worker-unique name (`<prefix>-${WORKER_INDEX || 0}`), Enter; then tap the row (use the
  `.*Search sets.*` input + index:1 when the list is long). addCustomSelectorOption is idempotent.
- For CARD tests, add a custom variant type under the custom set, then add custom cards in ITS checklist.
- `util-drill-to-custom-set.yaml` hardcodes **Football/2026** — do NOT use it for flows needing seeded
  Baseball data. TeamPicker / team-search is **sport-scoped**: the cascade seeds Yankees/Mets for
  BASEBALL only, so TeamPicker flows MUST drill Baseball/2024 (inline), or "Yankees" returns "No matches."
- Tag the flow `requires:setup-done` (cascade level 1 — Baseball/2024/Topps synced) not
  `requires:cards-loaded` (which needs the real Topps Chrome checklist you're moving away from).
