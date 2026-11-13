// NEO-527 (R1): a collector never sees a year's brand-unknown row (Jason,
// 2026-11-12: "a user should never see unknown outside of the admin screen").
// A card whose set sits under that row is named without it, and the set is
// reached without it:
//   * the dashboard's Fresh Pulls tile is named by the card's listing title,
//     "1995 <set> ... #<number>", never "1995 Unknown <set> ...";
//   * the card's panel, opened from that tile, gives its Set as "1995 <set>";
//   * the Checklists drill lists the set itself in the year's brand column, in
//     the row's place (no "Unknown" option), and picking it goes straight on to
//     its Variant Types: there is no Sets column between. Back returns to the
//     brand column with the set offered again (navigation lives in the URL).
// The admin set builder still shows the row: that is where this spec puts the
// set, by picking "Unknown" in the Manufacturers column.
//
// FIXTURE (SET-REGISTRY.md, custom-set prefix `nbu`): ONE hand-made set per
// attempt, `nbu<token>`, under the REAL Hockey > 1995 > Unknown, with `Insert` >
// `Base` and ONE hand-added card `527<token>` (card name `Nbu<token>`, no player,
// no marketplace id anywhere beneath it). The brand-unknown row only exists on a
// year a year-wide Sets sync has filed, so the spec first drills Hockey > 1995
// through the pinned All Brands view (the same cold sync the 1995 wizard
// fixtures pay; concurrent visits are harmless, see `drillToColdManufacturer`),
// then asserts the `Unknown` row is listed BEFORE drilling to it by name, so a
// hand-made "Unknown" brand can never be made in its place (`selectOrCreate`
// would make one). Hockey 1995 because no other spec drills it in the
// collection, and its brand column already holds only the Unknown row's sets
// (the wizard fixtures commit there): this set changes no other spec's column.
//
// R7/R7a: writes only its own set, its card and the worker account's own copy;
// self-cleaning: the copy is removed through the drawer and the card deleted
// through the set builder, so the set is empty again and hidden from every
// collector (the set and its rows stand). Single-token minted names (GUIDE).
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { columnOption, drillToColdManufacturer, drillToCustom, setBuilderReady } from "../../support/set-builder";
import { addCardViaForm, confirmDeleteCardButton, deleteCardButton, editCardButton, escapeRe } from "../../support/cards";

const SPORT = "Hockey";
const YEAR = "1995";

/**
 * The collector's brand column, by its title. NEVER "Brands" alone once it
 * lists a set: "Sets" when every entry is one (Hockey 1995 today), "Brands and
 * sets" when real brands sit above the loose sets. Kept in this one place so
 * the wording is a one-line update.
 */
const BRAND_COLUMN = /^(Sets|Brands and sets)$/;

/** The brand column's summary once a loose set in it is picked: "Sets: <name>, change". */
function pickedInBrandColumn(set: string): string {
  return `Sets: ${set}, change`;
}

