---
name: no-jest-dom-matchers-in-unit-tests
description: apps/web vitest has no @testing-library/jest-dom; toBeInTheDocument/toHaveAttribute/toHaveTextContent throw "Invalid Chai property"
metadata:
  type: reference
---

The `components` vitest project does not register `@testing-library/jest-dom`, so
`toBeInTheDocument`, `toHaveAttribute`, `toHaveTextContent` fail with
"Invalid Chai property". Assert on the DOM directly: `getByRole(...)` alone proves
presence (it throws when absent), `el.getAttribute("href")` with `toBe`, and
`el.textContent` with `toBe`/`toContain`.

**Why:** a test written in the usual RTL idiom goes 4/4 red on the first run (NEO-421).
**How to apply:** any new `.test.tsx` under app/, components/ or src/; copy the style of a
neighbouring page test. Related: [[reference-unit-axe-helper]].
