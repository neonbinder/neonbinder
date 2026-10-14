---
name: probe-fixture-attribute-tokens-from-bsc-public-catalogue
description: Check whether a real fixture set's cards carry BSC attribute tokens (AU, SN<n>, RC) from BSC's unauthenticated shop search before writing a spec that depends on them; productName can say "AU, SN99" while playerAttribute is empty
metadata:
  type: reference
---

A spec that needs "the sync commits cards carrying AU / SN<n>" must verify the
fixture really has the token in BSC's `playerAttribute` field, because the
sync reads that field and nothing else. The shop search answers without a
login (recipe in [[probe-bsc-public-search-for-card-ids]] in the
marketplace-adapter-dev memory): page through `q=<year set variant>`, filter on
`setName` and `variantName`, and compare `playerAttribute` with `productName`.

Trap found on NEO-345: a set's cards can print "AU, SN99" in `productName`
while `playerAttribute` is `[""]` for every card (2025 Bowman Draft "Prospect
Dual Autographs"), so the sync sees no AU and no print run. Sibling inserts of
the same set (Bowman Draft Nights, Bowman In Action, Prized Prospects,
Achromatic Autographs) do carry `["AU","SN99"]`.

**How to apply:** before asserting a wizard step or a print run that hangs on a
token, probe the fixture's rows; if the field is empty, say so in the spec
comment and the report instead of asserting on it. Adding a better fixture is a
new real set and needs the owner's approval (SET-REGISTRY rule 1).
Also: `expect(a.or(b))` is a strict-mode error when both resolve (the autograph
step shows its radio group AND Next together), so gate on the one that is
always there, then branch.
