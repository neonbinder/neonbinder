---
name: branch-on-copied-button-text
description: To vary a drain step by which KIND of wizard step is up without a second `when: visible` guard, copyTextFrom the button the one guard already matched and branch on `when: true: '${maestro.copiedText === "…"}'` — a script condition costs nothing when false; worked example util-wizard-answer-step-as-new.yaml (NEO-331 league level)
metadata:
  type: feedback
---

When a loop's single guard (`when: visible: id: "^Add as New (Team|League)$"`)
already matches more than one kind of step and ONE kind needs an extra action
(NEO-331: a New League step needs a level pill pressed before its held
primary answers), do not add a second visibility guard for that kind — a
guard that misses on most iterations is the expensive shape the drains were
rebuilt to avoid ([[wizard-drain-loop-one-footer-guard]]).

Instead, inside the matched branch:

```yaml
- copyTextFrom:
    id: "^Add as New (Team|League)$"   # the element the guard just saw
    optional: true                     # wizard self-advances: tolerate a miss
- runFlow:
    when:
      true: '${maestro.copiedText === "Add as New League"}'
    commands:
      - tapOn: { text: "Other", optional: true }
- tapOn: { id: "^Add as New (Team|League)$", optional: true }
```

**Why:** the copy is one hierarchy read of an element known to be present; a
`true:` script condition is evaluated without touching the screen. Verified
offline with the parse harness ([[offline-flow-parse-harness]]):
`CopyTextFromCommand(selector=…optional=true…, optional=true)` and
`Condition(scriptCondition=${maestro.copiedText === "…"})`. Single-quote the
`true:` value (it holds double quotes).

**How to apply:** only inside a branch whose guard already proved the element
is there. On a copy miss `maestro.copiedText` keeps the PREVIOUS value, so the
dependent action must be harmless when stale (here: an optional tap that costs
one 7000 lookup) and a hard post-condition must adjudicate the loop (R2). Where
nothing races (the batch has stopped moving), drop `optional` and keep every
step hard — `inserts-1996-score-one-nb-set-two-bsc-sources.yaml` step 6a.
