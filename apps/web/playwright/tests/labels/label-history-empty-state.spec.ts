// Origin: .maestro/flows/labels/label-history-empty-state.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";

test("Print Shop — Label History empty state", { tag: ["@labels"] }, async ({ page, signIn }) => {
  await signIn("/print", { account: "new-profile" });
  await expect(page.getByRole("heading", { name: "Print Shop" })).toBeVisible({ timeout: LAUNCH_GATE });

  await page.getByRole("link", { name: /Reprint a label you already paid for/ }).click();
  await expect(page.getByText(/newest first\. Reprint one without paying for it twice/)).toBeVisible({
    timeout: 10_000,
  });

  await expect(page.getByText(/No labels yet.*nothing to reprint/)).toBeVisible();
  await expect(page.getByText(/Buy postage over on/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Reprint" })).toBeHidden();
});
