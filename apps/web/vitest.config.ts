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
      defineProject({
        test: {
          name: "components",
          environment: "happy-dom",
          globals: true,
          include: ["components/**/*.test.tsx", "src/**/*.test.tsx"],
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
