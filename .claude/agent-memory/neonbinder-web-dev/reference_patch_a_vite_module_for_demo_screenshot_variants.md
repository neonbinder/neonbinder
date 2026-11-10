---
name: reference-patch-a-vite-module-for-demo-screenshot-variants
description: Screenshot a demo state the fake data does not have (no boxes, 19 binders) without touching product code, by rewriting the Vite-served module in a temporary Playwright spec with page.route + route.fetch
metadata:
  type: reference
---

The demo pages draw compiled-in fake data (`app/dashboard/fake-data.ts`). For a
review screenshot of a state that data lacks, a temporary spec can rewrite the
module as Vite serves it:

```ts
await page.route(/\/app\/dashboard\/fake-data\.ts/, async (route) => {
  const resp = await route.fetch();
  const body = (await resp.text()).replace(/function getDashboard\(\) \{/, "function getDashboard() { /* mutate DASHBOARD once */");
  await route.fulfill({ response: resp, body });
});
```

Vite's dev transform keeps top-level names (`DASHBOARD`, `bindersOf`), so the
patch can call the module's own helpers. Guard the mutation with a flag: the
getter runs on every render. Dev server only (a build bundles the module).
Delete the spec after the run; nothing of it ships.

Pairs with [[reference-local-screenshot-script-gotchas]] (clip a fullPage shot
after `scrollTo(0, 0)` so the sticky header does not cover a section's top).
