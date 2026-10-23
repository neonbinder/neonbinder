// NEO-356 (R1): on /collection a signed-in collector on System can flip the
// demo to Light as a preview that is never saved, and the switch disappears
// once they have saved a mode of their own. Modes are proven by painted colour
// (support/theme.ts); the suite runs as a dark-OS user (playwright.config.ts).
//
// R7: the saved theme is changed here, so the spec ends with System saved
// again, in a finally block, so no later spec on this worker's account runs
// light. It is the only account state this spec touches.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { expectLook, expectPageLook } from "../../support/theme";

test(
  "Collection demo (signed in): the Light switch previews without saving and hides once Light is saved",
  { tag: ["@smoke", "@home"] },
  async ({ page, signIn, isMobile }) => {
    // The app's own navigation: binder tabs on desktop, the Menu dialog on a phone.
    const goTo = async (name: string) => {
      if (isMobile) {
        await page.getByRole("button", { name: "Open menu" }).click();
        await page.getByRole("dialog", { name: "Menu" }).getByRole("link", { name, exact: true }).click();
      } else {
        await page.getByRole("link", { name, exact: true }).click();
      }
    };

    await signIn("/collection");
    const title = page.getByRole("heading", { level: 1, name: "Collection" });
    await expect(title).toBeVisible({ timeout: LAUNCH_GATE });

    // On System (the account's resting state) the switch is offered.
    const demoTheme = page.getByRole("radiogroup", { name: "Demo theme" });
    const light = demoTheme.getByRole("radio", { name: "Light", exact: true });
    await expect(demoTheme).toBeVisible();
    await expectLook(page, "dark", title);
    // Before the switch is touched the page follows the OS, so axe can check
    // it in both modes. The Light preview is an override that pins the page
    // light, where only one mode could be checked.
    await expectAccessible(page, { label: "Collection demo, signed in, before the switch" });

    // Light previews on the whole page.
    await light.click();
    await expect(light).toBeChecked();
    await expectLook(page, "light", title);

    // Leaving the demo for another tab of the app restores the saved (System, here dark) look.
    await goTo("Dashboard");
    await expect(page).toHaveURL(/\/dashboard/);
    await expectPageLook(page, "dark");

    // The preview was never saved: Settings still says System.
    await goTo("Profile");
    await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible();
    await page.getByRole("navigation", { name: "Profile sections" }).getByRole("link", { name: "Settings", exact: true }).click();
    const theme = page.getByRole("radiogroup", { name: "Theme" });
    const system = theme.getByRole("radio", { name: "System", exact: true });
    await expect(system).toBeChecked();
    await expect(theme.getByRole("radio", { name: "Light", exact: true })).not.toBeChecked();

    try {
      // With Light saved, the demo honours it and offers no switch.
      await theme.getByRole("radio", { name: "Light", exact: true }).click();
      await expect(page.getByRole("main").getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
      await goTo("Collection");
      await expect(title).toBeVisible();
      await expect(page.getByRole("region", { name: "About this demo" })).toBeVisible();
      await expectLook(page, "light", title);
      await expect(demoTheme).toBeHidden();
    } finally {
      // R7: back to System, whatever happened above.
      await page.goto("/profile/settings");
      await expect(page.getByRole("heading", { level: 2, name: "Appearance" })).toBeVisible({ timeout: LAUNCH_GATE });
      await system.click();
      await expect(system).toBeChecked();
      await expect(page.getByText("Saving…")).toHaveCount(0);
    }
  },
);
