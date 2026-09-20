# Marketplace Adapter Dev — Agent Memory Index

- [Eslint does not cover plain ts](reference_eslint_does_not_cover_plain_ts.md) — apps/web `npm run lint` visits no plain `.ts` file, so Convex adapters and lib/ are gated only by tsc + vitest
- [Worktree node_modules linking](reference_worktree_node_modules_linking.md) — link-deps.sh checks the repo root, not apps/web; symlink main/apps/web/node_modules by hand after cmp on the lockfile
