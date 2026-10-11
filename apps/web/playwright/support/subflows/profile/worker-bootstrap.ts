/**
 * Port of .maestro/flows/profile/worker-bootstrap.yaml (util-tagged): sign in
 * as TEST_EMAIL_${WORKER_INDEX}, reset that user's state, seed BSC + SL creds
 * server-side, then warm both marketplace sessions (best-effort).
 *
 * Runs once per shard as the `bootstrap` project (playwright.config.ts), the
 * equivalent of run-e2e-queue.sh's Phase 0.
 */
import type { Maestro } from "../../maestro";
import { utilLoginToBsc } from "../util/util-login-to-bsc";
import { utilLoginToSportlots } from "../util/util-login-to-sportlots";

export const WORKER_BOOTSTRAP_URL_REDIRECT =
  "/testing/reset?redirect=/testing/seed-credentials?redirect=/profile/credentials";

export async function workerBootstrap(m: Maestro): Promise<void> {
  await m.launch(m.signInUrl(WORKER_BOOTSTRAP_URL_REDIRECT));
  // 90 s: one wait over the whole sign-in -> reset -> seed-credentials chain,
  // which may perform a real marketplace sign-in (NEO-141).
  await m.waitVisible("Profile Settings", 90_000);

  // Warm BSC then SportLots — `optional: true` in the flow: a miss is logged,
  // never fatal.
  for (const warm of [utilLoginToBsc, utilLoginToSportlots]) {
    try {
      await warm(m);
    } catch (e) {
      console.warn(`[optional runFlow skipped] ${warm.name}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
}
