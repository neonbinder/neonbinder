/**
 * The `test` every idiomatic spec imports (never import `test` from
 * @playwright/test directly).
 *
 * Fixtures:
 *   env    — the per-test variables the Maestro runners pass with `-e`
 *            (WORKER_INDEX, ATTEMPT_ID/ATTEMPT_TOKEN, TEST_USERNAME,
 *            PAUSED_PLATFORMS, SL_PAUSED). Shared with the first port:
 *            ../../playwright/support/env.ts.
 *   signIn — opens the per-flow Clerk handshake the Maestro flows enter
 *            through (`url: /testing/sign-in?redirect=<R>&worker=<n>`) and
 *            returns once the browser is on its way to <R>. The caller then
 *            asserts the destination's heading (the launch gate).
 *
 *   test("<Maestro name: verbatim>", { tag: ["@set-selector"] }, async ({ page, signIn }) => {
 *     await signIn("/set-selector");
 *     await expect(page.getByText("Build set parameters using marketplace APIs")).toBeVisible({ timeout: LAUNCH_GATE });
 *   });
 */
import { test as base, expect } from "@playwright/test";
import { makeEnv, type FlowEnv } from "../../playwright/support/env";

export type SignIn = (
  redirect: string,
  opts?: {
    /** A dedicated account key (`account=` in the flow url), e.g. "admin-no-credentials". */
    account?: string;
  },
) => Promise<void>;

/**
 * The sign-in URL exactly as the Maestro flows spell it. `redirect` is
 * passed through unencoded, nested `?` and `%26` included, because that is
 * what the flows send and what /testing/sign-in parses
 * (e.g. "/testing/reset?redirect=/testing/seed-credentials?redirect=/admin").
 */
export function signInUrl(redirect: string, worker: string, account?: string): string {
  const acct = account ? `&account=${account}` : "";
  return `/testing/sign-in?redirect=${redirect}${acct}&worker=${worker}`;
}

export const test = base.extend<{ env: FlowEnv; signIn: SignIn }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature
  env: async ({}, use) => {
    await use(makeEnv());
  },
  signIn: async ({ page, env }, use) => {
    await use(async (redirect, opts = {}) => {
      await page.goto(signInUrl(redirect, env.WORKER_INDEX, opts.account), {
        waitUntil: "domcontentloaded",
      });
    });
  },
});

export { expect };

/**
 * Explicit long budgets, named for WHY they exceed the 7 s UX budget. Use
 * one only where the Maestro flow states that timeout on that step; pass the
 * flow's own number inline if it differs from these.
 */
export const LAUNCH_GATE = 45_000; // cold launch + Clerk handshake (README "Launching a flow")
