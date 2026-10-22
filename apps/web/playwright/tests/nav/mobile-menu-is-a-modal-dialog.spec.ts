// R1: below the lg breakpoint the binder tabs give way to a header toggle that
// opens the Menu, and the Menu behaves as a modal dialog: named, focus moves
// in and lands on the current page, the page behind is out of reach, Tab is
// trapped, Escape / Close menu / picking a link all close it, and focus goes
// back to the toggle. Read-only: it navigates, it writes nothing (R7).
//
// Desktop (1024px = lg) shows the tabs and no toggle, so the project branch
// (GUIDE "Desktop and mobile": branch on `isMobile`, never skip) proves the
// matching desktop half and still ends in hard asserts (R2).
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test("Mobile menu opens as a modal dialog, traps focus and closes cleanly", { tag: ["@smoke", "@nav"] }, async ({
  page,
  signIn,
  isMobile,
}) => {
  await signIn("/dashboard");
  await expect(page.getByText("COMING SOON")).toBeVisible({ timeout: LAUNCH_GATE });

  if (!isMobile) {
    // Desktop: the binder tabs are the navigation, there is no menu toggle.
    await expect(page.getByRole("link", { name: "Print Shop", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Profile", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open menu" })).toBeHidden();
    await expectAccessible(page, { label: "Dashboard, desktop binder tabs" });
    return;
  }

  const toggle = page.getByRole("button", { name: "Open menu" });
  const dialog = page.getByRole("dialog", { name: "Menu" });
  const closeButton = dialog.getByRole("button", { name: "Close menu" });
  const links = dialog.getByRole("link");

  // The toggle announces a popup dialog and starts collapsed.
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAttribute("aria-haspopup", "dialog");
  await expect(dialog).toBeHidden();

  // Open: a modal dialog, focus on the link for the page we are on.
  await toggle.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog.getByRole("heading", { name: "Menu" })).toBeVisible();
  const dashboardLink = dialog.getByRole("link", { name: "Dashboard" });
  await expect(dashboardLink).toHaveAttribute("aria-current", "page");
  await expect(dashboardLink).toBeFocused();

  // The page behind is inert: focus cannot be put on the header's toggle,
  // so focus stays in the dialog. The toggle keeps its one name and reports
  // the open menu through aria-expanded.
  const headerControl = page.getByRole("banner").getByRole("button", { name: "Open menu" });
  await expect(headerControl).toHaveAttribute("aria-expanded", "true");
  await headerControl.focus();
  await expect(headerControl).not.toBeFocused();
  await expect(dashboardLink).toBeFocused();

  // axe, once the slide-in has finished (fully inside the viewport).
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await expectAccessible(page, { within: dialog, label: "Mobile menu open" });

  // Tab is trapped: Close menu is the first stop and the last link the last,
  // and each wraps to the other.
  await page.keyboard.press("Shift+Tab");
  await expect(closeButton).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(links.last()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dashboardLink).toBeFocused();

  // Escape closes and hands focus back to the toggle.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("main")).toBeVisible();

  // The Close menu button closes it too, focus back on the toggle again.
  await toggle.click();
  await expect(dialog).toBeVisible();
  await closeButton.click();
  await expect(dialog).toBeHidden();
  await expect(toggle).toBeFocused();

  // Picking a link navigates and closes the menu on the route change.
  await toggle.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("link", { name: "Print Shop" }).click();
  await expect(page).toHaveURL(/\/print$/);
  await expect(page.getByRole("heading", { name: "Print Shop", level: 1 })).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // Back steps through the URL to the dashboard, with the menu still closed.
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText("COMING SOON")).toBeVisible();
  await expect(dialog).toBeHidden();
});
