// NEO-359 (R1): a signed-in collector's My Binders shelf holds real binders and
// boxes. The shelf starts with the three system spines (Main, Up for Trade, Want
// List); the collector makes a binder and a box, opens each, files a stack of
// three copies in the binder, moves two of them into the box (the box is the
// sale table, so those two read "For sale" and the shelf headline counts them),
// moves the box line back (the pair re-folds into one stack of three), takes
// that back with Undo (the stack splits again) and moves it again. A Want on a
// second card lands on the Want List spine and in the Want List, and comes off
// again. The spec ends by deleting the binder (its cards go back to Main) and
// the box, so the shelf shows the system spines alone.
//
// The signed-in page is the REAL collection (Convex, per user). Moves are driven
// with the drawer's Move form (buttons and fields), never by dragging.
//
// R7/R7a: writes only the signed-in user's own rows (`collectionContainers`,
// `collectionCopies`, `collectionWants`; the bootstrap reset clears the account)
// on two cards of the seed's 2024 Topps Chrome Base, registered in
// SET-REGISTRY.md. It never writes the set, its cards, players or teams.
// Self-cleaning: the copy is removed and both containers are deleted through the
// UI, and the closing shelf check proves the account is back to its start.
//
// R3: the collector's cascade is drilled through `support/collection.ts`
// (shared with add-edit-remove-copy); `drillToSet` drives the admin Set Builder.
// Minted names are single tokens from `env.ATTEMPT_TOKEN` (never rebuilt by
// hand), so a binder and a box of this run are this run's alone.
import { drillToCollectorBase, ordinaryBaseRows, shortNameOf } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test(
  "Collection: make a binder and a box, move copies between them (for sale, re-fold, Undo), want a card, delete both",
  { tag: ["@smoke", "@collection"] },
  async ({ page, signIn, env }) => {
    const binder = `Binder${env.ATTEMPT_TOKEN}`;
    const box = `Box${env.ATTEMPT_TOKEN}`;

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
    const mainSpine = (cards: number) =>
      shelf.getByRole("button", { name: `Main, ${cards} ${cards === 1 ? "card" : "cards"}`, exact: true });
    const wantSpine = (cards: number) =>
      special.getByRole("button", { name: `Want List, ${cards} ${cards === 1 ? "card" : "cards"} wanted`, exact: true });
    const headline = (text: RegExp) => page.getByText(text);

    // R2: the account starts with nothing, so every count below is this spec's.
    await expect(mainSpine(0)).toBeVisible();
    await expect(special.getByRole("button", { name: "Up for Trade, 0 cards up for trade", exact: true })).toBeVisible();
    await expect(wantSpine(0)).toBeVisible();
    await expect(headline(/^0 cards, 1 binder, 0 for sale\.$/)).toBeVisible();
    await expectAccessible(page, { label: "My Binders, the system spines" });

    // --- A binder, then a box ------------------------------------------------
    const newButton = shelf.getByRole("button", { name: "New binder or box", exact: true });
    const heading = (name: string) => page.getByRole("heading", { level: 2, name, exact: true });
    const backToShelf = async () => {
      await page.getByRole("button", { name: "Back to the shelf" }).click();
      await expect(shelf).toBeVisible();
      await expect(page).not.toHaveURL(/[?&]b=/);
    };

    await newButton.click();
    const newDialog = page.getByRole("dialog", { name: "New binder or box" });
    await expect(newDialog.getByRole("textbox", { name: "Binder name" })).toBeVisible();
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
    await expect(shelf.getByRole("button", { name: `${binder}, 0 cards`, exact: true })).toBeVisible();

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
    const boxSpine = (forSale: number) =>
      shelf.getByRole("button", {
        name: `${box}, box, ${forSale} ${forSale === 1 ? "card" : "cards"} for sale`,
        exact: true,
      });
    await expect(boxSpine(0)).toBeVisible();
    await expect(headline(/^0 cards, 2 binders, 1 box, 0 for sale\.$/)).toBeVisible();

    // Opening from the shelf is a Back step: Back returns to the shelf.
    await shelf.getByRole("button", { name: `${binder}, 0 cards`, exact: true }).click();
    await expect(page).toHaveURL(/[?&]b=[^&]+/);
    await expect(heading(binder)).toBeVisible();
    await page.goBack();
    await expect(page).not.toHaveURL(/[?&]b=/);
    await expect(shelf.getByRole("button", { name: `${binder}, 0 cards`, exact: true })).toBeVisible();
    await expect(heading(binder)).toBeHidden();

    // --- Checklists: two ordinary Base cards --------------------------------
    const toChecklists = async () => {
      await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
      await expect(page).toHaveURL(/[?&]tab=checklists/);
    };
    await toChecklists();
    const checklist = await drillToCollectorBase(page);
    /** The page's binder scope rides along between tabs; look through everything. */
    const lookThroughEverything = async () => {
      await checklist.getByRole("combobox", { name: "Binder" }).selectOption({ label: "All" });
    };
    await lookThroughEverything();

    // Read both names before any write: a card with two lines drops out of the
    // "ordinary row" match (its Details button names the line).
    const rows = ordinaryBaseRows(checklist);
    await expect(rows.nth(1)).toBeVisible(); // "any two": the first two ordinary rows
    const one = await shortNameOf(rows.first());
    const two = await shortNameOf(rows.nth(1));
    expect(two.short, "two different cards").not.toBe(one.short);

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
    /** Move a whole or part of a line to a home; `count` is what the Move button reads. */
    const moveLine = async (what: string, to: string, count: number, quantity?: number) => {
      await yourCopies.getByRole("button", { name: `Move ${one.short}, ${what}`, exact: true }).click();
      const form = yourCopies.getByRole("form", { name: `Move ${what}`, exact: true });
      await expect(form).toBeVisible();
      await form.getByRole("combobox", { name: "Move to" }).selectOption({ label: to });
      if (quantity !== undefined) await form.getByRole("spinbutton", { name: "Quantity to move" }).fill(String(quantity));
      await form.getByRole("button", { name: `Move ${count}`, exact: true }).click();
      await expect(form).toBeHidden();
    };

    await expect(lines(1)).toBeVisible();
    await expect(line("Raw ×3").getByText(binder)).toBeVisible();
    await expect(forSale("Raw ×3")).toHaveCount(0);

    // --- Move two into the box: a split, and the box line is for sale -------
    await moveLine("Raw ×3", `${box} (box, for sale)`, 2, 2);
    await expect(
      drawer.getByRole("status").filter({ hasText: `Moved 2 of ${one.short} to ${box}. They're for sale now.` }),
    ).toBeVisible();
    await expect(lines(2)).toBeVisible();
    await expect(line("Raw").getByText(binder)).toBeVisible();
    await expect(forSale("Raw")).toHaveCount(0);
    await expect(line("Raw ×2").getByText(box)).toBeVisible();
    await expect(forSale("Raw ×2")).toBeVisible();
    await expectAccessible(page, { within: drawer, label: "Card drawer, a stack split between a binder and a box" });

    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();
    // The checklist row carries the sale tag too.
    await expect(checklist.getByText("For sale", { exact: true })).toBeVisible();

    // --- The shelf counts what is for sale; the box shows the card ----------
    await tabs.getByRole("link", { name: "My Binders", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=binders/);
    await expect(headline(/^3 cards, 2 binders, 1 box, 2 for sale\.$/)).toBeVisible();
    await expect(shelf.getByRole("button", { name: `${binder}, 1 card`, exact: true })).toBeVisible();
    await expect(boxSpine(2)).toBeVisible();
    await expect(special.getByRole("button", { name: "Inventory, 2 cards for sale", exact: true })).toBeVisible();

    await boxSpine(2).click();
    await expect(heading(box)).toBeVisible();
    const open = page.getByRole("region", { name: `${box}, open`, exact: true });
    const boxCard = open.getByRole("button", {
      name: new RegExp(`#${escapeRegExp(one.number)} ${escapeRegExp(one.player)}.*, 2 copies, for sale$`),
    });
    await expect(boxCard).toBeVisible();
    await expectAccessible(page, { label: "My Binders, a box holding a card for sale" });

    // --- Move the box line back: it re-folds; Undo splits it again ----------
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
    await expect(headline(/^3 cards, 2 binders, 1 box, 0 for sale\.$/)).toBeVisible();

    // --- A Want on another card: the Want List spine and the Want List ------
    await toChecklists();
    await lookThroughEverything();
    const wantOff = checklist.getByRole("button", { name: `Want ${two.short}`, exact: true, pressed: false });
    const wantOn = checklist.getByRole("button", { name: `Want ${two.short}`, exact: true, pressed: true });
    await wantOff.click();
    await expect(wantOn).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: `${two.short} is on your Want List` })).toBeVisible();

    await tabs.getByRole("link", { name: "My Binders", exact: true }).click();
    await expect(wantSpine(1)).toBeVisible();
    await wantSpine(1).click();
    await expect(heading("Want List")).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: new RegExp(`#${escapeRegExp(two.number)} ${escapeRegExp(two.player)}.*, need\\. Add it$`),
      }),
    ).toBeVisible();
    await backToShelf();

    await toChecklists();
    await lookThroughEverything();
    await wantOn.click();
    await expect(wantOff).toBeVisible();
    await tabs.getByRole("link", { name: "My Binders", exact: true }).click();
    await expect(wantSpine(0)).toBeVisible();

    // --- Cleanup through the UI: delete the binder, remove the copy, delete the box
    const deleteContainer = async (spine: ReturnType<typeof boxSpine>, name: string, noun: "binder" | "box", goes: string) => {
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
      shelf.getByRole("button", { name: `${binder}, 3 cards`, exact: true }),
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
    await expect(mainSpine(3)).toBeVisible();
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
    await tabs.getByRole("link", { name: "My Binders", exact: true }).click();
    await expect(mainSpine(0)).toBeVisible();
    const boxConfirm = await deleteContainer(boxSpine(0), box, "box", "It's empty, so nothing moves. You can't undo this.");
    await boxConfirm.getByRole("button", { name: "Yes, delete it" }).click();
    await expect(boxConfirm).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: new RegExp(`^${escapeRegExp(box)} is off the shelf\\.$`) })).toBeVisible();

    // The shelf is back to the system spines (self-cleaning, R7).
    await expect(shelf.getByRole("button", { name: new RegExp(`^${escapeRegExp(box)},`) })).toHaveCount(0);
    await expect(headline(/^0 cards, 1 binder, 0 for sale\.$/)).toBeVisible();
    await expect(special.getByRole("button", { name: "Up for Trade, 0 cards up for trade", exact: true })).toBeVisible();
    await expect(wantSpine(0)).toBeVisible();
  },
);
