/**
 * NEO-164 — the single source of truth for which files are unit tests.
 *
 * These globs are imported by BOTH `vitest.config.ts` (to collect tests) and
 * `scripts/verify-test-completeness.mjs` (to prove every collected file
 * actually reported a result). They must not be duplicated: the whole point of
 * the verifier is that it catches a file the run did not execute, and it can
 * only do that if it derives "should have run" from the same list vitest uses.
 * Two copies would drift, and the drift would land on the side of silence.
 *
 * A new top-level directory holding tests needs a glob added HERE, and only
 * here. The verifier will then start failing the run for any such file that
 * does not report — which is the loud version of the bug NEO-128 and NEO-141
 * both hit as silence.
 *
 * `.mjs` rather than `.ts` so a plain `node` script can import it without a
 * TypeScript loader.
 */

/**
 * Node/edge tests: Convex functions, pure libs, and the build/CI scripts under
 * `scripts/` (which are plain `.mjs`, so they carry a `.test.mjs` suffix).
 */
export const CONVEX_LIB_INCLUDE = [
  "convex/**/*.test.ts",
  "lib/**/*.test.ts",
  "scripts/**/*.test.mjs",
];

/**
 * React component tests (happy-dom).
 *
 * `src/**` sits alongside `components/**` because layouts live in src/layouts/
 * (NEO-128); `app/**` because routed pages live under app/ (NEO-141). In both
 * cases a test file in the uncovered directory was collected by nothing and
 * never ran, and the suite still printed "passed".
 */
export const COMPONENTS_INCLUDE = [
  "components/**/*.test.tsx",
  "src/**/*.test.tsx",
  "app/**/*.test.tsx",
];

/** Every unit-test glob, across both projects. */
export const ALL_TEST_INCLUDE = [...CONVEX_LIB_INCLUDE, ...COMPONENTS_INCLUDE];

/**
 * Directory names that must never contribute test files, regardless of the
 * globs above. Guards against a dependency shipping its own `*.test.tsx` under
 * a path that happens to sit beneath one of our roots.
 *
 * Applied by the verifier as a plain path filter rather than through
 * `fs.globSync`'s `exclude` option, because that option's contract changed
 * across Node versions — it takes a predicate function on Node 22 and accepts
 * an array of patterns on Node 24. `npm run` resolves `node` from PATH, which
 * on this machine is not necessarily the version in `.nvmrc`, so the script
 * must not depend on which one it gets.
 */
export const EXCLUDED_DIRS = ["node_modules", "dist", "build"];

/**
 * DISCOVERY glob — deliberately broader than the COLLECTION globs above, and
 * it must stay that way.
 *
 * The verifier's job is to notice a test file that did not run. If it derived
 * "should have run" from the same patterns vitest collects from, the check
 * would be tautological for the most common miss: a file vitest does not
 * collect is also not expected, so it is never reported, and the run prints a
 * green completeness tick that cannot possibly detect it. That is worse than
 * having no check, because the tick is what a reviewer trusts instead of
 * comparing counts by hand.
 *
 * The realistic miss is not a whole new directory — it is an extension/root
 * pairing, because collection pairs them narrowly: `.test.ts` only under
 * convex/ and lib/, `.test.tsx` only under components/, src/ and app/,
 * `.test.mjs` only under scripts/. So `lib/print/sheet-layout.test.tsx` (a
 * happy-dom test for a lib helper) or `components/SetSelector/helpers.test.ts`
 * (a non-JSX unit test beside its component) are collected by nothing today.
 *
 * Discovery therefore matches ANY test-shaped filename under ANY source root,
 * and the verifier fails on anything it finds that reported no result. Two
 * independently-derived sets, which is the only way the comparison means
 * something. Verified to produce zero false positives on the current tree.
 */
export const TEST_FILE_GLOB = "*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";
