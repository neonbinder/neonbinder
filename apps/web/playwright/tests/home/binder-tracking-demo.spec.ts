// NEO-350 (R1): the signed-out collection demo on the Binder Tracking tour
// opens in place, its tabs, a binder and the Inventory tab (boxes, Sell) work, browser Back returns to the
// previous view, and "Back to the tour" leaves it. Light by design: the demo
// is hard-coded marketing data; its depth is covered by unit tests.
import { test, expect, expectAccessible } from "../../support/fixtures";
import type { Locator } from "@playwright/test";

// A button's accessible name, read from its ARIA snapshot. The snapshot is
// YAML, which writes an apostrophe as '' ("Artist''s Proof"); undo that.
const buttonName = async (button: Locator) =>
  (/button "([^"]+)"/.exec(await button.ariaSnapshot())?.[1] ?? "").replace(/''/g, "'");

test(
  "Binder Tracking tour: open the demo binder, switch tabs, open a binder, Back, leave",
  { tag: ["@smoke", "@home"] },
  async ({ page }) => {
    await page.goto("/binder-tracking");
    const tour = page.getByRole("region", { name: "Take it for a spin" });
    await expect(tour).toBeVisible();
    await expectAccessible(page, { within: tour, label: "Binder Tracking tour, Take it for a spin" });

    // Opening the demo swaps the tour for it, in place, and lands focus on the demo notice.
    await tour.getByRole("link", { name: "Open the demo binder" }).click();
    await expect(page).toHaveURL(/\/binder-tracking\?demo=on$/);
    const about = page.getByRole("region", { name: "About this demo" });
    await expect(about).toBeFocused();
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();

    // The three tabs, each on its own view of the URL.
    const tabs = page.getByRole("navigation", { name: "Collection sections" });
    await tabs.getByRole("link", { name: "My Cards" }).click();
    await expect(page).toHaveURL(/[?&]tab=cards/);
    await expect(page.getByRole("heading", { level: 2, name: "Sets I'm building" })).toBeVisible();
    await expectAccessible(page, { label: "Collection demo, My Cards" });

    await tabs.getByRole("link", { name: "Checklists" }).click();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    await expect(page.getByRole("searchbox", { name: "Search every card" })).toBeVisible();

    await tabs.getByRole("link", { name: "My Binders" }).click();
    await expect(page).toHaveURL(/[?&]tab=binders/);
    const binders = page.getByRole("list", { name: "Your binders" });
    await expect(binders).toBeVisible();

    // Open one binder; browser Back returns to the shelf.
    await binders.getByRole("button", { name: /^All Reggie White,/ }).click();
    await expect(page.getByRole("heading", { level: 2, name: "All Reggie White" })).toBeVisible();
    await expectAccessible(page, { label: "Collection demo, an open binder" });
    await page.goBack();
    await expect(binders).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "All Reggie White" })).toBeHidden();

    // NEO-359: collection and inventory are separate screens. The shelf's
    // Inventory door opens the demo's Inventory tab (boxes and Sell are demo-only
    // until the real Inventory ships); no box stands among the binders.
    const special = page.getByRole("list", { name: "Special places" });
    await expect(binders.getByRole("button", { name: /, box, / })).toHaveCount(0);
    // Copies in a box never count on a collection screen: read All my cards now,
    // and it moves only when a card leaves or enters a box below.
    const allSpine = special.getByRole("button", { name: /^All my cards, [\d,]+ cards?$/ });
    await expect(allSpine).toBeVisible();
    const allBase = Number(/All my cards, ([\d,]+) card/.exec(await allSpine.ariaSnapshot())?.[1]?.replace(/,/g, ""));
    expect(allBase, "All my cards reads a count").toBeGreaterThanOrEqual(0);
    const door = special.getByRole("link", { name: /^Inventory, \d+ cards? for sale$/ });
    await expect(door).toBeVisible();
    await door.click();
    await expect(page).toHaveURL(/[?&]tab=inventory/);
    await expect(tabs.getByRole("link", { name: "Inventory", exact: true })).toHaveAttribute("aria-current", "page");

    // The box shelf: the Show box, a New box, and the whole stock's long box.
    // Nothing from the collection stands here.
    await expect(page.getByRole("heading", { level: 3, name: "Your boxes" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Your binders" })).toHaveCount(0);
    const boxes = page.getByRole("list", { name: "Your boxes" });
    const showBox = boxes.getByRole("button", { name: /^Show box, box, \d+ cards? for sale$/ });
    await expect(showBox).toBeVisible();
    await expect(boxes.getByRole("button", { name: "New box", exact: true })).toBeVisible();
    await expect(page.getByText(/^\d+ cards? for sale in 1 box\.$/)).toBeVisible();
    const stock = page.getByRole("list", { name: "The whole stock" });
    const wholeStock = stock.getByRole("button", { name: /^Everything for sale, \d+ cards? for sale$/ });
    await expect(wholeStock).toBeVisible();
    await expectAccessible(page, { label: "Collection demo, the Inventory shelf" });

    // Open the Show box: five rows, and the strip of cards not sorted into a row yet.
    await showBox.click();
    await expect(page).toHaveURL(/[?&]b=[^&]+/);
    await expect(page.getByRole("heading", { level: 2, name: "Show box", exact: true })).toBeVisible();
    const open = page.getByRole("region", { name: "Show box, open", exact: true });
    await expect(open.getByRole("group", { name: /^Row \d, \d+ cards?$/ })).toHaveCount(5);
    await expect(page.getByRole("group", { name: "Not sorted into a row yet", exact: true })).toBeVisible();
    await expectAccessible(page, { label: "Collection demo, an open box" });

    // The drawer: take a box card off sale. It leaves Inventory and joins the
    // collection (All my cards); selling it again takes it back out of there.
    const boxCard = open.getByRole("button", { name: /, for sale/ }).first();
    const boxCardName = await buttonName(boxCard);
    // "<card label>[, N copies][, slab][, serial][, for sale]": the label is what comes first.
    const label = boxCardName.split(/, \d+ copies|, serial |, slab|, for sale/)[0];
    const copiesTaken = Number(/, (\d+) copies/.exec(boxCardName)?.[1] ?? "1");
    expect(label, `a box card named like a card (read: ${boxCardName})`).toMatch(/#/);
    await boxCard.click();
    const drawer = page.getByRole("dialog");
    const takeOff = drawer.getByRole("button", { name: /^Take .*, off sale$/ }).first();
    // The line's own name ("#N Player, Raw ×3"), for the Sell button it becomes.
    const line = /^Take (.*), off sale$/.exec(await buttonName(takeOff))?.[1] ?? "";
    expect(line, "a Take off sale button naming its line").not.toBe("");
    await takeOff.click();
    const offForm = drawer.getByRole("form", { name: / off sale$/ });
    await expect(offForm.getByRole("combobox", { name: "Back into" })).toBeVisible();
    await offForm.getByRole("button", { name: /^Take (it|\d+) off sale$/ }).click();
    await expect(drawer.getByRole("status").filter({ hasText: /^Took .* off sale\./ })).toBeVisible();
    // The drawer rides on the URL: closing it is a Back step onto the open box.
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();
    await expect(page.getByRole("heading", { level: 2, name: "Show box", exact: true })).toBeVisible();

    // My Binders: All my cards now counts the card, and shows it, with no sale
    // chip, no sale tag and no sale pocket anywhere.
    await tabs.getByRole("link", { name: "My Binders" }).click();
    await expect(page).toHaveURL(/[?&]tab=binders/);
    const allNow = special.getByRole("button", { name: `All my cards, ${allBase + copiesTaken} ${allBase + copiesTaken === 1 ? "card" : "cards"}`, exact: true });
    await expect(allNow).toBeVisible();
    await allNow.click();
    await expect(page).toHaveURL(/[?&]all=1/);
    await expect(page.getByRole("heading", { level: 2, name: "All my cards", exact: true })).toBeVisible();
    await expect(page.getByText("Every card in your binders, one pocket per copy.").first()).toBeVisible();
    const only = page.getByRole("group", { name: "Only show", exact: true });
    await expect(only.getByRole("button", { name: "Graded" })).toBeVisible();
    await expect(only.getByRole("button", { name: "Rookies" })).toBeVisible();
    await expect(only.getByRole("button", { name: /for sale/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /, for sale/ })).toHaveCount(0);
    // The card is among the pockets (the pile turns in pages: a bounded walk to its page).
    const pile = page.getByRole("region", { name: "All my cards, open", exact: true });
    const pocket = // A plain-string name (a substring match), not a RegExp: inside .or(), a
    // RegExp holding an apostrophe ("Artist's Proof") breaks Playwright's selector parser.
    pile.getByRole("button", { name: label }).first();
    const turn = page.getByRole("button", { name: /^Next pages?$/ });
    for (let i = 0; i < 12; i++) {
      await expect(pocket.or(turn).first()).toBeVisible();
      if (await pocket.isVisible()) break;
      await turn.click();
    }
    await expect(pocket).toBeVisible();
    await expectAccessible(page, { label: "Collection demo, All my cards without a for-sale card" });

    // Sell it again from its pocket: the Sell panel, then it is gone from the pile.
    await pocket.click();
    await drawer.getByRole("button", { name: `Sell ${line}` }).first().click();
    const sellForm = drawer.getByRole("form", { name: /^Sell / });
    await sellForm.getByRole("combobox", { name: "Into which box" }).selectOption({ label: "Show box" });
    await expectAccessible(page, { within: sellForm, label: "Collection demo, the drawer's Sell panel" });
    await sellForm.getByRole("button", { name: /^Put (it|\d+) up for sale$/ }).click();
    await expect(drawer.getByRole("status").filter({ hasText: /up for sale in Show box/ })).toBeVisible();
    await expect(drawer.getByText(/For sale · Show box/).first()).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();
    await expect(page.getByRole("heading", { level: 2, name: "All my cards", exact: true })).toBeVisible();
    await expect(pocket).toHaveCount(0);

    // Back to the shelf: All my cards is back to where it started.
    await page.goBack();
    await expect(page).toHaveURL(/[?&]tab=binders/);
    await expect(page).not.toHaveURL(/[?&]all=1/);
    await expect(allSpine).toBeVisible();
    await expect(special.getByRole("button", { name: `All my cards, ${allBase} ${allBase === 1 ? "card" : "cards"}`, exact: true })).toBeVisible();
    // Back again: the open box, then the Inventory shelf.
    await page.goBack();
    await expect(page.getByRole("heading", { level: 2, name: "Show box", exact: true })).toBeVisible();
    await page.goBack();
    await expect(page).not.toHaveURL(/[?&]b=/);
    await expect(page).toHaveURL(/[?&]tab=inventory/);
    await expect(showBox).toBeVisible();

    // The whole stock: every card in every box, box by box.
    await wholeStock.click();
    await expect(page).toHaveURL(/[?&]sale=1(&|$)/);
    await expect(page.getByRole("heading", { level: 2, name: "For sale", exact: true })).toBeVisible();
    await expect(page.getByText(/^\d+ cards? for sale in 1 box$/)).toBeVisible();
    const saleBox = page.getByRole("region", { name: "Show box, for sale", exact: true });
    await expect(saleBox.getByRole("button", { name: /, for sale, Show box, / }).first()).toBeVisible();
    await expectAccessible(page, { label: "Collection demo, everything for sale" });
    await saleBox.getByRole("button", { name: "Open the box, Show box", exact: true }).click();
    await expect(page).toHaveURL(/[?&]b=[^&]+/);
    await expect(open).toBeVisible();

    // Back steps through all of it: box, stock, shelf, then My Binders.
    await page.goBack();
    await expect(page).toHaveURL(/[?&]sale=1(&|$)/);
    await expect(saleBox).toBeVisible();
    await page.goBack();
    await expect(page).not.toHaveURL(/[?&]sale=/);
    await expect(showBox).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/[?&]tab=binders/);
    await expect(binders).toBeVisible();
    await expect(door).toBeVisible();

    // "Back to the tour" goes straight out, to the tour.
    await page.getByRole("button", { name: "Back to the tour" }).click();
    await expect(page).toHaveURL(/\/binder-tracking$/);
    await expect(tour).toBeVisible();
    await expect(tour.getByRole("link", { name: "Open the demo binder" })).toBeFocused();
  },
);
