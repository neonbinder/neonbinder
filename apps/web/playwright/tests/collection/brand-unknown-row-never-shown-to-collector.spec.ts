// NEO-527 (R1): a collector never sees a year's brand-unknown row (Jason,
// 2026-11-12: "a user should never see unknown outside of the admin screen").
// A card whose set sits under that row is named without it everywhere a
// collector meets it, and the set is reached without it:
//   * Checklists drill, a year whose brand column holds ONLY such sets (Hockey
//     1995): the column is titled "Sets", lists the set itself, no "Unknown"
//     option; picking it collapses to "Sets: <set>, change" and goes straight
//     on to its Variant Types (no Sets column between); Back returns to the
//     column (navigation lives in the URL). The checklist reached that way, its
//     heading and the "Added ... to Main" notice name the set alone.
//   * Checklists search: the set's suggestion is "Open the 1995 <set>
//     checklist", the card's hit reads "1995 <set> ...", and "Unknown <set>"
//     finds no card (the row's name is no part of a card's title).
//   * Add cards' set pick (the same cascade) and Request a card: the brand
//     field is a "Set" field listing the set, with no Set field after it; the
//     request's Checklist field follows the pick.
//   * Start building a set: the browsed set's where-line is "Hockey" alone.
//   * A smart binder whose rule is the set: Find cards says the rule as "1995
//     <set>" (the server's rule names).
//   * Dashboard: the Fresh Pulls tile is named by the card's listing title,
//     "1995 <set> ... #<number>"; the card's panel gives its Set as "1995 <set>".
//   * Checklists drill, a MIXED year (Baseball 1996: a real brand holding a
//     carded set, and a carded set under the brand-unknown row): the column is
//     titled "Brands and sets", the brand comes first, the loose set sits in a
//     group "More sets" that holds no brand, nothing reads "Unknown", and the
//     loose set opens as in the first year. Request a card calls the field
//     "Brand or set" there; picking the loose set in it takes the Set field
//     away and says so: "Set picked: <set>. On to the checklist."
// The admin set builder still shows the row: that is where the spec puts its
// sets, by picking "Unknown" in the Manufacturers column.
//
// FIXTURES (SET-REGISTRY.md, custom-set prefixes `nbu`, `nbb`, `nbl`), each a
// hand-made set per attempt with `Insert` > `Base` and ONE hand-added card (no
// player, no marketplace id anywhere beneath it):
//   `nbu<token>` (card `527<token>`) under the REAL Hockey > 1995 > Unknown;
//   `nbb<token>` (card `528<token>`) under the REAL Baseball > 1996 > Topps;
//   `nbl<token>` (card `529<token>`) under the REAL Baseball > 1996 > Unknown.
// A brand-unknown row only exists on a year a year-wide Sets sync has filed,
// so each year is first drilled through the pinned All Brands view (the cold
// sync its registered fixtures already pay; concurrent visits are harmless, see
// `drillToColdManufacturer`), and the admin column is asserted to list the
// rows by name BEFORE `drillToCustom` goes to them, so `selectOrCreate` can
// never hand-make a fake "Unknown" (or a second "Topps") in their place. Both
// years are drilled in the collection by no other spec, so these sets change
// no other spec's brand column (support/collection.ts, BRAND_COLUMN_TITLE).
//
// R7/R7a: writes only its own sets, their cards and the worker account's own
// copy and binder. Self-cleaning: the binder is deleted, the copy removed
// through the drawer and the three cards deleted through the set builder, so
// the sets are empty again and hidden from every collector (the sets and
// their rows stand). Single-token minted names (GUIDE).
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { columnOption, drillToColdManufacturer, drillToCustom, setBuilderReady } from "../../support/set-builder";
import { addCardViaForm, confirmDeleteCardButton, deleteCardButton, editCardButton, escapeRe } from "../../support/cards";
import { confirmRemoved } from "../../support/collection";
import type { Locator, Page } from "@playwright/test";

/** Every row of this year's collector brand column is a loose set. */
const LOOSE = { sport: "Hockey", year: "1995" };
/** This year's collector brand column holds a brand AND a loose set. */
const MIXED = { sport: "Baseball", year: "1996", brand: "Topps" };

/**
 * The brand column's title, one exact value per year (`brandColumnTitle`,
 * app/collection/final/catalog/drill.ts): "Sets" when every row is a loose set,
 * "Brands and sets" when brands sit above them. Never "Brands" once it lists a
 * set. Kept here so the wording is a one-line update.
 */
