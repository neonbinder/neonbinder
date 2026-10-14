// Origin: .maestro/flows/placeholders/flip-edge-mirrors-the-backs.yaml (Maestro suite retired in NEO-341; see git history)
// Six full-bleed fixtures pair into THREE cards, which fill the first row of a
// 3x3 sheet: that is what lets the checks tell a column reversal (long edge)
// from a row reversal (short edge) from no mirror at all. The pocket numbers
// shown by "Show cutting guides" are the instrument that reads the mirroring.
import type { Locator } from "@playwright/test";
import { test, expect, expectAccessible } from "../../support/fixtures";

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("not laid out");
  return b;
}

test(
  "Print settings — the flip edge re-mirrors the backs, and backs can be turned off",
  { tag: ["@placeholders"] },
  async ({ page, signIn }) => {
    await signIn("/testing/seed-placeholder-upload%3Ffixtures%3Dplaceholder-fixtures-fullbleed");
    await expect(page.getByText("Upload your cards")).toBeVisible({ timeout: 90_000 });

    // Every image has been read: the state that offers finishing.
    await expect(page.getByText("All 6 photos read.")).toBeVisible({ timeout: 180_000 });
    await page.getByRole("button", { name: "Finish the batch" }).click();
    await expect(page.getByText("Finish this batch?")).toBeVisible();
    await expectAccessible(page, { label: "Finish this batch dialog" });
    await page.getByRole("button", { name: "Finish it" }).click();
    await expect(page.getByText("3 pairs ready to print.")).toBeVisible();
    await expectAccessible(page, { label: "Placeholder batch, pairs ready" });

    // The live summary, recomputed from the form: backs are on by default.
    const print = page.getByRole("region", { name: "Print your placeholders" });
    await expect(print.getByRole("status")).toContainText(
      "3 cards on 1 sheet of Letter, printed both sides.",
    );

    // Calibration mode draws the pocket numbers the mirroring is read from.
    await print.getByRole("checkbox", { name: /Show cutting guides/ }).check();

    const preview = print.getByRole("list", { name: "Preview" });
    const front = preview.getByRole("listitem").filter({ hasText: "Sheet 1 — front" });
    const back = preview.getByRole("listitem").filter({ hasText: "Sheet 1 — back" });
    const pocket = (sheet: Locator, n: number) => sheet.getByText(String(n), { exact: true });

    // Front reads 1 2 3 across the first row. Long edge (the default) reverses
    // the COLUMNS on the back: 3 2 1, so pocket 1 sits right of pocket 3.
    await expect(print.getByRole("radio", { name: /^Long edge/ })).toBeChecked();
    await expect
      .poll(async () => (await box(pocket(back, 1))).x - (await box(pocket(back, 3))).x)
      .toBeGreaterThan(40);

    // Short edge reverses the ROWS instead: the three cards move to the bottom
    // row of the back, still in front order, so pocket 1 is below the front's
    // pocket 3 and to the left of the back's pocket 2.
    await print.getByRole("radio", { name: /^Short edge/ }).check();
    await expect
      .poll(async () => (await box(pocket(back, 1))).y - (await box(pocket(front, 3))).y)
      .toBeGreaterThan(40);
    await expect
      .poll(async () => (await box(pocket(back, 2))).x - (await box(pocket(back, 1))).x)
      .toBeGreaterThan(40);

    // Backs off: the summary says front only, and the back sheet is gone.
    await print.getByRole("checkbox", { name: /Print the backs too/ }).uncheck();
    await expect(print.getByRole("status")).toContainText("3 cards on 1 sheet of Letter, front only.");
    await expect(preview.getByRole("listitem").filter({ hasText: "Sheet 1 — front" })).toBeVisible();
    await expect(preview.getByRole("listitem").filter({ hasText: "Sheet 1 — back" })).toHaveCount(0);
    await expectAccessible(page, { label: "Print settings, front only" });
  },
);
