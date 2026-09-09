---
name: reference-reactive-field-editing-in-tests
description: How to simulate editing a useReactiveField-backed input (SetAttributesPanel/CardFeaturesEditor/ReactiveTextField) in RTL tests, and how to route useQuery/useMutation mocks by query/mutation identity when a component calls multiple distinct ones.
metadata:
  type: reference
---

# Editing useReactiveField-backed inputs in tests (apps/web)

Any row built on `components/forms/useReactiveField.ts` (directly, or via
`FeatureValueControl`'s `TextValueControl`) is an **uncontrolled** input —
`defaultValue` only, commit happens on blur/Enter reading the live DOM value.
To simulate a user edit in RTL/happy-dom you need BOTH the real DOM call and
the React synthetic event, for both focus and blur:

```ts
el.focus();                          // sets document.activeElement (mirror-guard)
fireEvent.focus(el);                 // sets the hook's internal focusedRef
el.value = "new value";
fireEvent.input(el, { target: { value: "new value" } });
el.blur();                           // clears document.activeElement
fireEvent.blur(el);                  // fires onBlur -> runCommit()
```

Wrap in `await act(async () => { ... })` and then `await waitFor(...)` on the
mutation spy — commit is async. Skipping either the real `.focus()`/`.blur()`
or the synthetic `fireEvent.focus`/`fireEvent.blur` breaks the invariant
(mirror-guard uses `document.activeElement`; commit uses `focusedRef`/`onBlur`).
This mirrors the pattern already established in
`components/forms/useReactiveField.test.tsx`.

Established while writing `components/SetSelector/SetAttributesPanel.test.tsx`
and `components/SetSelector/CardFeaturesEditor.test.tsx` (NEO-71-74 write-once
feature snapshot coverage).

## Routing useQuery/useMutation mocks by identity

When a component calls `useQuery`/`useMutation` more than once with different
`api.*` references (e.g. `SetAttributesPanel` calls both
`getSelectorOptionById` and `getAncestorChain`, and both
`setSelectorOptionFeature` and `setSetMetadata`), mock the `api` module so
each leaf resolves to its own **string identity**, then switch on that string
inside a single `convex/react` mock:

```ts
vi.mock("../../convex/_generated/api", () => ({
  api: { selectorOptions: {
    getSelectorOptionById: "getSelectorOptionById",
    getAncestorChain: "getAncestorChain",
    setSelectorOptionFeature: "setSelectorOptionFeature",
    setSetMetadata: "setSetMetadata",
  } },
}));

vi.mock("convex/react", () => ({
  useQuery: (query: string) =>
    query === "getSelectorOptionById" ? currentRow
    : query === "getAncestorChain" ? currentChain
    : undefined,
  useMutation: (mutation: string) =>
    mutation === "setSelectorOptionFeature" ? mockSetFeature
    : mutation === "setSetMetadata" ? mockSetMetadata
    : vi.fn(),
}));
```

Use `let currentRow; let currentChain;` (reassigned per-test, not per-`describe`)
so each `it` controls its own fixtures without needing separate mock modules.
This is a variant of the single-`mockQuery.mockReturnValue(...)` pattern in
`drill-forms-onDone.test.tsx` — that pattern only works when a component calls
`useQuery` exactly once; switch to identity-routing as soon as a component
calls it more than once with different query refs.

## Extending identity-routing to three hooks (useAction + useMutation + useQuery)

The same identity-routing pattern extends cleanly to a component that uses
all three Convex hooks at once — e.g. `BaseMappingForm` (`useAction` for
`fetchRawOptions`, `useMutation` for `setVariantTypePlatformData`, `useQuery`
for `getAncestorChain`). Mock all three in one `vi.mock("convex/react", ...)`
block, each switching on its own string ref (precedent already existed in
`EntityColumn.ensure-sync.test.tsx`, which combines `useAction` + `useMutation`
+ `useQuery`). No special handling needed for a modal child component (e.g.
`BaseSetPicker`) that the form under test renders conditionally — just render
the parent and interact with the child's real rendered buttons
(`screen.getByText("Cancel")` etc.) rather than mocking the child.

One nuance for components that open a picker synchronously and populate it
async: if the mocked action's promise resolves before the effect's own
`await`, `act(async () => { fireEvent.click(...) })` flushes both the
synchronous state updates (`setPickerOpen(true)`) AND the async resolution in
one go — so asserting the post-resolution state (e.g. re-opened picker
heading text) right after that `act` block works without extra `waitFor`,
though `waitFor` is still safest as a defensive wrapper. Established in
`components/SetSelector/BaseMappingForm.test.tsx` (NEO-71-74 cancel-recovery
regression).

## getByLabelText collisions on repeated aria-labels

Components that render one "Missing required feature" (or similar) marker per
row will have MULTIPLE elements sharing that exact aria-label when several
rows are simultaneously blank. `screen.getByLabelText(...)` throws
"multiple elements found" in that case — use
`screen.getAllByLabelText(...).length` instead, or scope the query to a
specific row's container.