const TITLE = { loose: "Sets", mixed: "Brands and sets" } as const;
/** The label over the loose sets in a mixed column (`LOOSE_SETS_LABEL`). */
const MORE_SETS = "More sets";

/** The brand column's summary once a loose set in it is picked (`brandColumnPickTitle`). */
function pickedLooseSet(set: string): string {
  return `Sets: ${set}, change`;
}

/** An option of `list` by its own visible text. */
function optionIn(page: Page, list: Locator, name: string): Locator {
  return list.getByRole("option").filter({ has: page.getByText(name, { exact: true }) });
}

test(
  "A collector never sees the brand-unknown row: a card under it is titled and labelled by its set alone, and the Checklists drill lists that set in the brand column and goes straight to its variant types",
  { tag: ["@collection"] },
  async ({ page, signIn, env }) => {
    const T = env.ATTEMPT_TOKEN;
    const setName = `nbu${T}`;
    const number = `527${T}`;
    const short = `#${number}`;
    const brandSet = `nbb${T}`;
    const looseSet = `nbl${T}`;
    const looseBuild = { sport: LOOSE.sport, year: LOOSE.year, manufacturer: "Unknown", set: setName, variantType: "Insert", variant: "Base" };
    const mixedBrandBuild = { sport: MIXED.sport, year: MIXED.year, manufacturer: MIXED.brand, set: brandSet, variantType: "Insert", variant: "Base" };
    const mixedLooseBuild = { sport: MIXED.sport, year: MIXED.year, manufacturer: "Unknown", set: looseSet, variantType: "Insert", variant: "Base" };

    // --- Admin: the years' rows exist (a year-wide Sets sync filed them) ------
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    for (const year of [LOOSE, MIXED]) {
      await drillToColdManufacturer(page, env, { sport: year.sport, year: year.year, manufacturer: "All Brands", expectSets: true });
      await drillToCustom(page, { sport: year.sport, year: year.year });
      // The admin screen still shows the row; the creates below depend on it.
      await expect(columnOption(page, "Manufacturers", "Unknown")).toBeVisible();
    }
    await expect(columnOption(page, "Manufacturers", MIXED.brand)).toBeVisible();

    // --- Admin: our sets, one card each ---------------------------------------
    await drillToCustom(page, looseBuild);
    await addCardViaForm(page, { cardNumber: number, playerName: `Nbu${T}` });
    await drillToCustom(page, mixedBrandBuild);
    await addCardViaForm(page, { cardNumber: `528${T}`, playerName: `Nbb${T}` });
    await drillToCustom(page, mixedLooseBuild);
    await addCardViaForm(page, { cardNumber: `529${T}`, playerName: `Nbl${T}` });

    // === Checklists drill, a year of loose sets only =============================
    const cascade = page.getByRole("group", { name: "Sport, year, brand and set" });
    const pickIn = async (column: string, name: string) => {
      await optionIn(page, cascade.getByRole("listbox", { name: column }), name).click();
      await expect(cascade.getByRole("button", { name: `${column}: ${name}, change` })).toBeVisible();
    };
    const toChecklists = async () => {
      await page.goto("/collection?tab=checklists");
      await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
    };
    const looseColumn = cascade.getByRole("listbox", { name: TITLE.loose, exact: true });
    const setInBrands = optionIn(page, looseColumn, setName);

    await toChecklists();
    await pickIn("Sports", LOOSE.sport);
    await pickIn("Years", LOOSE.year);
    await looseColumn.scrollIntoViewIfNeeded();
    await expect(setInBrands).toBeVisible();
    await expect(cascade.getByRole("option").filter({ has: page.getByText("Unknown", { exact: true }) })).toHaveCount(0);
    await expectAccessible(page, { label: "Checklists, a year's brand column of loose sets" });

    // Picking it goes straight on to its Variant Types: no Sets column between.
    await setInBrands.click();
    await expect(cascade.getByRole("button", { name: pickedLooseSet(setName), exact: true })).toBeVisible();
    const types = cascade.getByRole("listbox", { name: "Variant Types" });
    await types.scrollIntoViewIfNeeded();
    await expect(types).toBeInViewport();
    await expect(cascade.getByRole("listbox", { name: "Sets", exact: true })).toHaveCount(0);

    // Back steps to the brand column, the set offered again.
    await page.goBack();
    await expect(setInBrands).toBeVisible();
    await expect(types).toBeHidden();

    // The checklist reached through the loose set, and the collector's Have.
    await setInBrands.click();
    await pickIn("Variant Types", "Insert");
    await pickIn("Insert", "Base");
    const checklist = page.getByRole("region", { name: `${LOOSE.year} ${setName} Base`, exact: true });
    await expect(checklist.getByRole("heading", { level: 3, name: `${LOOSE.year} ${setName} Base`, exact: true })).toBeVisible();
    const haveOff = checklist.getByRole("button", { name: `Have ${short}`, exact: true, pressed: false });
    await expect(haveOff).toBeVisible();
    await expectAccessible(page, { label: "Checklists, a checklist reached through a loose set" });
    await checklist.getByRole("combobox", { name: "Binder" }).selectOption({ label: "Main" });
    await haveOff.click();
    await expect(checklist.getByRole("button", { name: `Have ${short}, Raw, Excellent`, exact: true, pressed: true })).toBeVisible();
    // The toggle flips optimistically; the notice is the server's answer.
    const added = page.getByRole("status").filter({ hasText: `Added ${short} to Main` });
    await expect(added).toBeVisible();
    await expect(added).not.toContainText("Unknown");

    // === Checklists search ==========================================================
    const quick = page.getByRole("region", { name: "Quick search" });
    const searchBox = page.getByRole("searchbox", { name: "Search every card" });
    const openSet = quick.getByRole("button", { name: `Open the ${LOOSE.year} ${setName} checklist`, exact: true });
    await searchBox.fill(setName);
    await expect(openSet).toBeVisible();
    // The card's hit is named by its set alone, and so is its caption.
    const hit = quick.getByRole("button", {
      name: new RegExp(`^Details for ${LOOSE.year} ${escapeRe(setName)}\\b.*${escapeRe(short)}\\b`),
    });
    await expect(hit).toBeVisible();
    await expect(quick.getByText(new RegExp(`^${LOOSE.year} ${escapeRe(setName)}\\b`)).first()).toBeVisible();
    await expect(quick).not.toContainText("Unknown");
    // The row's name is no part of the card's title: "Unknown <set>" finds no card.
    await searchBox.fill(`Unknown ${setName}`);
    await expect(quick.getByText("Not in the catalog yet.", { exact: true })).toBeVisible();
    await expect(hit).toHaveCount(0);
    await searchBox.fill("");

    // === Request a card: the brand field is a Set field here ==========================
    await page.getByRole("button", { name: "Request a card", exact: true }).click();
    const requestDialog = page.getByRole("dialog", { name: "Can't find it?" });
    const form = requestDialog.getByRole("form", { name: "Request a card" });
    await form.getByRole("combobox", { name: "Sport", exact: true }).selectOption({ label: LOOSE.sport });
    await form.getByRole("combobox", { name: "Year", exact: true }).selectOption({ label: LOOSE.year });
    const setField = form.getByRole("combobox", { name: "Set", exact: true });
    await expect(setField).toHaveCount(1);
    await expect(form.getByRole("combobox", { name: /^Brand/ })).toHaveCount(0);
    await setField.selectOption({ label: setName });
    await expect(form.getByRole("combobox", { name: "Checklist", exact: true })).toBeVisible();
    await expect(setField).toHaveCount(1);
    await expect(requestDialog).not.toContainText("Unknown");
    await expectAccessible(page, { within: requestDialog, label: "Request a card, a year of loose sets" });
    await page.keyboard.press("Escape");
    await expect(requestDialog).toBeHidden();

    // === Add cards' set pick: the same cascade, the same column =========================
    await page.goto("/collection?tab=add");
    await page.getByRole("button", { name: /^Set: / }).click();
    const intake = page.getByRole("group", { name: "Sport, year, brand, set and variant" });
    const pickInIntake = async (column: string, name: string) => {
      await optionIn(page, intake.getByRole("listbox", { name: column }), name).click();
      await expect(intake.getByRole("button", { name: `${column}: ${name}, change` })).toBeVisible();
    };
    await pickInIntake("Sports", LOOSE.sport);
    await pickInIntake("Years", LOOSE.year);
    await optionIn(page, intake.getByRole("listbox", { name: TITLE.loose, exact: true }), setName).click();
    await expect(intake.getByRole("button", { name: pickedLooseSet(setName), exact: true })).toBeVisible();
    await pickInIntake("Variant Types", "Insert");
    await optionIn(page, intake.getByRole("listbox", { name: "Insert" }), "Base").click();
    await expect(page.getByRole("button", { name: `Set: ${LOOSE.year} ${setName} Base`, exact: true })).toBeVisible();

    // === Start building a set: the where-line is the sport alone ========================
    await page.goto("/collection?tab=cards");
    await page.getByRole("button", { name: /^Start building a set/ }).click();
    const picker = page.getByRole("dialog", { name: "Start building a set" });
    await picker.getByRole("combobox", { name: "Sport", exact: true }).selectOption({ label: LOOSE.sport });
    await picker.getByRole("combobox", { name: "Year", exact: true }).selectOption({ label: LOOSE.year });
    await picker.getByRole("combobox", { name: "Set", exact: true }).selectOption({ label: setName });
    const browsed = picker.getByRole("listitem").filter({ has: page.getByText(`${LOOSE.year} ${setName}`, { exact: true }) });
    await expect(browsed.getByText(LOOSE.sport, { exact: true })).toBeVisible();
    await expect(picker).not.toContainText("Unknown");
    await expectAccessible(page, { within: picker, label: "Start building a set, a loose set browsed" });
    await picker.getByRole("button", { name: "Done", exact: true }).click();
    await expect(picker).toBeHidden();

    // === A smart binder whose rule is the set =======================================
    const binder = `Nbu${T}Binder`;
    await page.goto("/collection?tab=binders");
    const shelf = page.getByRole("list", { name: "Your binders" });
    await shelf.getByRole("button", { name: "New binder", exact: true }).click();
    const newDialog = page.getByRole("dialog", { name: "New binder", exact: true });
    await newDialog.getByRole("textbox", { name: "Binder name" }).fill(binder);
    await newDialog.getByRole("radio", { name: /^Smart: a rule helps fill it/ }).check();
    await newDialog.getByRole("combobox", { name: "Line 1" }).selectOption({ label: "Set" });
    await newDialog.getByRole("combobox", { name: "Sets" }).fill(setName);
    await newDialog.getByRole("option", { name: `${LOOSE.year} ${setName}`, exact: true }).click();
    await expect(newDialog.getByRole("button", { name: `Remove ${LOOSE.year} ${setName}` })).toBeVisible();
    await newDialog.getByRole("button", { name: "Put it on the shelf" }).click();
    await expect(newDialog).toBeHidden();
    // Find cards opens by itself and says the rule by the server's names for it.
    const find = page.getByRole("dialog", { name: `Find cards for ${binder}`, exact: true });
    await expect(find.getByText(`Cards you already have that fit: ${LOOSE.year} ${setName}.`, { exact: true })).toBeVisible();
    // The copy in Main fits, and is offered by its set alone.
    await expect(
      find.getByRole("button", { name: new RegExp(`^Add ${LOOSE.year} ${escapeRe(setName)}\\b.*${escapeRe(short)}\\b.* from Main$`) }),
    ).toBeVisible();
    await expect(find).not.toContainText("Unknown");
    await find.getByRole("button", { name: "Done" }).click();
    await expect(find).toBeHidden();
    await expect(page.getByRole("heading", { level: 2, name: binder, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Binder settings", exact: true }).click();
    await page.getByRole("button", { name: `Rename or delete ${binder}`, exact: true }).click();
    await page
      .getByRole("dialog", { name: `Rename or delete ${binder}`, exact: true })
      .getByRole("button", { name: "Delete this binder" })
      .click();
    const confirm = page.getByRole("dialog", { name: `Delete ${binder}?`, exact: true });
    await confirm.getByRole("button", { name: "Yes, delete it" }).click();
    await expect(confirm).toBeHidden();
    await expect(shelf.getByRole("button", { name: new RegExp(`^${escapeRe(binder)},`) })).toHaveCount(0);

    // === Dashboard: the card by its set alone ==========================================
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { level: 1, name: "Welcome back, slugger." })).toBeVisible();
    const pulls = page.getByRole("region", { name: "Fresh Pulls" });
    // The tile is a link named by the card's full listing title.
    const tile = pulls.getByRole("link", { name: new RegExp(`^${LOOSE.year} ${escapeRe(setName)}\\b.*${escapeRe(short)}\\b`) });
    await expect(tile).toBeVisible();
    await expect(pulls.getByRole("link", { name: new RegExp(`\\bUnknown ${escapeRe(setName)}\\b`) })).toHaveCount(0);
    await expectAccessible(page, { label: "Dashboard, Fresh Pulls with a card of a loose set" });

    // Its panel gives the set by its own name.
    await tile.click();
    const drawer = page.getByRole("dialog", { name: new RegExp(`^${LOOSE.year} ${escapeRe(setName)}\\b.*${escapeRe(short)}\\b`) });
    await expect(drawer).toBeVisible();
    // (The card face prints the same words; the panel's Set line is its definition.)
    await expect(drawer.getByRole("definition").filter({ hasText: new RegExp(`^${LOOSE.year} ${escapeRe(setName)}$`) })).toBeVisible();
    await expect(drawer).not.toContainText("Unknown");
    await expectAccessible(page, { within: drawer, label: "Card detail of a loose set's card, from the dashboard" });
    await page.goBack();
    await expect(drawer).toBeHidden();
    await expect(tile).toBeVisible();

    // === Checklists drill, a mixed year ===============================================
    await toChecklists();
    await pickIn("Sports", MIXED.sport);
    await pickIn("Years", MIXED.year);
    const mixedColumn = cascade.getByRole("listbox", { name: TITLE.mixed, exact: true });
    await mixedColumn.scrollIntoViewIfNeeded();
    const brandOption = optionIn(page, mixedColumn, MIXED.brand);
    const looseOption = optionIn(page, mixedColumn, looseSet);
    await expect(brandOption).toBeVisible();
    await expect(looseOption).toBeVisible();
    // Brands first, then the loose sets, under their own label.
    const order = (await mixedColumn.getByRole("option").allInnerTexts()).map((t) => t.split("\n")[0].trim());
    expect(order.indexOf(MIXED.brand), `brand before the loose set in ${JSON.stringify(order)}`).toBeLessThan(order.indexOf(looseSet));
    const more = mixedColumn.getByRole("group", { name: MORE_SETS, exact: true });
    await expect(optionIn(page, more, looseSet)).toBeVisible();
    await expect(optionIn(page, more, MIXED.brand)).toHaveCount(0);
    await expect(cascade).not.toContainText("Unknown");
    await expectAccessible(page, { label: "Checklists, a mixed brand column" });
    await looseOption.click();
    await expect(cascade.getByRole("button", { name: pickedLooseSet(looseSet), exact: true })).toBeVisible();
    await types.scrollIntoViewIfNeeded();
    await expect(types).toBeInViewport();
    await expect(cascade.getByRole("listbox", { name: "Sets", exact: true })).toHaveCount(0);

    // Request a card names the mixed field for both.
    await page.getByRole("button", { name: "Request a card", exact: true }).click();
    await form.getByRole("combobox", { name: "Sport", exact: true }).selectOption({ label: MIXED.sport });
    await form.getByRole("combobox", { name: "Year", exact: true }).selectOption({ label: MIXED.year });
    const brandOrSet = form.getByRole("combobox", { name: "Brand or set", exact: true });
    await expect(brandOrSet).toBeVisible();
    // Picking the loose set there picks the set: the Set field goes, and the
    // form says so (a screen reader would otherwise hear a field vanish).
    await brandOrSet.selectOption({ label: looseSet });
    await expect(form.getByRole("status").filter({ hasText: `Set picked: ${looseSet}. On to the checklist.` })).toBeAttached();
    await expect(form.getByRole("combobox", { name: "Set", exact: true })).toHaveCount(0);
    await expect(form.getByRole("combobox", { name: "Checklist", exact: true })).toBeVisible();
    await expect(requestDialog).not.toContainText("Unknown");
    await page.keyboard.press("Escape");
    await expect(requestDialog).toBeHidden();

    // === Clean up: the copy goes, then the three cards ==================================
    await page.goto("/dashboard");
    await tile.click();
    const yourCopies = drawer.getByRole("region", { name: `Your copies of ${short}` });
    await yourCopies.getByRole("button", { name: `Remove ${short}, Raw, Excellent`, exact: true }).click();
    // "Removed ..." is the server's answer; the card can only be deleted once it has landed.
    await confirmRemoved(drawer);
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();

    for (const [build, card] of [
      [looseBuild, number],
      [mixedBrandBuild, `528${T}`],
      [mixedLooseBuild, `529${T}`],
    ] as const) {
      await drillToCustom(page, build);
      await deleteCardButton(page, card).click();
      await confirmDeleteCardButton(page, card).click();
      await expect(editCardButton(page, card)).toBeHidden();
      await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible();
    }
  },
);
