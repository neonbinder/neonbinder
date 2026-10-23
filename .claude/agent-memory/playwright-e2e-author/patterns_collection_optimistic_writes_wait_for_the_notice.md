---
name: collection-optimistic-writes-wait-for-the-notice
description: /collection flips Have and Remove optimistically, so leaving the page on the flipped state races the write; wait for the server-confirmed notice first
metadata:
  type: pattern
---

On `/collection`, Have, Add and Remove copy use Convex optimistic updates: the pressed state or the "None yet." list shows BEFORE the mutation lands. The notice (`Added <short> to your collection`, drawer status `Removed <short>, Raw`) is posted only after the write resolves.

**Why:** a spec that then navigates (page.goto to the set builder) can reach it before the copy is stored or removed. Seen on the mobile project: the final delete was still refused after "None yet." had shown.

**How to apply:** before any cross-page step that depends on the copy being really there or really gone (a set-builder delete refused or allowed by the collector guard), assert the notice, not the optimistic state. Never a sleep.

Other facts from the NEO-358 delete-refusal spec: a hand-made card has no player, so the collector sees only `#<number>` (names are `Have #<n>`, `Details for #<n>`), the checklist region is `2024 <set> Base`, and the cascade column under a hand-made `Insert` type is titled `Insert` (pick `Base` there). Refusal copy for one collector reads "Hold up! A collector has this card, so it stays in the catalog."; the planted break that proves the spec is skipping the Have step (the delete then succeeds and the alert never shows).
