// Port of .maestro/flows/profile/worker-bootstrap.yaml. Not a test flow
// (Maestro tags it `util`); it is the per-shard Phase-0 bootstrap, run by the
// `bootstrap` project that `e2e` depends on (see playwright.config.ts).
import { test } from "../../support/fixtures";
import { workerBootstrap } from "../../support/subflows/profile/worker-bootstrap";

test(
  "Worker bootstrap — sign in as TEST_EMAIL_${WORKER_INDEX}, reset state, and seed BSC + SL creds",
  { tag: ["@util"] },
  async ({ m }) => {
    await workerBootstrap(m);
  },
);
