---
name: convex-call-spread-hides-bad-args
description: Spreading conditional keys into a useMutation/useAction call bypasses TS excess-property checking, so a Convex arg the validator will reject at runtime compiles clean
metadata:
  type: reference
---

`await updateCard({ id, ...(cond ? { pendingPlayerNames: [] } : {}) })` type-checks
even when `updateCard`'s validator has no `pendingPlayerNames` arg. TypeScript only
runs excess-property checking on **fresh object literals**; a spread (and a
pre-built variable) is exempt. Convex then rejects the unknown arg at runtime,
so the failure lands in the browser, not in `tsc`.

**Why it matters here:** the fast gate for `apps/web` leans on `tsc` to catch
client↔Convex drift while parallel work packages land their halves at different
times. A spread silently opts that call site out of the only check that would
have caught a stale or not-yet-shipped argument name.

**How to apply:** when a client call must include an argument conditionally,
write every key unconditionally with a computed value
(`pendingPlayerNames: linked ? [] : (row.pendingPlayerNames ?? [])`) rather than
spreading. It keeps the object literal fresh, so removing or renaming the
validator arg breaks the build instead of production. Reserve the spread form
for keys you have already confirmed exist.

Related: [[apps-web-root-tsc-is-red-at-baseline]] — `tsc --noEmit -p .` carries
~39 pre-existing errors, so grep your own files out of the output rather than
reading the exit code.
