// NEO-358 (R1): a card a collector owns cannot be deleted from the set builder,
// and the collector's catalog hides a set while nothing is in it (see "HIDDEN
// UNTIL IT HOLDS A CARD" below; one set and one card serve both, so the second
// check costs navigations, not another fixture).
//
// The operator presses Del, then Confirm; the server refuses; the checklist's
// notice banner says so as an alert ("Hold up! A collector has this card, so it
// stays in the catalog."), the confirm resets to Del, focus returns to the
// row's "Delete card ..." control, and the card is still listed. Once the
// collector's copy is removed, the same delete goes through.
//
// The collector here is the worker's own signed-in account: it marks the card
// Have through the real /collection (Checklists), exactly as add-edit-remove-
// copy does. The refusal copy is `lib/collection/collectors.ts`; the unit test
// CardChecklist.deleteRefused.test.tsx pins the row, this proves it live.
//
// SAFETY (R7/R7a): if the guard ever broke, Confirm would delete the card. So
// the card is never on a shared set. It is a hand-made card in a hand-made,
// per-attempt set (`cdr-<worker>-<attempt>`, SET-REGISTRY.md) under the real
// Baseball > 2024 > Topps, with no marketplace id anywhere beneath it. The
// guard breaking costs this spec's own card and turns it red at "still
// listed". Self-cleaning: the copy is removed through the UI, and then the
// card is deleted through the UI (the set and its rows stand).
//
// R3: add-edit-remove-copy proves the collector's side (Have, drawer, copies)
// on the seeded Base; this spec owns the set builder's refusal. The cascade
// drill below is that spec's collector cascade, kept local for the same reason
// it is local there: `support/set-builder.ts` drives the admin builder.
//
// HIDDEN UNTIL IT HOLDS A CARD (Jason, 2026-10-24: "hide anything that is a
// zero"): every row the app creates is born with a known subtree count of 0, and
// the collector's Checklists cascade (`collectionCatalog.drill`) leaves out a
// level whose count is exactly 0. So the hand-made set, created empty above, is
// NOT in the Sets column of Baseball > 2024 > Topps until its first card lands;
// it is there once the card is added, and gone again once the card is deleted
// (the delete takes the count back to 0). The real Topps Chrome set sits in that
// same column with cards (the seed's commit), so seeing it first proves the
// column has loaded and an absent hand-made set is the filter, not a column that
// has not answered yet (R2: the absence is never asserted alone). The ancestors
// (Baseball, 2024, Topps) are real rows from the reference bundle with no stored
// subtree count, which reads as unknown and is shown, so the drill reaches the
// column; only the rows this spec creates are known-empty. That is why the proof
// lives on the hand-made set and not on a bundle row.
//
// MINTED NAMES are single tokens: the set `cdr-<worker>-<attempt>` (the same
// shape `mtf-` uses), the card number `361-<attempt>` and the card name
// `Held<token>`.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { drillToCustom, setBuilderReady } from "../../support/set-builder";
import { addCardViaForm, confirmDeleteCardButton, deleteCardButton, editCardButton, escapeRe } from "../../support/cards";

