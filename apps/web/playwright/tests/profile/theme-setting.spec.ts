// NEO-356 (R1): a signed-in collector picks Light, Dark or System in Profile
// -> Settings and the whole app is painted that way, the choice follows them
// to another device, and System follows the OS in both directions.
//
// Modes are proven by what the user sees: the page colour and a heading's
// colour (support/theme.ts), plus the radio that reads as chosen. The suite
// runs as a dark-OS user (playwright.config.ts); this is one of the only
// specs that changes the saved theme or calls emulateMedia, and it ends with
// System saved again (R7), in a finally block, so no later spec on this
// worker's account runs light.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { expectLook } from "../../support/theme";

test(
  "Settings theme: Light, Dark and System repaint the app, persist, and System follows the OS",
  { tag: ["@smoke", "@profile"] },
  async ({ page, signIn, browser, baseURL, viewport, userAgent, hasTouch, isMobile, deviceScaleFactor }) => {
    await signIn("/profile/public");
    await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({
      timeout: LAUNCH_GATE,
    });

    // The Settings link is the last in the Profile nav; it opens the Appearance panel.
    const nav = page.getByRole("navigation", { name: "Profile sections" });
    await nav.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(/\/profile\/settings$/);
    const appearance = page.getByRole("heading", { level: 2, name: "Appearance" });
    await expect(appearance).toBeVisible();

    const theme = page.getByRole("radiogroup", { name: "Theme" });
    const light = theme.getByRole("radio", { name: "Light", exact: true });
    const dark = theme.getByRole("radio", { name: "Dark", exact: true });
    const system = theme.getByRole("radio", { name: "System", exact: true });
    const saved = page.getByRole("main").getByRole("status").filter({ hasText: "Saved." });

    try {
      // Light.
      await light.click();
      await expect(light).toBeChecked();
      await expect(saved).toBeVisible();
      await expectLook(page, "light", appearance);
      await expectAccessible(page, { label: "Settings, Light" });

      // It survives a reload.
      await page.reload();
      await expect(appearance).toBeVisible({ timeout: LAUNCH_GATE });
      await expect(light).toBeChecked();
      await expectLook(page, "light", appearance);

      // And it is saved to the profile, not only to this browser: another
      // device (same session, no stored copy of the choice) opens light.
      const { cookies } = await page.context().storageState();
      const device = await browser.newContext({
        baseURL,
        viewport,
        userAgent,
        hasTouch,
        isMobile,
        deviceScaleFactor,
        colorScheme: "dark",
        storageState: { cookies, origins: [] },
      });
      try {
        const other = await device.newPage();
        await other.goto("/profile/settings");
        const otherAppearance = other.getByRole("heading", { level: 2, name: "Appearance" });
        await expect(otherAppearance).toBeVisible({ timeout: LAUNCH_GATE });
        await expect(other.getByRole("radio", { name: "Light", exact: true })).toBeChecked();
        await expectLook(other, "light", otherAppearance);
      } finally {
        await device.close();
      }

      // Dark.
      await dark.click();
      await expect(dark).toBeChecked();
      await expect(saved).toBeVisible();
      await expectLook(page, "dark", appearance);
      await expectAccessible(page, { label: "Settings, Dark" });

      // System follows the OS, in both directions.
      await system.click();
      await expect(system).toBeChecked();
      await expect(saved).toBeVisible();
      await expect(page.getByText("Your device is on dark right now.")).toBeVisible();
      await expectLook(page, "dark", appearance);

      await page.emulateMedia({ colorScheme: "light" });
      await expect(page.getByText("Your device is on light right now.")).toBeVisible();
      await expectLook(page, "light", appearance);

      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.getByText("Your device is on dark right now.")).toBeVisible();
      await expectLook(page, "dark", appearance);

      // Back steps out of Settings to the previous tab.
      await page.goBack();
      await expect(page).toHaveURL(/\/profile\/public$/);
      await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible();
    } finally {
      // R7: leave the account on System with the OS dark, whatever happened above.
      await page.emulateMedia({ colorScheme: "dark" });
      await page.goto("/profile/settings");
      await expect(appearance).toBeVisible({ timeout: LAUNCH_GATE });
      await system.click();
      await expect(system).toBeChecked();
      await expect(page.getByText("Saving…")).toHaveCount(0);
    }
  },
);
