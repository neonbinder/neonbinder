---
name: lockfile-peer-flag-churn
description: Any npm install in apps/web drops ~26 stale `"peer": true` flags (the @esbuild/* platform packages) from package-lock.json; restore them by script to keep a dependency diff minimal
metadata:
  type: reference
---

`npm install <pkg>` in `apps/web` (npm 11.4 from .nvmrc's Node AND npm 11.19 from newer Node alike) rewrites the lockfile without the `"peer": true` lines on the `@esbuild/*` optional platform packages. That is 26+ unrelated deletions in a PR that only meant to add a dependency. npm 11.19 also blocks install scripts by default (`npm warn install-scripts … esbuild postinstall`), so use the .nvmrc Node for the install itself.

**How to apply:** copy `package.json` + `package-lock.json` to the scratchpad first, install with the .nvmrc Node, then run a small node script that, for every package that had `peer: true` in the old lock and still exists, re-inserts the key in its old position, and writes `JSON.stringify(lock, null, 2) + "\n"`. `git diff --stat` should then show only the new packages. Check `npm ls <pkg>` afterwards. Related: [[gates-in-a-shared-worktree]].
