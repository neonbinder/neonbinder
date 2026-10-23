---
name: patterns-neo356-theme-prepaint
description: NEO-356 theme — the safe shape for an inline pre-paint script reading localStorage, the no-CSP status of apps/web, and the self-only preference mutation shape that passes audit
metadata:
  type: project
---

NEO-356 added the app's first inline `<script>` in apps/web/index.html (reads
localStorage `nb-theme`, sets `<html data-theme>`). Audited clean because the
stored value is only COMPARED to literals and the attribute is only ever set to
one of two constants; nothing from storage reaches the DOM. Re-check that
property if the script ever grows (e.g. stores a colour or accent string).

apps/web ships NO Content-Security-Policy (vercel.json has rewrites only, no
headers; no meta CSP). If a CSP is ever added, the inline script needs a
`'sha256-…'` source or it silently stops running (fails to the dark default);
that is the place to look first.

`userProfile.setThemePreference` is the house shape for a self-only preference
write: narrow literal-union arg, getCurrentUserId + throw, by_user .unique(),
spread-patch of `preferences` (does not clobber sibling keys), registered in
publicFunctionAuth.test.ts with a refuse-and-wrote-nothing assert.

**How to apply:** any new user preference, any inline script in index.html, or
any CSP work. ProfileThemeSync subscribes getUserProfile app-wide for signed-in
users, so anything added to that query's `returns` is now on every page's wire.
Related: [[public-function-auth-registry]], [[patterns-convex-auth-boundary]].
