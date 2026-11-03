---
name: reference-seed-tests-run-under-vitest
description: apps/web/scripts/reference-seed/*.test.mjs (the SELECTOR_DEPENDANT_TABLES pin) run under vitest; `node --test` fails at import on main too, a false red
metadata:
  type: reference
---

The reference-seed pins (`cli.test.mjs`, `lib.test.mjs`, `pipeline.test.mjs`
under `apps/web/scripts/reference-seed/`) import `convex/schema` without an
extension, so plain `node --test cli.test.mjs` dies with
`ERR_MODULE_NOT_FOUND` before a single assertion, on `main` as much as on a
branch. That red says nothing about your table.

Run them as `npx vitest run scripts/reference-seed` from `apps/web` (they are
also inside `npm run test:unit`). This is the runner that exercises the
`SELECTOR_DEPENDANT_TABLES` check from [[transient-side-table-checklist]].

**How to apply:** when checking that a new table keyed on `selectorOptions`
or `cardChecklist` is wired into the reference seed, use vitest; never report
a `node --test` failure here as a regression.
