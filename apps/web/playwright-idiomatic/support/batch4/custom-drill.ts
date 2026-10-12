/**
 * Hand-made (custom) set helpers for batch 4. Specs:
 *   .maestro/flows/set-selector/util-drill-to-custom.yaml
 *   .maestro/flows/set-selector/util-drill-to-custom-set.yaml
 *   .maestro/flows/set-selector/util-add-custom-card.yaml
 *
 * A custom row is made through the column's "+ Custom" form: type a name,
 * Enter, then (usually) confirm with "Create <level>". If the name already
 * exists in the column the form selects it and closes without a confirm, so
 * the confirm is only ONE of two outcomes.
 */
import { expect, type Page } from "@playwright/test";
import type { FlowEnv } from "../env";
import {
  columnHeading,
  columnOption,
  columnSearch,
  setBuilderReady,
  type Column,
} from "../set-builder";

/** The confirm button's name per column ("Create <level>", lower-cased). */
const CONFIRM: Record<Column, string> = {
  Sports: "Create sport",
  Years: "Create year",
  Manufacturers: "Create manufacturer",
  Sets: "Create set",
  "Variant Types": "Create variant type",
  Inserts: "Create insert",
  Parallels: "Create insert",
};

/** Create `name` through a column's "+ Custom" form and wait for the form to close. */
export async function addCustomEntry(page: Page, column: Column, name: string): Promise<void> {
  await page.getByRole("button", { name: `Add custom ${column}` }).click();
  const heading = page.getByText("Add Custom Entry");
  await expect(heading).toBeVisible();
  const value = page.getByPlaceholder("Enter custom value...");
  await value.fill(name);
  await value.press("Enter");
  // Two outcomes: a confirm to press, or the name already existed and the
  // form closed by itself.
  const confirm = page.getByRole("button", { name: CONFIRM[column], exact: true });
  await Promise.race([
    confirm.waitFor({ state: "visible" }),
    heading.waitFor({ state: "hidden" }),
  ]);
  if (await confirm.isVisible()) await confirm.click();
  await expect(heading).toBeHidden();
}

/** Pick `name` in a searchable column, creating it through "+ Custom" when it is not there. */
export async function selectOrCreate(page: Page, column: Column, name: string): Promise<void> {
  const search = columnSearch(page, column);
  await search.fill(name);
  const option = columnOption(page, column, name);
  await expect(option.or(page.getByText("No matches found"))).toBeVisible();
  if (!(await option.isVisible())) {
    await addCustomEntry(page, column, name);
    await search.fill(name);
  }
  await option.click();
}

export interface CustomTarget {
  sport?: string;
  year?: string;
  manufacturer?: string;
  setName?: string;
  /** "Insert" or "Parallel": the variant type opened under the set. */
  variantType?: string;
  /** An insert (or parallel) row created and opened under the variant type. */
  variant?: string;
}

/** The per-worker custom sport every custom flow lives under. */
export function customSport(env: FlowEnv): string {
  return `E2E Test Sport ${env.WORKER_INDEX}`;
}

/**
 * util-drill-to-custom.yaml: drill the EntitySelector to the deepest level
 * given, creating each hand-made row that does not exist yet. Starts from a
 * fresh /set-selector load.
 */
export async function drillToCustom(page: Page, target: CustomTarget): Promise<void> {
  const { sport, year, manufacturer, setName, variantType, variant } = target;
  await page.goto("/set-selector");
  await expect(setBuilderReady(page)).toBeVisible({ timeout: 20_000 });
  await expect(columnHeading(page, "Sports")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Baseball", { exact: true })).toBeVisible({ timeout: 60_000 });

  if (!sport) return;
  await selectOrCreate(page, "Sports", sport);
  await expect(columnHeading(page, "Years")).toBeVisible({ timeout: 60_000 });

  if (!year) return;
  await selectOrCreate(page, "Years", year);
  await expect(columnHeading(page, "Manufacturers")).toBeVisible({ timeout: 20_000 });

  if (!manufacturer) return;
  await selectOrCreate(page, "Manufacturers", manufacturer);
  await expect(columnHeading(page, "Sets")).toBeVisible({ timeout: 20_000 });

  if (!setName) return;
  await selectOrCreate(page, "Sets", setName);
  await expect(columnHeading(page, "Variant Types")).toBeVisible({ timeout: 30_000 });

  if (!variantType) return;
  const typeOption = columnOption(page, "Variant Types", variantType);
  if (!(await typeOption.isVisible())) await addCustomEntry(page, "Variant Types", variantType);
  await typeOption.click();
  await expect(page.getByText("An error occurred. Please refresh the page.")).toBeHidden();
  const level = `${variantType}s` as Column;
  await expect(columnHeading(page, level)).toBeVisible({ timeout: 15_000 });

  if (!variant) return;
  const variantOption = columnOption(page, level, variant);
  if (!(await variantOption.isVisible())) await addCustomEntry(page, level, variant);
  await variantOption.click();
  await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible();
}

/** util-drill-to-custom-set.yaml: the per-worker custom sport / 2026 / Topps / <setName>. */
export async function drillToCustomSet(
  page: Page,
  env: FlowEnv,
  { setName, variantType = "Insert" }: { setName: string; variantType?: string },
): Promise<void> {
  await drillToCustom(page, {
    sport: customSport(env),
    year: "2026",
    manufacturer: "Topps",
    setName,
    variantType,
  });
}

/**
 * util-add-custom-card.yaml: drill to the custom set, make sure the insert
 * exists and is open, add one card. Leaves the new card's "Edit card" control
 * on screen.
 */
export async function addCustomCard(
  page: Page,
  env: FlowEnv,
  opts: {
    setName: string;
    variantType?: string;
    insertName?: string;
    cardNumber: string;
    playerName: string;
    cardName?: string;
  },
): Promise<void> {
  const { setName, variantType = "Insert", insertName = "Base", cardNumber, playerName, cardName } = opts;
  await drillToCustom(page, {
    sport: customSport(env),
    year: "2026",
    manufacturer: "Topps",
    setName,
    variantType,
    variant: insertName,
  });
  await addCardViaForm(page, { cardNumber, playerName, cardName });
}

/**
 * Open the checklist's add-card form, fill it and submit. `beforeSubmit` runs
 * with the form open (e.g. to pick a team). Waits for the new card's row.
 */
export async function addCardViaForm(
  page: Page,
  opts: {
    cardNumber: string;
    playerName: string;
    cardName?: string;
    beforeSubmit?: () => Promise<void>;
  },
): Promise<void> {
  const { cardNumber, playerName, cardName, beforeSubmit } = opts;
  await page.getByRole("button", { name: "Open add card form" }).click();
  const name = page.getByRole("textbox", { name: "Card name", exact: true });
  await expect(name).toBeVisible({ timeout: 15_000 });
  await page.getByRole("textbox", { name: "Card number", exact: true }).fill(cardNumber);
  // The add form's one name field is labelled "Card name" and placeholdered
  // "Player name": the flow's player name lands in it, and an explicit card
  // name replaces it.
  await name.fill(cardName ?? playerName);
  if (beforeSubmit) await beforeSubmit();
  await page.getByRole("button", { name: "Submit new card" }).click();
  await expect(name).toBeHidden();
  await expect(
    page.getByRole("button", { name: new RegExp(`^Edit card ${cardNumber}(, .*)?$`) }),
  ).toBeVisible();
}
