---
name: print-emulation-and-rare-state-axe
description: NEO-500 — emulateMedia print on a phone keeps the 390px viewport (a flexible print column collapses); no axe in vitest by default, jsdom axe-core cannot do contrast; a setup run on an unseeded per-worktree deployment fails at the SportLots-id step
metadata:
  type: feedback
---

- `page.emulateMedia({ media: "print" })` keeps the project's viewport. On the
  phone project a fixed-layout print table's flexible column has no width, so
  its text is in the tree but `toBeVisible` fails. Branch on `isMobile`: wide
  `toBeVisible`, phone `toHaveCount(1)`. Restore with `{ media: null }` and
  assert the screen table is back. Pair every `toBeHidden` of screen chrome
  with a positive assert on the sheet.
- `th scope="rowgroup"` reads as `rowheader`; count them to pin the dividers.
- Rare states the live data cannot reach (list cut at a cap, a state the test
  hop never makes) get a vitest + `axe-core` run on the real component
  (`axe.run(container, { rules: { "color-contrast": { enabled: false } } })`);
  it cannot check contrast or light/dark, so say so in the file. Prove it can
  fail by planting an `<img src>` with no alt and confirming `image-alt` reds.
- A `setup` project run needs the reference bundle (the seeded catalogue
  carries SportLots ids). A plain `e2e-seed-reset.sh` without the bundle gets
  past the manufacturers step and fails on the Years pause notice; with gcloud
  reauth expired, a signed-in real-set spec cannot run on a fresh deployment.

Related: [[patterns-dual-layout-rows-and-card-face-text]].
