// NEO-359 (R1): a signed-in collector's My Binders shelf holds real binders. The
// shelf starts with the three system spines (Main, Up for Trade, Want List) and
// the Inventory door; the collector makes two binders, files a stack of three
// copies in the first, moves two of them into the second (a split into two
// lines), flags a copy Up for trade and takes it off again, moves the pair back
// (it re-folds into one stack of three), takes that back with Undo (the stack
// splits again) and moves it again. The second binder is renamed and relabelled,
// a second card is slotted into a pocket from the hunt tray, a Want on a third
// card lands on the Want List spine and in the Want List and comes off again.
// The spec ends by deleting the first binder (its cards go back to Main) and
// the second, so the shelf is back to where it started.
//
// Collection and inventory are separate screens (NEO-359, NEO-364; Jason:
// "Inventory is things for sale and My Collection is things that are for your
// collection. They should not mix on the screens"): the shelf holds binders
// only, so no box stands on it and Unsorted, the inventory's catch-all, never
// does; the Add form offers binders and no box; a binder line offers Sell (the
// one way across, into a box) and never Take off sale; and the shelf's long box
// is a link to the real `/inventory` list. The boxes themselves (Sell, Take off
// sale, Unsorted) are proved by collection/inventory-boxes-sell-take-off-sale.
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
// Self-cleaning: the copies are removed and both binders are deleted through
// the UI.
//
// R3: the collector's cascade is drilled through `support/collection.ts`
// (shared with add-edit-remove-copy); `drillToSet` drives the admin Set Builder.
// Minted names are single tokens from `env.ATTEMPT_TOKEN` (never rebuilt by
// hand), so the binders of this run are this run's alone.
import type { Locator } from "@playwright/test";
import { drillToCollectorBase, ordinaryBaseRows, shortNameOf } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const cardsWord = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "card" : "cards"}`;

interface Stats {
  cards: number;
  binders: number;
}

test(
  "Collection: make two binders, move copies between them (split, re-fold, Undo, trade), fill a pocket, want a card, delete both",
  { tag: ["@smoke", "@collection"] },
  async ({ page, signIn, env }) => {
    const binderA = `BinderA${env.ATTEMPT_TOKEN}`;
    let binderB = `BinderB${env.ATTEMPT_TOKEN}`;
    const renamed = `Spare${env.ATTEMPT_TOKEN}`;

    // --- The shelf: three system spines and the Inventory door -------------
    await signIn("/collection");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({
      timeout: LAUNCH_GATE,
    });
    const tabs = page.getByRole("navigation", { name: "Collection sections" });
    // Inventory is a separate screen; the real collection has no tab for it yet.
    await expect(tabs.getByRole("link", { name: "Inventory" })).toHaveCount(0);
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
    const spineOf = (name: string, cards: number) =>
      shelf.getByRole("button", { name: `${name}, ${cardsWord(cards)}`, exact: true });

    // The first read: every later count is this plus what the spec did.
    const headlineRe = /^([\d,]+)\+? cards?, (\d+) binders?\.$/;
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
    expect(parsed, "the shelf headline reads 'N cards, N binders.'").not.toBeNull();
    const base: Stats = { cards: number(parsed![1]), binders: number(parsed![2]) };
    const headline = (d: Partial<Stats>) => {
      const s: Stats = { cards: base.cards + (d.cards ?? 0), binders: base.binders + (d.binders ?? 0) };
      return page.getByText(`${cardsWord(s.cards)}, ${s.binders} ${s.binders === 1 ? "binder" : "binders"}.`, {
        exact: true,
      });
    };
    await expect(headline({})).toBeVisible();

    // Collection and inventory do not mix: no box on this screen (Unsorted, the
    // inventory's catch-all, included), and the Inventory door is a plain link
    // to the `/inventory` list.
    await expect(shelf.getByRole("button", { name: /, box, / })).toHaveCount(0);
    await expect(shelf.getByRole("button", { name: /^Unsorted/ })).toHaveCount(0);
    await expect(special.getByRole("button", { name: /^Unsorted/ })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /boxes/i })).toHaveCount(0);
    await expectAccessible(page, { label: "My Binders, the system spines" });
    const door = special.getByRole("link", { name: /^Inventory, / });
    await expect(door).toBeVisible();
    await door.click();
    await expect(page).toHaveURL(/\/inventory\?tab=cards/);
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Everything for sale" })).toBeVisible();
    await expectAccessible(page, { label: "Inventory list, reached from the collection's long box" });
    await page.goBack();
    await expect(page).toHaveURL(/[?&]tab=binders/);
    await expect(headline({})).toBeVisible();

    // --- Two binders ---------------------------------------------------------
    const newButton = shelf.getByRole("button", { name: "New binder", exact: true });
    const heading = (name: string) => page.getByRole("heading", { level: 2, name, exact: true });
    const backToShelf = async () => {
      await page.getByRole("button", { name: "Back to the shelf" }).click();
      await expect(shelf).toBeVisible();
      await expect(page).not.toHaveURL(/[?&]b=/);
    };
    const openNewBinder = async () => {
      await newButton.click();
      const dialog = page.getByRole("dialog", { name: "New binder", exact: true });
      await expect(dialog.getByRole("textbox", { name: "Binder name" })).toBeVisible();
      return dialog;
    };

    const newDialog = await openNewBinder();
    // The real collection makes binders only: no box to pick, and no smart binder yet.
    await expect(newDialog.getByRole("radio")).toHaveCount(0);
    await expect(newDialog.getByText(/\bbox\b/i)).toHaveCount(0);
    await expectAccessible(page, { within: newDialog, label: "New binder dialog" });
    await newDialog.getByRole("textbox", { name: "Binder name" }).fill(binderA);
    await newDialog.getByRole("button", { name: "Put it on the shelf" }).click();
    await expect(newDialog).toBeHidden();
    await expect(page).toHaveURL(/[?&]b=[^&]+/);
    await expect(heading(binderA)).toBeVisible();
    // Its pages are drawn (an empty pocket to fill), not the loading line.
    await expect(page.getByRole("button", { name: /^Empty .*\. Fill it from the pack$/ }).first()).toBeVisible();
    await expectAccessible(page, { label: "My Binders, an empty binder" });
    await backToShelf();
    await expect(spineOf(binderA, 0)).toBeVisible();

    const dialogB = await openNewBinder();
    await dialogB.getByRole("textbox", { name: "Binder name" }).fill(binderB);
    await dialogB.getByRole("button", { name: "Put it on the shelf" }).click();
    await expect(dialogB).toBeHidden();
    await expect(heading(binderB)).toBeVisible();
    await backToShelf();
    await expect(spineOf(binderB, 0)).toBeVisible();
    await expect(headline({ binders: 2 })).toBeVisible();

    // Opening from the shelf is a Back step: Back returns to the shelf.
    await spineOf(binderA, 0).click();
    await expect(page).toHaveURL(/[?&]b=[^&]+/);
    await expect(heading(binderA)).toBeVisible();
    await page.goBack();
    await expect(page).not.toHaveURL(/[?&]b=/);
    await expect(spineOf(binderA, 0)).toBeVisible();
    await expect(heading(binderA)).toBeHidden();

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

    // --- File three copies in the first binder ------------------------------
    const drawer = page.getByRole("dialog", {
      name: new RegExp(`^2024 Topps Chrome #${escapeRegExp(one.number)} ${escapeRegExp(one.player)}`),
    });
    await checklist.getByRole("button", { name: `Details for ${one.short}`, exact: true }).click();
    const yourCopies = drawer.getByRole("region", { name: `Your copies of ${one.short}`, exact: true });
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    const addForm = drawer.getByRole("form", { name: "Add a copy", exact: true });
    const where = addForm.getByRole("combobox", { name: "Where it lives" });
    // Binders only: no box to file a copy in, and not Unsorted (the inventory's).
    await expect(where.getByRole("option", { name: binderA, exact: true })).toBeAttached();
    await expect(where.getByRole("option", { name: "Main", exact: true })).toBeAttached();
    await expect(where.getByRole("option", { name: /box/i })).toHaveCount(0);
    await expect(where.getByRole("option", { name: "Unsorted", exact: true })).toHaveCount(0);
    await where.selectOption({ label: binderA });
    await addForm.getByRole("spinbutton", { name: "Quantity" }).fill("3");
    await addForm.getByRole("button", { name: "Add to collection" }).click();
    await expect(drawer.getByRole("status").filter({ hasText: `Added ${one.short}, Raw ×3` })).toBeVisible();

    /** One "Your copies" line, found by what it says ("Raw ×3"). */
    const line = (what: string) =>
      yourCopies.getByRole("listitem").filter({ has: page.getByText(what, { exact: true }) });
    const lines = (n: number) =>
      yourCopies.getByRole("heading", { name: `Your copies (${n} ${n === 1 ? "line" : "lines"})`, exact: true });
    const upForTrade = (what: string) => line(what).getByText("Up for trade", { exact: true });
    /** Move a whole or part of a line to another binder; `count` is what the Move button reads. */
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
    await expect(line("Raw ×3").getByText(binderA)).toBeVisible();
    // A binder line can be SOLD (the one way across to a box) and is never "taken off
    // sale": it is not for sale. (inventory-boxes-sell-take-off-sale follows the sale.)
    await expect(yourCopies.getByRole("button", { name: `Sell ${one.short}, Raw ×3`, exact: true })).toBeVisible();
    await expect(yourCopies.getByRole("button", { name: /^Take off sale, / })).toHaveCount(0);

    // --- Move two into the second binder: a split into two lines -----------
    await moveLine("Raw ×3", binderB, 2, 2, "Card drawer, the Move panel with a binder picked");
    await expect(
      drawer.getByRole("status").filter({ hasText: `Moved 2 of ${one.short} to ${binderB}.` }),
    ).toBeVisible();
    await expect(lines(2)).toBeVisible();
    await expect(line("Raw").getByText(binderA)).toBeVisible();
    await expect(line("Raw ×2").getByText(binderB)).toBeVisible();
    await expect(yourCopies.getByText("For sale")).toHaveCount(0);
    await expectAccessible(page, { within: drawer, label: "Card drawer, a stack split between two binders" });

    // --- Up for trade: a flag on the copy in the first binder ---------------
    await setTrade("Raw", true);
    await expect(upForTrade("Raw")).toBeVisible();
    await expect(upForTrade("Raw ×2")).toHaveCount(0);
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();

    // --- The shelf counts what is where, and what is up for trade -----------
    await toBinders();
    await expect(headline({ cards: 3, binders: 2 })).toBeVisible();
    await expect(spineOf(binderA, 1)).toBeVisible();
    await expect(spineOf(binderB, 2)).toBeVisible();
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
    await expect(line("Raw").getByText(binderA)).toBeVisible();
    await expect(upForTrade("Raw")).toBeVisible();
    await setTrade("Raw", false);
    await expect(upForTrade("Raw")).toHaveCount(0);
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();
    await expect(heading("Up for Trade")).toBeVisible();
    await expect(tradeCard).toHaveCount(0);
    await backToShelf();
    await expect(tradeSpine(tradeBase)).toBeVisible();
    await expect(spineOf(binderA, 1)).toBeVisible();

    // --- Rename and relabel the second binder -------------------------------
    await spineOf(binderB, 2).click();
    await expect(heading(binderB)).toBeVisible();
    await page.getByRole("button", { name: `Rename or delete ${binderB}`, exact: true }).click();
    const editDialog = page.getByRole("dialog", { name: `Rename or delete ${binderB}`, exact: true });
    await expect(editDialog.getByRole("textbox", { name: "Binder name" })).toHaveValue(binderB);
    await expectAccessible(page, { within: editDialog, label: "Rename or delete a binder dialog" });
    await editDialog.getByRole("textbox", { name: "Binder name" }).fill(renamed);
    await editDialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editDialog).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: `${binderB} is now ${renamed}.` })).toBeVisible();
    binderB = renamed;
    await expect(heading(binderB)).toBeVisible();

    await page.getByRole("button", { name: `Edit label for ${binderB}`, exact: true }).click();
    const labelDialog = page.getByRole("dialog", { name: `Spine label for ${binderB}`, exact: true });
    await expect(labelDialog.getByRole("textbox", { name: "Background" })).toBeVisible();
    await labelDialog.getByRole("textbox", { name: "Background" }).fill("#203731");
    await labelDialog.getByRole("textbox", { name: "Lettering" }).fill("#FFFFFF");
    await expectAccessible(page, { within: labelDialog, label: "Edit a binder's spine label dialog" });
    await labelDialog.getByRole("button", { name: "Save label" }).click();
    await expect(labelDialog).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: `New label on ${binderB}. Looking sharp.` })).toBeVisible();
    await page.getByRole("button", { name: `Edit label for ${binderB}`, exact: true }).click();
    await expect(labelDialog.getByRole("textbox", { name: "Background" })).toHaveValue(/^#203731$/i);
    await labelDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(labelDialog).toBeHidden();
    await backToShelf();
    await expect(spineOf(binderB, 2)).toBeVisible();

    // --- Move the pair back: it re-folds; Undo splits it again --------------
    await toChecklists();
    await lookThroughEverything();
    await checklist.getByRole("button", { name: `Details for ${one.short}, Raw ×2`, exact: true }).click();
    await expect(lines(2)).toBeVisible();
    await moveLine("Raw ×2", binderA, 2);
    await expect(
      drawer.getByRole("status").filter({
        hasText: `Moved ${one.short} to ${binderA}, stacked with the ones already there.`,
      }),
    ).toBeVisible();
    await expect(lines(1)).toBeVisible();
    await expect(line("Raw ×3").getByText(binderA)).toBeVisible();

    await drawer.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(drawer.getByRole("status").filter({ hasText: "Undone." })).toBeVisible();
    await expect(lines(2)).toBeVisible();
    await expect(line("Raw").getByText(binderA)).toBeVisible();
    await expect(line("Raw ×2").getByText(binderB)).toBeVisible();

    await moveLine("Raw ×2", binderA, 2);
    await expect(lines(1)).toBeVisible();
    await expect(line("Raw ×3").getByText(binderA)).toBeVisible();
    // The drawer was pushed from Checklists, so closing it is a Back step there.
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(/[?&]tab=checklists/);

    await toBinders();
    await expect(spineOf(binderB, 0)).toBeVisible();
    await expect(spineOf(binderA, 3)).toBeVisible();
    await expect(headline({ cards: 3, binders: 2 })).toBeVisible();

    // --- A pocket filled from the hunt tray ---------------------------------
    await spineOf(binderA, 3).click();
    await expect(heading(binderA)).toBeVisible();
    const hunt = page.getByRole("searchbox", { name: "Hunt for one of your cards" });
    await hunt.fill(`${three.player} ${three.number}`);
    await page
      .getByRole("button", {
        // The hunt finds the base card and its parallels ("..., Orioles, Gold Wave
        // Refractors"): the base card's name stops at the team.
        name: new RegExp(`^Slot in 2024 Topps Chrome #${escapeRegExp(three.number)} ${escapeRegExp(three.player)}, [^,]+$`),
      })
      .click();
    await page
      .getByRole("group", { name: /^Where should .* go\?$/ })
      .getByRole("button", { name: "This binder", exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: `Added ${three.short} to ${binderA}, page 1, pocket 1` }),
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
    await expect(spineOf(binderA, 3)).toBeVisible();

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

    // --- Cleanup through the UI: delete the first binder, remove the copy, delete the second
    const deleteBinder = async (spine: Locator, name: string, goes: string) => {
      await spine.click();
      await expect(heading(name)).toBeVisible();
      await page.getByRole("button", { name: `Rename or delete ${name}`, exact: true }).click();
      await page
        .getByRole("dialog", { name: `Rename or delete ${name}`, exact: true })
        .getByRole("button", { name: "Delete this binder" })
        .click();
      const confirm = page.getByRole("dialog", { name: `Delete ${name}?`, exact: true });
      await expect(confirm.getByText(goes)).toBeVisible();
      return confirm;
    };

    // The first binder holds the three: deleting it sends them back to Main.
    const confirmA = await deleteBinder(
      spineOf(binderA, 3),
      binderA,
      "Its 3 cards go back to Main. You can't undo this.",
    );
    await expectAccessible(page, { within: confirmA, label: "Delete a binder, confirm" });
    await confirmA.getByRole("button", { name: "Yes, delete it" }).click();
    await expect(confirmA).toBeHidden();
    await expect(page).not.toHaveURL(/[?&]b=/);
    await expect(
      page.getByRole("status").filter({ hasText: `${binderA} is off the shelf. Its 3 cards went back to Main.` }),
    ).toBeVisible();
    await expect(mainSpine(mainBase + 3)).toBeVisible();
    await expect(shelf.getByRole("button", { name: new RegExp(`^${escapeRegExp(binderA)},`) })).toHaveCount(0);

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

    // The second binder is empty: nothing moves.
    await toBinders();
    await expect(mainSpine(mainBase)).toBeVisible();
    const confirmB = await deleteBinder(spineOf(binderB, 0), binderB, "It's empty, so nothing moves. You can't undo this.");
    await confirmB.getByRole("button", { name: "Yes, delete it" }).click();
    await expect(confirmB).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: new RegExp(`^${escapeRegExp(binderB)} is off the shelf\\.$`) })).toBeVisible();

    // The shelf is back to where it started (self-cleaning, R7).
    await expect(shelf.getByRole("button", { name: new RegExp(`^${escapeRegExp(binderB)},`) })).toHaveCount(0);
    await expect(headline({})).toBeVisible();
    await expect(mainSpine(mainBase)).toBeVisible();
    await expect(tradeSpine(tradeBase)).toBeVisible();
    await expect(wantSpine(wantBase)).toBeVisible();
  },
);
