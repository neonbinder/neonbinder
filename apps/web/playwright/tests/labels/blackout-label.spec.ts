// NEO-349 — the Print Shop's Blackout Label: a solid black 4x6 label, reached
// from the Print Shop sub-nav, previewed at true size, handed to the printer
// as a full-bleed black page.
//
// Needs no setup: the page reads nothing from Convex (no return address), so
// the worker's own account is enough and the spec writes nothing (R7).
//
// HOW THE PRINT IS PROVED, and why it is allowed: see support/print-capture.ts.
// In short, an init script replaces `window.print` in every frame and reports
// what the browser WOULD have been given to print; nothing is located by
// selector, id or test id, and the page itself is driven by role and name.
//
// The page is the portrait 4in x 6in paper a label printer feeds (Firefox 158
// stopped turning a landscape page onto 4x6 stock, NEO-365), with the 6in x 4in
// black slab turned 90deg clockwise to fill it.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import {
  capturePrint,
  expectRotatedFourBySixPage,
  stubPrintDialog,
} from "../../support/print-capture";

test(
  "Blackout Label — open it from the Print Shop nav, see the true-size slab, print a black 4x6 page",
  { tag: ["@smoke", "@labels"] },
  async ({ page, signIn }) => {
    // Replace the native print dialog in every frame, before any page script.
    await stubPrintDialog(page);

    // Enter on the neighbouring tool, so the nav click is what proves the route.
    await signIn("/print/shipping");
    await expect(page.getByRole("heading", { name: "Shipping Labels" })).toBeVisible({
      timeout: LAUNCH_GATE,
    });

    const nav = page.getByRole("navigation", { name: "Print Shop sections" });
    const shippingTab = nav.getByRole("link", { name: "Shipping", exact: true });
    const blackoutTab = nav.getByRole("link", { name: "Blackout Label", exact: true });

    // Shipping is the current tab; the new one is offered but not current.
    await expect(shippingTab).toHaveAttribute("aria-current", "page");
    await expect(blackoutTab).toBeVisible();
    await expect(blackoutTab).not.toHaveAttribute("aria-current", "page");

    await blackoutTab.click();

    await expect(page.getByRole("heading", { name: "Blackout Label", level: 2 })).toBeVisible();
    await expect(page).toHaveURL(/\/print\/shipping\/blackout$/);

    // Only the Blackout tab is current; Shipping must not also read as current.
    await expect(blackoutTab).toHaveAttribute("aria-current", "page");
    await expect(shippingTab).not.toHaveAttribute("aria-current", "page");

    // The preview: a solid black slab at true size (6in x 4in at 96 dpi).
    const preview = page.getByRole("group", { name: "Preview" });
    await expect(preview).toBeVisible();
    const slab = preview.getByRole("img", { name: "A solid black 4 by 6 inch label" });
    await expect(slab).toBeVisible();
    await expect(slab).toHaveCSS("background-color", "rgb(0, 0, 0)");
    await expect(slab).toHaveCSS("width", "576px");
    await expect(slab).toHaveCSS("height", "384px");
    await expectAccessible(page, { label: "Blackout Label" });

    // Print: the capture arms its listener first, then clicks. A real dialog never opens.
    const report = await capturePrint(page, () =>
      page.getByRole("button", { name: "Print Blackout Label" }).click(),
    );

    // A portrait 4in x 6in page, the slab turned onto it, no margin.
    expectRotatedFourBySixPage(report);
    // Black, edge to edge: the page, the body and the slab itself.
    expect(report.pageBackground).toBe("rgb(0, 0, 0)");
    expect(report.bodyBackground).toBe("rgb(0, 0, 0)");
    expect(report.content?.background).toBe("rgb(0, 0, 0)");
    expect(report.content?.layoutWidth).toBe(576);
    expect(report.content?.layoutHeight).toBe(384);

    // The page is still there and printable again.
    await expect(page.getByRole("button", { name: "Print Blackout Label" })).toBeVisible();
  },
);
