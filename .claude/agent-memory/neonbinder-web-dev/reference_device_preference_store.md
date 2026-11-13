---
name: device-preference-store
description: A per-device UI preference read by both a page and its layout frame (NEO-522 Pick List rows) — one useSyncExternalStore module, storage in try/catch, a test reset for its module state
metadata:
  type: reference
---

When a setting is per device (not a filter, so not in the URL) and two far-apart
components must agree on it (the Pick List's Spacious/Condensed and BinderLayout's
page width), keep it in one `src/hooks/use<Thing>.ts` module: a module-level value
read lazily from localStorage inside try/catch (default when storage throws), a
setter that updates the value, writes in try/catch and notifies listeners, a
`storage` event listener for other tabs, and `useSyncExternalStore` for readers.

**Why:** a context would need a provider above both the layout and the page; a
plain useState in each drifts. A throwing localStorage (private mode, blocked
site data) must never break the page.

**How to apply:** export a `reset…ForTests()` that nulls the module value and
emits; call it in every test file's afterEach with `localStorage.clear()`, or one
test's choice leaks into the next (module state outlives `cleanup()`). Test the
throwing path with `vi.spyOn(Storage.prototype, "getItem")`. A "Back to default"
that clears URL params must leave it alone, and say so in a comment.
Example: apps/web/src/hooks/usePickDensity.ts.
