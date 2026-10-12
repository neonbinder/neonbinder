---
name: render-phase-state-for-previous-render-values
description: A value that depends on the PREVIOUS render (a high-water counter, "did the rail move forward", a one-shot announcement) goes in useState updated conditionally during render — passes this repo's react-hooks lint where set-state-in-effect and ref-in-render both fail
metadata:
  type: reference
---

apps/web's eslint runs the React Compiler hook rules on `.tsx`:
`react-hooks/set-state-in-effect` flags an effect that mirrors props into
state, and `react-hooks/refs` flags reading `ref.current` during render. The
pattern that passes both is React's documented "storing information from
previous renders":

```ts
const [tracker, setTracker] = useState<T | null>(null);
const next = advance(tracker, input);   // pure; returns `tracker` itself when nothing moved
if (next !== tracker) setTracker(next); // conditional, so it settles in one extra pass
```

The pure reducer MUST return the same object when nothing changed, or the
render loops. Used for NEO-335's "Step x of y" (never-shrinking y,
`entity-review-steps.ts` `trackSteps`) and WizardChrome's forward-only rail.

Two traps from that build:
- It must sit ABOVE any early `return null`, like any hook-adjacent state.
- A transient line keyed on the value it describes can vanish in the same
  commit: the render that grows the wizard's y is often the one where the nav
  pin is still moving (a skip lands while the skipped row is still on
  screen), so keying the growth line on x wiped it. Key it on operator
  progress (decided count + requested step) instead. See
  [[e2e-viewport-is-the-ux-constraint]] for why status text stays near its cause.
