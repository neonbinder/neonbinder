---
name: app-wide-usequery-needs-its-own-boundary
description: A Convex useQuery whose function errors THROWS in render; an app-wide nicety subscription (e.g. ProfileThemeSync) with no boundary of its own blanks every signed-in page
metadata:
  type: reference
---

`useQuery` throws during render when its function errors, including when the
deployment lacks the function (a branch's new query against dev, or a preview
before the deploy lands). A subscription mounted once for the whole app (in
`src/main.tsx`, beside `SentryErrorBoundary`) then unmounts everything to a
blank page about a second after load.

**How to apply:** give any nice-to-have, app-wide query component its own
small class boundary that renders null and reports once via
`Sentry.captureException` (see `ThemeSyncBoundary` in
`src/theme/ProfileThemeSync.tsx`, NEO-356), plus a unit test whose
`useQuery` mock throws. Browsing a branch against dev is the quickest way to
see the failure live. Related: [[convex-codegen-only-blocks-types]].
