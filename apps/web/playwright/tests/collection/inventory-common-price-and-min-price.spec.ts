// NEO-378 (R1): a collector prices what they sell. On the inventory's Checklists
// each checklist carries the collector's COMMON PRICE for that exact variant
// (manual, per collector: "commons go for 25¢"). A copy for sale with no price
// of its own sells at it, and the card drawer says so: the add form's Price
// field shows the common price as what a blank means, and the box line reads
// "$0.25, common". A copy's own price overrides it ("$0.50"). The collector
// never sees "minimum price" (Jason, 2026-10-28), though it is stored as a floor.
// A blank common price clears it.
//
// The common price line opens in place: Set common price, type, Enter saves
// (the status line says it, with Undo); a blank field clears it.
//
// R7/R7a: writes only the signed-in user's own rows (`variantCommonPrices`,
// `collectionContainers`, `collectionCopies`; the bootstrap reset clears the
// account) against one card of the seed's 2024 Topps Chrome Base, registered in
// SET-REGISTRY.md. It never writes the set, its cards, players or teams.
// Self-cleaning: the copy is removed through the drawer and the common price is
// cleared through the UI, so the account ends as it began.
//
// R3: the collector's cascade and tabs come from `support/collection.ts`.
import { drillToCollectorBase, inventoryTabs, ordinaryBaseRows, shortNameOf } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test(
  "Inventory: set a checklist's common price, a box copy sells at it, its own minimum price overrides it",
  { tag: ["@smoke", "@collection"] },
  async ({ page, signIn }) => {
    const title = "2024 Topps Chrome Base";
    const said = (text: string) => page.getByRole("status").filter({ hasText: text });

    await signIn("/inventory?tab=checklists");
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
    await expect(inventoryTabs(page).getByRole("link", { name: "Checklists", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const checklist = await drillToCollectorBase(page);

    // --- A fresh account has no common price for Base; set one with Enter ---------
    await expect(checklist.getByText("No common price yet", { exact: true })).toBeVisible();
    await checklist.getByRole("button", { name: `Set a common price for ${title}`, exact: true }).click();
    const priceField = checklist.getByRole("textbox", { name: "Common price", exact: true });
    await expect(priceField).toBeFocused();
    await expectAccessible(page, { within: checklist, label: "Inventory checklist, the common price field open" });
    await priceField.fill("0.25");
    await page.keyboard.press("Enter");
    await expect(said(`Common price for ${title} is $0.25`)).toBeVisible();
    await expect(priceField).toBeHidden();
    await expect(checklist.getByText("$0.25", { exact: true })).toBeVisible();
    const change = checklist.getByRole("button", { name: `Change the common price for ${title}`, exact: true });
    await expect(change).toBeFocused();

    // --- A box copy with no floor of its own sells at the common price ------------
    const one = await shortNameOf(ordinaryBaseRows(checklist).first());
    await checklist.getByRole("button", { name: `Details for ${one.short}`, exact: true }).click();
    const drawer = page.getByRole("dialog", {
      name: new RegExp(`^2024 Topps Chrome #${escapeRegExp(one.number)} ${escapeRegExp(one.player)}`),
    });
    await expect(drawer).toBeVisible();
    const yourCopies = drawer.getByRole("region", { name: `Your copies of ${one.short}`, exact: true });
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    const addForm = drawer.getByRole("form", { name: "Add a copy", exact: true });
    // On the inventory the add files into Unsorted, a box: the copy is for sale, so it takes a floor.
    await expect(
      addForm.getByRole("combobox", { name: "Where it lives" }).getByRole("option", { selected: true }),
    ).toHaveText("Unsorted (box, for sale)");
    const minField = addForm.getByRole("spinbutton", { name: "Price", exact: true });
    await expect(minField).toHaveAttribute("placeholder", "0.25");
    await expect(addForm.getByText("Blank sells at your common price, $0.25.", { exact: true })).toBeVisible();
    await expectAccessible(page, { within: drawer, label: "Card drawer, add form with a minimum price" });
    await addForm.getByRole("button", { name: "Add to inventory" }).click();
    await expect(drawer.getByRole("status").filter({ hasText: `Added ${one.short}, Raw, Excellent` })).toBeVisible();
    const line = yourCopies.getByRole("listitem").filter({ has: page.getByText("Raw, Excellent", { exact: true }) });
    await expect(line.getByText(/\$0\.25, common/)).toBeVisible();

    // --- Its own minimum price overrides the common one ---------------------------
    await yourCopies.getByRole("button", { name: `Edit ${one.short}, Raw, Excellent`, exact: true }).click();
    const editForm = drawer.getByRole("form", { name: "Edit Raw, Excellent", exact: true });
    const ownMin = editForm.getByRole("spinbutton", { name: "Price", exact: true });
    await expect(ownMin).toHaveValue("");
    await ownMin.fill("0.50");
    await editForm.getByRole("button", { name: "Save copy" }).click();
    await expect(drawer.getByRole("status").filter({ hasText: `Saved ${one.short}` })).toBeVisible();
    await expect(line.getByText(/\$0\.50/)).toBeVisible();
    await expect(line.getByText(/, common/)).toHaveCount(0);

    // --- Cleanup (R7): remove the copy, then clear the common price ---------------
    await yourCopies.getByRole("button", { name: `Remove ${one.short}, Raw, Excellent`, exact: true }).click();
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();
    await change.click();
    await expect(priceField).toHaveValue("0.25");
    await priceField.fill("");
    await page.keyboard.press("Enter");
    await expect(said(`Cleared the common price for ${title}`)).toBeVisible();
    await expect(checklist.getByText("No common price yet", { exact: true })).toBeVisible();
  },
);
