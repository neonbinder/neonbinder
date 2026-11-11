---
name: playwright-harness-mirrors-checklist-parser
description: playwright/support/published-checklist.ts computes expected checklist counts; it must share lib/checklists rules, so check it whenever the parser or no-team.ts changes
metadata:
  type: project
---

`playwright/support/published-checklist.ts` (`checklistFacts`) predicts the "Teams from your checklist: N of M" numbers the product shows. It reads team cells and card numbers the way `lib/checklists/parse-published-checklist.ts` and `lib/checklists/no-team.ts` do. Import those helpers rather than copying rules.

**Why:** NEO-489 added "No Team" claims, no-claim words (None, N/A, TBD, dashes) and case-kept card numbers; a copied rule set silently disagrees with the product and turns a spec red by its count.

**How to apply:** when changing the checklist parser, matcher or no-team.ts, grep `playwright/support/published-checklist.ts` and run one spec that asserts the "N of M" line.
