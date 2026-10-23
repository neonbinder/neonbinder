---
name: compiler-memo-lost-by-derived-jsx-map
description: react-hooks/preserve-manual-memoization can fire on a useCallback/useMemo whose inferred deps (often a state setter) differ from the list given; drop the manual memo and let the React Compiler memoize, never disable the rule
metadata:
  type: reference
---

NEO-358 (2026-10-23), `app/collection/final/FinalCollectionPage.tsx`:
- Mapping a derived `tabs` array directly in JSX, next to manual memos, made
  the compiler skip the component.
- `useCallback(..., [])` around handlers that call `setDrawer` / `setNotice`
  failed with "Existing memoization could not be preserved; inferred
  dependency `setDrawer`". The error was reported at an unrelated effect
  line as well as at the callback.

**How to apply:** remove the manual `useCallback` / `useMemo` (plain
functions; the compiler memoizes them), or make the dependency list match
what the compiler infers. Do not add eslint-disable comments. Rerun
`npm run lint` — vitest and tsc do not catch this.
