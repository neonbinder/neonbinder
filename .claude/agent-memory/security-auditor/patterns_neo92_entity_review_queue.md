---
name: patterns-neo92-entity-review-queue
description: NEO-92 entityReviewQueue wizard — getBatch/recordDecision/cancelBatch/recordAllRemainingAsCreate now ALL requireAdmin (resolved 2026-07-18); linked*Id kind-checked; NEO-71/74 added manualCareerTeams to create-decision
metadata:
  type: project
---

NEO-92 replaced UnknownEntitiesDialog with a step-through wizard backed by a new
`entityReviewQueue` scratch table + `convex/entityReviewQueue.ts`.

**Why:** better UX for large unknown-name lists; background Wikidata preview per name.

**RESOLVED 2026-07-18 (verified in code):** `getBatch`, `recordDecision`, `cancelBatch`,
and the new bulk `recordAllRemainingAsCreate` all now call `requireAdmin`. `recordDecision`
now validates linked ids: requires the id matching `row.kind`, fetches it, and rejects a
sport mismatch — closing the verbatim-trust gap. `recordAllRemainingAsCreate` (admin-gated,
scoped to one batch via by_selector_option_and_batch, only patches undecided rows, marks
still-"pending" rows create → bare unenriched row, consistent w/ commit's optional-enrichment
branch) is clean. Original findings below, kept for context.

**How to apply (original audit findings, now fixed):**
- New public surface `getBatch` (query, NO auth check at all), `recordDecision` +
  `cancelBatch` (mutations, only `getCurrentUserId`, NOT `requireAdmin`). Every other
  fn in selectorOptions.ts requireAdmins, and the sibling `commitCardChecklist`
  requireAdmins — so these three are a NEW least-privilege inconsistency, reachable by
  any signed-in non-admin (getBatch even by unauthenticated). Blast radius limited to
  the throwaway table; practical exploit gated by unguessable `batchId`
  (crypto.randomUUID) + opaque `reviewRowId`. Recommended fix: add `requireAdmin` to all
  three. Severity MEDIUM (defense-in-depth/consistency, no creds/PII).
- `recordDecision` stores `linkedPlayerId`/`linkedTeamId` with NO validation of
  kind/sport; `commitCardChecklist` uses them verbatim into cardChecklist.playerIds/
  teamOnCardIds. Arg validators enforce table (players vs teams) but NOT sport, and don't
  require the id be present for action:"link". Wrong-sport link or null-id silent-drop
  possible. LOW data-integrity (internal reference data).
- SPARQL injection: CLEAN. Wizard names route fetchCardChecklist→startBatch (raw name
  stored)→processEntityReviewQueue→lookupPlayer/TeamEnrichment→findPlayer/TeamQid→
  `sparqlStringLiteral` (200-char cap, escapes \\ " \n \r \t U+2028/9). Detail queries
  interpolate only Wikidata-derived `wd:${qid}` + constant HOF/sport QIDs. No new bypass.
- DoS via unbounded `startBatch` inserts: mitigated — fetchCardChecklist is NOT directly
  admin-gated but calls `getAncestorChain` FIRST, which requireAdmins, inside a try/catch,
  so a non-admin throws before startBatch. Admin-triggered batch size = marketplace
  catalog size (300+), same bound as pre-existing processEnrichmentQueue. No per-batch
  cap but consistent with existing pattern. INFORMATIONAL.
- entityReviewQueue.ts doc comment "fetchCardChecklist (an action, no admin gate)" is
  misleading — it's transitively gated via getAncestorChain. Refines the note in
  [[patterns_set_metadata_admin_gate]].

**NEO-71/74 add-on (manualCareerTeams, reviewed 2026-07-21, PR #73):** recordDecision's
create-decision now accepts optional `manualCareerTeams: Array<{name, fromYear, toYear?}>`;
commitCardChecklist merges them with Wikidata `enrichment.careerTeams` → resolveTeamIdByName
get-or-create → players.teamYears. Credential-free, requireAdmin-gated both ends. Audit:
- Year validation SOLID — `Number.isInteger` gate catches NaN/Infinity/floats that Convex
  `v.number()` (Float64) would otherwise admit; bounds [1869, currentYear+1], toYear>=fromYear.
  No coercion holes (values arrive as JS numbers, string coercion impossible via validator).
- NO array-size cap on manualCareerTeams (`v.array` unbounded). Commit does one DB query +
  possible insert per entry sequentially in a single mutation, merged across all batch rows —
  a huge array can blow Convex's per-txn doc/time limits and fail the commit. Admin-only, fails
  closed. LOW; recommend a sanity cap (~64) mirroring the "reject nonsense" year philosophy.
- `name` is bare `v.string()` — no min-length/trim/non-empty check. Empty/whitespace name →
  norm→"" → get-or-creates a junk empty-named team. Same validation level as the pre-existing
  Wikidata path (no NEW privileged reach), but that path never sends empties. LOW admin foot-gun.
- Dedupe drops manual silently: commit iterates `[...wikidata, ...manual]`, keeps FIRST per
  resolved teamId. A manual entry correcting a Wikidata team's YEARS resolves to the same
  teamId → dropped, Wikidata years kept, no admin feedback. Pure additions to distinct teams
  fine. LOW-MEDIUM data-integrity — manual "override" can't actually override years.
