---
name: neo102-reconcile-no-team
description: NEO-102 consult findings — repo facts on team field handling (schema, adapters, wizard) for the missing-team reconciliation feature
metadata:
  type: project
---

NEO-102 "Reconcile No Team" planning consult (2026-09-02). Key repo facts gathered
so future consults/dev don't re-derive them:

- `cardChecklist.teamOnCardIds` is `v.optional(v.array(v.id("teams")))` — already
  an array, already supports multi-team cards. `apps/web/convex/schema.ts:369`.
- `cardChecklist.team` (free-text string) is DEPRECATED, kept only for a
  backfill migration to read legacy rows; no code path writes it anymore.
  `apps/web/convex/schema.ts:357-369`.
- `teamCheckDoneAt` (schema.ts:376) marks "BSC per-card team lookup ran,
  regardless of outcome" — distinct from empty `teamOnCardIds`, which can mean
  either "no team" or "not yet checked". This is the field the new
  reconciliation step must NOT treat as a terminal "done" for teamless cards —
  today it silently suppresses re-prompting.
- BSC's bulk-upload endpoint (`/search/bulk-upload/results`) never carries
  team data by design — confirmed in `apps/web/docs/marketplace-listings.md`
  and in adapter comments at `convex/adapters/buysportscards.ts` ~line 350.
  Per-card BSC detail lookup (`fetchBscCardTeamNames`,
  `convex/adapters/buysportscards.ts`) sometimes fills it; SportLots checklist
  scraping deliberately does NOT attempt team extraction — see
  `convex/adapters/sportlots.ts:797-799` ("Team extraction is intentionally
  NOT attempted here").
- `EntityReviewWizard.tsx` (`components/SetSelector/EntityReviewWizard.tsx`)
  is the "Confirm New Players & Teams" step — but it only reconciles NEW
  player/team ENTITIES (not yet in the players/teams tables) and per-player
  career-team history. It has no notion today of "this card row has no team
  linked" — that's the gap NEO-102 fills.
- `CareerTeamEntry.tsx` is the existing UX precedent to reuse for the new
  step: free-text combobox that typeaheads against `api.teams.list` for the
  sport, but unlike `EntityLinkSearch` it accepts a non-matching name as a
  deliberate create (get-or-create at commit via `resolveTeamIdByName`).
  Exactly the pattern a multi-select team picker for League Leaders cards
  should copy.
- No eBay listing-creation adapter exists in the repo yet (`convex/adapters/ebay.ts`
  only implements search/comps, not Sell Inventory API item creation) — so
  eBay item-specifics team-field behavior in NEO-102 answers is hobby
  knowledge, not repo-verified. Flag this if eBay listing work starts.
- `services/browser/src/adapters/sportlots-adapter.ts` (Puppeteer listing
  automation) has zero "team" references — confirms SportLots listing
  creation flow in this codebase does not currently submit a team field at
  all.
