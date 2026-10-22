// R1: the "Find my BSC url" and "Find my MySlabs url" helpers on the public
// profile open a real modal dialog: named, focus lands on Close, the "Open ..."
// control is a link to the marketplace in a new tab, Tab stays inside, Escape
// and Close both dismiss it, and focus goes back to the button that opened it.
// Read-only (R7): it opens and closes help text and never saves the profile.
// Same call on desktop and mobile (GUIDE "Desktop and mobile"): nothing here
// differs by viewport, so there is no project branch.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

const DIALOGS = [
  {
    opener: "Find my BSC url",
    title: "Find Your BuySportsCards Seller URL",
    openLabel: "Open BuySportsCards",
    href: "https://www.buysportscards.com/sellers",
  },
  {
    opener: "Find my MySlabs url",
    title: "Find Your MySlabs URL",
    openLabel: "Open MySlabs Account",
    href: "https://www.myslabs.com/account/",
  },
];

test(
  "Public profile: the BuySportsCards and MySlabs URL help dialogs are modal dialogs with a focus return",
  { tag: ["@profile"] },
  async ({ page, signIn }) => {
    await signIn("/profile/public");
    await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({ timeout: LAUNCH_GATE });

    for (const { opener, title, openLabel, href } of DIALOGS) {
      const openerButton = page.getByRole("button", { name: opener });
      const dialog = page.getByRole("dialog", { name: title });
      const closeButton = dialog.getByRole("button", { name: "Close" });
      const openLink = dialog.getByRole("link", { name: openLabel });

      // Open: a named modal dialog, focus on Close.
      await expect(dialog).toBeHidden();
      await openerButton.click();
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute("aria-modal", "true");
      await expect(closeButton).toBeFocused();

      // The marketplace opens as a link, in a new tab.
      await expect(openLink).toBeVisible();
      await expect(openLink).toHaveAttribute("href", href);
      await expect(openLink).toHaveAttribute("target", "_blank");
      await expectAccessible(page, { within: dialog, label: `${title} dialog` });

      // Tab is trapped: Close is the last stop and wraps to the link, and back.
      await page.keyboard.press("Tab");
      await expect(openLink).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(closeButton).toBeFocused();

      // Escape closes and hands focus back to the button that opened it.
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(openerButton).toBeFocused();
    }

    // The Close button dismisses too, with the same focus return.
    const { opener, title } = DIALOGS[0];
    const dialog = page.getByRole("dialog", { name: title });
    await page.getByRole("button", { name: opener }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: opener })).toBeFocused();
  },
);
