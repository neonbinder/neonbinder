// NEO-369: Add cards, the demo's intake tab on both sides of the public demo
// binder. A scripted pile of scans walks the pipeline on fake data (no
// Convex, R7 read-only); saved cards go into the demo store. `?speed=6` runs
// the pile six times faster so no wait leaves the 7 s budget.
import { test, expect, expectAccessible } from "../../support/fixtures";

test(
  "Add cards (collection): the tab opens from the demo, Yes saves a card, a click lands in its quantity, y saves it",
  { tag: ["@home"] },
  async ({ page }) => {
    // Cards keep fading in as the scripted scans land; with reduced motion
    // they arrive settled, so axe measures the colours a reader sees.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/binder-tracking?demo=on&speed=6");
    await page.getByRole("link", { name: "Add cards" }).click();
    await expect(page.getByLabel("Put them in this binder")).toBeVisible();

    const review = page.getByRole("region", { name: /^Needs you/ });
    const saved = page.getByRole("region", { name: /^Saved/ });
    const yes = review
      .getByRole("button", { name: "Yes", exact: true })
      .first();
    await expect(yes).toBeEnabled();
    await expectAccessible(page, { label: "Add cards, collection" });
    await yes.click();
    await expect(saved).toHaveAccessibleName("Saved, 1");

    // A click on a waiting card puts the caret in its quantity with the
    // number selected, so typing replaces it.
    const card = review
      .getByRole("listitem")
      .filter({ hasText: /Matched \d+%/ })
      .first();
    const badge = card.getByText(/^Matched \d+%$/);
    const qty = card.getByRole("textbox", { name: /^(Qty|Had \d+ →)$/ });
    await badge.click();
    await expect(qty).toBeFocused();
    await page.keyboard.type("5");
    await expect(qty).toHaveValue("5");

    // p jumps to the card's price beside it, number selected, and a letter
    // there is still a shortcut: y saves the card at the typed price.
    const price = card.getByRole("textbox", { name: "Price $" });
    await page.keyboard.press("p");
    await expect(price).toBeFocused();
    await page.keyboard.type("2.50");
    await expect(price).toHaveValue("2.50");
    await page.keyboard.press("y");
    await expect(saved).toHaveAccessibleName("Saved, 2");
  },
);

test(
  "Add cards (collection): a card that can't be saved as is opens its drawer, and Reject card takes it out",
  { tag: ["@home"] },
  async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/binder-tracking?demo=on&tab=add&speed=6");
    const review = page.getByRole("region", { name: /^Needs you/ });
    // The scripted autograph: its number says it isn't a Base card.
    const why = review.getByText(/not a Base card/);
    await why.click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText(/not a Base card/)).toBeVisible();
    await expectAccessible(page, {
      label: "Add cards, drawer for a wrong variant",
    });
    await drawer.getByRole("button", { name: /Reject card$/ }).click();
    await expect(drawer).toBeHidden();
    await expect(why).toBeHidden();
  },
);

test(
  "Add cards (collection): the set button opens the set selector and Skip folds it",
  { tag: ["@home"] },
  async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/binder-tracking?demo=on&tab=add&speed=6");
    const set = page.getByRole("button", {
      name: "Set: 2024 Topps Chrome Base",
    });
    await set.click();
    await expect(set).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByRole("button", { name: "Sports: Baseball, change" }),
    ).toBeVisible();
    await expectAccessible(page, { label: "Add cards, set selector open" });
    await page
      .getByRole("button", {
        name: "Skip: find each card's set from its photo",
      })
      .click();
    await expect(
      page.getByRole("button", { name: "Set: from the photos" }),
    ).toBeFocused();
  },
);

test(
  "Add cards (inventory): files into a box and saves every matched card at once",
  { tag: ["@home"] },
  async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/binder-tracking?demo=on&side=inventory&tab=add&speed=6");
    await expect(page.getByLabel("Put them in this box")).toHaveValue(/.+/);
    const saveAll = page.getByRole("button", {
      name: /^Save [1-9]\d* matched$/,
    });
    await expect(saveAll).toBeEnabled();
    await saveAll.click();
    await expect(
      page.getByRole("region", { name: /^Saved, [1-9]/ }),
    ).toBeVisible();
    await expectAccessible(page, { label: "Add cards, inventory" });
  },
);
