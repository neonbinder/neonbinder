---
name: team-resolution-null-is-two-answers
description: resolveTeamForSetYear's teamId null means BOTH "no such team" and "several eras / only a later era"; branch on candidates.length when the next step differs (e.g. whether to split a name)
metadata:
  type: reference
---

`resolveTeamForSetYear` (convex/lib/teamRow.ts) returns `{ teamId, candidates }`.
`teamId: null` covers two different facts:

- `candidates.length === 0`: NB holds no team (name or alias) by that string;
- `candidates.length > 0`: it does, but the set year cannot pick one (two
  overlapping eras, or the only row is a later era).

Any fallback that should run only for an UNKNOWN name must test `candidates`,
not `teamId`. NEO-333 shipped a whole-name-first match that fell through to
the comma split on `!teamId`, so a known team in two undecidable eras
("Scranton, Wilkes-Barre RailRiders") was cut into two new teams for review.
The fix: any candidate means one team; keep the raw string so the review gate
asks its own era question (sync path), or leave the card unmatched with the
raw hint (background `applyBscTeamResolution`).

**How to apply:** whenever code does "if it doesn't resolve, try X instead",
ask which of the two nulls X is for. Pin both with a convex-test seeding two
same-name rows with overlapping `yearsActive`. Related:
[[team-names-contain-separators]].
