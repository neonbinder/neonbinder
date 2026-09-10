---
name: wizard-drain-loop-one-footer-guard
description: "A `runFlow when: visible` that does NOT match waits out the full visibility timeout (~6.6s measured); a matching one costs ~2.3s. So drain the entity-review wizard with ONE guard on the pinned footer button `^Add as New (Team|League)$`, never one guard per step heading — two guards cost +214s on a single flow and pushed it past the runner's 600s cap."
metadata:
  type: reference
---

# Draining the entity-review wizard: one guard, on the footer button

## The cost model (measure, don't assume)

Measured on the SAME loop in the SAME flow across two CI runs of
`inserts-1996-score-one-nb-set-two-bsc-sources`:

| | run 34077526784 (green) | run 34123557194 (timed out) |
|---|---|---|
| `repeat` block total | **80.8s** | **294.9s** |
| iterations | 22 | 29 |
| guards | 1 × `New Team: .*` (matched every time) | + a 2nd × `New League: .*` (missed 23 of 29) |
| pure guard overhead | **7.6s** | **199.5s** |
| actual taps | 43.0s (22) | 58.0s (30) |

**A `when: visible` that MISSES pays the full visibility timeout — ~6.6s. One
that MATCHES costs ~2.3s.** So a second guard for a step that is usually absent
is the most expensive way imaginable to handle it: +214s on this flow, of which
+192s was guard overhead against 11.5s of the league taps it existed to do. That
alone took the flow from 386s past `FLOW_TIMEOUT_SEC=600`.

The old note in `setup.yaml` claiming an idle iteration "costs one hierarchy
read and nothing else" was wrong and has been corrected in place.

## The shape

```yaml
- repeat:
    times: 250                 # runaway guard; `while` carries the intent
    while:
      notVisible:
        text: ".*Confirm & Save.*"
    commands:
      - runFlow:
          when:
            visible:
              id: "^Add as New (Team|League)$"
          commands:
            - tapOn:
                id: "^Add as New (Team|League)$"
```

* **Key on the FOOTER BUTTON, not the step heading.** It is present whenever
  there is anything to answer, so every iteration is the cheap case — and it
  lives in the dialog's pinned footer, where a heading lives in the
  `overflow-y-auto` body no flow can scroll (see
  [[below-the-fold-asserts-and-bottom-locked-scrolls]]).
* **`(Team|League)`, never `(Player|…)`.** The bulk decides players only, so a
  player row it left undecided is an *ambiguous same-name* row — the wizard is
  asking which existing person is on the card. `Add as New Player` there mints a
  third one silently. Excluded, the loop runs out and the wait after it fails
  loudly, which is the outcome to want.
* **Anchored `^…$`** so it cannot reach the demoted `Add as New {kind} anyway`
  link. `Filters.idMatches` uses Kotlin `Regex.matches` (a FULL match) on CLI
  2.8.0, so the anchors are a no-op there — they are insurance against the
  looser reading, and they cost nothing.

## The other wizard walkers

Any loop that answers steps needs to know a `New League:` step exists:

* skip-draining utils key on the skip control, and a league's is worded
  differently on purpose — `Skip <name> — this team has no league`, not
  "not a league" (the string IS a league; skipping says this TEAM has none). Use
  `id: "Skip .*(not a team|has no league)"`, which still excludes a player row's
  `— not a person`.
* `setup.yaml` has THREE drain sites; the two behind the smaller sets are
  normally skipped entirely (the Base sync creates the whole roster first), so a
  defect there stays invisible until it doesn't.
