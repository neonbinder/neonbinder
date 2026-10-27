// NEO-369: the four add-cards-from-photos prototypes are public (logged
// out, beside the demo binder) and run a scripted pipeline
// on fake data (no Convex writes, R7 read-only). Each one must get a card from
// the pile to "needs you", let it be saved by the prototype's own route in
// (a button, a quantity, or the keyboard), and pass axe. `?speed=6` runs the
// fake pipeline six times faster so no wait leaves the 7 s budget.
import { test, expect, expectAccessible } from "../../support/fixtures";

test(
  "Add cards prototype 1 (Guided Wizard): steps, then a card saved with its button",
  { tag: ["@home"] },
  async ({ page }) => {
    await page.goto("/binder-tracking/add/1?speed=6");
    await expect(
      page.getByRole("heading", { name: "Add cards from photos" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Where are these cards going?" }),
    ).toBeVisible();
    await expectAccessible(page, { label: "Add cards prototype 1, step 1" });
    await page.getByRole("button", { name: "Next" }).click();
    await expect(
      page.getByRole("heading", { name: "Which set are they from?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Start adding" }).click();

    const save = page
      .getByRole("button", { name: "Yes, this is the card" })
      .first();
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByRole("heading", { name: /^Saved/ })).toBeVisible();
    await expectAccessible(page, { label: "Add cards prototype 1, workspace" });
  },
);

test(
  "Add cards prototype 2 (Mission Control): lanes, and a card reviewed in the drawer",
  { tag: ["@home"] },
  async ({ page }) => {
    await page.goto("/binder-tracking/add/2?speed=6");
    const review = page.getByRole("region", { name: /^Needs you/ });
    await expect(review).toBeVisible();
    const open = review.getByRole("button", { name: "Review" }).first();
    await expect(open).toBeVisible();
    await open.click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await expectAccessible(page, {
      within: drawer,
      label: "Add cards prototype 2, card drawer",
    });
    await drawer.getByRole("button", { name: "Close" }).click();
    await expect(drawer).toBeHidden();
    await expectAccessible(page, { label: "Add cards prototype 2, lanes" });
  },
);

test(
  "Add cards prototype 3 (Review Desk): set up, then save and next",
  { tag: ["@home"] },
  async ({ page }) => {
    await page.goto("/binder-tracking/add/3?speed=6");
    await expect(
      page.getByRole("heading", { name: "Start a run" }),
    ).toBeVisible();
    await expectAccessible(page, { label: "Add cards prototype 3, setup" });
    await page.getByRole("button", { name: "Start adding cards" }).click();
    const save = page.getByRole("button", { name: "Save and next" });
    await expect(save).toBeEnabled();
    await save.click();
    await expect(
      page.getByRole("region", { name: /^Saved, [1-9]/ }),
    ).toBeVisible();
    await expectAccessible(page, { label: "Add cards prototype 3, desk" });
  },
);

test(
  "Add cards prototype 4 (Keyboard Counter): set up and save by keyboard only",
  { tag: ["@home"] },
  async ({ page }) => {
    await page.goto("/binder-tracking/add/4?speed=6");
    const answer = page.getByRole("combobox");
    await expect(answer).toBeFocused();
    await expectAccessible(page, {
      label: "Add cards prototype 4, setup prompt",
    });
    for (let n = 0; n < 4; n++) await page.keyboard.press("Enter");

    await expect(page.getByRole("region", { name: /^#/ })).toBeVisible();
    // Wait for a confident match in the queue, then save every one of them.
    await expect(
      page
        .getByRole("list", { name: "Queue" })
        .getByRole("button", { name: /^✓/ })
        .first(),
    ).toBeVisible();
    await page.keyboard.press("Shift+Enter");
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: /^Saved [1-9]\d* matched cards$/ }),
    ).toBeVisible();
    await expectAccessible(page, { label: "Add cards prototype 4, counter" });
  },
);

test(
  "The demo binder links to the add-cards prototypes",
  { tag: ["@home"] },
  async ({ page }) => {
    await page.goto("/binder-tracking?demo=on");
    await page.getByRole("link", { name: "Try the four prototypes" }).click();
    await expect(page).toHaveURL(/\/binder-tracking\/add\/1$/);
    await page.getByRole("link", { name: "Back to the demo binder" }).click();
    await expect(
      page.getByRole("region", { name: "About this demo" }),
    ).toBeVisible();
  },
);
