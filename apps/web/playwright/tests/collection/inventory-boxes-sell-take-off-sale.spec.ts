// NEO-364 (R1): a card crosses between the collection and the inventory only
// through the card drawer. The collector files three copies in Main, makes a box
// on the new My Boxes screen, SELLS two of them into it from the drawer (they
// leave the collection's counts and join the box's: the hard line), files the
// box's card into Row 2, TAKES one off sale into Main (it folds into the copy
// already there), then deletes the box (its copy drops into Unsorted, still for
// sale) and removes what is left.
//
// Collection = Binders, Inventory = Boxes (Jason: "Inventory is things for sale
// and My Collection is things that are for your collection. They should not mix
// on the screens"). So the spec reads the collection's headline, Main and
// long-box counts and the inventory's Unsorted, Up for Trade and headline stock
// counts FIRST and asserts every later number as a delta from them: a sale moves
// a copy from one side's count to the other's, nothing else moves. Unsorted is
// the inventory's own Main: it stands first in My Boxes' Special places (never
// among the collector's own boxes, never on the collection's shelf), and a
// deleted box's copies land there. My Boxes has no long box: the Inventory tab
// is the whole stock in one list, and the headline counts it.
//
// R7/R7a: writes only the signed-in user's own rows (`collectionContainers`,
// `collectionCopies`; the bootstrap reset clears the account) on one card of the
// seed's 2024 Topps Chrome Base, registered in SET-REGISTRY.md. It never writes
// the set, its cards, players or teams. Self-cleaning: the box is deleted and the
// copies removed through the UI; the closing counts equal the opening ones.
//
// R3: the collector's cascade and the box helpers come from `support/collection.ts`.
// Minted names are single tokens from `env.ATTEMPT_TOKEN` (never rebuilt by hand).
import type { Locator } from "@playwright/test";
import {
  backToBoxes,
  cardsWord,
  countOf,
  createBox,
  deleteOpenBox,
  drillToCollectorBase,
  forSaleOnMyBoxes,
  goViaShell,
  inventoryTabs,
  myBoxesStock,
  numberOf,
  ordinaryBaseRows,
  shortNameOf,
} from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test(
  "Inventory: sell two copies into a new box from the drawer, row one, take one off sale, delete the box into Unsorted",
  { tag: ["@smoke", "@collection"] },
  async ({ page, signIn, env, isMobile }) => {
    const boxName = `Sale${env.ATTEMPT_TOKEN}`;

    // --- The collection's numbers, read first ---------------------------------
    await signIn("/collection");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({ timeout: LAUNCH_GATE });
    const collectionTabs = page.getByRole("navigation", { name: "Collection sections" });
    // The collection has no Inventory tab: the long box on the shelf is the way across.
    await expect(collectionTabs.getByRole("link", { name: "Inventory" })).toHaveCount(0);
    await collectionTabs.getByRole("link", { name: "My Binders", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=binders/);

    const shelf = page.getByRole("list", { name: "Your binders" });
    const special = page.getByRole("list", { name: "Special places" });
    const mainRe = /^Main, ([\d,]+) cards?$/;
    const doorRe = /^Inventory, ([\d,]+) cards? for sale$/;
    const door = special.getByRole("link", { name: doorRe });
    const mainBase = await countOf(shelf.getByRole("button", { name: mainRe }), mainRe);
    const forSaleBase = await countOf(door, doorRe);
    const headlineRe = /^([\d,]+)\+? cards?, (\d+) binders?\.$/;
    const headlineText = page.getByText(headlineRe);
    await expect(headlineText).toBeVisible();
    const parsed = headlineRe.exec((await headlineText.textContent()) ?? "");
    expect(parsed, "the shelf headline reads 'N cards, N binders.'").not.toBeNull();
    const cardsBase = numberOf(parsed![1]);
    const bindersBase = Number(parsed![2]);
    const headline = (delta: number) =>
      page.getByText(`${cardsWord(cardsBase + delta)}, ${bindersBase} ${bindersBase === 1 ? "binder" : "binders"}.`, {
        exact: true,
      });
    const mainSpine = (delta: number) =>
      shelf.getByRole("button", { name: `Main, ${cardsWord(mainBase + delta)}`, exact: true });
    const doorWith = (delta: number) =>
      special.getByRole("link", { name: `Inventory, ${cardsWord(forSaleBase + delta)} for sale`, exact: true });
    await expect(headline(0)).toBeVisible();
    // Unsorted is the inventory's: it never stands on the collection's shelf.
    await expect(shelf.getByRole("button", { name: /^Unsorted/ })).toHaveCount(0);
    await expect(shelf.getByRole("button", { name: /, box, / })).toHaveCount(0);

    // --- Across the long box: the Inventory list, and Back ---------------------
    await door.click();
    await expect(page).toHaveURL(/\/inventory\?tab=cards/);
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible();
    const tabs = inventoryTabs(page);
    await expect(tabs.getByRole("link", { name: "Inventory", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(tabs.getByRole("link", { name: "My Boxes", exact: true })).toBeVisible();
    await expect(tabs.getByRole("link", { name: "Checklists", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Everything for sale" })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/[?&]tab=binders/);
    await expect(shelf).toBeVisible();
    await expect(headline(0)).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(/\/inventory\?tab=cards/);

    // --- My Boxes: the collector's own boxes; Unsorted first in Special places, then Up for Trade as a box
    await tabs.getByRole("link", { name: "My Boxes", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=boxes/);
    const boxes = page.getByRole("list", { name: "Your boxes" });
    const places = page.getByRole("list", { name: "Special places" });
    const unsortedRe = /^Unsorted, box, ([\d,]+) cards? for sale$/;
    const unsortedSpine = places.getByRole("button", { name: unsortedRe });
    await expect(places.getByRole("button").first()).toHaveAccessibleName(unsortedRe);
    await expect(boxes.getByRole("button", { name: /^Unsorted,/ })).toHaveCount(0);
    // No long box on the inventory side: the Inventory tab is the list.
    await expect(places.getByRole("link")).toHaveCount(0);
    const unsortedBase = await countOf(unsortedSpine, unsortedRe);
    const tradeRe = /^Up for Trade, box, ([\d,]+) cards? up for trade$/;
    const tradeBase = await countOf(places.getByRole("button", { name: tradeRe }), tradeRe);
    expect(await forSaleOnMyBoxes(page), "My Boxes' headline counts the same stock as the collection's door").toBe(forSaleBase);
    await expectAccessible(page, { label: "My Boxes, Unsorted and the special places" });

    // --- A box of my own -------------------------------------------------------
    await createBox(page, boxName, async (dialog) => {
      await expectAccessible(page, { within: dialog, label: "New box dialog" });
    });
    await expect(page.getByRole("region", { name: `${boxName}, open`, exact: true })).toBeVisible();
    await expect(page.getByRole("group", { name: "Row 2, 0 cards", exact: true })).toBeVisible();
    // Sharing is the collection's: no Share button on an inventory-side view.
    await expect(page.getByRole("button", { name: /^Share / })).toHaveCount(0);
    await expectAccessible(page, { label: "My Boxes, an empty box" });
    await backToBoxes(page);
    const boxSpine = (cards: number) =>
      boxes.getByRole("button", { name: `${boxName}, box, ${cardsWord(cards)} for sale`, exact: true });
    await expect(boxSpine(0)).toBeVisible();

    // --- File three copies in Main from the collection's drawer ----------------
    await goViaShell(page, isMobile, "Collection");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
    await collectionTabs.getByRole("link", { name: "Checklists", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    const checklist = await drillToCollectorBase(page);
    const one = await shortNameOf(ordinaryBaseRows(checklist).first());
    const drawer = page.getByRole("dialog", {
      name: new RegExp(`^2024 Topps Chrome #${escapeRegExp(one.number)} ${escapeRegExp(one.player)}`),
    });
    await checklist.getByRole("button", { name: `Details for ${one.short}`, exact: true }).click();
    const yourCopies = drawer.getByRole("region", { name: `Your copies of ${one.short}`, exact: true });
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    const addForm = drawer.getByRole("form", { name: "Add a copy", exact: true });
    await addForm.getByRole("spinbutton", { name: "Quantity" }).fill("3");
    await addForm.getByRole("button", { name: "Add to collection" }).click();
    await expect(drawer.getByRole("status").filter({ hasText: `Added ${one.short}, Raw ×3` })).toBeVisible();

    /** One "Your copies" line, found by what it says ("Raw ×3"). */
    const line = (what: string) =>
      yourCopies.getByRole("listitem").filter({ has: page.getByText(what, { exact: true }) });
    const lines = (n: number) =>
      yourCopies.getByRole("heading", { name: `Your copies (${n} ${n === 1 ? "line" : "lines"})`, exact: true });
    await expect(lines(1)).toBeVisible();
    await expect(line("Raw ×3").getByText("Main")).toBeVisible();
    // The drawer's headline splits what is kept from what is for sale.
    await expect(drawer.getByText(/^3 in binders\.?$/)).toBeVisible();

    // --- Sell two of them into the box ----------------------------------------
    await yourCopies.getByRole("button", { name: `Sell ${one.short}, Raw ×3`, exact: true }).click();
    const sellForm = yourCopies.getByRole("form", { name: "Sell Raw ×3", exact: true });
    const into = sellForm.getByRole("combobox", { name: "Into which box" });
    await expect(into).toBeVisible();
    // Unsorted is always there to sell into; so is the box just made. Binders are not boxes.
    await expect(into.getByRole("option", { name: "Unsorted", exact: true })).toBeAttached();
    await expect(into.getByRole("option", { name: boxName, exact: true })).toBeAttached();
    await expect(into.getByRole("option", { name: "Main", exact: true })).toHaveCount(0);
    await into.selectOption({ label: boxName });
    await sellForm.getByRole("spinbutton", { name: "Quantity to sell" }).fill("2");
    await expectAccessible(page, { within: sellForm, label: "Card drawer, the Sell panel with a box picked" });
    await sellForm.getByRole("button", { name: "Put 2 up for sale", exact: true }).click();
    await expect(sellForm).toBeHidden();
    await expect(
      drawer.getByRole("status").filter({ hasText: `2 of ${one.short} are up for sale in ${boxName}` }),
    ).toBeVisible();
    await expect(lines(2)).toBeVisible();
    await expect(drawer.getByText(/^1 in binders · 2 for sale\.?$/)).toBeVisible();
    await expect(line("Raw").getByText("Main")).toBeVisible();
    await expect(line("Raw ×2").getByText(new RegExp(`For sale · ${escapeRegExp(boxName)}`))).toBeVisible();
    await expectAccessible(page, { within: drawer, label: "Card drawer, a stack split between Main and a box" });
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(/[?&]tab=checklists/);

    // --- The collection counts one copy more; the door counts two ---------------
    await collectionTabs.getByRole("link", { name: "My Binders", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=binders/);
    await expect(headline(1)).toBeVisible();
    await expect(mainSpine(1)).toBeVisible();
    await expect(doorWith(2)).toBeVisible();

    // --- The box counts two, Unsorted and Up for Trade did not move -------------
    await doorWith(2).click();
    await expect(page).toHaveURL(/\/inventory\?tab=cards/);
    await tabs.getByRole("link", { name: "My Boxes", exact: true }).click();
    await expect(boxSpine(2)).toBeVisible();
    await expect(places.getByRole("button", { name: `Unsorted, box, ${cardsWord(unsortedBase)} for sale`, exact: true })).toBeVisible();
    await expect(places.getByRole("button", { name: `Up for Trade, box, ${cardsWord(tradeBase)} up for trade`, exact: true })).toBeVisible();
    await expect(myBoxesStock(page, forSaleBase + 2)).toBeVisible();

    // --- Open the box: the card stands in it; file it into Row 2 ----------------
    await boxSpine(2).click();
    await expect(page.getByRole("heading", { level: 2, name: boxName, exact: true })).toBeVisible();
    const open = page.getByRole("region", { name: `${boxName}, open`, exact: true });
    // (The strip of cards not sorted into a row yet sits under the rows, outside the box's region.)
    const cardInBox = page.getByRole("button", {
      name: new RegExp(`#${escapeRegExp(one.number)} ${escapeRegExp(one.player)}.*, 2 copies, for sale`),
    });
    await expect(cardInBox).toBeVisible();
    // A card lands in the box's front: Row 1, or "Not in a row"; the picker files it into Row 2.
    const rowPick = page.getByRole("combobox", {
      name: new RegExp(`^Row for .*#${escapeRegExp(one.number)} ${escapeRegExp(one.player)}`),
    });
    await rowPick.selectOption({ label: "Row 2" });
    await expect(open.getByRole("group", { name: "Row 2, 2 cards", exact: true }).getByRole("button", { name: /, 2 copies, for sale/ })).toBeVisible();
    await expect(open.getByRole("group", { name: "Row 1, 0 cards", exact: true })).toBeVisible();
    await expectAccessible(page, { label: "My Boxes, an open box with a card in Row 2" });

    // --- Take one off sale into Main: it folds into the copy already there ------
    await cardInBox.click();
    await expect(drawer).toBeVisible();
    await expect(lines(2)).toBeVisible();
    await yourCopies.getByRole("button", { name: `Take off sale, ${one.short}, Raw ×2`, exact: true }).click();
    const offForm = yourCopies.getByRole("form", { name: /off sale/i });
    const back = offForm.getByRole("combobox", { name: "Back into" });
    await expect(back.getByRole("option", { name: "Main", exact: true })).toBeAttached();
    await expect(back.getByRole("option", { name: boxName, exact: true })).toHaveCount(0);
    await back.selectOption({ label: "Main" });
    await offForm.getByRole("spinbutton", { name: "Quantity to take back" }).fill("1");
    await expectAccessible(page, { within: offForm, label: "Card drawer, the Take off sale panel with Main picked" });
    await offForm.getByRole("button", { name: "Take 1 off sale", exact: true }).click();
    await expect(offForm).toBeHidden();
    await expect(
      drawer.getByRole("status").filter({
        hasText: `Took 1 of ${one.short} off sale. It's back in Main, stacked with the ones already there.`,
      }),
    ).toBeVisible();
    await expect(lines(2)).toBeVisible();
    await expect(drawer.getByText(/^2 in binders · 1 for sale\.?$/)).toBeVisible();
    await expect(line("Raw ×2").getByText("Main")).toBeVisible();
    await expect(line("Raw").getByText(new RegExp(`For sale · ${escapeRegExp(boxName)}`))).toBeVisible();
    await expectAccessible(page, { within: drawer, label: "Card drawer, one copy back in Main and one still for sale" });
    // The drawer rode on the URL: closing it is a Back step onto the open box.
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();
    await expect(page.getByRole("heading", { level: 2, name: boxName, exact: true })).toBeVisible();
    await expect(open.getByRole("group", { name: "Row 2, 1 card", exact: true })).toBeVisible();

    // --- Two copies in Main now, one for sale -----------------------------------
    await goViaShell(page, isMobile, "Collection");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
    await collectionTabs.getByRole("link", { name: "My Binders", exact: true }).click();
    await expect(headline(2)).toBeVisible();
    await expect(mainSpine(2)).toBeVisible();
    await expect(doorWith(1)).toBeVisible();

    // --- Delete the box: its copy drops into Unsorted, still for sale -----------
    await doorWith(1).click();
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible();
    await tabs.getByRole("link", { name: "My Boxes", exact: true }).click();
    await boxSpine(1).click();
    await expect(page.getByRole("heading", { level: 2, name: boxName, exact: true })).toBeVisible();
    await deleteOpenBox(page, boxName, async (confirm) => {
      // The box is not empty: say where its card goes (Unsorted, not a binder).
      await expect(confirm.getByText(/Unsorted/)).toBeVisible();
      await expect(confirm.getByText(/back to Main/)).toHaveCount(0);
      await expectAccessible(page, { within: confirm, label: "Delete a box, confirm" });
    });
    await expect(page).not.toHaveURL(/[?&]b=/);
    await expect(
      page.getByRole("status").filter({ hasText: `${boxName} is off the shelf. Its card went into Unsorted, still for sale.` }),
    ).toBeVisible();
    await expect(boxes.getByRole("button", { name: new RegExp(`^${escapeRegExp(boxName)},`) })).toHaveCount(0);
    await expect(places.getByRole("button", { name: `Unsorted, box, ${cardsWord(unsortedBase + 1)} for sale`, exact: true })).toBeVisible();
    // The URL no longer names the deleted box, and one Back does not return to it.
    await expect(page).toHaveURL(/[?&]tab=boxes/);
    await page.goBack();
    await expect(page).not.toHaveURL(/[?&]b=/);
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(/[?&]tab=boxes/);
    await expect(boxes).toBeVisible();

    // --- Cleanup: remove what is left through the drawer (R7) -------------------
    await tabs.getByRole("link", { name: "Inventory", exact: true }).click();
    // The list is named for what it shows ("Every box, 6 cards, 3 different", "Unsorted, 4 cards, 2 different").
    const list = page.getByRole("list", { name: /, \d+ cards?(, \d+ different)?$/ });
    const item: Locator = list.getByRole("button", {
      name: new RegExp(`#${escapeRegExp(one.number)} ${escapeRegExp(one.player)}.*\\bin Unsorted`),
    });
    await expect(item).toBeVisible();
    await item.click();
    await expect(drawer).toBeVisible();
    await expect(lines(2)).toBeVisible();
    // On the inventory the drawer adds to the inventory, into a box: never a binder.
    await expect(drawer.getByRole("button", { name: "Add to inventory" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Add to collection" })).toHaveCount(0);
    const where = drawer.getByRole("combobox", { name: "Where it lives" });
    await expect(where.getByRole("option", { name: "Unsorted", exact: true })).toBeAttached();
    await expect(where.getByRole("option", { name: "Main", exact: true })).toHaveCount(0);
    await yourCopies.getByRole("button", { name: `Remove ${one.short}, Raw`, exact: true }).click();
    await expect(lines(1)).toBeVisible();
    await yourCopies.getByRole("button", { name: `Remove ${one.short}, Raw ×2`, exact: true }).click();
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();

    // Everything is back where it started, on both sides.
    await tabs.getByRole("link", { name: "My Boxes", exact: true }).click();
    await expect(places.getByRole("button", { name: `Unsorted, box, ${cardsWord(unsortedBase)} for sale`, exact: true })).toBeVisible();
    await goViaShell(page, isMobile, "Collection");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
    await collectionTabs.getByRole("link", { name: "My Binders", exact: true }).click();
    await expect(headline(0)).toBeVisible();
    await expect(mainSpine(0)).toBeVisible();
    await expect(doorWith(0)).toBeVisible();

    // --- An old bookmark still lands: the collection's former Inventory tab opens My Boxes ----
    await page.goto("/collection?tab=inventory");
    await expect(page).toHaveURL(/\/inventory\?tab=boxes/);
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible();
    await expect(tabs.getByRole("link", { name: "My Boxes", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(boxes).toBeVisible();
    // The redirect replaced the old entry: Back leaves for the page before it.
    await page.goBack();
    await expect(page).toHaveURL(/\/collection/);
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
  },
);
