---
name: patterns_per_worker_data_isolation
description: "HARD RULE for every flow: CI drains a dynamic work queue across 8 runners (parallelism=1 EACH) and selectorOptions+cardChecklist are GLOBAL (not per-user). So flows must operate on a PER-WORKER CUSTOM set and never write to a shared real set. The `isolated` serial lane is GONE — do not add that tag; .maestro/SET-REGISTRY.md is the authority on which sets a flow may touch."
---

# Per-worker data isolation (8-runner work-queue contention) — HARD RULE

**Why:** CI runs the NEO-49 dynamic work queue — a pool of ~8 runners, each its own VM at
`MAESTRO_PARALLELISM=1`, all claiming flows off ONE shared queue against ONE shared Convex
preview. Each runner signs in as a DIFFERENT
test user (`&worker=${WORKER_INDEX}` → `TEST_EMAIL_${worker}`), so up to 8 flows run as **8
concurrent real users**. But `selectorOptions` (the set catalog: sport→…→set→
variant) and `cardChecklist` are **GLOBAL** — there is NO per-user scoping field (only an optional
`createdByUserId` audit field). So if two flows edit the **same real set** (e.g. "2024 Topps Chrome")
— its `features`/`setMetadata`, or add/delete cards in its checklist — they **stomp each other** and
contend on the same docs (Convex OCC retries → slow mutations → toast/assert timeouts; Virtuoso list
races). This is THE root cause of "a different flow flakes every CI run." Owner's stance: a system
that can't handle concurrent users is broken — so DON'T make 8 users fight over one global record.

**`${ATTEMPT_ID}` does NOT make a shared-set write safe** — it protects against a PRIOR
attempt's debris, never against a CONCURRENT runner.

## The rule for EVERY flow you write or touch
1. **Default = per-worker CUSTOM set.** Create/use a custom set under **Baseball / 2024** (modern
   baseball, so seeded teams/players stay warm — no re-loading) with a worker/attempt-unique name.
   Do all editing there: metadata edits (`setSetMetadata` works on custom sets), feature edits, card
   CRUD, propagation mechanics, panel collapse/expand/inherited behavior, parallel grouping, etc.
   Custom sets never collide because each worker has its own. (See the existing custom-set flows:
   `cards-custom-subtree-gate`, `custom-entry`, `parallel-grouping-*`, `util-drill-to-custom-set`.)
2. **Never write to a shared REAL set. At all.** No `inputText`/`Save`/`Toggle`/add-card/delete on a
   real seeded set (Topps Chrome, 1996 Score). Only `setup.yaml` provisions them; every other flow
   reads. `.maestro/SET-REGISTRY.md` is the authority and lists the read-only visitors.
3. **CORRECTED 2026-09-02 — the `isolated` serial lane no longer exists.** The NEO-49 work queue
   removed lanes entirely, so there is nothing to serialize a shared-set writer onto; the `isolated`
   tag is dead and must not be added. If a flow seems to need a shared-set write, that is a finding
   to raise, not a licence to proceed.
4. **Reads of a shared set are concurrent-safe; WRITES are not** → a write goes on a per-worker
   custom subtree, full stop.

## Quick test
Before adding any `inputText`/`tapOn Save`/add-card step, ask: "does this write to a shared real set
that another worker could be editing?" If yes → move it to a per-worker custom set. See [[feedback_no_secrets_via_env.md]] for the other hard authoring rule.

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

## `teams` is global too — and other flows create rows in it MID-RUN
`convex/teams.ts` is explicit that teams are globally-shared rows (dedup key =
normalized name + sportId; "Yankees are Yankees"). The non-obvious part is WHO
writes them: committing a player in the entity-review/checklist path resolves that
player's Wikidata career and get-or-creates every club in it, so a flow on another
runner can insert e.g. "Gulf Coast League Yankees" seconds into your flow.

So **any assertion of the form "filtering by X narrows to exactly 1" must filter on
a FULL unique name, never a distinctive-looking token.** CI run 33546667978
(2026-09-01) failed `admin/team-management-edit-a-team` on "Yankees" matching 2 of
105 teams for exactly this reason — nothing was broken, the needle was too short.
A full name is safe in both directions: a concurrent get-or-create of the same team
lands on the same row, and farm clubs carry their own city's name.

## NEVER assert a filtered RESULT COUNT on a shared admin list

`{n} of {N} teams` is fine — the flow filters to a name only this attempt owns
and `1 of N` holds. **`{n} matches` on `/admin/players` is not**: that counter
appears only while a search term is present, and the search runs through
Convex's search index, which is **word-wise**. A per-attempt name is a bag of
tokens (`TME`, `2`, `r2`, `a1`, `4406`), other runners' fixtures share several
of them, and the index returns them all. Measured in CI run 33982239886:
filtering by the exact string `TME-2-r2-a1-4406` reported **"3 matches"** —
ours plus `KOPlayer-r5-a1-…` and `PM-0-r0-a1-…`, matched on the shared `a1`.

An assertion on that number is an assertion about what the other seven runners
happened to create, which is precisely what this file exists to forbid. Wait on
**the row** instead — every admin master row carries `title={name}`, so
`extendedWaitUntil: { visible: { id: "<name>" } }` is the settle gate AND the
real assertion, and it is the same handle you tap next. (Teams and leagues use
`{n} of {N}`, which is a substring filter on the client, not the search index —
that one IS safe to compose with a count.)