test(
  "A set is hidden from the collector until it holds a card; a card a collector owns cannot be deleted: the set builder says so, resets to Del, keeps focus on it and keeps the card",
  { tag: ["@smoke", "@collection"] },
  async ({ page, signIn, env }) => {
    const A = env.ATTEMPT_ID;
    const setName = `cdr-${env.WORKER_INDEX}-${A}`;
    const number = `361-${A}`;
    const cardName = `Held${env.ATTEMPT_TOKEN}`;
    const refusal = "Hold up! A collector has this card, so it stays in the catalog.";

    // --- An empty set of our own ----------------------------------------------
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    const build = {
      sport: "Baseball",
      year: "2024",
      manufacturer: "Topps",
      set: setName,
      variantType: "Insert",
      variant: "Base",
    };
    // Ends on the Base checklist's "Open add card form": the set and its
    // Insert > Base rows exist, with no card in any of them.
    await drillToCustom(page, build);

    // --- The collector's cascade -----------------------------------------------
    const cascade = page.getByRole("group", { name: "Sport, year, brand and set" });
    const drill = async (column: string, option: string) => {
      await cascade
        .getByRole("listbox", { name: column })
        .getByRole("option")
        .filter({ has: page.getByText(option, { exact: true }) })
        .click();
      await expect(cascade.getByRole("button", { name: `${column}: ${option}, change` })).toBeVisible();
    };
    const setOption = cascade
      .getByRole("listbox", { name: "Sets" })
      .getByRole("option")
      .filter({ has: page.getByText(setName, { exact: true }) });
    /** Baseball > 2024 > Topps, with the Sets column open and loaded (the real Topps Chrome is in it). */
    const openSets = async () => {
      await page.goto("/collection?tab=checklists");
      await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
      await drill("Sports", "Baseball");
      await drill("Years", "2024");
      await drill("Brands", "Topps");
      await expect(
        cascade
          .getByRole("listbox", { name: "Sets" })
          .getByRole("option")
          .filter({ has: page.getByText("Topps Chrome", { exact: true }) }),
      ).toBeVisible();
    };

    // --- Empty: the collector is not offered the set ---------------------------
    await openSets();
    await expect(setOption).toHaveCount(0);

    // --- A card of our own, in that set ------------------------------------------
    await drillToCustom(page, build);
    await addCardViaForm(page, { cardNumber: number, playerName: cardName });

    // --- Holding a card: the set is offered, and the collector marks it Have ----
    await openSets();
    await expect(setOption).toBeVisible();
    await drill("Sets", setName);
    await drill("Variant Types", "Insert");
    await drill("Insert", "Base");

    // A hand-made card has no linked player, so the collector sees only its number.
    const checklist = page.getByRole("region", { name: `2024 ${setName} Base`, exact: true });
    const short = `#${number}`;
    const haveOff = checklist.getByRole("button", { name: `Have ${short}`, exact: true, pressed: false });
    await expect(haveOff).toBeVisible();
    // All is a view (NEO-374): Have files into a picked binder.
    await checklist.getByRole("combobox", { name: "Binder" }).selectOption({ label: "Main" });
    await haveOff.click();
    await expect(checklist.getByRole("button", { name: `Have ${short}, Raw`, exact: true, pressed: true })).toBeVisible();
    // The toggle flips optimistically; the notice is the server's answer. The
    // set builder is only opened once the copy is really stored.
    await expect(page.getByRole("status").filter({ hasText: `Added ${short} to Main` })).toBeVisible();

    // --- The set builder refuses the delete ----------------------------------
    await drillToCustom(page, build);
    const del = deleteCardButton(page, number);
    await expect(editCardButton(page, number)).toBeVisible();
    await del.click();
    await expect(page.getByText("Confirm?")).toBeVisible();
    await confirmDeleteCardButton(page, number).click();

    // Said, and announced: the checklist's notice banner, as an alert.
    const alert = page.getByRole("alert").filter({ hasText: refusal });
    await expect(alert).toHaveText(refusal);
    // The confirm reset to Del, and focus is back on that row's Del control.
    await expect(confirmDeleteCardButton(page, number)).toBeHidden();
    await expect(page.getByText("Confirm?")).toBeHidden();
    await expect(del).toBeVisible();
    await expect(del).toBeFocused();
    // The card is still listed.
    await expect(editCardButton(page, number)).toBeVisible();
    await expect(page.getByText(`#${number}`, { exact: true })).toBeVisible();
    await expectAccessible(page, { label: "Checklist after a refused card delete" });

    // --- Clean up: the collector lets go, then the card can go ---------------
    await openSets();
    await drill("Sets", setName);
    await drill("Variant Types", "Insert");
    await drill("Insert", "Base");
    await checklist.getByRole("button", { name: `Details for ${short}`, exact: true }).click();
    const drawer = page.getByRole("dialog", { name: new RegExp(`^2024 ${escapeRe(setName)}.*#${escapeRe(number)}`) });
    const yourCopies = drawer.getByRole("region", { name: `Your copies of ${short}` });
    await yourCopies.getByRole("button", { name: `Remove ${short}, Raw`, exact: true }).click();
    // The list empties optimistically; "Removed ..." is the server's answer. The
    // card can only be deleted once that write has landed, so wait for it.
    await expect(drawer.getByRole("status").filter({ hasText: `Removed ${short}, Raw` })).toBeVisible();
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();

    await drillToCustom(page, build);
    await deleteCardButton(page, number).click();
    await confirmDeleteCardButton(page, number).click();
    await expect(editCardButton(page, number)).toBeHidden();
    await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible();

    // --- Empty again: the delete took the set's count back to zero -------------
    await openSets();
    await expect(setOption).toHaveCount(0);
  },
);
