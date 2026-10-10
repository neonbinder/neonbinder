---
name: source-slice-tests-key-on-export-names
description: Some convex tests readFileSync a module and slice between two `export const X` markers; deleting or renaming an export turns indexOf into -1 and the slice into the whole file
metadata:
  type: reference
---

Several apps/web convex tests (e.g. `enrichmentCreationOnly.test.ts`) pin "this
function body does not contain Y" by `readFileSync`-ing the module and slicing
`src.indexOf("export const A")` .. `src.indexOf("export const B")`, where B is
simply the NEXT export in the file. Deleting or renaming B makes its
`indexOf` return -1, `slice(start, -1)` then spans to the end of the file, and
the `not.toContain` assertion goes red on code from unrelated functions — or,
for a `toContain`, passes for the wrong reason.

**How to apply:** before deleting/renaming any exported Convex function, run
`grep -rn 'indexOf("export const <name>' convex lib` (and the bare name in
quotes). Repoint the slice end at the new next export with enough of the
signature to be unique (`"export const get = query"`, not `"export const get"`,
which also prefixes `getManyByIds`). Found on NEO-331 deleting `teams.list`.
Related: [[a-green-suite-can-mean-the-test-stopped-testing]].
