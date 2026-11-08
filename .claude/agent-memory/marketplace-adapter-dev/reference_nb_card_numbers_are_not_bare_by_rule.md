---
name: nb-card-numbers-are-not-bare-by-rule
description: Comments say NB stores numbers bare, but the BSC sync commits cardNo raw; a prefix check must accept bare and prefixed on either side
metadata:
  type: reference
---

Comments in `lib/intakeMatch.ts` and `CardPrefixRow.tsx` read as if
`cardNumberPrefix` always comes off NB's number. It does not. `fetchCardChecklist`
strips it only for the SportLots lookup, and commit stores the marketplace's
number as given, so a row carries the prefix when BSC's `cardNo` did at the time.
A row is bare when it came from SportLots or a hand edit, or when BSC changed
its number later, because sync never rewrites a stored number.

BSC numbers per variant, not per set: one set can have a bare Base and prefixed
inserts. A prefix belongs to the row whose cards carry it. A sample says nothing
about another sport: BSC's public search isn't sport-scoped, so a baseball hit
doesn't describe the same-named football set, whose parallel can carry a prefix
the baseball one doesn't. Check the hit's `sport` before reading anything into
its numbers.

A strip must not split a run of digits: prefix `1` is not on `12`, and `T2` is
not on `T21`. The listing guard ignores such a strip in `cardNumberSpellings`;
`stripNbCardNumberPrefix` itself does not, so `baseMatchProbe` still strips them.

**How to apply:** any comparison of an NB number with a marketplace number
strips on both sides. Do not assume which side carries the prefix.
