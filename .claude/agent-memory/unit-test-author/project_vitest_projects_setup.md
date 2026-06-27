---
name: project-vitest-projects-setup
description: Vitest 4 multi-project config for neonbinder_web — node/edge-runtime for convex+lib, happy-dom for component tests
metadata:
  type: project
---

# Vitest multi-project config (neonbinder_web)

**Established in NEO-39.** `vitest.config.ts` in `neonbinder_web/` (and its worktrees) uses `test.projects` (vitest 4 API) to run two isolated environments from a single config file.

## Project layout

```
vitest.config.ts
  test.projects:
    [0] "convex-lib"   environment: node, include: convex/**/*.test.ts + lib/**/*.test.ts
                       environmentMatchGlobs: convex/** → edge-runtime  (cast as Record<string,unknown>)
    [1] "components"   environment: happy-dom, include: components/**/*.test.tsx
```

Both projects share `resolve.alias: { "@": path.resolve(__dirname, ".") }`.

## Package versions added (devDependencies)

| Package | Version |
|---|---|
| `happy-dom` | `^20.9.0` |
| `@testing-library/react` | `^16.3.2` |
| `@testing-library/dom` | `^10.4.1` |

`@testing-library/react` 16.1+ supports React 19. No `@testing-library/jest-dom` — unused.

## Focus / activeElement in happy-dom

happy-dom 20.x properly tracks `document.activeElement` after a real `.focus()` call. **`fireEvent.focus` alone does NOT update `document.activeElement`** — it only dispatches a FocusEvent. When testing hooks that inspect `document.activeElement`, always use both:

```ts
el.focus();        // sets document.activeElement (real DOM)
fireEvent.focus(el); // fires the React synthetic onFocus handler (sets focusedRef)
```

Similarly for blur:
```ts
el.blur();
fireEvent.blur(el);
```

## Test file location

`components/forms/useReactiveField.test.tsx` — co-located with the hook.

## Running tests

```bash
npx vitest run                  # both projects
npx vitest run --project components   # component tests only
npx vitest run --project convex-lib   # convex+lib only
```

## Key invariant test pattern (reactive-safe fields)

The 3+1 invariants to prove for any reactive field hook:
1. Focus-guard: external push ignored while focused
2. Mirror: external push applied while idle (blurred, not saving)  
3. Read-at-commit: onSave called with live DOM value
4. Busy-guard: external push ignored while save in flight (busyRef=true)

Use a `<Harness>` component with a re-renderable `currentValue` prop so `rerender()` can simulate external reactive pushes from useQuery.
