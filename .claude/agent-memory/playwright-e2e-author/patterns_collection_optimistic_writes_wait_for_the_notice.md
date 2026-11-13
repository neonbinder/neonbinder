---
name: collection-optimistic-writes-wait-for-the-notice
description: /collection flips Have and Remove optimistically, so leaving the page, or pressing the next Remove in the same list, races the write; wait for the server-confirmed notice first
metadata:
  type: pattern
---

On `/collection`, Have, Add and Remove copy use Convex optimistic updates: the pressed state or the "None yet." list shows BEFORE the mutation lands. The notice (`Added <short> to your collection`, drawer status `Removed <short>, Raw`) is posted only after the write resolves.

**Why:** a spec that then navigates (page.goto to the set builder) can reach it before the copy is stored or removed. Seen on the mobile project: the final delete was still refused after "None yet." had shown.

**How to apply:** before any cross-page step that depends on the copy being really there or really gone (a set-builder delete refused or allowed by the collector guard), assert the notice, not the optimistic state. Never a sleep.

**Second shape, a lost press in the same list (NEO-481, 2026-11-12):** a "Your copies (N lines)" heading passes on the optimistic update, so a second Remove pressed right after it lands while the first write's answer arrives. That answer swaps the drawer notice above the list for a shorter one ("Added … with its front and back photos." → "Removed …"), the list moves up, and the press is lost: Playwright checks the hit target only on the first pointer event, so the click "succeeds" on the `<li>` and no mutation is sent. Mobile width made it fail (taller notice), desktop got lucky. Before each next press in the list, wait on `drawer.getByRole("status").filter({ hasText: /^Removed <short>, Raw, …/ })`, anchored with `^Removed` so it can't match the "Added" notice.

Other facts from the NEO-358 delete-refusal spec: a hand-made card has no player, so the collector sees only `#<number>` (names are `Have #<n>`, `Details for #<n>`), the checklist region is `2024 <set> Base`, and the cascade column under a hand-made `Insert` type is titled `Insert` (pick `Base` there). Refusal copy for one collector reads "Hold up! A collector has this card, so it stays in the catalog."; the planted break that proves the spec is skipping the Have step (the delete then succeeds and the alert never shows).
