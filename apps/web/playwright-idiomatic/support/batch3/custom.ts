/**
 * Batch 3 helpers: the "custom hierarchy" drills the set-selector flows share.
 * Specs: .maestro/flows/set-selector/util-drill-to-custom.yaml,
 * util-drill-to-custom-set.yaml and util-add-custom-card.yaml.
 *
 * Every level is create-or-select and idempotent: search for the name; if a
 * row answers, pick it, otherwise add it through the column's "+ Custom" form.
 */
import { expect, type Page } from "@playwright/test";
import type { FlowEnv } from "../env";
import { columnHeading, columnOption, columnSearch, setBuilderReady, type Column } from "../set-builder";

/** The "Create <thing>" confirm button's noun, per column. */
const NOUN: Record<Column, string> = {
  Sports: "sport",
  Years: "year",
  Manufacturers: "manufacturer",
  Sets: "set",
  "Variant Types": "variant type",
  Inserts: "insert",
  Parallels: "parallel",
};

/** Create a row through the open column's "+ Custom" form. */
export async function addCustomEntry(page: Page, column: Column, name: string): Promise<void> {
  await page.getByRole("button", { name: `Add custom ${column}` }).click();
  await expect(page.getByText("Add Custom Entry")).toBeVisible();
  const value = page.getByPlaceholder("Enter custom value...");
  await value.fill(name);
  await value.press("Enter");
  // A new name asks for one confirm; the Create button is named for the thing.
  await page.getByRole("button", { name: new RegExp(`^Create ${NOUN[column]}`) }).click();
  await expect(page.getByText("Add Custom Entry")).toBeHidden();
}

/** Search the column for `name`; select it when listed, create it when not. */
export async function selectOrCreate(page: Page, column: Column, name: string): Promise<void> {
  await columnSearch(page, column).fill(name);
  const option = columnOption(page, column, name);
  // The column has settled when it lists the row or says nothing matches.
  await expect(option.or(page.getByText("No matches found"))).toBeVisible();
  if (!(await option.isVisible())) {
    await addCustomEntry(page, column, name);
    await columnSearch(page, column).fill(name);
  }
  await option.click();
}

export interface CustomTarget {
  /** Defaults to this worker's "E2E Test Sport <n>" when a deeper level is asked for. */
  sport?: string;
  year?: string;
  manufacturer?: string;
  set?: string;
  variantType?: string;
  /** The entry inside the variant type's column (e.g. an Insert named "Base"). */
  variant?: string;
}

/** The variant type's own column title: "Insert" -> "Inserts". */
function variantColumn(variantType: string): Column {
  return `${variantType}s` as Column;
}

/**
 * util-drill-to-custom.yaml: drill the cascade to the deepest level given,
 * creating any level that is missing (idempotent). Stops at the first level
 * left undefined.
 */
export async function drillToCustom(page: Page, target: CustomTarget): Promise<void> {
  const { sport, year, manufacturer, set, variantType, variant } = target;

  await page.goto("/set-selector");
  await expect(setBuilderReady(page)).toBeVisible({ timeout: 20_000 });
  await expect(columnSearch(page, "Sports")).toBeVisible({ timeout: 30_000 });
  if (!sport) return;

  await selectOrCreate(page, "Sports", sport);
  await expect(columnHeading(page, "Years")).toBeVisible({ timeout: 60_000 });
  if (!year) return;

  await selectOrCreate(page, "Years", year);
  await expect(columnHeading(page, "Manufacturers")).toBeVisible({ timeout: 20_000 });
  if (!manufacturer) return;

  await selectOrCreate(page, "Manufacturers", manufacturer);
  await expect(columnHeading(page, "Sets")).toBeVisible({ timeout: 20_000 });
  if (!set) return;

  await selectOrCreate(page, "Sets", set);
  await expect(columnHeading(page, "Variant Types")).toBeVisible({ timeout: 30_000 });
  if (!variantType) return;

  await selectOrCreate(page, "Variant Types", variantType);
  await expect(page.getByText("An error occurred. Please refresh the page.")).toBeHidden();
  await expect(columnHeading(page, variantColumn(variantType))).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: `Add custom ${variantColumn(variantType)}` })).toBeVisible();
  if (!variant) return;

  await selectOrCreate(page, variantColumn(variantType), variant);
  await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible();
}

/**
 * util-drill-to-custom-set.yaml: E2E Test Sport <n> -> 2026 -> Topps -> <set>
 * -> <variant type>, leaving that type's column open.
 */
export async function drillToCustomSet(
  page: Page,
  env: FlowEnv,
  target: { set: string; variantType?: string },
): Promise<void> {
  await drillToCustom(page, {
    sport: `E2E Test Sport ${env.WORKER_INDEX}`,
    year: "2026",
    manufacturer: "Topps",
    set: target.set,
    variantType: target.variantType ?? "Insert",
  });
}

export interface CustomCard {
  set: string;
  variantType?: string;
  /** The entry added (idempotently) to the variant type's column and opened. */
  insertName?: string;
  cardNumber: string;
  /** What the flow types into the name field. */
  playerName: string;
  /** Overrides the name field after the player name, when the flow sets one. */
  cardName?: string;
}

/**
 * util-add-custom-card.yaml: drill to the per-worker custom set, make sure the
 * insert entry exists and open it, then add one card through the add form.
 * Leaves the new card's row on the page.
 */
export async function addCustomCard(page: Page, env: FlowEnv, card: CustomCard): Promise<void> {
  const { set, variantType = "Insert", insertName = "Base", cardNumber, playerName, cardName } = card;
  await drillToCustomSet(page, env, { set, variantType });
  await selectOrCreate(page, variantColumn(variantType), insertName);

  await page.getByRole("button", { name: "Open add card form" }).click();
  await page.getByRole("textbox", { name: "Card number" }).fill(cardNumber);
  // The card's name field is where the flow types the player's name.
  await page.getByRole("textbox", { name: "Card name" }).fill(cardName ?? playerName);
  await page.getByRole("button", { name: "Submit new card" }).click();
  await expect(page.getByRole("textbox", { name: "Card number" })).toBeHidden();
  await expect(page.getByRole("button", { name: new RegExp(`^Edit card ${cardNumber}(, .*)?$`) })).toBeVisible();
}
