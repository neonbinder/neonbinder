---
name: collapsed-radiogroup-posinset
description: A radiogroup that collapses to only its checked option lies about set size ("1 of 1"). aria-posinset/aria-setsize counted against the full option list is the name-preserving, test-safe fix. From NEO-236's NewTeamForm league picker.
metadata:
  type: patterns
---

`NewTeamForm.tsx`'s league picker is a roving-tabindex `role="radiogroup"` of
`role="radio"` pills. NEO-236 bounded it: with a standing answer it collapses
to THAT one pill plus a `Change league` disclosure (`aria-expanded`,
`aria-controls` at the group id); open, it is `max-h-40 overflow-y-auto`.

**The defect that creates:** a screen reader derives set position from the DOM,
so the collapsed group announces "Australian Baseball League, radio button,
checked, **1 of 1**" when the sport has 40 leagues. That is a real SC 4.1.2
misreport, and the cheapest honest fix does not touch a single accessible name
or the DOM shape:

```tsx
aria-posinset={(listOpen ? idx : answeredIndex) + 1}
aria-setsize={leaguePills.length}   // the FULL list, both states
```

`aria-posinset`/`aria-setsize` are supported on `role="radio"`. Set them in
BOTH states so the numbers never disagree with themselves.

**Do not "fix" it by dropping the radiogroup role when collapsed.** The tests
pin `getByRole("radiogroup", { name: "New team league" })` in states reached
through a `openLeagueList()` helper that is a deliberate no-op when the list is
already open, and the wizard pins the group's `id` (`entity-review-team-league`)
as a Maestro selector — a role that comes and goes takes the id with it.

**`aria-controls` may be omitted.** The host passes `leagueGroupId` only from
the wizard; the standalone New Team dialog deliberately passes none, so
`aria-controls` is `undefined` there. That is conformant — `aria-expanded`
alone satisfies the disclosure pattern, and an `aria-controls` pointing at a
non-existent id would be strictly worse. Resist adding a `useId()` fallback:
maestro-web derives `resource-id = node.id || node.ariaLabel`, so giving the
group a generated id would replace the `New team league` handle a flow can use.

**Still open in this component (reported, not fixed):** the visible
`<span>League</span>` and the `role="status"` "Loading leagues…" span are both
non-`radio` children of the `radiogroup` — invalid owned-children, mostly
tolerated by AT. Moving them out is the correct fix but it re-flows the exact
flex container whose height caused the CI failure, so it is not worth the risk
in a layout-fix ticket.
