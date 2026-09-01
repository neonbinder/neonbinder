import { defineConfig, defineProject } from "vitest/config";
import path from "path";
import {
  COMPONENTS_INCLUDE,
  CONVEX_LIB_INCLUDE,
} from "./vitest.include.mjs";

// NEO-188: both projects install a fetch guard that turns any real outbound
// request into a failed run. It goes on EVERY project deliberately — the
// original leak was a scheduled Convex function calling BSC's prod API, and
// a guard only one project honors leaves that class open on the other.
const NETWORK_GUARD = path.resolve(__dirname, "./vitest.setup.network-guard.ts");

// `environmentMatchGlobs` is the field convex-test docs recommend but it's
// not in the current Vitest types. Cast so tsc stays clean — runtime
// behavior is unaffected.
export default defineConfig({
  test: {
    projects: [
      // Project 1: existing node/edge convex + lib tests — UNCHANGED behavior
      defineProject({
        test: {
          name: "convex-lib",
          environment: "node",
          globals: true,
          include: CONVEX_LIB_INCLUDE,
          setupFiles: [NETWORK_GUARD],
          ...({ environmentMatchGlobs: [["convex/**", "edge-runtime"]] } as Record<string, unknown>),
        },
        resolve: {
          alias: {
            "@": path.resolve(__dirname, "."),
          },
        },
      }),
      // Project 2: React component tests with happy-dom.
      //
      // The include globs now live in ./vitest.include.mjs, shared with
      // scripts/verify-test-completeness.mjs (NEO-164). A new top-level dir
      // holding tests needs a glob added THERE, not here.
      //
      // Two failure modes made that sharing necessary, and both were silent:
      // a test file in a directory no glob covers is collected by nothing and
      // never runs (NEO-128 for src/layouts/, NEO-141 for app/), and a worker
      // fork can die mid-run and drop a file that WAS collected. Neither
      // errors — the run simply reports fewer tests and still prints "passed".
      // The verifier now turns both into a failed run, so "compare COUNTS, not
      // the word passed" is enforced rather than remembered.
      defineProject({
        test: {
          name: "components",
          environment: "happy-dom",
          globals: true,
          include: COMPONENTS_INCLUDE,
          setupFiles: [NETWORK_GUARD],
        },
        resolve: {
          alias: {
            "@": path.resolve(__dirname, "."),
          },
        },
      }),
    ],
  },
});
