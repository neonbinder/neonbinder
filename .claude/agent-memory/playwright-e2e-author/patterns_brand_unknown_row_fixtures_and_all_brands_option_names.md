---
name: patterns-brand-unknown-row-fixtures-and-all-brands-option-names
description: How to reach and assert a year's brand-unknown row in specs (admin vs collector), why All Brands set options need a name regex, and which year can host a collector fixture under Unknown without changing other specs' brand columns (NEO-527)
metadata:
  type: reference
---

**All Brands view option names are "<set> <brand>".** The set builder's All Brands
view lists each set with its brand as part of the option's accessible name:
"Topps Topps", "Topps Traded Topps", "Donruss Unknown". `columnOption(page, "Sets", X)`
filters by an exact TEXT X, which also matches every sibling whose brand badge reads X,
so once a brand row is minted for the line ("Donruss Elite Donruss") the helper hits a
strict-mode violation. Pick a flagship by role name instead:
`getByRole("option", { name: /^Donruss \S+$/ })`, or assert the filing with an exact
name (`"Topps Topps"`, and `"Topps Unknown"` toHaveCount(0)).

**Known-brands list (NEO-294, majors since NEO-527) mints brand rows on any year-wide
Sets sync, SportLots paused or not.** A year's brand column is not "only what the spec
hand-made" any more; `selectOrCreate` finds the sync's row when the year was filed first.

**The brand-unknown row exists only on a year some year-wide Sets sync has filed** (no
custom-sport path mints it, and Move to another brand only offers an existing one). Drill
the year through All Brands first, then ASSERT `columnOption(page, "Manufacturers",
"Unknown")` is listed before any `drillToCustom(..., manufacturer: "Unknown")`:
`selectOrCreate` would otherwise hand-make a fake brand called Unknown.

**Collector side (NEO-527):** the collection's Checklists drill never lists the row; its
sets sit in the year's brand column (after a "More sets" group), and picking one skips
the Sets column. The column's title depends on what else the year holds ("Brands",
"Sets" when all are sets, "Brands and sets" when mixed); a picked loose set collapses to
"Sets: <name>, change", a brand to "Brands: <name>, change". Keep the title in one regex
constant and never assert "Brands" for a column that lists a set. Note `getByRole`'s
non-exact name is a case-insensitive substring, so `listbox "Brands"` also finds
"Brands and sets": the shared `drill("Brands", ...)` helper survives a mixed year, but a
"Sets"-only year has no brand to pick at all.
A set WITH CARDS under a year's Unknown changes that year's column for every spec that
drills it (`drill("Brands", ...)` helpers, the request form's "Brand" select), so host
such a fixture on a year no collector spec drills: Hockey 1995 (its Unknown already holds
the wizard fixtures' committed sets). Never Baseball 2024 or 2026.

**Dashboard surface that proves it per account:** the Fresh Pulls tile (a link named by
the listing title, "1995 <set> Base Insert #<n> Hockey"). "New on NeonBinder" also names
the set but is GLOBAL and shows 6, so concurrent shards can push a spec's set out of it.
The card panel's Set line is a `definition` (the card face repeats the same words).

Related: [[sets-sync-is-year-wide-and-populated-gated]], [[patterns_responsive_duplicates_and_text_locators]]
