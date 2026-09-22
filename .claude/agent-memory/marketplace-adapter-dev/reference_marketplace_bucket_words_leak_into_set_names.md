---
name: marketplace-bucket-words-leak-into-set-names
description: Marketplace grouping labels like "Other" are concatenated into NB set names at ingest; fix at the adapter boundary, never by loosening a name matcher
metadata:
  type: reference
---

A marketplace's own **grouping/bucket label** can arrive fused to the front of
a set name and be stored that way as NB's `selectorOptions.value`. The
observed case is the literal word `Other`: NB rows exist as
`Other ONIT Athlete LSU Tigers` and `Other King B Discs` alongside a bare
`King B Discs`.

Why it matters: every NB name matcher anchored at the start of the string
(`matchesBrandPrefix`, and therefore `matchKnownBrand`, the BSC bucketing and
the SportLots narrowing) silently misses those rows. In NEO-294 this is why
`ONIT Athlete` filed zero football sets while filing 43 baseball ones — the
list looked broken and was not.

**The two wrong fixes, both rejected:** adding the bucket word as a brand
entry (that keys NB behaviour on a marketplace value — product invariant 4),
and loosening the matcher to skip a leading noise word (guessing which leading
word is noise is the same dependency, just hidden). Leaving the rows unclaimed
FAILS SAFE — they sit in Unknown, where an operator moves them in one click.

**The right fix is at the adapter boundary**: stop concatenating the bucket
label into the set name on the way in. When a name matcher under-claims,
check the stored names for a leading marketplace grouping word before
suspecting the matcher or the vocabulary. Related: [[pure-router-rows-carry-nb-value]].
