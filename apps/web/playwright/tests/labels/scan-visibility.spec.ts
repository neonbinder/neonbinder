// Origin: .maestro/flows/labels/scan-visibility.yaml (Maestro suite retired in NEO-341; see git history)
// The seed (`sites=label-scans`) gives this worker one bought label with four
// USPS scans, the latest "Delivery, OLYMPIA, WA" (out_for_delivery).
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test("Label History — see what USPS has scanned", { tag: ["@labels"] }, async ({ page, signIn }) => {
  await signIn("/testing/seed-credentials?sites=label-scans%26redirect=/print/labels");
  await expect(
    page.getByText(/newest first\. Reprint one without paying for it twice/),
  ).toBeVisible({ timeout: LAUNCH_GATE });

  // The explainer: the drop-off is never scanned.
  await expect(page.getByText(/Nothing scans it when you drop it off/)).toBeVisible();

  const label = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "Scan Fixture Buyer" }) });
  await expect(label.getByText(/Out for delivery.*last USPS scan/)).toBeVisible();

  // Latest scan, in the label's own summary (not the expandable timeline).
  const latestScan = label.getByRole("definition").filter({ hasText: /Delivery.*OLYMPIA, WA/ });
  await expect(latestScan).toBeVisible();

  await expect(label.getByText("0004012345678901234567890123456", { exact: true })).toBeVisible();
  await expect(
    label.getByRole("button", { name: /^Copy the tracking number for Scan Fixture Buyer/ }),
  ).toBeVisible();
  await expect(label.getByRole("link", { name: /Public scan page/ })).toBeVisible();

  // The full timeline is collapsed: the postmark scan is not shown yet.
  const postmark = label.getByText(/Cancellation of Postage.*postmarked/);
  await expect(postmark).toBeHidden();
  await expectAccessible(page, { label: "Label History, scans collapsed" });

  await label.getByRole("button", { name: /^Show all scans \(4\)/ }).click();
  await expect(postmark).toBeVisible();
  await expectAccessible(page, { label: "Label History, scans expanded" });

  await label.getByRole("button", { name: /^Hide all scans \(4\)/ }).click();
  await expect(postmark).toBeHidden();
  await expect(latestScan).toBeVisible();
});
