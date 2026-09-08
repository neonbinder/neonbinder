---
name: patterns-asserting-spatial-order
description: How to assert that a grid/list is in the RIGHT ORDER (not just that the right items exist) in Maestro-web — the candidate/anchor recipe, why text composition can't do it, and the invariant-reference-line trick, as built for the NEO-157 duplex placeholder sheets
metadata:
  type: reference
---

Some features are only wrong in their ARRANGEMENT: a duplex mirror, a sort, a
reversed column. The items are identical in both the right and wrong rendering,
so "the number 3 is on screen" proves nothing. Recipe that works on maestro-web
(cli 2.6.0), proven green twice on
`apps/web/.maestro/flows/placeholders/flip-edge-mirrors-the-backs.yaml`:

**1. You cannot do it with text.** `getNodeText` returns only a node's DIRECT
text-node children, so no ancestor carries the concatenated "cell1cell2cell3"
run you would need to assert order textually — see
[[maestro-web-getnodetext-form-values]]. Position is the only signal.

**2. Name the item structurally, by what it shows.**
```yaml
containsChild:            # a DIRECT child whose text is exactly this…
  text: "3"
containsDescendants:      # …and somewhere inside, this
  - text: "BACK"
```
`containsChild` is direct-children-only (`TreeNode.getChildren()`), which is what
keeps the match down at the item and off its ancestors —
`containsDescendants` alone matches every wrapper up to `<body>`, and
`deepestMatchingElement` will not always save you. The pair resolves to exactly
one node (verified against the live DOM by replicating `traverse()` in Chrome).

**3. Compare it against an INVARIANT reference line, with plain `text:`.**
`above:` / `below:` compare TOP edges (`element.bounds.y < anchor.bounds.y`),
element vs anchor, and an element passes if it satisfies the relation against
ANY one anchor. Do NOT put `containsDescendants` in the anchor — it silently
matches nothing there (driver-primitives §3b). So pick an anchor that is
unambiguous as bare text AND whose position does not move with the feature:
for a 3×3 mirror, the CENTRE cell ("5") maps to itself under both flips, so it
marks the middle row of every sheet in every mode. Then:
- correct-state assertion: candidate `above:` the centre
- flipped-state assertion: the same candidate `below:` the centre

The two are mutually exclusive, which is what makes the pair a real regression
test rather than a pair of things that happen to be true.

**4. Let `scrollUntilVisible` carry the assertion.** Off-screen is ABSENT
(§3a), so the check must be made from a scroll position where BOTH the candidate
and its anchor are on screen. Putting the composite selector in
`scrollUntilVisible … centerElement: true` scrolls to it, centres it (which pulls
the neighbouring reference row in too), and fails loudly if it never appears —
one step, no redundant re-assert (R6).

**Costs**: each such step is a normal ~0.4s lookup when it matches; a genuine
miss burns the 17s lookup (or the 20s scroll timeout), so a broken feature fails
slowly but correctly.

Related: [[maestro-web-driver-primitives]] §3a/§3b,
[[maestro-web-getnodetext-form-values]].
