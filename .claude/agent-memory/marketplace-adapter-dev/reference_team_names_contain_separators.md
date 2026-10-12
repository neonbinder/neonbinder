---
name: team-names-contain-separators
description: Real team names contain "/" and ", " (Bodø/Glimt, Negro League "Browns/Stogies", "Korea, South"); team values split on comma only, players on , / |; whole-name match first
metadata:
  type: reference
---

Splitting a marketplace team value is not symmetric with players. NB team
names and aliases legitimately contain `/` (football clubs like Bodø/Glimt,
Negro League clubs named "X/Y") and `, ` ("Korea, South", company-style
suffixes, "University, ABBR" aliases), and BSC has sent a single team with a
comma in it. Player names contain none of `,` `/` `|`.

So the shared splitter (`convex/adapters/marketplaceNames.ts`, NEO-333) has
two named rules: `splitMarketplaceTeamNames` (comma only) and
`splitMarketplacePlayerNames` (`,` `/` `|`). Even comma-only over-splits some
real teams, so team resolution is WHOLE NAME FIRST: `fetchBscCardTeamNameRaw`
returns `rawTeamName` beside `teamNames`, every path carries both, and the
resolvers (`applyBscTeamResolution`, `resolveCandidateTeams`) try the raw
string through `resolveTeamForSetYear` (name + alias) before the split. A
whole string that resolves to none goes to review as its parts; the operator
fixes that with an alias.

**How to apply:** never add `/` or `|` to a team split; before trusting any
separator on an entity name, ask for a scan of real NB names for it. Keep the
unsplit marketplace value reachable when you split. Related:
[[marketplace-bucket-words-leak-into-set-names]].
