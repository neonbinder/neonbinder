// Origin: .maestro/flows/labels/print-label.yaml (Maestro suite retired in NEO-341; see git history)
// Dedicated `new-profile` account, reset on the way in: no return address yet.
//
// NEO-365: Print Label also hands the printer the portrait 4in x 6in page a
// label printer feeds (Firefox 158 stopped turning a landscape page onto 4x6
// stock), with the 6in x 4in label turned onto it and carrying what the
// preview showed. The print dialog is replaced and the print document read as
// support/print-capture.ts explains; nothing is located by selector or id.
// The bought-label print and the Label History Reprint go through the same
// printHtmlDocument, but neither can be driven here without buying postage
// (a reprint asks EasyPost for the shipment), so this free print is the E2E
// proof of the shared page geometry; print-html.test.ts covers the document.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import {
  capturePrint,
  expectRotatedFourBySixPage,
  stubPrintDialog,
} from "../../support/print-capture";

test(
  "Shipping Labels — type a recipient and the label preview follows, and prints on a 4x6 page",
  { tag: ["@smoke", "@labels"] },
  async ({ page, signIn }) => {
    // Replace the native print dialog in every frame, before any page script.
    await stubPrintDialog(page);

    await signIn("/testing/reset?redirect=/profile/shipping", { account: "new-profile" });
    await expect(page.getByText("Profile Settings", { exact: true })).toBeVisible({
      timeout: LAUNCH_GATE,
    });
    await expect(page.getByText("Your return address for printed shipping labels")).toBeVisible({
      timeout: 10_000,
    });

    // Save the return address on the profile.
    await page.getByLabel("Name", { exact: true }).fill("Neon Seller");
    await page.getByLabel("Street Address").fill("100 Binder Way");
    await page.getByLabel("City").fill("Austin");
    await page.getByLabel("State").fill("TX");
    await page.getByLabel("ZIP").fill("78701");
    await page.getByRole("button", { name: "Save Return Address" }).click();
    await expect(page.getByText("Return address saved.")).toBeVisible();
    await expectAccessible(page, { label: "Profile, Shipping tab, address saved" });

    // The Print Shop form now offers a label.
    await page.goto("/print/shipping");
    await expect(page.getByRole("heading", { name: "Shipping Labels" })).toBeVisible();
    await expect(page.getByText("Ship To", { exact: true })).toBeVisible();

    await page.getByLabel("Name", { exact: true }).fill("Jane Buyer");
    await page.getByLabel("Street Address").fill("742 Evergreen Ter");
    await page.getByLabel("City").fill("Springfield");
    await page.getByLabel("State").fill("IL");
    await page.getByLabel("ZIP").fill("62704");
    await expect(page.getByRole("button", { name: "Print Label" })).toBeVisible();

    // The preview follows what was typed: buyer's line, and the saved return address.
    await expect(page.getByText("SPRINGFIELD IL 62704")).toBeVisible();
    await expect(page.getByText("AUSTIN TX 78701")).toBeVisible();
    await expectAccessible(page, { label: "Shipping Labels, preview" });

    // Print Label: a portrait 4in x 6in page with the label turned onto it,
    // carrying the buyer and the saved return address from the preview.
    const report = await capturePrint(page, () =>
      page.getByRole("button", { name: "Print Label" }).click(),
    );
    expectRotatedFourBySixPage(report);
    // The printed label sets names in capitals, as USPS addresses read.
    expect(report.text).toContain("JANE BUYER");
    expect(report.text).toContain("SPRINGFIELD IL 62704");
    expect(report.text).toContain("AUSTIN TX 78701");

    // The page is still there and printable again.
    await expect(page.getByRole("button", { name: "Print Label" })).toBeVisible();
  },
);
