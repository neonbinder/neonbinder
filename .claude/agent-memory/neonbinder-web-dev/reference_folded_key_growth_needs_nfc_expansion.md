---
name: reference-folded-key-growth-needs-nfc-expansion
description: To test a "folded key too long" cap, toLowerCase grows a string at most 2x (U+0130); only an NFC composition exclusion like U+FB2C grows 1→3 code units
metadata:
  type: reference
---

A key built as `name.normalize("NFC").trim().replace(/\s+/g," ").toLowerCase()`
(NEO-496 `sectionKeyOf`) can be longer than the name, so a key cap of 2x the
name cap looks reachable. Lower-casing alone is not enough to reach it: U+0130
"İ" folds to two UTF-16 units, so 120 of them land exactly ON a 240 cap and the
"over the cap" test fails. Use an NFC composition exclusion instead:
U+FB2C (Hebrew presentation form) normalises to three code units, so
`"שּׁ".repeat(120)` folds to 360.

**How to apply:** any test that must exceed a cap on a normalised/folded
string. Assert the folded length first (`expect(key.length).toBeGreaterThan(cap)`)
so a vacuous fixture fails loudly instead of passing the wrong branch.

Related: [[character-caps-are-not-byte-caps]] (schema-specialist memory: caps
in UTF-16 units vs `getConvexSize` bytes).
