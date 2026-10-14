// Origin: .maestro/flows/profile/worker-bootstrap.yaml (Maestro suite retired in NEO-341; see git history)
// Not a test flow (Maestro tags it `util`): the per-shard Phase-0 bootstrap,
// run by the `bootstrap` project that `e2e` depends on. Signs the shard's
// account in, resets its per-user state, seeds BSC + SportLots credentials
// server-side, then warms both marketplace sessions (best effort).
import { test, expect } from "../../support/fixtures";
import { loginToBsc, loginToSportLots } from "../../support/credentials";

test(
  "Worker bootstrap — sign in as TEST_EMAIL_${WORKER_INDEX}, reset state, and seed BSC + SL creds",
  { tag: ["@util"] },
  async ({ page, signIn, env }) => {
    await signIn(
      "/testing/reset?redirect=/testing/seed-credentials?redirect=/profile/credentials",
    );
    // One wait covers the whole redirect chain; the seed may perform a real
    // marketplace sign-in per platform (30-65 s each), hence the flow's 90 s.
    await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({
      timeout: 90_000,
    });

    // The warm-ups are an optimisation (`optional: true` in the flow): a
    // failure is logged, never fatal. The steps above stay mandatory.
    await loginToBsc(page).catch((e: Error) =>
      console.warn(`bootstrap: BSC warm-up skipped: ${e.message.split("\n")[0]}`),
    );
    await loginToSportLots(page, env).catch((e: Error) =>
      console.warn(`bootstrap: SportLots warm-up skipped: ${e.message.split("\n")[0]}`),
    );
  },
);