test(
  "A collector never sees the brand-unknown row: a card under it is titled and labelled by its set alone, and the Checklists drill lists that set in the brand column and goes straight to its variant types",
  { tag: ["@collection"] },
  async ({ page, signIn, env }) => {
    const setName = `nbu${env.ATTEMPT_TOKEN}`;
    const number = `527${env.ATTEMPT_TOKEN}`;
    const cardName = `Nbu${env.ATTEMPT_TOKEN}`;
    const short = `#${number}`;

    // --- The year's Unknown row exists: a year-wide Sets sync filed it ---------
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await drillToColdManufacturer(page, env, { sport: SPORT, year: YEAR, manufacturer: "All Brands", expectSets: true });
    await drillToCustom(page, { sport: SPORT, year: YEAR });
    // The admin screen still shows the row; this is the precondition the
    // create below depends on (never let selectOrCreate hand-make "Unknown").
    await expect(columnOption(page, "Manufacturers", "Unknown")).toBeVisible();

    // --- A set of our own under it, with one card ------------------------------
    const build = { sport: SPORT, year: YEAR, manufacturer: "Unknown", set: setName, variantType: "Insert", variant: "Base" };
    await drillToCustom(page, build);
    await addCardViaForm(page, { cardNumber: number, playerName: cardName });

    // --- The collector's Checklists drill ---------------------------------------
    const cascade = page.getByRole("group", { name: "Sport, year, brand and set" });
    const option = (column: string | RegExp, name: string) =>
      cascade.getByRole("listbox", { name: column }).getByRole("option").filter({ has: page.getByText(name, { exact: true }) });
    const brandColumn = cascade.getByRole("listbox", { name: BRAND_COLUMN });
    const setInBrands = brandColumn.getByRole("option").filter({ has: page.getByText(setName, { exact: true }) });

    await page.goto("/collection?tab=checklists");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
    await option("Sports", SPORT).click();
    await expect(cascade.getByRole("button", { name: `Sports: ${SPORT}, change` })).toBeVisible();
    await option("Years", YEAR).click();
    await expect(cascade.getByRole("button", { name: `Years: ${YEAR}, change` })).toBeVisible();

    // The set is listed in the year's brand column, and the row it sits under is not.
    await brandColumn.scrollIntoViewIfNeeded();
    await expect(setInBrands).toBeVisible();
    await expect(cascade.getByRole("option").filter({ has: page.getByText("Unknown", { exact: true }) })).toHaveCount(0);
    await expectAccessible(page, { label: "Checklists, a year's brand column listing a set in the Unknown row's place" });

    // Picking it goes straight on to its Variant Types: no Sets column between.
    await setInBrands.click();
    await expect(cascade.getByRole("button", { name: pickedInBrandColumn(setName), exact: true })).toBeVisible();
    const types = cascade.getByRole("listbox", { name: "Variant Types" });
    await types.scrollIntoViewIfNeeded();
    await expect(types).toBeInViewport();
    await expect(cascade.getByRole("listbox", { name: "Sets", exact: true })).toHaveCount(0);

    // Back steps to the brand column, the set offered again.
    await page.goBack();
    await expect(setInBrands).toBeVisible();
    await expect(types).toBeHidden();

    // --- The collector marks the card Have ---------------------------------------
    await setInBrands.click();
    await option("Variant Types", "Insert").click();
    await option("Insert", "Base").click();
    const checklist = page.getByRole("region", { name: `${YEAR} ${setName} Base`, exact: true });
    const haveOff = checklist.getByRole("button", { name: `Have ${short}`, exact: true, pressed: false });
    await expect(haveOff).toBeVisible();
    await checklist.getByRole("combobox", { name: "Binder" }).selectOption({ label: "Main" });
    await haveOff.click();
    await expect(checklist.getByRole("button", { name: `Have ${short}, Raw, Excellent`, exact: true, pressed: true })).toBeVisible();
    // The toggle flips optimistically; the notice is the server's answer.
    await expect(page.getByRole("status").filter({ hasText: `Added ${short} to Main` })).toBeVisible();

    // --- The dashboard names the card by its set alone ----------------------------
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { level: 1, name: "Welcome back, slugger." })).toBeVisible();
    const pulls = page.getByRole("region", { name: "Fresh Pulls" });
    // The tile is a link named by the card's full listing title.
    const tile = pulls.getByRole("link", { name: new RegExp(`^${YEAR} ${escapeRe(setName)}\\b.*${escapeRe(short)}\\b`) });
    await expect(tile).toBeVisible();
    await expect(pulls.getByRole("link", { name: new RegExp(`\\bUnknown ${escapeRe(setName)}\\b`) })).toHaveCount(0);

    // Its panel gives the set by its own name.
    await tile.click();
    const drawer = page.getByRole("dialog", { name: new RegExp(`^${YEAR} ${escapeRe(setName)}\\b.*${escapeRe(short)}\\b`) });
    await expect(drawer).toBeVisible();
    // (The card face prints the same words; the panel's Set line is its definition.)
    await expect(drawer.getByRole("definition").filter({ hasText: new RegExp(`^${YEAR} ${escapeRe(setName)}$`) })).toBeVisible();
    await expect(drawer.getByText(/\bUnknown\b/)).toHaveCount(0);
    await page.goBack();
    await expect(drawer).toBeHidden();
    await expect(tile).toBeVisible();

    // --- Clean up: the copy goes, then the card ---------------------------------
    await tile.click();
    const yourCopies = drawer.getByRole("region", { name: `Your copies of ${short}` });
    await yourCopies.getByRole("button", { name: `Remove ${short}, Raw, Excellent`, exact: true }).click();
    // "Removed ..." is the server's answer; the card can only be deleted once it has landed.
    await expect(drawer.getByRole("status").filter({ hasText: `Removed ${short}, Raw, Excellent` })).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();

    await drillToCustom(page, build);
    await deleteCardButton(page, number).click();
    await confirmDeleteCardButton(page, number).click();
    await expect(editCardButton(page, number)).toBeHidden();
    await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible();
  },
);
