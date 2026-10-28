// NEO-364 (R1): the Inventory list, everything the collector has for sale, one
// item per card across every box. Entered through the signed-in shell's Inventory
// link, it lists cards stocked through quick entry in Unsorted and in a box of
// the collector's own, narrows to one box on the rail (each pick is a Back step),
// re-orders with "Sort by", finds a card with the filter box, narrows with the
// "Dupes only" and "Up for trade" chips, and an Up for Trade card shows on its
// own rail stop.
//
// THE HARD LINE (Jason: "Inventory is things for sale and My Collection is
// things that are for your collection. They should not mix on the screens."):
// the collection's "Every card I own" count is read before any of this and must
// read exactly the same while six cards stand in the boxes.
//
// R7/R7a: writes only the signed-in user's own rows (`collectionContainers`,
// `collectionCopies`; the bootstrap reset clears the account) on the first three
// rows of the seed's 2024 Topps Chrome Base, registered in SET-REGISTRY.md. It
// never writes the set, its cards, players or teams. Self-cleaning: the copies
// are removed through the drawer and the minted box is deleted.
//
// A phone has no Tab key: the fields' Next key is Enter, so the quick-entry
// passes use `isMobile` to pick Tab or Enter (GUIDE "Desktop and mobile"), and
// every branch ends in the same asserts.
//
// Minted names are single tokens from `env.ATTEMPT_TOKEN`.
import type { Locator } from "@playwright/test";
import {
  backToBoxes,
  cardsWord,
  createBox,
  deleteOpenBox,
  drillToCollectorBase,
  forSaleOnMyBoxes,
  goViaShell,
  inventoryTabs,
  myBoxesStock,
  nameOf,
  openListFilters,
  quantityField,
} from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test(
  "Inventory list: stock Unsorted and a box, narrow by box, sort, search and chips; the collection's count never moves",
  { tag: ["@smoke", "@collection"] },
  async ({ page, signIn, env, isMobile }) => {
    const boxName = `Lst${env.ATTEMPT_TOKEN}`;
    const advance = isMobile ? "Enter" : "Tab";
    const said = (text: string) => page.getByRole("status").filter({ hasText: text });

    // --- The collection's count, read first (the hard line) -----------------------------
    await signIn("/collection");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({ timeout: LAUNCH_GATE });
    const everyRe = /^Every card I own [\d,]+\+? cards?$/;
    const every = page.getByRole("navigation", { name: "Shelves and binders" }).getByRole("button", { name: everyRe });
    const ownedBefore = await nameOf(every);

    // --- Enter through the shell's Inventory link; Back and forward -----------------------
    await goViaShell(page, isMobile, "Inventory");
    await expect(page).toHaveURL(/\/inventory/);
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible();
    const tabs = inventoryTabs(page);
    await expect(tabs.getByRole("link", { name: "Inventory", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 2, name: "Everything for sale" })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/collection/);
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
    await page.goForward();
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible();

    // --- A box of my own; My Boxes' headline count to measure against ----------------------
    await tabs.getByRole("link", { name: "My Boxes", exact: true }).click();
    const forSaleBase = await forSaleOnMyBoxes(page);
    await createBox(page, boxName);
    await backToBoxes(page);

    // --- Stock through quick entry: X x3 and Y x1 in Unsorted, Z x2 in the box ---------------
    await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
    const adding = page.getByRole("combobox", { name: "Adding to" });
    await expect(adding.getByRole("option", { selected: true })).toHaveText("Unsorted");
    const checklist = await drillToCollectorBase(page);
    const unsortedList = checklist.getByRole("list", { name: "Quantities in Unsorted" });
    await expect(unsortedList.getByRole("textbox").nth(2)).toBeVisible();
    const card = async (n: number) => {
      const name = await nameOf(unsortedList.getByRole("textbox").nth(n));
      const m = /^Quantity of #(\S+) ([^,]+?)(?:,.*)? in Unsorted$/.exec(name);
      expect(m, `a quantity field named "Quantity of #N Player in Unsorted" (read: ${name})`).not.toBeNull();
      const short = /^Quantity of (.+) in Unsorted$/.exec(name)![1];
      return { short, number: m![1], player: m![2] };
    };
    // The search step finds Y by its player, so X and Z must be someone else: the Base opens
    // on one player's run (#1, #1b, #1c are all Ohtani), so take the next row that changes player.
    const x = await card(0);
    let n = 1;
    let y = await card(n);
    while (y.player === x.player) y = await card(++n);
    let z = await card(++n);
    while (z.player === y.player) z = await card(++n);
    expect(new Set([x.short, y.short, z.short]).size, "three different cards").toBe(3);

    await quantityField(unsortedList, x.short, "Unsorted").fill("3");
    await page.keyboard.press(advance);
    await quantityField(unsortedList, y.short, "Unsorted").fill("1");
    await page.keyboard.press(advance);
    await expect(said(`Boxed 1 more of ${y.short}. 1 in Unsorted.`)).toBeVisible();
    await adding.selectOption({ label: boxName });
    await expect(adding.getByRole("option", { selected: true })).toHaveText(boxName);
    const zField = quantityField(checklist.getByRole("list", { name: `Quantities in ${boxName}` }), z.short, boxName);
    await zField.fill("2");
    await page.keyboard.press(advance);
    await expect(said(`Boxed 2 more of ${z.short}. 2 in ${boxName}.`)).toBeVisible();

    // --- The list: one item per card, how many, which box ----------------------------------------
    await tabs.getByRole("link", { name: "Inventory", exact: true }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Everything for sale" })).toBeVisible();
    await expect(page.getByText(new RegExp(`^${cardsWord(forSaleBase + 6)} for sale in \\d+ box(?:es)?\\.$`))).toBeVisible();
    // The list is named for what it shows ("Every box, 6 cards, 3 different", "Unsorted, 4 cards, 2 different").
    const list = page.getByRole("list", { name: /, \d+ cards?(, \d+ different)?$/ });
    // An item leads with its count ("×3 <card>, ...") and ends with where it sits.
    const itemOf = (c: { number: string; player: string }, quantity: number, box: string) =>
      list.getByRole("button", {
        name: new RegExp(`^×${quantity} .*#${escapeRegExp(c.number)} ${escapeRegExp(c.player)}.*\\bin ${escapeRegExp(box)}\\b`),
      });
    const itemX = itemOf(x, 3, "Unsorted");
    const itemY = itemOf(y, 1, "Unsorted");
    const itemZ = itemOf(z, 2, boxName);
    // X after the graded copy joins it (the slab step below): x4, one a slab.
    let mixedX = itemX;
    await expect(itemX).toBeVisible();
    await expect(itemY).toBeVisible();
    await expect(itemZ).toBeVisible();
    await expectAccessible(page, { label: "Inventory list, three cards in two boxes" });

    // --- The rail narrows to one box; each pick is a Back step --------------------------------------
    const rail = page.getByRole("navigation", { name: "Boxes" });
    const railStop = (name: string | RegExp) => rail.getByRole("button", { name });
    await expect(railStop(/^All boxes/)).toHaveAttribute("aria-current", "true");
    await railStop(/^Unsorted/).click();
    await expect(railStop(/^Unsorted/)).toHaveAttribute("aria-current", "true");
    await expect(itemX).toBeVisible();
    await expect(itemY).toBeVisible();
    await expect(itemZ).toHaveCount(0);
    await railStop(new RegExp(`^${escapeRegExp(boxName)}`)).click();
    await expect(railStop(new RegExp(`^${escapeRegExp(boxName)}`))).toHaveAttribute("aria-current", "true");
    await expect(itemZ).toBeVisible();
    await expect(itemX).toHaveCount(0);
    await expect(list.getByRole("button")).toHaveCount(1);
    await expectAccessible(page, { label: "Inventory list, narrowed to one box" });
    await page.goBack();
    await expect(railStop(/^Unsorted/)).toHaveAttribute("aria-current", "true");
    await expect(itemZ).toHaveCount(0);
    await page.goBack();
    await expect(railStop(/^All boxes/)).toHaveAttribute("aria-current", "true");
    await expect(itemZ).toBeVisible();
    await expect(itemX).toBeVisible();

    // On a phone the filters fold behind a "Filters" button (closed to start, "Sort by" out of
    // reach); on a desktop there is no such button and "Sort by" is simply there.
    const sortBy = page.getByRole("combobox", { name: "Sort by" });
    if (isMobile) {
      await expect(page.getByRole("button", { name: /^Filters/ })).toHaveAttribute("aria-expanded", "false");
      await expect(sortBy).toBeHidden();
      await expectAccessible(page, { label: "Inventory list, filters folded on a phone" });
    } else {
      await expect(page.getByRole("button", { name: /^Filters/ })).toHaveCount(0);
      await expect(sortBy).toBeVisible();
    }
    // Open the Filters once for sort, search and chips.
    await openListFilters(page, isMobile);
    await expect(sortBy).toBeVisible();

    // --- Sort: the order flips -------------------------------------------------------------------------
    // Set and number: the checklist's own order, so Z (the third row) never leads while X
    // (the first) stands in the same list.
    const zName = new RegExp(`#${escapeRegExp(z.number)} ${escapeRegExp(z.player)}`);
    await expect(list.getByRole("button").first()).not.toHaveAccessibleName(zName);
    // Newest first: Z was stocked last of everything, so it leads.
    await sortBy.selectOption({ label: "Newest first" });
    await expect(list.getByRole("button").first()).toHaveAccessibleName(zName);
    await sortBy.selectOption({ label: "Set and number" });
    await expect(list.getByRole("button").first()).not.toHaveAccessibleName(zName);

    // --- Search: the filter box finds one card ------------------------------------------------------------
    const filter = page.getByRole("textbox", { name: "Filter these cards" });
    await filter.fill(y.player);
    await expect(itemY).toBeVisible();
    await expect(itemX).toHaveCount(0);
    await expect(itemZ).toHaveCount(0);
    await filter.clear();
    await expect(itemX).toBeVisible();
    await expect(itemZ).toBeVisible();

    // --- Chips: Dupes only keeps the stacks; Up for trade keeps flagged cards ----------------------------
    const only = page.getByRole("group", { name: "Only show", exact: true });
    const dupes = only.getByRole("button", { name: "Dupes only", exact: true });
    await dupes.click();
    await expect(dupes).toHaveAttribute("aria-pressed", "true");
    await expect(itemX).toBeVisible();
    await expect(itemZ).toBeVisible();
    await expect(itemY).toHaveCount(0);
    await dupes.click();
    await expect(dupes).toHaveAttribute("aria-pressed", "false");
    await expect(itemY).toBeVisible();

    // Flag Y up for trade from its Details; the line stays in Unsorted.
    await itemY.click();
    const drawer = page.getByRole("dialog", {
      name: new RegExp(`^2024 Topps Chrome #${escapeRegExp(y.number)} ${escapeRegExp(y.player)}`),
    });
    const yourCopies = drawer.getByRole("region", { name: `Your copies of ${y.short}`, exact: true });
    await expect(yourCopies.getByRole("heading", { name: "Your copies (1 line)", exact: true })).toBeVisible();
    await yourCopies.getByRole("button", { name: `Edit ${y.short}, Raw, Excellent`, exact: true }).click();
    const editForm = drawer.getByRole("form", { name: "Edit Raw, Excellent", exact: true });
    const flag = editForm.getByRole("switch", { name: "Up for trade" });
    await expect(flag).not.toBeChecked();
    await flag.click();
    await expect(flag).toBeChecked();
    await editForm.getByRole("button", { name: "Save copy" }).click();
    await expect(editForm).toBeHidden();
    await expect(yourCopies.getByText("Up for trade", { exact: true })).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();
    await expect(page.getByRole("heading", { level: 2, name: "Everything for sale" })).toBeVisible();

    const flaggedY = list.getByRole("button", {
      name: new RegExp(`^×1 .*#${escapeRegExp(y.number)} ${escapeRegExp(y.player)}.*\\bin Unsorted.*up for trade`),
    });
    await expect(flaggedY).toBeVisible();
    const trade = only.getByRole("button", { name: "Up for trade", exact: true });
    await trade.click();
    await expect(trade).toHaveAttribute("aria-pressed", "true");
    await expect(flaggedY).toBeVisible();
    await expect(itemX).toHaveCount(0);
    await expect(itemZ).toHaveCount(0);
    await trade.click();
    await expect(trade).toHaveAttribute("aria-pressed", "false");
    await expect(itemX).toBeVisible();
    // The Up for Trade stop on the rail (drawn as a box) lists the same card.
    await railStop(/^Up for Trade/).click();
    await expect(railStop(/^Up for Trade/)).toHaveAttribute("aria-current", "true");
    // The trade stop lists the whole pile (binders too), so its rows need no ", up for trade" tag.
    await expect(itemY).toBeVisible();
    await expect(page.getByText("Everything you'd swap, from your binders and your boxes.")).toBeVisible();
    await expect(itemX).toHaveCount(0);
    await expectAccessible(page, { label: "Inventory list, the Up for Trade stop" });
    await railStop(/^All boxes/).click();

    // Up for Trade opens as a box on My Boxes: one well, no rows, the flagged card in it.
    await tabs.getByRole("link", { name: "My Boxes", exact: true }).click();
    await page
      .getByRole("list", { name: "Special places" })
      .getByRole("button", { name: /^Up for Trade, box, / })
      .click();
    await expect(page).toHaveURL(/[?&]b=[^&]+/);
    await expect(page.getByRole("heading", { level: 2, name: "Up for Trade", exact: true })).toBeVisible();
    const tradeWell = page.getByRole("group", { name: /^Up for Trade, \d+ cards?$/ });
    await expect(
      tradeWell.getByRole("button", {
        name: new RegExp(`#${escapeRegExp(y.number)} ${escapeRegExp(y.player)}.*up for trade`, "i"),
      }),
    ).toBeVisible();
    // A pile is not a home: nothing is filed in rows.
    await expect(page.getByRole("group", { name: /^Row \d, / })).toHaveCount(0);
    await expectAccessible(page, { label: "My Boxes, Up for Trade opened as a box" });
    await backToBoxes(page);

    // --- Slabs only: one graded copy beside the raw ones of the same card ------------------------------------
    await tabs.getByRole("link", { name: "Inventory", exact: true }).click();
    await expect(itemX).toBeVisible();
    await itemX.click();
    const drawerX = page.getByRole("dialog", {
      name: new RegExp(`^2024 Topps Chrome #${escapeRegExp(x.number)} ${escapeRegExp(x.player)}`),
    });
    // The card has copies, so its add form waits behind Add.
    await drawerX.getByRole("button", { name: `Add another copy of ${x.short}`, exact: true }).click();
    const addForm = drawerX.getByRole("form", { name: "Add another copy", exact: true });
    await addForm.getByRole("radio", { name: "Graded" }).check();
    await addForm.getByRole("combobox", { name: "Grader" }).selectOption({ label: "PSA" });
    await addForm.getByRole("textbox", { name: "Grade", exact: true }).fill("9");
    await addForm.getByRole("spinbutton", { name: "Quantity" }).fill("1");
    await addForm.getByRole("button", { name: "Add to inventory" }).click();
    await expect(
      drawerX.getByRole("status").filter({ hasText: new RegExp(`Added ${escapeRegExp(x.short)}, PSA 9`) }),
    ).toBeVisible();
    await drawerX.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawerX).toBeHidden();
    // The card now reads x4, one of them a slab, in the same box.
    const xRe = `#${escapeRegExp(x.number)} ${escapeRegExp(x.player)}`;
    mixedX = list.getByRole("button", { name: new RegExp(`^×4 .*${xRe}.*\\bin Unsorted, 1 slab$`) });
    await expect(mixedX).toBeVisible();
    await openListFilters(page, isMobile);
    const slabs = only.getByRole("button", { name: "Slabs only", exact: true });
    await slabs.click();
    await expect(slabs).toHaveAttribute("aria-pressed", "true");
    // Slabs only counts the graded copies alone: x1, tagged Slab, and nothing raw stays.
    const slabX = list.getByRole("button", { name: new RegExp(`^×1 .*${xRe}.*\\bin Unsorted, slab$`) });
    await expect(slabX).toBeVisible();
    await expect(slabX.getByText("Slab", { exact: true })).toBeVisible();
    await expect(mixedX).toHaveCount(0);
    await expect(itemY).toHaveCount(0);
    await expect(itemZ).toHaveCount(0);
    // The tally follows (this account's only graded copy is the one just made).
    await expect(page.getByRole("list", { name: "Every box, 1 card", exact: true })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /^1 card$/ })).toBeVisible();
    await expectAccessible(page, { label: "Inventory list, Slabs only with a mixed card" });
    await slabs.click();
    await expect(slabs).toHaveAttribute("aria-pressed", "false");
    await expect(mixedX).toBeVisible();

    // --- The hard line: seven cards stand in the boxes; the collection still counts what it did ------------
    await goViaShell(page, isMobile, "Collection");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
    await expect(every).toBeVisible();
    expect(await nameOf(every), "the collection's 'Every card I own' count never moves for a box card").toBe(ownedBefore);

    // --- Cleanup: remove the four lines through the drawer, delete the box (R7) -------------------------
    await goViaShell(page, isMobile, "Inventory");
    await expect(page.getByRole("heading", { level: 2, name: "Everything for sale" })).toBeVisible();
    const removeLines = async (c: { number: string; player: string; short: string }, lines: string[], item: Locator) => {
      await item.click();
      const d = page.getByRole("dialog", {
        name: new RegExp(`^2024 Topps Chrome #${escapeRegExp(c.number)} ${escapeRegExp(c.player)}`),
      });
      const copies = d.getByRole("region", { name: `Your copies of ${c.short}`, exact: true });
      for (const line of lines) {
        const remove = copies.getByRole("button", { name: `Remove ${c.short}, ${line}`, exact: true });
        await remove.click();
        await expect(remove).toHaveCount(0);
      }
      await expect(copies.getByRole("heading", { name: /^Your copies/ })).toBeVisible();
      await d.getByRole("button", { name: "Close card detail" }).click();
      await expect(d).toBeHidden();
    };
    await removeLines(x, ["Raw, Excellent ×3", "PSA 9"], mixedX);
    await removeLines(y, ["Raw, Excellent"], flaggedY);
    await removeLines(z, ["Raw, Excellent ×2"], itemZ);
    await expect(mixedX).toHaveCount(0);
    await expect(itemX).toHaveCount(0);
    await expect(itemZ).toHaveCount(0);

    // The minted box is empty again: its rail stop says so.
    await railStop(new RegExp(`^${escapeRegExp(boxName)}`)).click();
    await expect(
      page.getByText("Empty box. Fill it from Checklists, or Sell a card into it from its Details."),
    ).toBeVisible();
    await expect(railStop(new RegExp(`^${escapeRegExp(boxName)}`))).toHaveAttribute("aria-current", "true");
    await railStop(/^All boxes/).click();
    // Only when nothing else stood in the boxes at the start can the whole list be empty:
    // then it says so and points at Checklists. (Never asserted when other stock exists.)
    if (forSaleBase === 0) {
      await expect(page.getByText("No cards in your boxes yet.")).toBeVisible();
      const stockUp = page.getByRole("button", { name: "Stock up in Checklists" });
      await expect(stockUp).toBeVisible();
      await expectAccessible(page, { label: "Inventory list, empty" });
      await stockUp.click();
      await expect(page).toHaveURL(/[?&]tab=checklists/);
      await expect(page.getByRole("combobox", { name: "Adding to" })).toBeVisible();
      await page.goBack();
      await expect(page.getByRole("heading", { level: 2, name: "Everything for sale" })).toBeVisible();
    } else {
      await expect(page.getByRole("heading", { level: 2, name: "Everything for sale" })).toBeVisible();
    }

    await tabs.getByRole("link", { name: "My Boxes", exact: true }).click();
    await page.getByRole("list", { name: "Your boxes" }).getByRole("button", { name: `${boxName}, box, 0 cards for sale`, exact: true }).click();
    await expect(page.getByRole("heading", { level: 2, name: boxName, exact: true })).toBeVisible();
    await deleteOpenBox(page, boxName);
    await expect(page.getByRole("status").filter({ hasText: `${boxName} is off the shelf.` })).toBeVisible();
    await expect(myBoxesStock(page, forSaleBase)).toBeVisible();
  },
);
