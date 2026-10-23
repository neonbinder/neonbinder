/**
 * The `test` every idiomatic spec imports (never import `test` from
 * @playwright/test directly).
 *
 * Fixtures:
 *   env    — the per-test variables the Maestro runners pass with `-e`
 *            (WORKER_INDEX, WORKER_KEY, ATTEMPT_ID/ATTEMPT_TOKEN,
 *            TEST_USERNAME, PAUSED_PLATFORMS, SL_PAUSED), minted per
 *            project so the desktop and mobile runs never share a name.
 *            Shared with the first port: ./env.ts.
 *   signIn — opens the per-flow Clerk handshake the Maestro flows enter
 *            through (`url: /testing/sign-in?redirect=<R>&worker=<n>`) and
 *            returns once the browser is on its way to <R>. The caller then
 *            asserts the destination's heading (the launch gate).
 *
 * Plus `expectAccessible(page, { within?, label? })`, the axe check (below),
 * and Playwright's own `isMobile` fixture for the rare genuine layout branch.
 *
 *   test("<Maestro name: verbatim>", { tag: ["@set-selector"] }, async ({ page, signIn }) => {
 *     await signIn("/set-selector");
 *     await expect(page.getByText("Build set parameters using marketplace APIs")).toBeVisible({ timeout: LAUNCH_GATE });
 *   });
 */
import { test as base, expect, type Page } from "@playwright/test";
import { checkAccessibility, type AccessibleOptions } from "./a11y";
import { makeEnv, type FlowEnv } from "./env";

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
  env: async ({}, use, testInfo) => {
    // The project feeds the d/m marker in every minted name (./env.ts).
    await use(makeEnv(testInfo.project.name));
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
 * Fails the test if axe finds any WCAG 2.0/2.1/2.2 A or AA violation on the
 * page (or only `within` a region), listing each violated rule with the mode
 * (light or dark) it came from. It checks BOTH modes by flipping the OS
 * colour scheme, and ends with the OS dark; a page that cannot flip is
 * checked in the mode it is in and says so. A spec that saved an explicit
 * theme restores System before calling. Call it once
 * the screen or state is on show, i.e. right after the assertion that proves
 * it, at every new screen or state a spec reaches; it runs on both projects.
 * See ./a11y.ts and playwright/GUIDE.md, "Accessibility checks".
 *
 *   await expect(dialog.getByRole("heading", { name: "New Team" })).toBeVisible();
 *   await expectAccessible(page, { within: dialog, label: "New Team dialog" });
 */
export async function expectAccessible(page: Page, opts: AccessibleOptions = {}): Promise<void> {
  const label = opts.label ?? new URL(page.url()).pathname;

  await test.step(`accessibility: ${label}`, () => checkAccessibility(page, test.info(), opts), { box: true });
}

/**
 * Explicit long budgets, named for WHY they exceed the 7 s UX budget. Use
 * one only where the Maestro flow states that timeout on that step; pass the
 * flow's own number inline if it differs from these.
 */
export const LAUNCH_GATE = 45_000; // cold launch + Clerk handshake (README "Launching a flow")
