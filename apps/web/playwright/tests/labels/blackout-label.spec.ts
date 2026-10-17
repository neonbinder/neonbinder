// NEO-349 — the Print Shop's Blackout Label: a solid black 4x6 label, reached
// from the Print Shop sub-nav, previewed at true size, handed to the printer
// as a full-bleed black page.
//
// Needs no setup: the page reads nothing from Convex (no return address), so
// the worker's own account is enough and the spec writes nothing (R7).
//
// HOW THE PRINT IS PROVED, and why it is allowed. The print document lives in
// a hidden, aria-hidden iframe the user never sees, and the only thing that
// ever shows it is the browser's print dialog, which cannot be asserted and
// would hang the run. So the proof is taken where the browser takes it: an
// init script replaces `window.print` in every frame, and the replacement
// reports what the browser WOULD have been given to print (the document's
// `@page` rule, the page background, the size of the painted slab) as a
// console line. Nothing is located: no selector, id or DOM structure is read
// by the spec. The spec locates only by role and name; the stub is an
// environment substitute for a native dialog (like a stubbed download), and
// the assertion is on the print output itself.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

const PRINT_REPORT = "[e2e-print] ";

test(
  "Blackout Label — open it from the Print Shop nav, see the true-size slab, print a black 4x6 page",
  { tag: ["@smoke", "@labels"] },
  async ({ page, signIn }) => {
    // Replace the native print dialog in every frame, before any page script.
    // The report goes out as a console line; no page state is read by the spec.
    await page.addInitScript((prefix) => {
      window.print = () => {
        const pageRules: string[] = [];
        for (const sheet of Array.from(document.styleSheets)) {
          for (const rule of Array.from(sheet.cssRules)) {
            if (rule instanceof CSSPageRule) pageRules.push(rule.cssText.replace(/\s+/g, " "));
          }
        }
        const slab = document.body.firstElementChild?.getBoundingClientRect();
        console.log(
          prefix +
            JSON.stringify({
              inFrame: window !== window.top,
              pageRules,
              pageBackground: getComputedStyle(document.documentElement).backgroundColor,
              bodyBackground: getComputedStyle(document.body).backgroundColor,
              slabWidth: slab?.width,
              slabHeight: slab?.height,
              slabBackground: document.body.firstElementChild
                ? getComputedStyle(document.body.firstElementChild).backgroundColor
                : null,
            }),
        );
      };
    }, PRINT_REPORT);

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

    // Print: arm the listener first, then click. A real dialog never opens.
    const printed = page.waitForEvent("console", {
      predicate: (message) => message.text().startsWith(PRINT_REPORT),
      timeout: 7_000,
    });
    await page.getByRole("button", { name: "Print Blackout Label" }).click();
    const report = JSON.parse((await printed).text().slice(PRINT_REPORT.length)) as {
      inFrame: boolean;
      pageRules: string[];
      pageBackground: string;
      bodyBackground: string;
      slabWidth: number;
      slabHeight: number;
      slabBackground: string | null;
    };

    // It is the print document that was printed, never the app page itself.
    expect(report.inFrame).toBe(true);
    // A 4x6 label fed landscape (6in x 4in), the same page as the Shipping
    // label, with no margin so the black reaches every edge.
    expect(report.pageRules).toHaveLength(1);
    expect(report.pageRules[0]).toMatch(/size: 6in 4in/);
    expect(report.pageRules[0]).toMatch(/margin: 0(px)?;/);
    // Black, edge to edge: the page, the body and the slab itself.
    expect(report.pageBackground).toBe("rgb(0, 0, 0)");
    expect(report.bodyBackground).toBe("rgb(0, 0, 0)");
    expect(report.slabBackground).toBe("rgb(0, 0, 0)");
    expect(report.slabWidth).toBe(576);
    expect(report.slabHeight).toBe(384);

    // The page is still there and printable again.
    await expect(page.getByRole("button", { name: "Print Blackout Label" })).toBeVisible();
  },
);
