// NEO-386 (R1): "Use a scanner" on Add cards. With no run open it starts one
// (an empty scanner session filing into the binder picked) and shows the
// six-character code the scanner script joins it with, plus the command to
// run. The run lives on the URL, so after a reload asking again gives the
// same code. "Done adding photos" closes the empty session.
//
// The script itself (apps/scanner) needs a real scanner, so its side of the
// join is pinned in convex/intakeScanner.test.ts and apps/scanner's unit
// tests, not here.
//
// R7: writes only the account's own run, closed at the end so the empty
// session never holds one of the account's two active-batch slots.
import { test, expect, expectAccessible } from "../../support/fixtures";

test(
  "Add cards: Use a scanner starts a run and shows the code the scanner joins with",
  { tag: ["@collection"] },
  async ({ page, signIn }) => {
    await signIn("/collection?tab=add");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
    await page.getByRole("combobox", { name: "Put them in this binder" }).selectOption({ label: "Main" });

    await page.getByRole("button", { name: "Use a scanner" }).click();
    await expect(page).toHaveURL(/[?&]run=/);
    const code = page.getByLabel(/^Scanner code( [A-Z2-9]){6}$/);
    await expect(code).toBeVisible();
    const label = (await code.getAttribute("aria-label")) ?? "";
    const typed = label.replace("Scanner code ", "").replace(/ /g, "");
    expect(typed).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    await expect(page.getByText(`npm run scan ${typed}`)).toBeVisible();
    await expectAccessible(page);

    // The same run after a reload: asking again gives the same code.
    await page.reload();
    await page.getByRole("button", { name: "Use a scanner" }).click();
    await expect(page.getByLabel(label, { exact: true })).toBeVisible();

    // Done with no photos: the empty session closes.
    await page.getByRole("button", { name: "Done adding photos" }).click();
    await expect(page.getByText("This run's photos are all in. To add more, start a new run.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Use a scanner" })).toHaveCount(0);
  },
);
