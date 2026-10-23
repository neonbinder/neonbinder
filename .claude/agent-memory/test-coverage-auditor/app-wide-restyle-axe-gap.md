---
name: app-wide-restyle-axe-gap
description: Pattern for audits of app-wide theme/restyle PRs where the E2E proves the mechanism but axe only runs on the few screens the new specs visit
metadata:
  type: project
---

An app-wide restyle (hundreds of files, class strings swapped for role tokens) tends to ship specs that prove the switch (settings, demo toggle, pre-paint) plus axe on 2-3 screens, while every other screen's new mode has no automated contrast check.

**Why:** unit tests of rewritten class strings assert tokens, not painted colour; only axe on the rendered mode catches a bad pairing.

**How to apply:** ask for a sweep spec that runs `expectAccessible` over the main routes in the new mode via `page.emulateMedia` (no saved state, so nothing to restore). Also check rewritten unit assertions still pin the same behaviour, and that tokens are tested against the stylesheet. Grep for colour-asserting specs with quoted `--include='*.ts'` (zsh aborts on an unquoted glob and the grep silently never runs).
