// NEO-356 (R1): the page is in the right light or dark mode from the first
// frame, decided by index.html's pre-paint script alone, before the app runs.
//
// NEO-356 no-flash exception, approved by Jason 2026-10-22: this spec (and
// profile/theme-saved-no-flash) may read the root attribute and the
// init-script log through support/theme-no-flash.ts. It covers the no-flash
// check ONLY; it does not license an id, selector or evaluate anywhere else.
//
// Two complementary proofs, neither timed (signed out, no backend):
//  1. App bundle blocked: React never runs, yet the page is light under a
//     stored Light, and System follows the OS (light then dark, one fresh load
//     each). Only the pre-paint script can have done that. The painted colour
//     is not asserted here: the stylesheet arrives through the same bundle in
//     dev, so a blocked bundle has no colours to read; the attribute is the
//     mode the script decided.
//  2. Observer from document start, bundle running, Light stored: the mode was
//     light when `<body>` was inserted and at the first frame and never
//     flipped; the painted page is light once the app is up.
import { test, expect } from "../../support/fixtures";
import { expectPageLook } from "../../support/theme";
import { expectNoFlash, recordThemeFromDocumentStart, themeAttribute } from "../../support/theme-no-flash";

test(
  "Theme pre-paint: the page is light from the first frame and the pre-paint script alone decides it",
  { tag: ["@smoke", "@home"] },
  async ({ page }) => {
    // Proof 2 (bundle blocked): the app's JS modules never load.
    const isAppBundle = (url: URL) => /\/src\//.test(url.pathname) || /\/assets\/[^/]*\.js$/.test(url.pathname);
    await page.route(isAppBundle, (route) => route.abort());

    // System, no stored choice: follows the OS on each fresh load.
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/binder-tracking", { waitUntil: "domcontentloaded" });
    await expect(themeAttribute(page)).toHaveAttribute("data-theme", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/binder-tracking", { waitUntil: "domcontentloaded" });
    await expect(themeAttribute(page)).toHaveAttribute("data-theme", "dark");

    // A stored Light beats the dark OS (the init script writes it before every load).
    await page.addInitScript(() => window.localStorage.setItem("nb-theme", "light"));
    await page.goto("/binder-tracking", { waitUntil: "domcontentloaded" });
    await expect(themeAttribute(page)).toHaveAttribute("data-theme", "light");

    // Proof 1: let the app run, record from document start, reload with Light stored.
    await page.unroute(isAppBundle);
    await recordThemeFromDocumentStart(page);
    await page.goto("/binder-tracking");
    await expect(page.getByRole("region", { name: "Take it for a spin" })).toBeVisible();
    await expectNoFlash(page, "light");
    await expectPageLook(page, "light");
  },
);
