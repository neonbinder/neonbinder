---
name: ref-guard-in-a-handler-passed-to-a-render-builder
description: react-hooks/refs flags a ref-reading useCallback once any handler calling it is passed into a render-time builder (idleButtons(fn)); go refless — render-time scope reset + updater guard
metadata:
  type: reference
---

In EntityColumn (and any component that builds JSX through helper functions
called during render, e.g. `idleButtons(onSync)`, `newPathContent()`), the
React Compiler lint `react-hooks/refs` reports "Cannot access refs during
render" / "Passing a ref to a function may read its value during render" when
a handler that reaches `ref.current` — even indirectly, through a
`useCallback` that reads a ref — is handed to the builder as an argument.
Defining the handler inside the builder, or as a plain closure instead of a
ternary, does NOT clear it once the callee is a ref-reading useCallback.

What does work (NEO-450): drop the refs.
- Unmount guard: unnecessary on React 19 — a state update on an unmounted
  component is a silent no-op.
- "Ignore a late answer for a scope the column has left": keep the scope IN
  the state, reset it during render when the prop-derived key changes
  (`if (state.scope !== key) setState({scope: key, ...})`), and have the async
  callback's updater bail out with `prev.scope === scope ? next : prev`.

Related: [[live-validation-without-keystroke-renders]] (ref.current in useMemo
also fails react-hooks/refs).
