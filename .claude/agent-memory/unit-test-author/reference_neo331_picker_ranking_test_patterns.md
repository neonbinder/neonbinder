---
name: neo331-picker-ranking-test-patterns
description: NEO-331 test recipes - mocking a ranked {team,tier} query in picker tests, role-agnostic level pill helpers, convex-test window fixtures, held aria-disabled presses
metadata:
  type: reference
---

- A component test that mounts the real TeamPicker mocks `api.teams.pickerCandidates` and the mocked `useQuery` wraps raw rows as `{ team, tier: 1 }`; ordering is the server's, so the picker test asserts "server order unchanged after filtering" rather than ranking.
- Level pills: query by `getByRole("radiogroup", {name:"Level"})` + `radio`, assert `aria-checked`; held submits are `aria-disabled="true"` (native `disabled` only while busy). A held press with only the level missing focuses the first/checked radio; arrow keys move focus on the next rAF.
- convex-test search window: harness returns insertion order and `.take(n)` drops the LAST inserted; real backend drops the oldest. Prove a league leg with the club inserted last plus a control query without context; run the lead assertion with the club first too.
- Break-check a server leg by editing the condition (`if (false && ...)`), run, restore from a scratchpad copy.
- `Math.max(1, Math.min(NaN, cap))` is NaN and `.slice(0, NaN)` is `[]`: v.number() admits NaN.
- Client-side `nameMatchesQuery` filter in TeamPicker drops server alias hits whose full name lacks the typed text.
