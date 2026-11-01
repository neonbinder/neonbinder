---
name: support-helper-rule-exception-unregistered
description: A new support/ helper that works under the covers (init script, window.* stub, DOM walk) is a new exception to GUIDE hard rule 2 and must be named in the GUIDE and fenced by the eslint no-restricted-imports block; check both when a helper appears
metadata:
  type: project
---

GUIDE hard rule 8 records the one approved exception to "locate only by what a
user perceives" and fences it with an `eslint.config.mjs` `no-restricted-imports`
block, so a third importer is a lint error. A helper that stubs a browser API
(a print dialog, a download) and reports from inside the page is the same kind
of exception, and tends to ship with a long "why this is allowed" comment in
the helper but no GUIDE entry, no lint fence and no recorded owner approval.

**How to apply:** when `support/` gains a file, grep it for `addInitScript`,
`evaluate`, `window.`, `querySelector`, `children[`; if any is there, check
the GUIDE's hard rules and Support list name it, the eslint block restricts
its importers to the specs that need it, and the approval is dated. Missing
any of the three is a finding against the harness, separate from the specs.
