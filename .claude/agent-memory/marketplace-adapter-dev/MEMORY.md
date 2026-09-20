# Marketplace Adapter Dev — Agent Memory Index

- [Eslint does not cover plain ts](reference_eslint_does_not_cover_plain_ts.md) — apps/web `npm run lint` visits no plain `.ts` file, so Convex adapters and lib/ are gated only by tsc + vitest
- [Generated api.d.ts needs a hand edit in worktrees](reference_generated_api_needs_hand_edit_in_worktrees.md) — new convex module → add its two lines to `_generated/api.d.ts` when `npx convex codegen` has no CONVEX_DEPLOYMENT; V8 files cannot import "use node" files
