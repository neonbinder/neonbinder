// Origin: .maestro/flows/placeholders/pipeline-escalation-cold-start.yaml (Maestro suite retired in NEO-341; see git history)
// R1: six CORNERED scans (three front/back pairs), dropped on the real
// /print/placeholders drop zone, are declined by the fast service and escalate
// to the heavy one. The user sees each escalating photo badged, every photo
// still finishes (more escalations than the heavy cap), and the batch ends in
// three pairs, none failed.
//
// NEO-529: the batch-level cold-start notice ("A few of these need a closer
// look...") is NOT asserted here. The run view appears only after the last
// photo is up, and on a warm heavy pool the escalating state lasts only 3-4 s
// past the upload's end, so the notice cannot be caught reliably from the
// screen. It is proven by unit tests instead: intake.test.tsx (the notice on
// `heavyWarming`) and convex/placeholderEscalation.test.ts (`deriveHeavyWarming`).
// Jason, 2026-11-13. The ceilings (UPLOAD_CEILING, HEAVY_CEILING) are approved
// and measured in support/placeholder-intake.ts.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import {
  HEAVY_CEILING,
  discardIfStillOpen,
  finishPlaceholderBatch,
  placeholderScans,
  startPlaceholderBatch,
} from "../../support/placeholder-intake";

test.afterEach(async ({ page }, testInfo) => {
  await discardIfStillOpen(page, testInfo);
});

test(
  "Placeholder pipeline (heavy escalation) — six photos past the heavy cap show as escalating, all finish, three pairs, none failed",
  { tag: ["@placeholders"] },
  async ({ page, signIn }) => {
    await signIn("/print/placeholders");
    await expect(page.getByRole("heading", { name: "Upload your cards" })).toBeVisible({ timeout: LAUNCH_GATE });

    await startPlaceholderBatch(page, placeholderScans("placeholder-fixtures-corner"));

    // Each escalating photo carries its own badge, so a photo on the slow path
    // never looks stuck.
    await expect(page.getByText(/Escalating.*deeper processing/).first()).toBeVisible();
    await expectAccessible(page, { label: "Placeholder upload, escalating" });

    // More escalations than the heavy cap still ALL finish: every photo is read.
    // "Finish the batch" shows once all six have settled, read or failed, so a
    // failed photo stops the spec here on the headline that names it (NEO-440).
    await expect(page.getByRole("button", { name: "Finish the batch" })).toBeVisible({ timeout: HEAVY_CEILING });
    await expect(page.getByText("All 6 photos read.")).toBeVisible();

    await finishPlaceholderBatch(page);
    await expectAccessible(page, { label: "Placeholder batch, pairs ready" });
  },
);
