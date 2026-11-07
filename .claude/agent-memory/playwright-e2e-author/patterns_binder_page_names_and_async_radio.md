---
name: patterns-binder-page-names-and-async-radio
description: Binder page groups carry a suffix ("Page 2, A fresh page"), a key press needs the Next button enabled first, check() fails on a radio moved by an async save, and how to prove an image loaded without evaluate
metadata:
  type: reference
---

Four handles on the binder screens, each of which cost a red run:

- **A binder page's group name is not always `Page N`.** The owner's back page is
  `Page 2, A fresh page` until a card lands on it; a sorted page is
  `Page 1, <section>`. Match `^Page N(,|$)`. An exact `Page 2` reads as "the
  page never turned", and the page had turned. Read the snapshot's `group` line
  and the status line before believing the key did nothing.
- **Page 1 draws before the binder's cards are in.** A PageDown pressed then
  clamps to the only page and is spent. A Next button's click auto-waits for
  enabled and a key press does not, so assert the Next button `toBeEnabled()`
  first. That is a real precondition (there is a page to turn to), not a settle wait.
- **`check()` fails on a controlled radio moved by an async save.** "Clicking the
  checkbox did not change its state" means the radio moved after the write
  landed, not that it refused. "Where I put them" writes the sorted order down
  first. Use `click()` and then a web-first `toBeChecked()`.
- **An image really loaded:** `await expect(img).not.toHaveJSProperty("naturalWidth", 0)`.
  It retries on the 7 s budget and needs no `evaluate`.

A red run leaves its copies on the account, and the first ordinary Base row then
drops out of `ordinaryBaseRows` or changes its form. Re-run `bootstrap` after every
red before reading anything into the next run of a collection spec.

Related: [[collection-binders-flake-mechanisms]]
