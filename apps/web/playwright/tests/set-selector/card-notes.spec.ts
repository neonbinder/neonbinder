// NEO-367 (R1): a catalog card's Notes, NB's own facts about the card ("short
// print, about 1:120 packs"). An admin types one into quick add, sees it in the
// card drawer's Notes box, edits it there (it autosaves on leaving the field
// like every other drawer field), and the collector's card detail shows the
// edited note. Clearing it in the drawer takes the Notes row off the
// collector's detail.
//
// SAFETY (R7/R7a): a hand-made card in a hand-made, per-attempt set
// (`cnote-<worker key>-<attempt>`, SET-REGISTRY.md) under the real Baseball > 2024 >
// Topps, with no marketplace id anywhere beneath it. Nothing is owned, so the
// card is deleted through the UI at the end; the set and its rows stand, and
// the delete takes the set's count back to zero, which hides it from the
// collector again.
//
// R3: the collector cascade is drilled locally, as in
// tests/collection/card-collectors-own-cannot-be-deleted.spec.ts, because
// `support/set-builder.ts` drives the admin builder.
//
// MINTED NAMES are single tokens: the set `cnote-<worker key>-<attempt>`, the card
// number `367-<attempt>` and the card name `Noted<token>`.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { drillToCustom, setBuilderReady } from "../../support/set-builder";
import { addCardViaForm, confirmDeleteCardButton, deleteCardButton, editCardButton, escapeRe } from "../../support/cards";

test(
  "Card notes: added in quick add, edited in the card drawer, shown on the collector's card detail",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const A = env.ATTEMPT_ID;
    const setName = `cnote-${env.WORKER_KEY}-${A}`;
    const number = `367-${A}`;
    const cardName = `Noted${env.ATTEMPT_TOKEN}`;
    const firstNote = `Short print, about 1:120 packs ${A}`;
    const editedNote = `Error card, corrected in a later print run ${A}`;

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
    await drillToCustom(page, build);

    // --- Quick add carries a note --------------------------------------------
    await addCardViaForm(page, {
      cardNumber: number,
      playerName: cardName,
      beforeSubmit: async () => {
        const notes = page.getByRole("textbox", { name: "Notes (optional)", exact: true });
        await expect(notes).toBeVisible();
        await expectAccessible(page, { label: "Quick add with a Notes box" });
        await notes.fill(firstNote);
      },
    });

    // --- The drawer shows it, and an edit autosaves --------------------------
    await editCardButton(page, number).click();
    const notes = page.getByRole("textbox", { name: "Card notes", exact: true });
    const cardNameBox = page.getByRole("textbox", { name: "Card name", exact: true });
    await expect(notes).toHaveValue(firstNote);
    await notes.fill(editedNote);
    await cardNameBox.click(); // leaving the field saves it
    await expect(page.getByText(/^Saved Notes$/)).toBeVisible();
    await expectAccessible(page, { within: page.getByRole("dialog"), label: "Card drawer with Notes" });
    await page.getByRole("button", { name: "Done editing card" }).click();
    await expect(cardNameBox).toBeHidden();

    // --- The collector sees the edited note ----------------------------------
    const cascade = page.getByRole("group", { name: "Sport, year, brand and set" });
    const drill = async (column: string, option: string) => {
      await cascade
        .getByRole("listbox", { name: column })
        .getByRole("option")
        .filter({ has: page.getByText(option, { exact: true }) })
        .click();
      await expect(cascade.getByRole("button", { name: `${column}: ${option}, change` })).toBeVisible();
    };
    const short = `#${number}`;
    const drawer = page.getByRole("dialog", { name: new RegExp(`^2024 ${escapeRe(setName)}.*#${escapeRe(number)}`) });
    /** The collector's card detail for this card, open. */
    const openCollectorDetail = async () => {
      await page.goto("/collection?tab=checklists");
      await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
      await drill("Sports", "Baseball");
      await drill("Years", "2024");
      await drill("Brands", "Topps");
      await drill("Sets", setName);
      await drill("Variant Types", "Insert");
      await drill("Insert", "Base");
      const checklist = page.getByRole("region", { name: `2024 ${setName} Base`, exact: true });
      await checklist.getByRole("button", { name: `Details for ${short}`, exact: true }).click();
      await expect(drawer).toBeVisible();
    };
    const closeCollectorDetail = async () => {
      await drawer.getByRole("button", { name: "Close card detail" }).click();
      await expect(drawer).toBeHidden();
    };

    await openCollectorDetail();
    await expect(drawer.getByRole("term").filter({ hasText: /^Notes$/ })).toBeVisible();
    await expect(drawer.getByText(editedNote, { exact: true })).toBeVisible();
    await expect(drawer.getByText(firstNote, { exact: true })).toHaveCount(0);
    await expectAccessible(page, { within: drawer, label: "Collector card detail with a note" });
    await closeCollectorDetail();

    // --- Clearing the note takes it off the collector's detail ----------------
    await drillToCustom(page, build);
    await editCardButton(page, number).click();
    await expect(notes).toHaveValue(editedNote);
    await notes.fill("");
    await cardNameBox.click();
    await expect(page.getByText(/^Cleared Notes$/)).toBeVisible();
    await page.getByRole("button", { name: "Done editing card" }).click();
    await expect(cardNameBox).toBeHidden();

    await openCollectorDetail();
    // R2: the detail has rendered (its Set term is there) before Notes is
    // asserted absent.
    await expect(drawer.getByRole("term").filter({ hasText: /^Set$/ })).toBeVisible();
    await expect(drawer.getByRole("term").filter({ hasText: /^Notes$/ })).toHaveCount(0);
    await closeCollectorDetail();

    // --- Clean up: nobody owns it, so the card goes ---------------------------
    await drillToCustom(page, build);
    await deleteCardButton(page, number).click();
    await confirmDeleteCardButton(page, number).click();
    await expect(editCardButton(page, number)).toBeHidden();
    await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible();
  },
);
