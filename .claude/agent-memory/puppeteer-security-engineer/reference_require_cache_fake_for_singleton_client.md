---
name: require-cache-fake-for-singleton-client
description: Test pattern in services/browser — when a dist module keeps ONE lazily-built SDK client for its lifetime, the require.cache fake's constructor must return an object that delegates to the per-test spy at CALL time, not the spy itself
metadata:
  type: reference
---

`tests/secrets-manager.test.mjs` fakes `@google-cloud/secret-manager` by
returning `activeClient` from the fake constructor. That works there because
`SecretsManagerService` is constructed per call. A module that holds a
module-level singleton client (`let client; if (!client) client = new …`)
captures whichever spy was active on the FIRST read, and every later test's
`activeClient = …` swap is silently ignored — the symptom is "calls.list is
[]" on the second test onward.

Fix: the fake constructor returns
`{ listSecretVersions: (r) => activeClient.listSecretVersions(r), … }` so
delegation happens per call. (Used in `tests/sportlots-automated-access.test.mjs`.)

Related: adapter tests patch a dist module's exports by property assignment
(`mod.fn = …`) — that works because tsc emits `exports.fn = fn` (writable) and
the caller does `mod_1.fn()` at call time. It would NOT work for `export *`
re-exports, which tsc emits as getters.
