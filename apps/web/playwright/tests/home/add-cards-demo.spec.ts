// NEO-369: Add cards, the demo's intake tab on both sides of the public demo
// binder. A scripted pile of scans walks the pipeline on fake data (no
// Convex, R7 read-only); saved cards go into the demo store. `?speed=6` runs
// the pile six times faster so no wait leaves the 7 s budget.
import type { Locator } from "@playwright/test";
import { nameOf } from "../../support/collection";
import { test, expect, expectAccessible } from "../../support/fixtures";

/** Wider than tall: the tile's front box after an odd number of quarter turns (the demo draws the edit as its preview). */
async function landscape(box: Locator): Promise<boolean> {
  const b = await box.boundingBox();
  return b !== null && b.width > b.height;
}

test(
  "Add cards (collection): the tab opens from the demo, Yes saves a card, a click lands in its quantity, y saves it",
  { tag: ["@home"] },
  async ({ page }) => {
    // Cards keep fading in as the scripted scans land; with reduced motion
    // they arrive settled, so axe measures the colours a reader sees.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/demo/collection?speed=6");
    await page.getByRole("link", { name: "Add cards" }).click();
    await expect(page.getByLabel("Put them in this binder")).toBeVisible();

    const review = page.getByRole("region", { name: /^Needs you/ });
    const saved = page.getByRole("region", { name: /^Saved/ });
    const yes = review
      .getByRole("button", { name: "Yes", exact: true })
      .first();
    await expect(yes).toBeEnabled();
    await expectAccessible(page, { label: "Add cards, collection" });

    // --- NEO-481: a card's front opens the photo viewer; a turn saves as the tile's preview ---
    {
      const first = review.getByRole("listitem").filter({ hasText: /Matched \d+%/ }).first();
      const openFront = first.getByRole("button", { name: /^Open front of / });
      const label = (await nameOf(openFront)).replace(/^Open front of /, "");
      // The front's picture, inside the button that opens it.
      const front = openFront.getByRole("img", { name: /^Front scan, / });
      await expect.poll(() => landscape(front)).toBe(false);
      await openFront.click();
      const viewer = page.getByRole("dialog", { name: `Front of ${label}`, exact: true });
      await expect(viewer).toBeVisible();
      await expect(viewer.getByRole("heading", { name: `Front of ${label}`, exact: true })).toBeVisible();
      const tools = viewer.getByRole("toolbar", { name: "Photo tools" });
      for (const tool of ["Turn left", "Turn right", "Crop by hand", "Start over"]) {
        await expect(tools.getByRole("button", { name: tool, exact: true })).toBeVisible();
      }
      await expect(viewer.getByRole("radiogroup", { name: "Which side" }).getByRole("radio", { name: "Front", exact: true })).toBeChecked();
      await expectAccessible(page, { within: viewer, label: "Demo card photo viewer, a waiting card's front" });
      await tools.getByRole("button", { name: "Turn right", exact: true }).click();
      // An unsaved turn holds the first Escape: the viewer stays and says why (a second would toss it).
      await page.keyboard.press("Escape");
      await expect(viewer).toBeVisible();
      await expect(viewer.getByRole("alert")).toHaveText(/^Unsaved edit\. Esc again to toss it, or Save photo\.\s?$/);
      await expectAccessible(page, { within: viewer, label: "Demo card photo viewer, an unsaved turn held on Escape" });
      await viewer.getByRole("button", { name: "Save photo", exact: true }).click();
      await expect(viewer.getByRole("status").filter({ hasText: /^Saved\.$/ })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(viewer).toBeHidden();
      await expect(openFront).toBeFocused();
      // The tile shows the turned card: its front box lies on its side now.
      await expect.poll(() => landscape(front)).toBe(true);
    }
    // A second card waiting, so there is a next one for Yes to move to.
    await expect(
      review.getByRole("button", { name: "Yes", exact: true }).nth(1),
    ).toBeEnabled();
    await yes.click();
    await expect(saved).toHaveAccessibleName("Saved, 1");
    // Yes works like Enter in the quantity: the next card is selected with
    // its quantity focused.
    await expect(
      review.getByRole("textbox", { name: /^(Qty|Had \d+ →)$/ }).first(),
    ).toBeFocused();

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

    // A binder card never has a price (NEO-481: only a card going into a box
    // does); the count field beside it is there, so the absence means something.
    await expect(card.getByRole("textbox", { name: /price/i })).toHaveCount(0);
    // A letter in the count is still a shortcut: y saves the card.
    await page.keyboard.press("y");
    await expect(saved).toHaveAccessibleName("Saved, 2");
  },
);

test(
  "Add cards (collection): a card that can't be saved as is opens its drawer, and Reject card takes it out",
  { tag: ["@home"] },
  async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/demo/collection?tab=add&speed=6");
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
    await page.goto("/demo/collection?tab=add&speed=6");
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
  "Add cards (inventory): each card has its own price, p and a typed price save it, and Save all files the rest into a box",
  { tag: ["@home"] },
  async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/demo/inventory?tab=add&speed=6");
    await expect(page.getByLabel("Put them in this box")).toHaveValue(/.+/);
    const review = page.getByRole("region", { name: /^Needs you/ });
    const saved = page.getByRole("region", { name: /^Saved/ });

    // A card going into a box has its own price, named for the card (NEO-481).
    // p jumps there from the selected card, and a letter typed there is still
    // a shortcut: y saves the card at the typed price.
    const card = review
      .getByRole("listitem")
      .filter({ hasText: /Matched \d+%/ })
      .first();
    const price = card.getByRole("textbox", { name: /^Price, / });
    await expect(price).toBeVisible();
    await card.getByText(/^Matched \d+%$/).click();
    await expect(card.getByRole("textbox", { name: /^(Qty|Had \d+ →)$/ })).toBeFocused();
    await page.keyboard.press("p");
    await expect(price).toBeFocused();
    await page.keyboard.type("2.50");
    await expect(price).toHaveValue("2.50");
    await page.keyboard.press("y");
    await expect(saved).toHaveAccessibleName("Saved, 1");

    const saveAll = page.getByRole("button", {
      name: /^Save [1-9]\d* matched$/,
    });
    await expect(saveAll).toBeEnabled();
    await saveAll.click();
    await expect(
      page.getByRole("region", { name: /^Saved, ([2-9]|\d\d)/ }),
    ).toBeVisible();
    await expectAccessible(page, { label: "Add cards, inventory" });
  },
);
