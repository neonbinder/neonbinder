---
name: marketplace-data-trust-characteristics
description: How trustworthy/structured BSC vs SportLots catalog data is, and why that should shape any feature that ingests or diffs marketplace-sourced card content.
metadata:
  type: reference
---

**BuySportsCards (BSC)** — centrally curated catalog with real structured
fields (player, team, set, insert/parallel, attributes enum: RC/AUTO/RELIC/
print-run). A correction there usually comes from BSC's own catalog team
fixing a genuine miscatalog (wrong player attribution on a multi-player
highlight card, a mistakenly-flagged RC). Treat a BSC-sourced structured-field
change as relatively high-confidence — it is a deliberate catalog fix, not a
seller typo.

**SportLots (SL)** — no structured attribute fields for most of what matters;
the "card" is effectively a free-text listing description typed by whichever
seller listed it (confirmed in code: `platformData.sportlots.ref` IS the
description string — see NEO-203 plan). Corrections are usually one seller
editing their own listing wording, not a canonical catalog fix. Parsing
structured attributes (RC, /##, parallel name) out of that description is a
heuristic that can misfire, and a "correction" may just be one seller's
formatting preference. Treat an SL-sourced field change as lower-confidence
than the equivalent BSC one.

**How to apply:** any feature that surfaces "marketplace said X, our data says
Y" (diff review, conflict resolution, auto-merge heuristics) should let the
operator see WHICH marketplace a changed value came from (reuse the existing
`sourceLabelMaps` / `ChecklistSourceFilter` badge machinery — it already
distinguishes bsc vs sportlots per card) and should weight BSC-origin
structured changes as more trustworthy than SL-origin ones when choosing
default accept/reject states. Also: because the SL ref = description, an SL
description edit changes the ref itself — that's why NEO-203's matching
cascade needs a slot+number fallback tier rather than relying on ref alone
for SL-linked rows. See [[neo-203-content-diff-review-spec]].
