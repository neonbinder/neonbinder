// NEO-356 (R1): a signed-in collector picks Light, Dark or System in Profile
// -> Settings and the whole app is painted that way, each choice survives a
// reload and follows them to another device, and System follows the OS in both
// directions.
//
// Modes are proven by what the user sees: the page colour and a heading's
// colour (support/theme.ts), plus the radio that reads as chosen. The suite
// runs as a dark-OS user (playwright.config.ts); this is one of the only
// specs that changes the saved theme or calls emulateMedia, and it ends with
// System saved again (R7), in a finally block, so no later spec on this
// worker's account runs light.
//
// Dark is told apart from System by running it under a LIGHT OS (a Dark pick
// ignores the OS; System does not), and System is told apart from both on a
// second device whose OS is light (it can only open light if System, not the
// previous pick, was saved to the profile).
//
// Accessibility (GUIDE "Accessibility checks"): expectAccessible checks the
// screen in both modes itself, which only works while the account is on
// System, so it is called once, on System, never under a saved Light or Dark.
//
// Not covered here: a failed save. There is no way to make the mutation fail
// from the UI, so the rollback (the old theme returns, focus moves to it, an
// alert says so) is proven by the unit tests app/profile/settings/page.test.tsx
// and page.rapidSaves.test.tsx.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { expectLook, type Look } from "../../support/theme";

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

    // The same session on another device (no stored copy of the choice) and
    // its own OS setting: what it opens is what the PROFILE holds.
    const openOnAnotherDevice = async (os: Look, pick: "Light" | "Dark" | "System", look: Look) => {
      const { cookies } = await page.context().storageState();
      const device = await browser.newContext({
        baseURL,
        viewport,
        userAgent,
        hasTouch,
        isMobile,
        deviceScaleFactor,
        colorScheme: os,
        storageState: { cookies, origins: [] },
      });
      try {
        const other = await device.newPage();
        await other.goto("/profile/settings");
        const otherAppearance = other.getByRole("heading", { level: 2, name: "Appearance" });
        await expect(otherAppearance).toBeVisible({ timeout: LAUNCH_GATE });
        await expect(other.getByRole("radio", { name: pick, exact: true })).toBeChecked();
        await expectLook(other, look, otherAppearance);
      } finally {
        await device.close();
      }
    };

    // A pick, proven fresh: nothing says "Saved." beforehand (the page was just
    // loaded), so the "Saved." that appears is this pick's save, never the last one's.
    const pick = async (radio: typeof light) => {
      await expect(saved).toHaveCount(0);
      await radio.click();
      await expect(radio).toBeChecked();
      await expect(saved).toBeVisible();
    };

    // After the save, a reload comes back the same: nothing leaned on the stale page state.
    const reload = async () => {
      await page.reload();
      await expect(appearance).toBeVisible({ timeout: LAUNCH_GATE });
    };

    try {
      // Light (the OS is dark).
      await pick(light);
      await expectLook(page, "light", appearance);
      await reload();
      await expect(light).toBeChecked();
      await expectLook(page, "light", appearance);
      await openOnAnotherDevice("dark", "Light", "light");

      // Dark, under a LIGHT OS: a Dark pick ignores the OS.
      await page.emulateMedia({ colorScheme: "light" });
      await pick(dark);
      await expectLook(page, "dark", appearance);
      await reload();
      await expect(dark).toBeChecked();
      await expectLook(page, "dark", appearance);
      await openOnAnotherDevice("light", "Dark", "dark");

      // System, still under the light OS: it follows the OS, so the page goes light.
      await pick(system);
      await expect(page.getByText("Your device is on light right now.")).toBeVisible();
      await expectLook(page, "light", appearance);
      await reload();
      await expect(system).toBeChecked();
      await expectLook(page, "light", appearance);
      await openOnAnotherDevice("light", "System", "light");

      // System follows the OS in both directions.
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.getByText("Your device is on dark right now.")).toBeVisible();
      await expectLook(page, "dark", appearance);

      await page.emulateMedia({ colorScheme: "light" });
      await expect(page.getByText("Your device is on light right now.")).toBeVisible();
      await expectLook(page, "light", appearance);

      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.getByText("Your device is on dark right now.")).toBeVisible();
      await expectLook(page, "dark", appearance);

      // The account is on System again, so axe can check this screen in both modes.
      await expectAccessible(page, { label: "Settings, System" });

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
