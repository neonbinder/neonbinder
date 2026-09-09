---
name: neo155-admin-section-and-setbuilder-anchor
description: NEO-155 killed the "Set Selector" <h1>; the suite-wide page-loaded gate is now the Set Builder panel subtitle. Plus /admin hub+sub-tab selector ambiguity and the Input primitive's missing aria-label.
metadata:
  type: reference
---

# NEO-155 — /set-selector became /admin/set-builder

**The `"Set Selector"` `<h1>` NO LONGER EXISTS anywhere in the UI.** ~48 flows
gated on it (`extendedWaitUntil: visible: "Set Selector"`), plus `setup.yaml`
twice — which is why a NEO-155 PR turned the whole E2E suite red at the `seed`
job before the flows were updated.

**The replacement gate, used suite-wide:**

```yaml
- extendedWaitUntil:
    visible: ".*Build set parameters using marketplace APIs.*"
    timeout: 45000
```

Why that string and not something shorter:

- **NOT `"Set Builder"`** — that is also the sub-tab `NavLink` label in
  `src/layouts/admin-section-layout.tsx`, which the section shell paints
  *instantly* on every `/admin/*` route, before the panel mounts. Gating on it
  passes early and makes every flow racy.
- **NOT `"Build set parameters"`** — the `/admin` HUB card for the same tool
  reads "Build set parameters **from marketplace data**…". Only the panel's own
  subtitle says "**using marketplace APIs**", so that phrase is what
  disambiguates hub from panel.

`/set-selector` still redirects to `/admin/set-builder` (kept deliberately for
the ~48 flows + bookmarks), so flow entry URLs did NOT need changing — only the
heading assertion did. Verified: entering at
`/testing/sign-in?redirect=/set-selector` and asserting the new anchor clears
normally.

## Route/heading map after NEO-155

| Route | `<h1>` | Panel `<h2>` | Unique gate |
|---|---|---|---|
| `/admin` (hub) | Admin | — | `.*Tools for managing the shared data.*` |
| `/admin/set-builder` | Admin | Set Builder | `.*Build set parameters using marketplace APIs.*` |
| `/admin/teams` | Admin | Team Management | `Team Management` |

On the `/admin` hub the tool NAMES each appear **twice** (sub-tab + card
heading), so they are unusable as `tapOn` selectors there. Navigate by the card
DESCRIPTION sentence instead — it sits inside the card's `<Link>`, so tapping it
follows the link. On `/admin/teams` and `/admin/set-builder` the *other* tool's
sub-tab name is unique, so `tapOn: "Set Builder"` / `tapOn: "Teams"` is safe
there.

## The shared `Input` primitive emits NO id and NO aria-label

`components/primitives/Input.tsx` deliberately never emits an `id` (it would
clobber Maestro's `resource-id = node.id || ariaLabel`). When the caller passes
no `id`, the label is associated by a **wrapping `<label>`** — so there is *no*
`aria-label` either. `id: "Name on the label"` / `id: "Filter teams"` do NOT
resolve. Target the **visible label text** (`tapOn: "Filter teams"`); the click
bubbles to the `<label>` and focuses the input. Uniqueness comes from a marker
CLASS, not an id.

See [[neo147-spine-label-designer]].
