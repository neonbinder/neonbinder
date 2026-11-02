---
name: unit-axe-helper
description: Component tests can run axe in happy-dom via lib/testing/axe.ts expectAccessibleInBothModes (E2E tags, light+dark via html data-theme, color-contrast off); use it for states the E2E suite cannot stage
metadata:
  type: reference
---

Since NEO-370, `axe-core` is a direct devDependency, pinned to the version
`@axe-core/playwright` pulls in, and `lib/testing/axe.ts` exports
`expectAccessibleInBothModes(container, { label, rerender })`.

- It uses the same WCAG tags as `playwright/support/a11y.ts`. `lib/testing/axe.test.ts`
  reads that file's source to pin the two lists equal, because the Playwright file
  imports Playwright and so cannot be imported in a unit run.
- It flips the mode the way the app does, by setting `<html data-theme>`, then calls
  `rerender`, which must render a FRESH element. It ends dark.
- `color-contrast` is off because happy-dom computes no cascaded colours. Contrast
  is left to the E2E axe check.
- It does catch real violations in happy-dom: button-name, image-alt and link-name
  were all verified with a probe.

**Why:** Jason wants axe coverage in both modes for listing states the E2E suite
cannot stage: a sync error, an expired sign-in, paused, a seller conflict.

**How to apply:** when a screen has states a spec cannot reach, add an `it.each` of
those states that calls this helper. Fix any violation it finds in the product,
never in the helper.
