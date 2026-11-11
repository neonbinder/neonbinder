---
name: signed-in-pages-must-not-import-demo-values
description: A VALUE import from app/dashboard/fake-data (or the demo store) in a shared screen drags demo data into signed-in chunks; demo-only data goes in a side-effect sample module; how to trace built chunks
metadata:
  type: reference
---

`app/dashboard/fake-data.ts` builds the demo at module load from the demo
store (`initialCollectionState`) and the prototypes' fake catalog. Any
**value** import of it from a module the signed-in page loads (a constant,
a helper, a fallback like `data.binders ?? bindersOf(data)`) puts the demo
store and seed in `/dashboard`'s static graph. `import type` is erased and is
fine; a mixed `import { x, type Y }` is not.

NEO-464 split: shared words live in `app/dashboard/dash-labels.ts`
(MARKETPLACES, isLate, daysAgoLabel, re-exported by fake-data), and the demo
hands the screen its shelf (`getDashboard()` fills `binders`), so
DashboardScreen derives nothing.

**How to check:** build to a scratch `--outDir`, find the page chunk by a
string only it holds ("Loading your dashboard."), walk `import … from
"./x.js"` statically (ignore the `__vite__mapDeps` preload list, which is
dynamic), and grep the reached chunks for a demo-only marker (an order number
from fake-data, the demo store's sessionStorage key). Rollup also merges the
demo store into whatever shared chunk has the same importer set (it sat in the
`label-*` chunk), so the chunk name will not tell you.

The prototypes' fake catalog (`_shared/catalog.ts`) is still reached from the
signed-in graph through CardFace's chunk; growing it grows signed-in pages.

**Growing the demo's data without growing signed-in pages:** the demo store
(`app/collection/final/store.ts`) is ALSO loaded by the signed-in Collection
and Inventory pages, so demo-only data cannot be imported from it or from the
catalog. Put it in a side-effect module (NEO-464:
`app/collection/final/data/sample/`) that calls `extendCatalog` +
`refreshDataIndexes` and pushes to the collector seed, imported first thing by
the demo entries only (`DashboardDemoLayout`, `PublicCollectionDemo`;
`fake-data` imports it too). The store reads it through a lookup that returns
null when it is not loaded. Lazily built indexes (demoStore, search) pick it
up; the eager index maps in `_shared/data.ts` need the refresh.
