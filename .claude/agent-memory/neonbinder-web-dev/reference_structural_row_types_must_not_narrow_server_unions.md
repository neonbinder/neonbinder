---
name: structural-row-types-must-not-narrow-server-unions
description: A hand-kept structural row type (NavRow in entity-review-nav.ts) that types a field's literal union narrower than the server validator makes every getBatch row unassignable, erroring at every helper call site in the wizard
metadata:
  type: reference
---

`components/SetSelector/entity-review-nav.ts` keeps a structural `NavRow` / `NavDecision` so the wizard can pass `getBatch` rows straight to pure helpers. Adding an OPTIONAL field there is safe whether or not the backend unit has landed it yet (a missing optional prop is assignable), which makes it the right way to read a parallel unit's new field: put a helper on `NavRow` (e.g. `preselectFor(row)`) and call it from the wizard.

The trap: if the hand copy's literal union is NARROWER than the server's validator (NEO-424: client `reason: "priorYearProduct" | "onlyNamesake"`, server added `"setHistory" | "hallOfFame"`), the whole row stops being assignable to `NavRow`, and tsc reports it at every `isAmbiguousPlayerRow(current)` / `resolveNav(rows, …)` call site, not at the field. The error text buries the real cause ~8 levels deep ("Types of property 'reason' are incompatible").

**How to apply:** when a component typecheck suddenly fails at many nav-helper call sites, read to the bottom of one error for the field; mirror the server union exactly (read `convex/schema.ts`), and give any switch on it a branch for every member. Root `tsc -p .` is the only check that sees this ([[reference_apps_web_root_tsc_is_red_at_baseline]]).
