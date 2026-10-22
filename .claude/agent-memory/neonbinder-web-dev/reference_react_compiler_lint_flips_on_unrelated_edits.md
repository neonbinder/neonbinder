---
name: react-compiler-lint-flips-on-unrelated-edits
description: In CardChecklist.tsx the react-hooks preserve-manual-memoization lint (React Compiler) reports 8 errors at far-away useCallbacks when a render-time call passes a hook-derived local to an imported function; results also flickered between runs. Bisect with eslint --stdin, and run lint 2-3 times
metadata:
  type: reference
---

`components/SetSelector/CardChecklist.tsx` sits on the edge of the React
Compiler's analysis. NEO-339's autograph-prompt refactor made `npm run lint`
report 8 "Compilation Skipped: Existing memoization could not be preserved"
errors at unrelated `useCallback`s (~lines 1240, 1300, 2205–2250: "inferred
dependency was `setPairingPhase`"). Baseline was clean.

What tripped it: in the JSX gate, `autographPromptAsks(leafAutographFormat, count)`
where `leafAutographFormat = asAutographFormat(variantRow?.features?.autographFormat)`
(a local built from a `useQuery` result by an imported call). Passing the raw
field instead, `autographPromptAsks(variantRow.features?.autographFormat, count)`,
was clean 5/5. The same file content ALSO gave different answers across runs
(clean, then 8, then clean) while it was near that edge, so a variant that
"passed once" proved nothing.

**How to apply:** bisect without touching the file:
`sed '<variant>' CardChecklist.tsx | npx eslint --stdin --stdin-filename components/SetSelector/CardChecklist.tsx`,
baseline via `git show <base>:apps/web/... | npx eslint --stdin …`. Accept a
variant only after 3 clean runs, then 2–3 clean `npm run lint`. Prefer
imported helpers that take raw fields or primitives, and keep comments in
the JSDoc above a `const`, not inside a hook call.
Related: [[reference-vitest-components-project-only-tsx]].
