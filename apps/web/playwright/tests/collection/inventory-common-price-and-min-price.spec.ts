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
// NEO-479: the drawer's Sell panel carries a Price field. It opens on the copy's
// own price, else the common price (which a one-card panel never writes): selling
// at the prefill stores no price of its own, so the copy keeps reading the common
// price ("$0.25, common"); a typed price becomes THIS copy's own. Taking a copy
// off sale clears that price, and Undo puts it back.
//
// R7/R7a: writes only the signed-in user's own rows (`variantCommonPrices`,
// `collectionContainers`, `collectionCopies`; the bootstrap reset clears the
// account) against one card of the seed's 2024 Topps Chrome Base, registered in
// SET-REGISTRY.md. It never writes the set, its cards, players or teams.
// Self-cleaning: the copy is removed through the drawer and the common price is
// cleared through the UI, so the account ends as it began.
//
// R3: the collector's cascade and tabs come from `support/collection.ts`.
import { confirmRemoved, drillToCollectorBase, inventoryTabs, ordinaryBaseRows, shortNameOf } from "../../support/collection";
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

    // --- NEO-479: take it off sale; its own price goes with it ---------------------
    await yourCopies.getByRole("button", { name: `Take off sale, ${one.short}, Raw, Excellent`, exact: true }).click();
    const offForm = yourCopies.getByRole("form", { name: /off sale/i });
    await expect(offForm.getByRole("combobox", { name: "Back into" }).getByRole("option", { name: "Main", exact: true })).toBeAttached();
    await offForm.getByRole("button", { name: "Take it off sale", exact: true }).click();
    await expect(offForm).toBeHidden();
    await expect(drawer.getByRole("status").filter({ hasText: `Took ${one.short} off sale.` })).toBeVisible();
    const binderLine = yourCopies.getByRole("listitem").filter({ has: page.getByText("Raw, Excellent", { exact: true }) });
    await expect(binderLine.getByText("Main")).toBeVisible();

    // Undo puts it back in the box WITH the $0.50 it had (the price left with the exit and returns with the Undo) ...
    await drawer.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(drawer.getByRole("status").filter({ hasText: "Undone." })).toBeVisible();
    await expect(line.getByText(/\$0\.50/)).toBeVisible();
    await expect(line.getByText(/, common/)).toHaveCount(0);
    // ... and taking it off sale again clears it for good.
    await yourCopies.getByRole("button", { name: `Take off sale, ${one.short}, Raw, Excellent`, exact: true }).click();
    await offForm.getByRole("button", { name: "Take it off sale", exact: true }).click();
    await expect(offForm).toBeHidden();
    await expect(binderLine.getByText("Main")).toBeVisible();

    // --- Sell it again: Price opens on the common price, not the old own price ----
    const sellButton = yourCopies.getByRole("button", { name: `Sell ${one.short}, Raw, Excellent`, exact: true });
    await sellButton.click();
    const sellForm = yourCopies.getByRole("form", { name: "Sell Raw, Excellent", exact: true });
    const sellInto = sellForm.getByRole("combobox", { name: "Into which box" });
    await expect(sellInto.getByRole("option", { selected: true })).toHaveText("Unsorted");
    const sellPrice = sellForm.getByRole("textbox", { name: "Price", exact: true });
    await expect(sellPrice).toHaveValue("0.25");
    await expect(
      sellForm.getByText("Your common price, $0.25. Change it to price just this card; your common price stays put."),
    ).toBeVisible();
    await expectAccessible(page, { within: sellForm, label: "Card drawer, the Sell panel on the common price" });

    // Left as it is: no price of its own is stored, so the line reads the common price again.
    await sellForm.getByRole("button", { name: "Put it up for sale", exact: true }).click();
    await expect(sellForm).toBeHidden();
    await expect(
      drawer.getByRole("status").filter({ hasText: `${one.short} is up for sale in Unsorted at your common price, $0.25.` }),
    ).toBeVisible();
    await expect(line.getByText(/\$0\.25, common/)).toBeVisible();

    // --- Take it off again and sell it at a price of its own -----------------------
    await yourCopies.getByRole("button", { name: `Take off sale, ${one.short}, Raw, Excellent`, exact: true }).click();
    await offForm.getByRole("button", { name: "Take it off sale", exact: true }).click();
    await expect(offForm).toBeHidden();
    await expect(binderLine.getByText("Main")).toBeVisible();
    await sellButton.click();
    await expect(sellPrice).toHaveValue("0.25");
    await sellPrice.fill("0.40");
    await sellForm.getByRole("button", { name: "Put it up for sale", exact: true }).click();
    await expect(sellForm).toBeHidden();
    await expect(
      drawer.getByRole("status").filter({ hasText: `${one.short} is up for sale in Unsorted at $0.40.` }),
    ).toBeVisible();
    await expect(line.getByText(/\$0\.40/)).toBeVisible();
    await expect(line.getByText(/, common/)).toHaveCount(0);

    // Undo puts the copy back in Main, without the $0.40 ...
    await drawer.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(drawer.getByRole("status").filter({ hasText: "Undone." })).toBeVisible();
    await expect(binderLine.getByText("Main")).toBeVisible();

    // ... so the Sell panel opens on the common price again: $0.40 was only ever this
    // copy's own price, and the panel never wrote it to the common price.
    await sellButton.click();
    await expect(sellPrice).toHaveValue("0.25");
    await expectAccessible(page, { within: sellForm, label: "Card drawer, the Sell panel after an Undo" });
    // A blank price will not sell, and the common price is the way back.
    await sellPrice.fill("");
    await expect(sellForm.getByRole("alert").getByText("Blank won't sell. Put back $0.25 or name your own price.")).toBeVisible();
    await expect(sellPrice).toHaveAttribute("aria-invalid", "true");
    await expect(sellForm.getByRole("button", { name: "Put it up for sale", exact: true })).toBeDisabled();
    await expectAccessible(page, { within: sellForm, label: "Card drawer, the Sell panel with a blank price" });
    // Past the cap is refused too, and typing the common price back clears the error.
    await sellPrice.fill("100000001");
    await expect(sellForm.getByRole("alert").getByText("Whoa, that's past the $100,000,000.00 cap.")).toBeVisible();
    await expect(sellPrice).toHaveAttribute("aria-invalid", "true");
    await expect(sellForm.getByRole("button", { name: "Put it up for sale", exact: true })).toBeDisabled();
    await expectAccessible(page, { within: sellForm, label: "Card drawer, the Sell panel with a price past the cap" });
    await sellPrice.fill("0.25");
    await expect(sellPrice).not.toHaveAttribute("aria-invalid", "true");
    await expect(sellForm.getByRole("button", { name: "Put it up for sale", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(sellForm).toBeHidden();
    await expect(sellButton).toBeFocused();

    // --- Cleanup (R7): remove the copy (it is back in Main), then clear the common price
    await yourCopies.getByRole("button", { name: `Remove ${one.short}, Raw, Excellent`, exact: true }).click();
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    await confirmRemoved(drawer);
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();
    // The common price is still what the collector set: no Sell panel wrote it.
    await expect(checklist.getByText("$0.25", { exact: true })).toBeVisible();
    await change.click();
    await expect(priceField).toHaveValue("0.25");
    await priceField.fill("");
    await page.keyboard.press("Enter");
    await expect(said(`Cleared the common price for ${title}`)).toBeVisible();
    await expect(checklist.getByText("No common price yet", { exact: true })).toBeVisible();
  },
);
