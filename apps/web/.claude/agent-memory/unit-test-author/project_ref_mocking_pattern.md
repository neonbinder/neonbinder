---
name: project_ref_mocking_pattern
description: Repo-wide convex/react mocking pattern — route useQuery/useMutation/useAction by (string-mocked) api ref, with a safe undefined/vi.fn() default for refs a test doesn't care about
metadata:
  type: project
---

Every `components/SetSelector/*.test.tsx` file that touches a component
calling `convex/react` hooks follows the same shape (see
`EntityColumn.ensure-sync.test.tsx`, `CardChecklistItem.test.tsx`,
`CardChecklist.test.tsx`):

1. `vi.mock("../../convex/_generated/api", ...)` replaces `api.<domain>.<fn>`
   with plain **strings** (the function name itself, e.g.
   `getCardChecklist: "getCardChecklist"`).
2. `vi.mock("convex/react", ...)` provides `useQuery`/`useMutation`/`useAction`
   that switch on that string ref and return per-test-controlled values/mocks.
3. A mutable `state` object (module-level, reset in `beforeEach`) holds the
   current value for each query ref, read lazily inside the mocked `useQuery`
   — this lets a single test rerender/act through several states without
   remounting.
4. **Always give the mocked hooks a safe default branch** (`return undefined;`
   for queries, `return vi.fn();` for mutations/actions) rather than throwing
   on an unrecognized ref. A component under test frequently mounts *child*
   components unconditionally (e.g. `CardChecklist` always renders
   `CrossListingImportModal`, just with `isOpen={false}`), and those children's
   own `useQuery`/`useMutation` calls still execute per the Rules of Hooks even
   though nothing renders. Without a default branch every one of those calls
   throws or returns garbage and the whole tree fails to mount.
5. Import the component under test **after** the `vi.mock` calls (hoisting
   handles the ordering, but writing it this way keeps the file readable top
   to bottom).

For an action whose *timing* matters (racing a cancel against a late
resolution — see `CardChecklist.test.tsx`'s NEO-189 regression test), mock it
with a manually-controlled deferred promise:

```ts
let resolveFetch: (value: unknown) => void;
mockFetchChecklist.mockImplementation(
  () => new Promise((resolve) => (resolveFetch = resolve)),
);
// ...fire the click that starts the async handler...
// ...fire the cancel...
await act(async () => { resolveFetch(lateResult); });
// assert the late result was dropped, not applied
```

## Verifying a new test isn't hollow

For a regression test in particular, temporarily revert the fix in the
component file (not the test), rerun `npx vitest run <file>`, confirm it
fails for the expected reason, then restore the file from a `cp` you took
before reverting. Do the same for an a11y invariant (e.g. flip
`aria-disabled` back to native `disabled`) to prove the assertion actually
distinguishes the two. This is cheap with a two-line `cp` before/after and is
worth doing every time — it's the only way to know an assertion isn't
vacuously true against the current component.

See also [[project_test_infrastructure]].
