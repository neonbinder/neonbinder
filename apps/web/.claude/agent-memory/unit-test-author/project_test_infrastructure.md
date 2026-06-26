---
name: project_test_infrastructure
description: Vitest setup, project layout, and component test patterns for neonbinder_web
metadata:
  type: project
---

## Test runner: Vitest v4 with two projects

Config at `neonbinder_web/vitest.config.ts`:

- **convex-lib** — `environment: "node"`, `include: ["convex/**/*.test.ts", "lib/**/*.test.ts"]`
- **components** — `environment: "happy-dom"`, `include: ["components/**/*.test.tsx"]`

Both projects resolve `@` to the project root via `resolve.alias`.

## Running tests

No `npm test` script exists. Invoke vitest directly:

```bash
# Run a specific file
npx vitest run convex/credentialLock.test.ts

# Run all component tests
npx vitest run --project components

# Run all convex/lib tests
npx vitest run --project convex-lib
```

Tests are NOT in CI — unit tests must be run manually for now.

## convex-test patterns (internalMutation + getUserProfile)

convex-test version: `0.0.53`. Pattern used in `testing.test.ts`, `selectorOptions.addCustom.test.ts`, `credentialLock.test.ts`.

### Module discovery (required boilerplate)

```typescript
const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");
```

Pass `modules` as second arg: `convexTest(schema, modules)`.

### Calling internalMutations

Use `t.mutation(internal.userProfile.acquireCredentialLock, args)`. The `internal` export is in `./_generated/api` alongside `api` — both exported from the same file. No special setup needed.

```typescript
import { api, internal } from "./_generated/api";
// ...
await t.mutation(internal.userProfile.acquireCredentialLock, { userId, site, op, token });
```

### Auth-gated queries

```typescript
const profile = await t
  .withIdentity({ subject: USER_A })
  .query(api.userProfile.getUserProfile, {});
```

Only `subject` is required in `withIdentity` for `getCurrentUserId(ctx)` to return the subject string.

### Direct DB access for assertions

`t.run(async (ctx) => ...)` gives raw DB access. Use this to:
- Seed rows with fields that no public mutation accepts (e.g. `lockToken`, `lockedAt` pre-set to specific timestamps)
- Read back fields stripped by projections (e.g. `lockToken` that `getUserProfile` intentionally omits)
- Assert on internal DB state that has no corresponding query

```typescript
// Seed a profile with a stale lock for reclaim testing
await t.run(async (ctx) => {
  await ctx.db.insert("userProfiles", {
    userId,
    siteCredentials: [{ site, hasCredentials: false, lockedAt: Date.now() - CRED_LOCK_LEASE_MS - 1000, ... }],
  });
});

// Read back a field the query strips
const entry = await t.run(async (ctx) => {
  const profile = await ctx.db.query("userProfiles").withIndex("by_user", q => q.eq("userId", userId)).unique();
  return profile?.siteCredentials?.find(c => c.site === site) ?? null;
});
```

### Exported constants from production files

You can import production constants alongside test utilities:

```typescript
import { CRED_LOCK_LEASE_MS } from "./userProfile";
```

This keeps tests in sync with the production lease value without hardcoding.

## Standard mocking pattern (component tests)

From `EntityColumn.custom-select.test.tsx` and `EntityColumn.field-class.test.tsx`:

```typescript
vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptions: "getSelectorOptions",
      addCustomSelectorOption: "addCustomSelectorOption",
    },
  },
}));

const mockAddCustom = vi.fn();
const mockQuery = vi.fn();

vi.mock("convex/react", () => ({
  useMutation: () => mockAddCustom,
  useQuery: () => mockQuery(),
}));
```

- `api` members are used only as identity keys — plain strings work fine.
- `useMutation` always returns the same spy regardless of which mutation key is passed.
- `useQuery` returns whatever `mockQuery()` returns — configure per test or in `beforeEach`.

## Key gotcha: EntityColumn auto-sync

Return `mockQuery.mockReturnValue(undefined)` (not `[]`) to keep EntityColumn in idle mode. See [[feedback_autosync_idle_mode]].
