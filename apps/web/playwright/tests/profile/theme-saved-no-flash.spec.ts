// NEO-356 (R1): a collector who saved Light gets a light page from the first
// frame on reload: the mode is light when the body is inserted and at the
// first frame, and never flips to dark once the app and the profile arrive.
//
// NEO-356 no-flash exception, approved by Jason 2026-10-22: the root attribute
// is read through support/theme-no-flash.ts for this check ONLY (see that
// file). Everything else here is perceivable.
//
// R7: the saved theme is changed, so the spec ends with System saved again, in
// a finally block, so no later spec on this worker's account runs light.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { expectPageLook } from "../../support/theme";
import { expectNoFlash, recordThemeFromDocumentStart } from "../../support/theme-no-flash";

test(
  "Saved Light: a reload is light from the first frame and never flips",
  { tag: ["@smoke", "@profile"] },
  async ({ page, signIn }) => {
    await signIn("/profile/settings");
    const appearance = page.getByRole("heading", { level: 2, name: "Appearance" });
    await expect(appearance).toBeVisible({ timeout: LAUNCH_GATE });
    const theme = page.getByRole("radiogroup", { name: "Theme" });
    const light = theme.getByRole("radio", { name: "Light", exact: true });
    const system = theme.getByRole("radio", { name: "System", exact: true });

    try {
      await light.click();
      await expect(light).toBeChecked();
      await expect(page.getByRole("main").getByRole("status").filter({ hasText: "Saved." })).toBeVisible();

      // Record from document start, then reload with Light saved.
      await recordThemeFromDocumentStart(page);
      await page.reload();
      await expect(appearance).toBeVisible({ timeout: LAUNCH_GATE });
      await expect(light).toBeChecked();
      await expectNoFlash(page, "light");
      await expectPageLook(page, "light");
    } finally {
      // R7: back to System, whatever happened above.
      await page.goto("/profile/settings");
      await expect(appearance).toBeVisible({ timeout: LAUNCH_GATE });
      await system.click();
      await expect(system).toBeChecked();
      await expect(page.getByText("Saving…")).toHaveCount(0);
    }
  },
);
