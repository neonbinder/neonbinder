---
name: wizard-chrome-strings-are-suite-wide-e2e-gates
description: The entity-review wizard's header title, "N of M reviewed" counter and "All reviewed — save N cards?" line are gate strings in ~20 Maestro flows AND the phase-0 setup.yaml seed; a chrome retitle is a maestro-author unit that starts with setup.yaml
metadata:
  type: project
---
Retitling or re-wording the entity-review wizard header/footer (title, progress
counter, final-step heading) or the attention walker header ("Cards Needing
Attention", "N cards need attention · k fixed") is never a UI-only change:
those strings are `visible:`/`copyTextFrom` gates in roughly twenty set-selector
flows, in `setup.yaml` (the phase-0 seed every shard depends on), in
`.maestro/README.md` and in SET-REGISTRY.md, plus ~35 pinned unit assertions.

**Why:** NEO-335 phase 2 (2026-10-10) retitles the wizard "Tidy up this set" with a
"Step x of y" counter; the grep showed the old strings are the suite's way of
telling "wizard open" from "Saved N cards" (`.*Confirm New Players.*|.*Saved [0-9]+.*`).
A wrong seed gate hangs every shard, not one flow.

**How to apply:** when a plan changes wizard/walker chrome copy, (1) fix the exact
new strings in the plan so the maestro author can rewrite flows in parallel with
the build, (2) make `setup.yaml` the first flow rewritten and run locally against
the PR preview, (3) keep accessible names on body controls (`id:` matchers such as
`Leave for later — #.*`) unchanged unless the ticket says otherwise — flows assert
header/footer text and body `id:`s, never body text.
