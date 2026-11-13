---
name: break-words-does-not-shrink-a-table-cell
description: In an auto-layout <table>, `break-words` (overflow-wrap:break-word) leaves an unspaced title's min-content width intact, so the table widens; use `wrap-anywhere`
metadata:
  type: reference
---

`break-words` is `overflow-wrap: break-word`, which does not count toward
min-content sizing. In an auto-layout table (the Pick List's
`nb-pick-table`), a 200-character title with no spaces keeps the column that
wide and the page scrolls sideways (WCAG 1.4.10). `wrap-anywhere`
(`overflow-wrap: anywhere`, Tailwind 4.1+) does lower min-content, so the
cell wraps. In a flex row with `min-w-0` (the Sales tab line) `break-words`
is enough.

A print sheet with `white-space: normal` but `overflow: hidden` clips an
unspaced title too; add `overflow-wrap: anywhere` to the cell rule.

Unit-test it with a class assertion on the rendered span (happy-dom paints
nothing). Related: [[unlayered-text-wrap-beats-truncate]],
[[caption-under-an-image-never-widens-it]].
