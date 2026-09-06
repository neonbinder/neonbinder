---
name: patterns-admin-master-row-aria-label
description: Admin master-list rows (TeamManagement/PlayerManagement) put the Maestro resource-id string verbatim into aria-label, which overrides all button content — recurring 4.1.2 gap for glyph/state indicators
metadata:
  type: pattern
---

Both `components/admin/TeamManagement.tsx` and the sibling `PlayerManagement.tsx`
master-list rows are `<button>`s. TeamManagement's row sets
`aria-label={teamFullName(team)}` verbatim, because Maestro's web driver derives
`resource-id = node.id || node.ariaLabel` and every `.maestro/flows/` selector
taps the row by that exact string — appending anything to it (a state word, a
league code) breaks the suite silently. This is a firm, documented constraint,
not an oversight — see the comment at TeamManagement.tsx:889-906.

**The recurring gap:** an `aria-label` on an element replaces its entire
accessible-name computation, so any content rendered as a *child* — a trailing
attention glyph ("?" / "—" in `text-neon-orange`, with only a `title` on the
glyph's own `<span>`), a metadata line (league abbreviation) — is silently
dropped from what AT users hear. `title` on a non-focusable inner span never
fires for keyboard users either (only the outer button is focusable).

**The fix that respects the Maestro constraint:** never touch `aria-label`.
Add `aria-describedby` pointing at a `sr-only` span (or reuse the visible
`title` text) that carries the state/metadata info. `aria-describedby` is
independent of the `resource-id` derivation, so it's free real estate for
exactly this kind of "the label must stay exactly X, but the row also carries
extra state" case. Example fix delivered for NEO-236 (not yet applied, report
only):

```tsx
{attention && (
  <span id={`team-row-meta-${team._id}`} className="sr-only">
    {league ? `${league.abbreviation ?? league.name} — ` : ""}
    {attention === "choice" ? "Several color sources match — needs a pick" : "No colors yet"}
  </span>
)}
<span
  aria-hidden="true"
  className="text-xs text-neon-orange"
  title={...}
>
  {attention === "choice" ? "?" : "—"}
</span>
```
and `aria-describedby={attention ? `team-row-meta-${team._id}` : undefined}` on
the button (id keyed by `team._id` since this is inside `.map()` — `useId()`
can't be called per iteration).

Check for this same shape (aria-label = Maestro handle, real content silently
dropped) in any other admin master-list row before it ships.
