---
name: patterns-public-function-guard-sweep
description: How to sweep convex/ for public functions missing an identity check — the full guard-helper inventory, the two false-negative traps, and the classes that are legitimately ungated
metadata:
  type: project
---

# Sweeping `convex/` for unguarded public functions

Every `query` / `mutation` / `action` export is client-callable — the deployment
URL ships in the bundle. `auth.ts`'s `requireSignedIn` docstring is the canonical
statement of the rule and of the three acceptable outcomes (internal* > guard >
public-by-intent-with-a-comment-naming-the-anonymous-caller). Read it first.

## The sweep that actually works

Grepping for `requireAdmin` alone gives a ~20% false-positive rate. Two traps:

1. **Guards hide behind helpers.** The full inventory as of NEO-202:
   `requireAdmin`, `requireSignedIn` (both `auth.ts`); `requireUserId` and
   `findOwnedJob` (exported from `placeholderPipeline.ts`, used across
   `placeholderPairing.ts` / `placeholderStream.ts`); `assertAuthorized`
   (`e2eQueue.ts`, shared-secret not identity); bare
   `getCurrentUserId` + an explicit null branch. Miss these and ~19 correctly
   guarded functions look naked.
2. **Substring matches hit comments.** Match `guard + "("` on lines that do not
   start with `//`, `*`, or `/*`, or long docstrings mentioning `requireAdmin`
   read as guarded.

Also check the *offset* of the first guard inside the handler. Every current hit
deeper than ~6 lines is a long TS return-type annotation or comment block, not
work-before-the-check — but that is the shape a real bug takes.

Baseline: **129 public exports**, 3 with no executable guard, all deliberate.
`httpAction`s live in `http.ts` (all delegate to `e2eQueue`'s secret gate) and
`machineAuth.ts`.

## Bare `getCurrentUserId` is not automatically a finding

All 33 such callers reject null correctly — some `throw`, some return a neutral
empty value (`[]` / `null` / `0` / `false`). Returning empty is the RIGHT choice
for a reactive `useQuery` that mounts before Clerk resolves (see
`checklistCandidates.getReadyCandidates`); a throw there surfaces as a broken
subscription. Judge per call site, do not blanket-convert to `requireSignedIn`.

## Legitimately ungated (do not re-litigate, but do re-verify the stated reason)

- `publicProfile.getPublicProfileByUsername` — the anonymous buyer on
  `/u/<username>` and `/u/<username>/sale`. These are the ONLY Convex calls on
  any anonymous route (verified against `src/main.tsx`'s public route list).
  Safety rests on `userId` being omitted from the returns validator.
- `publicProfile.checkUsernameAvailable` — boolean-only enumeration oracle.
  **Its docstring's stated caller ("the signup form, before an account exists")
  is stale**: the only caller is `PublicProfileEditor`, which sits behind
  `ProtectedLayout`. Harmless (strictly less disclosive than the query above),
  but the defense in the comment no longer matches the code.
- `e2eQueue.*` (6 functions) — shared-secret + fail-closed on unset
  `E2E_QUEUE_SECRET`, machine-to-machine, never in prod. Identity would be wrong.

## The recurring defect shape: the inconsistent twin

NEO-154 found `teams.findOrCreate` unguarded while `players.findOrCreate` was
guarded. NEO-202 found the same thing with the sides swapped —
`players.getManyByIds` unguarded while the `teams.getManyByIds` its own docstring
names as its mirror called `requireSignedIn`. **When auditing, diff mirrored
function pairs across `players.ts` / `teams.ts` explicitly.**

## `fetchCardChecklist` (NEO-202) — why it mattered more than a missing guard

Unauthenticated it drove authenticated BSC/SportLots fetches with our stored
credentials from our egress IP (pre-existing), and after NEO-195 also a
~900-row-per-call insert into `checklistCandidates` (new). Fixed with
`requireAdmin` **outside** the handler's `try` — the catch converts throws into
`{success:false, message}`, so a guard inside it would render an authz failure
as a marketplace outage. Applies to any `try`-wrapped action here.

The removed `?? "unknown"` fallback was itself a bug, not just dead code:
`startCandidateBatch` clears prior rows scoped to
`(selectorOptionId, createdByUserId)`, so every anonymous run shared one owner
and deleted the previous run's work. **A defensive `?? "sentinel"` on an owner
key is a data-loss bug wherever ownership scopes a delete.**

Regression coverage: `convex/publicFunctionAuthGuards.test.ts` — asserts the
rejections, asserts zero rows written on the anonymous path, and pins the two
public-by-intent queries as anonymous-callable so a future blanket sweep breaks
loudly.
