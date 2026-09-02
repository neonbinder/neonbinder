---
name: raf-focus-park-race
description: A requestAnimationFrame-based focus-park effect must guard on activeElement actually being <body>, not just "no handler present" — and testing it needs a settle-wait after mount or a stale mount-scheduled rAF wins a false race
metadata:
  type: patterns
---

## The bug class: focus stranded on an ADVANCE, not just on open

`CardAttentionWalker.tsx` (NEO-102) had a mount-time open effect (`useEffect`
on `[isOpen, restoreFocusRef]`) with a comment claiming it was "the fallback
for the all-clear step and for a kind with no fixer, so focus is never left
on `<body>` with a modal open" — but that effect's `requestAnimationFrame`
callback only ever fires ONCE, at mount. Two of the walker's states (a card
whose attention kind has no registered fixer; the all-clear step once the
queue empties) render no focusable control of their own — a REGISTERED
fixer's own mount effect is what grabs focus per-card (via `key={current.
_id}` remounting it), so those two states depend entirely on something ELSE
picking up focus, and the one-shot mount effect cannot do that for an advance
that happens after it already fired-and-resolved. Net effect: advancing INTO
either of those two states from a state that DID have focus on something
(e.g. a fixer's own chip) blurs the browser straight to `<body>` with
`aria-modal="true"` still set — the modal-family version of
[[focus-park-pattern]], but on ADVANCE rather than on the initial disable/
unmount moment that pattern's other instances cover.

## The fix, and the trap in the FIRST version of it

Add a second effect keyed on whatever signals "no fixer is currently
mounted to own focus" (here, `Fixer` being falsy) that parks focus onto the
dialog container itself (give it `tabIndex={-1}` — a `role="dialog"` wrapper
usually has an accessible name via `aria-labelledby` already, so it's a
valid landing spot).

**The trap**: the first version of this fix fired UNCONDITIONALLY whenever
the no-fixer effect's dependency changed (e.g. `current?._id`), which is
wrong whenever advancing between two SUCCESSIVE no-fixer states — e.g.
Skip-ing from one unregistered-attention-kind card straight to another. In
that transition NOTHING unmounts (the Skip button is the same DOM node
before and after, conditionally rendered on `current` truthiness which stays
true the whole time; only its label/handler props update), so focus is
already exactly where it should be. An unconditional park effect would
gratuitously rip focus off Skip and onto the dialog wrapper on every such
advance — a real regression, just a quieter one than the stranding bug it
was fixing.

**The correct guard**: only intervene when `document.activeElement` has
ACTUALLY become `null` or `document.body` at the moment the effect's `rAF`
fires — never park unconditionally just because "no Fixer this render".
This correctly:
- fires when a fixer's own control (or Skip, on the last card) really did
  unmount and blur to `<body>`,
- does nothing when Skip (or any other still-mounted control) already holds
  focus across a same-shape transition.

## Testing gotcha: a synchronous `render()` → `rerender()` in a test collapses a timing gap that always exists in real usage

Proving the fix with `render(...)` immediately followed by `rerender(...)`
(no `await` in between) can make the test see an unexpected winner: the
ORIGINAL mount-time open effect's `rAF` is still PENDING (rAF callbacks
never fire synchronously; nothing had caused it to be cancelled yet, since
`[isOpen, restoreFocusRef]` didn't change), and it sits ahead of the NEW
effect's freshly-scheduled `rAF` in the queue (FIFO by registration order).
When both finally flush during a later `await waitFor(...)`, the STALE
mount-effect's callback runs first, sees `activeElement === body` (nothing
had focused anything yet, because the test jumped straight from mount to
the state change with zero elapsed frames), and parks focus on whatever
IT'S own fallback target is (here, the dialog's Close/Done button) — a
perfectly valid, non-stranded outcome, just not the one the new effect
would have produced on its own, and not something that happens in real
usage (a human always lets at least one animation frame elapse between a
component mounting and clicking something in it, so the mount effect's
`rAF` has always already fired-and-resolved, harmlessly, by the time any
subsequent advance's effect needs to do its own job).

**Fix for the test, not the implementation**: insert `await waitFor(() =>
expect(document.activeElement?.tagName).toBe("BUTTON"))` (or equivalent)
right after the initial `render()`, before triggering the follow-up
state change, so the mount effect's one-shot `rAF` settles first — matching
real browser timing. Confirmed via a scratch reproduction
(`requestAnimationFrame`-tracing `HTMLElement.prototype.focus`) that with
this settle-wait, the NEW effect is the only one still pending at the time
of the later transition and correctly parks focus on its own intended
target every time.

**When auditing/fixing a focus-park effect that depends on `requestAnimationFrame`
here**: (1) guard on the ACTUAL blur-to-body condition, not just "the thing
that used to own focus is absent this render" — the latter over-fires on any
same-shape state-to-state transition where nothing really unmounted; (2) when
writing or reviewing a test for it, insert a settle-wait after the initial
mount before triggering whatever transition the test cares about, or a
same-file STALE mount-effect rAF can win a race that would never occur in a
real browser and produce a misleading pass/fail.
