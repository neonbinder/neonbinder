import { defineConfig, defineProject } from "vitest/config";
import path from "path";

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
          include: ["convex/**/*.test.ts", "lib/**/*.test.ts"],
          ...({ environmentMatchGlobs: [["convex/**", "edge-runtime"]] } as Record<string, unknown>),
        },
        resolve: {
          alias: {
            "@": path.resolve(__dirname, "."),
          },
        },
      }),
      // Project 2: React component tests with happy-dom.
      // `src/**` is included alongside `components/**` because layouts live in
      // src/layouts/ (NEO-128) — without it a test file there is silently
      // collected by nothing and never runs.
      // `app/**` is included for the same reason (NEO-141): routed pages live
      // under app/, so a page test there was collected by nothing either.
      // Note the failure mode — an uncollected test does not error. The run
      // simply reports fewer tests and still prints "passed", so compare
      // COUNTS, not the word. A new top-level dir holding .test.tsx needs a
      // glob added here.
      defineProject({
        test: {
          name: "components",
          environment: "happy-dom",
          globals: true,
          include: [
            "components/**/*.test.tsx",
            "src/**/*.test.tsx",
            "app/**/*.test.tsx",
          ],
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
