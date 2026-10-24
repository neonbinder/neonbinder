// NEO-359 (R1): a signed-in collector's My Binders shelf holds real binders and
// boxes. The shelf starts with the three system spines (Main, Up for Trade, Want
// List); the collector makes a binder and a box, opens each, files a stack of
// three copies in the binder, moves two of them into the box (the box is the
// sale table, so those two read "For sale" and the shelf headline and the
// Inventory view count them), flags a copy Up for trade and takes it off again,
// moves the box line back (the pair re-folds into one stack of three), takes
// that back with Undo (the stack splits again) and moves it again. The box is
// renamed and relabelled, a second card is slotted into a pocket from the
// hunt tray, a Want on a third card lands on the Want List spine and in the Want
// List and comes off again. The spec ends by deleting the binder (its cards go
// back to Main) and the box, so the shelf is back to where it started.
//
// The signed-in page is the REAL collection (Convex, per user). Moves are driven
// with the drawer's Move form and the tray's buttons, never by dragging.
//
// Counts are deltas from a first read of the shelf (the headline and the three
// system spines), not absolute account totals.
//
// R7/R7a: writes only the signed-in user's own rows (`collectionContainers`,
// `collectionCopies`, `collectionWants`; the bootstrap reset clears the account)
// on three cards of the seed's 2024 Topps Chrome Base, registered in
// SET-REGISTRY.md. It never writes the set, its cards, players or teams.
// Self-cleaning: the copies are removed and both containers are deleted through
// the UI.
//
// R3: the collector's cascade is drilled through `support/collection.ts`
// (shared with add-edit-remove-copy); `drillToSet` drives the admin Set Builder.
// Minted names are single tokens from `env.ATTEMPT_TOKEN` (never rebuilt by
// hand), so a binder and a box of this run are this run's alone.
import type { Locator } from "@playwright/test";
import { drillToCollectorBase, ordinaryBaseRows, shortNameOf } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const cardsWord = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "card" : "cards"}`;

interface Stats {
  cards: number;
  binders: number;
  boxes: number;
  sale: number;
}

test(
  "Collection: make a binder and a box, move copies between them (for sale, trade, re-fold, Undo), fill a pocket, want a card, delete both",
  { tag: ["@smoke", "@collection"] },
  async ({ page, signIn, env, isMobile }) => {
    const binder = `Binder${env.ATTEMPT_TOKEN}`;
    let box = `Box${env.ATTEMPT_TOKEN}`;
    const renamed = `Crate${env.ATTEMPT_TOKEN}`;

    // --- The shelf: three system spines --------------------------------------
    await signIn("/collection");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({
      timeout: LAUNCH_GATE,
    });
    const tabs = page.getByRole("navigation", { name: "Collection sections" });
    await tabs.getByRole("link", { name: "My Binders", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=binders/);

    const shelf = page.getByRole("list", { name: "Your binders" });
    const special = page.getByRole("list", { name: "Special places" });
    const mainRe = /^Main, ([\d,]+) cards?$/;
    const tradeRe = /^Up for Trade, ([\d,]+) cards? up for trade$/;
    const wantRe = /^Want List, ([\d,]+) cards? wanted$/;
    const mainSpine = (cards: number) => shelf.getByRole("button", { name: `Main, ${cardsWord(cards)}`, exact: true });
    const tradeSpine = (cards: number) =>
      special.getByRole("button", { name: `Up for Trade, ${cardsWord(cards)} up for trade`, exact: true });
    const wantSpine = (cards: number) =>
      special.getByRole("button", { name: `Want List, ${cardsWord(cards)} wanted`, exact: true });
    const inventorySpine = (sale: number) =>
      special.getByRole("button", { name: `Inventory, ${cardsWord(sale)} for sale`, exact: true });
    const boxSpine = (sale: number) => shelf.getByRole("button", { name: `${box}, box, ${cardsWord(sale)} for sale`, exact: true });
    const binderSpine = (cards: number) => shelf.getByRole("button", { name: `${binder}, ${cardsWord(cards)}`, exact: true });

    // The first read: every later count is this plus what the spec did.
    const headlineRe = /^([\d,]+)\+? cards?, (\d+) binders?(?:, (\d+) boxes?)?, ([\d,]+) for sale\.$/;
    const number = (s: string | undefined) => Number((s ?? "0").replace(/,/g, ""));
    const nameOf = async (spine: Locator) => /button "([^"]+)"/.exec(await spine.ariaSnapshot())?.[1] ?? "";
    const countOf = async (spine: Locator, re: RegExp) => {
      await expect(spine).toBeVisible();
      const name = await nameOf(spine);
      const m = re.exec(name);
      expect(m, `a spine named like ${re} (read: ${name})`).not.toBeNull();
      return number(m![1]);
    };
    const mainBase = await countOf(shelf.getByRole("button", { name: mainRe }), mainRe);
    const tradeBase = await countOf(special.getByRole("button", { name: tradeRe }), tradeRe);
    const wantBase = await countOf(special.getByRole("button", { name: wantRe }), wantRe);
    const headlineText = page.getByText(headlineRe);
    await expect(headlineText).toBeVisible();
    const parsed = headlineRe.exec((await headlineText.textContent()) ?? "");
    expect(parsed, "the shelf headline reads 'N cards, N binders, N for sale.'").not.toBeNull();
    const base: Stats = {
      cards: number(parsed![1]),
      binders: number(parsed![2]),
      boxes: number(parsed![3]),
      sale: number(parsed![4]),
    };
    const headline = (d: Partial<Stats>) => {
      const s: Stats = {
        cards: base.cards + (d.cards ?? 0),
        binders: base.binders + (d.binders ?? 0),
        boxes: base.boxes + (d.boxes ?? 0),
        sale: base.sale + (d.sale ?? 0),
      };
      const binders = `${s.binders} ${s.binders === 1 ? "binder" : "binders"}`;
      const boxes = s.boxes > 0 ? `, ${s.boxes} ${s.boxes === 1 ? "box" : "boxes"}` : "";
      return page.getByText(`${cardsWord(s.cards)}, ${binders}${boxes}, ${s.sale.toLocaleString("en-US")} for sale.`, {
        exact: true,
      });
    };
    await expect(headline({})).toBeVisible();
    await expectAccessible(page, { label: "My Binders, the system spines" });

    // --- A binder, then a box ------------------------------------------------
    const newButton = shelf.getByRole("button", { name: "New binder or box", exact: true });
    const heading = (name: string) => page.getByRole("heading", { level: 2, name, exact: true });
    const backToShelf = async () => {
      await page.getByRole("button", { name: "Back to the shelf" }).click();
      await expect(shelf).toBeVisible();
      await expect(page).not.toHaveURL(/[?&](b|sale)=/);
    };

    await newButton.click();
    const newDialog = page.getByRole("dialog", { name: "New binder or box" });
    await expect(newDialog.getByRole("textbox", { name: "Binder name" })).toBeVisible();
    // The real collection offers a binder and a box; a smart binder is not on offer.
    await expect(newDialog.getByRole("radio", { name: /^A binder/ })).toBeVisible();
    await expect(newDialog.getByRole("radio", { name: /^A box/ })).toBeVisible();
    await expect(newDialog.getByRole("radio")).toHaveCount(2);
    await expect(newDialog.getByRole("radio", { name: /^Smart/ })).toHaveCount(0);
    await expectAccessible(page, { within: newDialog, label: "New binder or box dialog" });
    await newDialog.getByRole("textbox", { name: "Binder name" }).fill(binder);
    await newDialog.getByRole("button", { name: "Put it on the shelf" }).click();
    await expect(newDialog).toBeHidden();
    await expect(page).toHaveURL(/[?&]b=[^&]+/);
    await expect(heading(binder)).toBeVisible();
    // Its pages are drawn (an empty pocket to fill), not the loading line.
    await expect(page.getByRole("button", { name: /^Empty .*\. Fill it from the pack$/ }).first()).toBeVisible();
    await expectAccessible(page, { label: "My Binders, an empty binder" });
    await backToShelf();
    await expect(binderSpine(0)).toBeVisible();

    await newButton.click();
    await newDialog.getByRole("radio", { name: /^A box/ }).check();
    await newDialog.getByRole("textbox", { name: "Box name" }).fill(box);
    await newDialog.getByRole("button", { name: "Put it on the shelf" }).click();
    await expect(newDialog).toBeHidden();
    await expect(page).toHaveURL(/[?&]b=[^&]+/);
    await expect(heading(box)).toBeVisible();
    await expect(page.getByRole("region", { name: `${box}, open`, exact: true })).toBeVisible();
    await expect(page.getByText(/^This box is empty\./)).toBeVisible();
    await expectAccessible(page, { label: "My Binders, an empty box" });
    await backToShelf();
    await expect(boxSpine(0)).toBeVisible();
    await expect(headline({ binders: 2, boxes: 1 })).toBeVisible();

    // Opening from the shelf is a Back step: Back returns to the shelf.
    await binderSpine(0).click();
    await expect(page).toHaveURL(/[?&]b=[^&]+/);
    await expect(heading(binder)).toBeVisible();
    await page.goBack();
    await expect(page).not.toHaveURL(/[?&]b=/);
    await expect(binderSpine(0)).toBeVisible();
    await expect(heading(binder)).toBeHidden();

    // --- Checklists: three ordinary Base cards ------------------------------
    const toChecklists = async () => {
      await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
      await expect(page).toHaveURL(/[?&]tab=checklists/);
    };
    const toBinders = async () => {
      await tabs.getByRole("link", { name: "My Binders", exact: true }).click();
      await expect(page).toHaveURL(/[?&]tab=binders/);
    };
    await toChecklists();
    const checklist = await drillToCollectorBase(page);
    /** The page's binder scope rides along between tabs; look through everything. */
    const lookThroughEverything = async () => {
      await checklist.getByRole("combobox", { name: "Binder" }).selectOption({ label: "All" });
    };
    await lookThroughEverything();

    // Read all three names before any write: a card with two lines drops out of
    // the "ordinary row" match (its Details button names the line).
    const rows = ordinaryBaseRows(checklist);
    await expect(rows.nth(2)).toBeVisible(); // "any three": the first three ordinary rows
    const one = await shortNameOf(rows.first());
    const two = await shortNameOf(rows.nth(1));
    const three = await shortNameOf(rows.nth(2));
    expect(new Set([one.short, two.short, three.short]).size, "three different cards").toBe(3);

    // --- File three copies in the binder -------------------------------------
    const drawer = page.getByRole("dialog", {
      name: new RegExp(`^2024 Topps Chrome #${escapeRegExp(one.number)} ${escapeRegExp(one.player)}`),
    });
    await checklist.getByRole("button", { name: `Details for ${one.short}`, exact: true }).click();
    const yourCopies = drawer.getByRole("region", { name: `Your copies of ${one.short}`, exact: true });
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    const addForm = drawer.getByRole("form", { name: "Add a copy", exact: true });
    await addForm.getByRole("combobox", { name: "Where it lives" }).selectOption({ label: binder });
    await addForm.getByRole("spinbutton", { name: "Quantity" }).fill("3");
    await addForm.getByRole("button", { name: "Add to collection" }).click();
    await expect(drawer.getByRole("status").filter({ hasText: `Added ${one.short}, Raw ×3` })).toBeVisible();

    /** One "Your copies" line, found by what it says ("Raw ×3"). */
    const line = (what: string) =>
      yourCopies.getByRole("listitem").filter({ has: page.getByText(what, { exact: true }) });
    const lines = (n: number) =>
      yourCopies.getByRole("heading", { name: `Your copies (${n} ${n === 1 ? "line" : "lines"})`, exact: true });
    const forSale = (what: string) => line(what).getByText("For sale", { exact: true });
    const upForTrade = (what: string) => line(what).getByText("Up for trade", { exact: true });
    /** Move a whole or part of a line to a home; `count` is what the Move button reads. */
    const moveLine = async (what: string, to: string, count: number, quantity?: number, axe?: string) => {
      await yourCopies.getByRole("button", { name: `Move ${one.short}, ${what}`, exact: true }).click();
      const form = yourCopies.getByRole("form", { name: `Move ${what}`, exact: true });
      await expect(form).toBeVisible();
      await form.getByRole("combobox", { name: "Move to" }).selectOption({ label: to });
      if (quantity !== undefined) await form.getByRole("spinbutton", { name: "Quantity to move" }).fill(String(quantity));
      const go = form.getByRole("button", { name: `Move ${count}`, exact: true });
      await expect(go).toBeVisible();
      if (axe) await expectAccessible(page, { within: form, label: axe });
      await go.click();
      await expect(form).toBeHidden();
    };
    /** Flag a line Up for trade, or take it off, through its Edit form. */
    const setTrade = async (what: string, on: boolean) => {
      await yourCopies.getByRole("button", { name: `Edit ${one.short}, ${what}`, exact: true }).click();
      const form = drawer.getByRole("form", { name: `Edit ${what}`, exact: true });
      const flag = form.getByRole("switch", { name: "Up for trade" });
      await expect(flag).toBeVisible();
      if (on) await expect(flag).not.toBeChecked();
      else await expect(flag).toBeChecked();
      await flag.click();
      if (on) await expect(flag).toBeChecked();
      else await expect(flag).not.toBeChecked();
      await form.getByRole("button", { name: "Save copy" }).click();
      await expect(form).toBeHidden();
    };

    await expect(lines(1)).toBeVisible();
    await expect(line("Raw ×3").getByText(binder)).toBeVisible();
    await expect(forSale("Raw ×3")).toHaveCount(0);

    // --- Move two into the box: a split, and the box line is for sale -------
    await moveLine("Raw ×3", `${box} (box, for sale)`, 2, 2, "Card drawer, the Move panel with a box picked");
    await expect(
      drawer.getByRole("status").filter({ hasText: `Moved 2 of ${one.short} to ${box}. They're for sale now.` }),
    ).toBeVisible();
    await expect(lines(2)).toBeVisible();
    await expect(line("Raw").getByText(binder)).toBeVisible();
    await expect(forSale("Raw")).toHaveCount(0);
    await expect(line("Raw ×2").getByText(box)).toBeVisible();
    await expect(forSale("Raw ×2")).toBeVisible();
    await expectAccessible(page, { within: drawer, label: "Card drawer, a stack split between a binder and a box" });

    // --- Up for trade: a flag on the copy in the binder ---------------------
    await setTrade("Raw", true);
    await expect(upForTrade("Raw")).toBeVisible();
    await expect(upForTrade("Raw ×2")).toHaveCount(0);
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();
    // The checklist row carries the sale tag too.
    await expect(checklist.getByText("For sale", { exact: true })).toBeVisible();

    // --- The shelf counts what is for sale and what is up for trade ---------
    await toBinders();
    await expect(headline({ cards: 3, binders: 2, boxes: 1, sale: 2 })).toBeVisible();
    await expect(binderSpine(1)).toBeVisible();
    await expect(boxSpine(2)).toBeVisible();
    await expect(inventorySpine(base.sale + 2)).toBeVisible();
    await expect(tradeSpine(tradeBase + 1)).toBeVisible();

    // --- Up for Trade: the card is listed, and still lives in its binder ----
    await tradeSpine(tradeBase + 1).click();
    await expect(heading("Up for Trade")).toBeVisible();
    const tradeCard = page.getByRole("button", {
      name: new RegExp(`#${escapeRegExp(one.number)} ${escapeRegExp(one.player)}.*, up for trade$`),
    });
    await expect(tradeCard).toBeVisible();
    await expectAccessible(page, { label: "Up for Trade, a card on the pile" });
    await tradeCard.click();
    await expect(lines(2)).toBeVisible();
    await expect(line("Raw").getByText(binder)).toBeVisible();
    await expect(upForTrade("Raw")).toBeVisible();
    await setTrade("Raw", false);
    await expect(upForTrade("Raw")).toHaveCount(0);
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();
    await expect(heading("Up for Trade")).toBeVisible();
    await expect(tradeCard).toHaveCount(0);
    await backToShelf();
    await expect(tradeSpine(tradeBase)).toBeVisible();
    await expect(binderSpine(1)).toBeVisible();

    // --- Inventory: every copy in every box (sale=1) ------------------------
    await inventorySpine(base.sale + 2).click();
    await expect(page).toHaveURL(/[?&]sale=1(&|$)/);
    await expect(heading("For sale")).toBeVisible();
    await expect(
      page.getByText(`${cardsWord(base.sale + 2)} for sale in ${base.boxes + 1} ${base.boxes + 1 === 1 ? "box" : "boxes"}`, {
        exact: true,
      }),
    ).toBeVisible();
    const saleBox = page.getByRole("region", { name: `${box}, for sale`, exact: true });
    await expect(
      saleBox.getByRole("button", {
        name: new RegExp(
          `#${escapeRegExp(one.number)} ${escapeRegExp(one.player)}.*, 2 copies, for sale, ${escapeRegExp(box)}, not in a row$`,
        ),
      }),
    ).toBeVisible();
    await expectAccessible(page, { label: "Inventory, every card for sale" });
    await saleBox.getByRole("button", { name: `Open the box, ${box}`, exact: true }).click();
    await expect(page).toHaveURL(/[?&]b=[^&]+/);
    await expect(heading(box)).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/[?&]sale=1(&|$)/);
    await expect(heading("For sale")).toBeVisible();
    await page.goBack();
    await expect(page).not.toHaveURL(/[?&]sale=/);
    await expect(boxSpine(2)).toBeVisible();

    // --- The box shows the card; five rows; rename and relabel it -----------
    await boxSpine(2).click();
    await expect(heading(box)).toBeVisible();
    const open = page.getByRole("region", { name: `${box}, open`, exact: true });
    // A card filed in the box but in no row yet sits on the table strip under it.
    const unsorted = page.getByRole("group", { name: "Not sorted into a row yet", exact: true });
    const boxCard = unsorted.getByRole("button", {
      name: new RegExp(`#${escapeRegExp(one.number)} ${escapeRegExp(one.player)}.*, 2 copies, for sale$`),
    });
    await expect(boxCard).toBeVisible();
    await expect(open.getByRole("group", { name: /^Row \d, \d+ cards?$/ })).toHaveCount(5);
    if (isMobile) {
      // On a phone every row is still reachable by scrolling the box.
      for (const r of [1, 2, 3, 4, 5]) {
        const row = open.getByRole("group", { name: new RegExp(`^Row ${r}, `) });
        await row.scrollIntoViewIfNeeded();
        await expect(row).toBeInViewport();
      }
    }
    await expectAccessible(page, { label: "My Binders, a box holding a card for sale" });

    const editButton = page.getByRole("button", { name: `Rename or delete ${box}`, exact: true });
    await editButton.click();
    const editDialog = page.getByRole("dialog", { name: `Rename or delete ${box}`, exact: true });
    await expect(editDialog.getByRole("textbox", { name: "Box name" })).toHaveValue(box);
    await expectAccessible(page, { within: editDialog, label: "Rename or delete a box dialog" });
    await editDialog.getByRole("textbox", { name: "Box name" }).fill(renamed);
    await editDialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editDialog).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: `${box} is now ${renamed}.` })).toBeVisible();
    box = renamed;
    await expect(heading(box)).toBeVisible();

    await page.getByRole("button", { name: `Edit label for ${box}`, exact: true }).click();
    const labelDialog = page.getByRole("dialog", { name: `Tape label for ${box}`, exact: true });
    await expect(labelDialog.getByRole("textbox", { name: "Background" })).toBeVisible();
    await labelDialog.getByRole("textbox", { name: "Background" }).fill("#203731");
    await labelDialog.getByRole("textbox", { name: "Lettering" }).fill("#FFFFFF");
    await expectAccessible(page, { within: labelDialog, label: "Edit a box's tape label dialog" });
    await labelDialog.getByRole("button", { name: "Save label" }).click();
    await expect(labelDialog).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: `New label on ${box}. Looking sharp.` })).toBeVisible();
    await page.getByRole("button", { name: `Edit label for ${box}`, exact: true }).click();
    await expect(labelDialog.getByRole("textbox", { name: "Background" })).toHaveValue(/^#203731$/i);
    await labelDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(labelDialog).toBeHidden();

    await backToShelf();
    await expect(boxSpine(2)).toBeVisible();
    await expect(headline({ cards: 3, binders: 2, boxes: 1, sale: 2 })).toBeVisible();

    // --- Move the box line back: it re-folds; Undo splits it again ----------
    await boxSpine(2).click();
    await expect(boxCard).toBeVisible();
    await boxCard.click();
    await expect(lines(2)).toBeVisible();
    await moveLine("Raw ×2", binder, 2);
    await expect(
      drawer.getByRole("status").filter({
        hasText: `Moved ${one.short} to ${binder}, stacked with the ones already there.`,
      }),
    ).toBeVisible();
    await expect(lines(1)).toBeVisible();
    await expect(line("Raw ×3").getByText(binder)).toBeVisible();
    await expect(forSale("Raw ×3")).toHaveCount(0);

    await drawer.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(drawer.getByRole("status").filter({ hasText: "Undone." })).toBeVisible();
    await expect(lines(2)).toBeVisible();
    await expect(line("Raw").getByText(binder)).toBeVisible();
    await expect(forSale("Raw ×2")).toBeVisible();

    await moveLine("Raw ×2", binder, 2);
    await expect(lines(1)).toBeVisible();
    await expect(line("Raw ×3").getByText(binder)).toBeVisible();

    // Closing the drawer (it was pushed from the box) is a Back step: the box is
    // there again, and now empty.
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();
    await expect(heading(box)).toBeVisible();
    await expect(page.getByText(/^This box is empty\./)).toBeVisible();
    await backToShelf();
    await expect(headline({ cards: 3, binders: 2, boxes: 1 })).toBeVisible();

    // --- A pocket filled from the hunt tray ---------------------------------
    await binderSpine(3).click();
    await expect(heading(binder)).toBeVisible();
    const hunt = page.getByRole("searchbox", { name: "Hunt for one of your cards" });
    await hunt.fill(`${three.player} ${three.number}`);
    await page
      .getByRole("button", {
        name: new RegExp(`^Slot in 2024 Topps Chrome #${escapeRegExp(three.number)} ${escapeRegExp(three.player)}`),
      })
      .click();
    await page
      .getByRole("group", { name: /^Where should .* go\?$/ })
      .getByRole("button", { name: "This binder", exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: `Added ${three.short} to ${binder}, page 1, pocket 1` }),
    ).toBeVisible();
    const pocket = page
      .getByRole("group", { name: "Page 1", exact: true })
      .getByRole("button", { name: new RegExp(`^2024 Topps Chrome #${escapeRegExp(three.number)} ${escapeRegExp(three.player)}`) });
    await expect(pocket).toBeVisible();
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(hunt).toHaveValue("");
    await expectAccessible(page, { label: "My Binders, a binder with a card in its pocket" });
    // Undo takes the copy out again, and the pocket goes empty.
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Undone." })).toBeVisible();
    await expect(pocket).toHaveCount(0);
    await backToShelf();
    await expect(binderSpine(3)).toBeVisible();

    // --- A Want on another card: the Want List spine and the Want List ------
    await toChecklists();
    await lookThroughEverything();
    const wantOff = checklist.getByRole("button", { name: `Want ${two.short}`, exact: true, pressed: false });
    const wantOn = checklist.getByRole("button", { name: `Want ${two.short}`, exact: true, pressed: true });
    await wantOff.click();
    await expect(wantOn).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: `${two.short} is on your Want List` })).toBeVisible();

    await toBinders();
    await expect(wantSpine(wantBase + 1)).toBeVisible();
    await wantSpine(wantBase + 1).click();
    await expect(heading("Want List")).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: new RegExp(`#${escapeRegExp(two.number)} ${escapeRegExp(two.player)}.*, need\\. Add it$`),
      }),
    ).toBeVisible();
    await expectAccessible(page, { label: "My Binders, the Want List with a card" });
    await backToShelf();

    await toChecklists();
    await lookThroughEverything();
    await wantOn.click();
    await expect(wantOff).toBeVisible();
    await toBinders();
    await expect(wantSpine(wantBase)).toBeVisible();

    // --- Cleanup through the UI: delete the binder, remove the copy, delete the box
    const deleteContainer = async (spine: Locator, name: string, noun: "binder" | "box", goes: string) => {
      await spine.click();
      await expect(heading(name)).toBeVisible();
      await page.getByRole("button", { name: `Rename or delete ${name}`, exact: true }).click();
      await page
        .getByRole("dialog", { name: `Rename or delete ${name}`, exact: true })
        .getByRole("button", { name: `Delete this ${noun}` })
        .click();
      const confirm = page.getByRole("dialog", { name: `Delete ${name}?`, exact: true });
      await expect(confirm.getByText(goes)).toBeVisible();
      return confirm;
    };

    // The binder holds the three: deleting it sends them back to Main.
    const binderConfirm = await deleteContainer(
      binderSpine(3),
      binder,
      "binder",
      "Its 3 cards go back to Main. You can't undo this.",
    );
    await expectAccessible(page, { within: binderConfirm, label: "Delete a binder, confirm" });
    await binderConfirm.getByRole("button", { name: "Yes, delete it" }).click();
    await expect(binderConfirm).toBeHidden();
    await expect(page).not.toHaveURL(/[?&]b=/);
    await expect(
      page.getByRole("status").filter({ hasText: `${binder} is off the shelf. Its 3 cards went back to Main.` }),
    ).toBeVisible();
    await expect(mainSpine(mainBase + 3)).toBeVisible();
    await expect(shelf.getByRole("button", { name: new RegExp(`^${escapeRegExp(binder)},`) })).toHaveCount(0);

    // The copy now lives in Main; remove it.
    await toChecklists();
    await lookThroughEverything();
    await checklist.getByRole("button", { name: `Details for ${one.short}`, exact: true }).click();
    await expect(lines(1)).toBeVisible();
    await expect(line("Raw ×3").getByText("Main")).toBeVisible();
    await yourCopies.getByRole("button", { name: `Remove ${one.short}, Raw ×3`, exact: true }).click();
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();

    // The box is empty: nothing moves.
    await toBinders();
    await expect(mainSpine(mainBase)).toBeVisible();
    const boxConfirm = await deleteContainer(boxSpine(0), box, "box", "It's empty, so nothing moves. You can't undo this.");
    await boxConfirm.getByRole("button", { name: "Yes, delete it" }).click();
    await expect(boxConfirm).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: new RegExp(`^${escapeRegExp(box)} is off the shelf\\.$`) })).toBeVisible();

    // The shelf is back to where it started (self-cleaning, R7).
    await expect(shelf.getByRole("button", { name: new RegExp(`^${escapeRegExp(box)},`) })).toHaveCount(0);
    await expect(headline({})).toBeVisible();
    await expect(mainSpine(mainBase)).toBeVisible();
    await expect(tradeSpine(tradeBase)).toBeVisible();
    await expect(wantSpine(wantBase)).toBeVisible();
  },
);
