// Origin: .maestro/flows/placeholders/pipeline-escalation-cold-start.yaml (Maestro suite retired in NEO-341; see git history)
// Six CORNERED scans (three front/back pairs) are declined by the fast service
// and escalate to the heavy one, which cold-loads its model. The user must be
// told while that runs, and every photo must still finish.
import { test, expect, expectAccessible } from "../../support/fixtures";

test(
  "Placeholder pipeline (heavy escalation) — six photos past the heavy cap, cold-start notice, three pairs, none failed",
  { tag: ["@placeholders"] },
  async ({ page, signIn }) => {
    await signIn("/testing/seed-placeholder-upload%3Ffixtures%3Dplaceholder-fixtures-corner");
    await expect(page.getByText("Upload your cards")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText("Your cards", { exact: true })).toBeVisible();

    // While the heavy service cold-starts the user is told, not left on a
    // frozen screen: the batch notice, and a badge on each escalating photo.
    await expect(
      page.getByText("A few of these need a closer look, which can take a minute or so. The rest keep coming in below.", {
        exact: true,
      }),
    ).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByText(/Escalating.*deeper processing/).first()).toBeVisible();
    await expectAccessible(page, { label: "Placeholder upload, escalating" });

    // More escalations than the heavy cap still ALL finish: every photo is read.
    // "Finish the batch" shows once all six have settled, read or failed, so a
    // failed photo stops the spec here on the headline that names it (NEO-440)
    // instead of running out the 600 s.
    await expect(page.getByRole("button", { name: "Finish the batch" })).toBeVisible({
      timeout: 600_000,
    });
    await expect(page.getByText("All 6 photos read.")).toBeVisible();

    await page.getByRole("button", { name: "Finish the batch" }).click();
    await expect(page.getByText("Finish this batch?")).toBeVisible();
    await expectAccessible(page, { label: "Finish this batch dialog" });
    await page.getByRole("button", { name: "Finish it" }).click();
    await expect(page.getByText("3 pairs ready to print.")).toBeVisible();
    await expectAccessible(page, { label: "Placeholder batch, pairs ready" });
  },
);
