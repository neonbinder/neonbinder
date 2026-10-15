---
name: build-sl-fixtures-through-the-parsers
description: fetchCardChecklist tests mock the SL action with hand-written rows; build them via parseSlVariationMarker + parseSlSubjects from the raw description, or a parser quirk hides behind a hand-set isVariation
metadata:
  type: reference
---

The `fetchCardChecklist.*.test.ts` files mock `fetchSportLotsChecklist` and
hand-write the parsed SL rows (`isVariation`, `cardName`, `players`). A
hand-written `isVariation: true` encodes what you *believe* the adapter does,
not what it does.

NEO-339: a pairing rule was correct against hand-written fixtures and still
regressed the CI seed. SportLots' bare `#16 Pete Crow-Armstrong [ VAR ]` parsed
as a NON-variation, because `VAR` sat in the bracket attribute-token set. So the
number looked printed twice and the name kept "[ VAR ]". The coordinator's own
diagnosis repeated the same wrong assumption ("SL lists it with isVariation").

**How to apply:**
- For a live-shape regression, build SL rows in the test from the exact live
  description through the exported parsers (`parseSlVariationMarker`, then
  `parseSlSubjects` on its residual). The `vi.mock` of `./adapters/sportlots`
  spreads `importOriginal`, so the real parsers are importable beside the
  mocked action.
- Before fixing a regression report, reproduce it from the raw strings. Do not
  start from the reported mechanism.

Related: [[cross-adapter-parity-test]].
