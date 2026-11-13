// NEO-356 / NEO-464 (R1): a signed-out visitor flips the demo (/demo) to Light
// with the demo's own switch, it holds across the demo's tabs, and leaving the
// demo (the shell's "Back to the tour") puts the page back to the dark the
// visitor arrived in. Nothing is saved (the visitor has no account). Modes are
// proven by painted colour (support/theme.ts); the suite runs as a dark-OS user
// (playwright.config.ts).
import { goViaShell } from "../../support/collection";
import { test, expect, expectAccessible } from "../../support/fixtures";
import { expectLook, expectPageLook } from "../../support/theme";

test(
  "Demo: the Light switch repaints the demo and going back to the tour restores dark",
  { tag: ["@smoke", "@home"] },
  async ({ page, isMobile }) => {
    await page.goto("/collection-tracking");
    const tour = page.getByRole("region", { name: "Take it for a spin" });
    await expect(tour).toBeVisible();
    await expectPageLook(page, "dark");

    await tour.getByRole("link", { name: "Open the demo binder" }).click();
    await expect(page).toHaveURL(/\/demo\/collection$/);
    const title = page.getByRole("heading", { level: 1, name: "Collection" });
    await expect(title).toBeVisible();

    // The switch starts on the mode the page is already in.
    const demoTheme = page.getByRole("radiogroup", { name: "Demo theme" });
    const light = demoTheme.getByRole("radio", { name: "Light", exact: true });
    const dark = demoTheme.getByRole("radio", { name: "Dark", exact: true });
    await expect(dark).toBeChecked();
    await expectLook(page, "dark", title);
    // Before the switch is touched the page follows the OS, so axe can check
    // it in both modes. Once Light is chosen the demo pins the page light (an
    // override), where only one mode could be checked.
    await expectAccessible(page, { label: "Collection demo, before the switch" });

    // Light repaints the whole page, header included.
    await light.click();
    await expect(light).toBeChecked();
    await expectLook(page, "light", title);

    // It holds across the demo's tabs and Back.
    const tabs = page.getByRole("navigation", { name: "Collection sections" });
    await tabs.getByRole("link", { name: "My Cards" }).click();
    await expect(page).toHaveURL(/[?&]tab=cards/);
    const building = page.getByRole("heading", { level: 2, name: "Sets I'm building" });
    await expect(building).toBeVisible();
    await expectPageLook(page, "light");
    await page.goBack();
    await expect(page).not.toHaveURL(/[?&]tab=cards/);
    await expect(light).toBeChecked();
    await expectLook(page, "light", title);

    // Leaving the demo releases the switch: back on the home page, the page is dark again.
    await goViaShell(page, isMobile, "Back to the tour");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("region", { name: "Check it Out" })).toBeVisible();
    await expect(demoTheme).toBeHidden();
    await expectPageLook(page, "dark");
  },
);
