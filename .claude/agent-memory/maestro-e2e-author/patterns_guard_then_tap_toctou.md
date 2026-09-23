---
name: guard-then-tap-toctou
description: "`runFlow when: visible X` + `tapOn X` is a TOCTOU — two hierarchy reads ~0.33s apart. The test for whether it is a REAL hazard (can the target vanish without the flow acting?), the `optional: true` repair, and why the same edit on the other 41 sites would be genuine R2 fall-through"
metadata:
  type: reference
---

`runFlow: when: {visible: X}` → `tapOn: X` is two hierarchy reads about
**0.33s** apart (measured: guard RUNNING 04:56:25.759, tap RUNNING
04:56:26.085, CI 35817349245 runner 3). Maestro cannot make them atomic, so
the race cannot be designed out. 45 sites in this suite have the shape.

## The test that separates hazard from anti-pattern

> **Can the target's existence change without the flow acting?**

- **NO — leave it alone.** A create-or-reuse branch (`"Create sport"`,
  `"Create insert"`, `"Edit attributes"`, `"Search sets"`) asks "does this
  affordance exist?" The page is static between the two reads; nothing races
  them. 41 of the 45 sites are this. **`optional: true` here would be genuine
  R2 silent fall-through** — the flow would skip its own action and pass.
- **YES — it is the hazard.** A self-advancing queue: the entity-review
  wizard drains itself as rows settle, so the control the guard just saw is
  gone by the tap. A non-optional tap then burns `lookupTimeoutMs` (**17000**)
  and fails the flow. 4 sites, all wizard drains.

## The repair, and why it is not fall-through

`optional: true` on the **tap only** (the enclosing `runFlow` stays
mandatory). It parses to `TapOnElementCommand(selector=ElementSelector(…,
optional=true), …, optional=true)` — command level, so Orchestra's
`executeCommand` raises `CommandWarned` (logged, skipped) instead of
rethrowing. It also swaps `lookupTimeoutMs` 17000 for
`optionalLookupTimeoutMs` **7000**, so a hit costs 7s not 16.76s.

The target vanishing **is the loop's success condition** — the row was
answered. What makes it safe is a **hard post-condition the product refuses
to satisfy on a failed drain**. Verify that guarantee at source, per site,
never by shape:

| adjudicating predicate | product guarantee, verified in `components/SetSelector/` |
|---|---|
| `Skip .* not a person` (a player row) | `entity-review-nav.ts` `nextUndecided` — *every* undecided TEAM precedes *any* undecided player, so a player row = the team queue is drained |
| `.*Confirm & Save.*` | `EntityReviewWizard.tsx` — `allDecided = total > 0 && decided === total`, and the button renders only `{allDecided && !commitError && …}` |
| `Skip .* not a team` (a team row) | the wizard presents exactly ONE row (`current` resolves the single `nav.rowId`), so the team control cannot show while a league row is presented |

Keep the loop's exit predicate and the post-condition the **same predicate**
where you can — there is then no gap between "the loop stopped" and "the loop
arrived".

**Inverting `repeat.while` does not fix this.** The window is from the LAST
read to the tap, and the inner guard already IS the last read; inverting just
changes which read is last. It is a cosmetic change dressed as a repair.

House precedent for tolerate-soft/fail-hard: `util-drill-to-custom.yaml`'s
optional pre-wait — *"a genuinely missing set still fails loudly at the
scrollUntilVisible"*. The `CommandWarned` decompilation is recorded at
`profile/worker-bootstrap.yaml`.

See also [[offline-flow-parse-harness]] (verify the parsed command object
rather than trusting the YAML) and [[never-diagnose-timing-first]].
