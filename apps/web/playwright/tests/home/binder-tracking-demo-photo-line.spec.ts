// NEO-431 (R1): the public demo's inventory takes a card with a photo the way
// the signed-in app does, on fake data (no Convex, no account, R7 read-only).
// On the demo's Inventory Checklists a visitor boxes one plain Ohtani, opens the
// card's drawer and adds a copy holding a front photo (the Add form is checked
// for accessibility with the photo held). The photo copy is its OWN line beside
// the identical plain one, never "Raw, Excellent x2", and the field counts both.
// The + raises the plain line that was there first, typing 0 pulls every plain
// line (the photo one too, said so) and Undo brings them back with the photo's
// thumbnail. The real thing, with R2 and Convex, is proven signed in by
// collection/inventory-photo-line-quick-quantity; this is the same behaviour in
// the demo's store.
import { photoFile } from "../../support/collection";
import { test, expect, expectAccessible } from "../../support/fixtures";

test(
  "Binder Tracking demo: a copy added with a photo is its own line beside a plain one, + and 0 count both, Undo brings the photo back",
  { tag: ["@home"] },
  async ({ page }) => {
    await page.goto("/binder-tracking?demo=on&side=inventory&tab=checklists");
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible();
    await page.getByRole("searchbox", { name: "Search every card" }).fill("ohtani");
    const field = page.getByRole("textbox", { name: /^Quantity of 2024 Topps Chrome #1 Shohei Ohtani, Dodgers in Unsorted$/ });
    await expect(field).toHaveValue("0");
    const said = (text: string | RegExp) => page.getByRole("status").filter({ hasText: text });

    // One plain copy, boxed with the quick count.
    await field.fill("1");
    await field.press("Tab");
    await expect(said("Boxed 1 more of #1 Shohei Ohtani. 1 in Unsorted.")).toBeVisible();

    // Its drawer: the card's seed copy in Main and the box copy just boxed. Add a third.
    const card = "2024 Topps Chrome #1 Shohei Ohtani, Dodgers";
    await page.getByRole("button", { name: `Details for ${card}`, exact: true }).click();
    const drawer = page.getByRole("dialog", { name: card, exact: true });
    await expect(drawer).toBeVisible();
    const yourCopies = drawer.getByRole("region", { name: "Your copies of #1 Shohei Ohtani", exact: true });
    await expect(yourCopies.getByRole("heading", { name: "Your copies (2 lines)" })).toBeVisible();
    await drawer.getByRole("button", { name: "Add another copy of #1 Shohei Ohtani", exact: true }).click();
    const addForm = drawer.getByRole("form", { name: "Add another copy" });
    await expect(addForm).toBeVisible();
    await expect(addForm.getByRole("combobox", { name: "Where it lives" }).getByRole("option", { selected: true })).toHaveText(
      "Unsorted (box, for sale)",
    );
    const panel = addForm.getByRole("region", { name: /^Photos of / });
    await panel.getByLabel("Front photo file", { exact: true }).setInputFiles(photoFile("front.jpg"));
    await expect(panel.getByRole("img", { name: "Front of your new copy", exact: true })).toBeVisible();
    await expect(drawer).toBeInViewport({ ratio: 0.99 });
    await expectAccessible(page, { within: drawer, label: "Demo card drawer, Add form holding a front photo" });
    await addForm.getByRole("button", { name: "Add to inventory" }).click();
    await expect(addForm).toBeHidden();
    await expect(drawer.getByRole("status").filter({ hasText: /^Added #1 Shohei Ohtani, Raw, Excellent.*with its front photo\./ })).toBeVisible();
    // Its own line beside the identical plain one: three lines, never "Raw, Excellent ×2".
    await expect(yourCopies.getByRole("heading", { name: "Your copies (3 lines)" })).toBeVisible();
    await expect(drawer.getByRole("status").filter({ hasText: "Stacked it" })).toHaveCount(0);
    await expect(yourCopies.getByText(/×2/)).toHaveCount(0);
    const thumbs = yourCopies.getByRole("img", { name: /^Front of Raw, Excellent/ });
    await expect(thumbs).toHaveCount(1);
    await expect(thumbs).toBeVisible();
    await expectAccessible(page, { within: drawer, label: "Demo card drawer, a photo line beside a plain one" });
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();

    // Both Excellent lines are plain (a photo alone sets none apart): the field counts them.
    await expect(field).toHaveValue("2");
    await page.getByRole("button", { name: `Add one ${card} to Unsorted`, exact: true }).click();
    await expect(said("Boxed 1 more of #1 Shohei Ohtani. 3 in Unsorted.")).toBeVisible();
    await expect(field).toHaveValue("3");
    await expectAccessible(page, { label: "Demo Inventory Checklists, the photo line counted 3" });
    await page.getByRole("button", { name: `Details for ${card}`, exact: true }).click();
    await expect(yourCopies.getByRole("heading", { name: "Your copies (3 lines)" })).toBeVisible();
    // The + went to the plain line that was there first; the photo line stays a line of one.
    const photoLine = yourCopies.getByRole("listitem").filter({ has: page.getByRole("img", { name: /^Front of Raw, Excellent/ }) });
    await expect(photoLine).toHaveCount(1);
    await expect(photoLine.getByText(/×\d/)).toHaveCount(0);
    await expect(yourCopies.getByRole("button", { name: "Edit #1 Shohei Ohtani, Raw, Excellent ×2", exact: true })).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();

    // Typing 0 pulls every plain line out, the photo one too, and says so.
    await field.fill("0");
    await field.press("Tab");
    await expect(said("Pulled 3 of #1 Shohei Ohtani from Unsorted, with its photos. 0 left.")).toBeVisible();
    await expect(field).toHaveValue("0");

    // Undo brings them back with the photo's thumbnail.
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(said("Undone.")).toBeVisible();
    await expect(field).toHaveValue("3");
    await page.getByRole("button", { name: `Details for ${card}`, exact: true }).click();
    await expect(yourCopies.getByRole("heading", { name: "Your copies (3 lines)" })).toBeVisible();
    await expect(yourCopies.getByRole("img", { name: /^Front of Raw, Excellent/ })).toBeVisible();
    await page.goBack();
    await expect(drawer).toBeHidden();
    await expect(field).toHaveValue("3");
  },
);
