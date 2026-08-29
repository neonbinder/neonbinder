---
name: maestro-aria-label-coupling
description: aria-label text on interactive elements is load-bearing for Maestro E2E selectors in this repo — check before editing
metadata:
  type: project
---

`components/primitives/Input.tsx` deliberately **never emits its own `id`**
unless the caller explicitly passes one. Its own header comment explains why:
maestro-web's `inputText`/`tapOn` resolves `resource-id = node.id || node.ariaLabel`,
so an auto-generated `id` would silently switch a flow's target away from the
aria-label it was written against.

**Consequence for a11y fixes:** if you find a `<label htmlFor="some-id">`
pointing at an `<Input>` that has no matching `id` prop (a dangling label —
found this in `CardDetailPanel.tsx`'s NEO-189 "Variation of" field), the fix is
almost never "add the `id`". Grep `.maestro/flows/**` for the field's
aria-label text first:

```bash
grep -rn "Card number this one is a variation of" .maestro/flows
```

If a flow targets it (`tapOn: { id: "<aria-label text>" }`), adding an `id`
attribute would change that field's Maestro resource-id and break the flow.
The safe fix is to drop the unused `htmlFor`/`<label>` association and let the
`aria-label` on the input alone carry the accessible name — which is already
the established pattern for every other field in these SetSelector detail
panels (none of them use `htmlFor`).

**General rule:** before changing the *text* of an existing `aria-label` on any
element in `apps/web/components/`, grep `.maestro/flows/**` for that literal
string. Treat Maestro's `id:` matching as effectively exact-string for
planning purposes (unconfirmed whether it's regex-substring under the hood —
don't rely on partial-match forgiveness). Appending/rewording an aria-label to
add accessibility context (e.g. "Edit card 11" → "Edit card 11 (variation of
#5)") is exactly the kind of change that risks this — verify no flow targets
the original string before doing it. See [[virtualized-list-a11y]] for a case
where this constraint blocked the more direct fix and a text-content-based
alternative was used instead.
