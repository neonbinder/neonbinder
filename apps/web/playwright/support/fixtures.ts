/**
 * The `test` every spec imports. Adds two fixtures:
 *   env — the per-test Maestro `-e` variables (see ./env.ts)
 *   m   — the Maestro-shaped driver (see ./maestro.ts)
 *
 *   import { test } from "../../support/fixtures";
 *   test("Sign In", { tag: ["@smoke", "@auth"] }, async ({ m }) => { ... });
 */
import { test as base } from "@playwright/test";
import { makeEnv, type FlowEnv } from "./env";
import { Maestro } from "./maestro";

export const test = base.extend<{ env: FlowEnv; m: Maestro }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature
  env: async ({}, use) => {
    await use(makeEnv());
  },
  m: async ({ page, env }, use) => {
    await use(new Maestro(page, env));
  },
});

export { expect } from "@playwright/test";
