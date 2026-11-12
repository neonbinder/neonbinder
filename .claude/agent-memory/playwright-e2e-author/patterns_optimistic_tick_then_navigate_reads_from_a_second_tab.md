---
name: optimistic-tick-then-navigate-reads-from-a-second-tab
description: When a screen ticks a write optimistically with no "saved" state, a reload/goto right after can outrun the write; confirm it from a second tab first. Also: minted ids that prefix each other break prefix-name locators
metadata:
  type: feedback
---

Seen on the NEO-500 Pick List: "Pull these 2" ticked both rows and posted its
notice at once (optimistic), the spec went straight to `page.goto(<ship hop>)`,
and after the load both lines were back, unpulled. With the page left open
the same pull was on the server within the 7 s budget.

**Why:** the notice and `aria-pressed` are client state; the screen has no
perceivable "saved" signal, so leaving the page can beat the mutation.

**How to apply:** before a reload or navigation that must read a just-ticked
write, open a second page in the same context on the same screen and assert
the server's state there (web-first, 7 s; it subscribes live). Then reload the
main page. Report the missing "saved" signal as a product gap; never a sleep.

Second trap from the same spec: order numbers `<token>` and `<token>b` made
`Pulled Card NB couldn't match, BSC <token>` (a `^`-prefix regex) match both
orders' rows. Mint sibling ids with disjoint suffixes (`<token>a`, `<token>b`).

Also: a failure cleanup that navigates the failing page wipes the failure
screenshot and error-context (both are taken at teardown). Do it on
`context.newPage()` instead.

Related: [[collection-optimistic-writes-wait-for-the-notice]], [[runtime-names-need-regex-escaping]].
