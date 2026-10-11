/**
 * Per-worker CUSTOM subtree helpers (batch 6). Specs:
 *   .maestro/flows/set-selector/util-drill-to-custom.yaml      -> drillToCustom
 *   .maestro/flows/set-selector/util-drill-to-custom-set.yaml  -> drillToCustomSet
 *   .maestro/flows/set-selector/util-add-custom-card.yaml      -> addCustomCard
 *
 * Every level is "select it, or create it through + Custom first": the
 * subtree belongs to the worker's account, so on a clean account the rows do
 * not exist yet and on a re-run they do.
 */
import { expect, type Page } from "@playwright/test";
import type { FlowEnv } from "../../../playwright/support/env";
import {
  columnHeading,
  columnOption,
  columnSearch,
  setBuilderReady,
  type Column,
} from "../set-builder";

/** Create `name` through the column's "+ Custom" form and wait for the form to close. */
export async function createCustom(
  page: Page,
  column: Column,
  singular: string,
  name: string,
): Promise<void> {
  await page.getByRole("button", { name: `Add custom ${column}` }).click();
  const value = page.getByPlaceholder("Enter custom value...");
  await expect(value).toBeVisible();
  await value.fill(name);
  await value.press("Enter");
  // Two outcomes (util-drill-to-custom's "when visible Create ..."): a confirm
  // to press, or the name already exists, so the form selects it and closes.
  const heading = page.getByRole("heading", { name: "Add Custom Entry" });
  const confirm = page.getByRole("button", { name: `Create ${singular}`, exact: true });
  await Promise.race([
    confirm.waitFor({ state: "visible" }),
    heading.waitFor({ state: "hidden" }),
  ]);
  if (await confirm.isVisible()) await confirm.click();
  await expect(heading).toBeHidden();
}

/**
 * Select `name` in a searchable column, creating it first when the search
 * finds nothing. The app settles into ONE of the two states before we branch.
 */
export async function selectOrCreate(
  page: Page,
  column: Column,
  singular: string,
  name: string,
): Promise<void> {
  await columnSearch(page, column).fill(name);
  const option = columnOption(page, column, name);
  await expect(option.or(page.getByText("No matches found"))).toBeVisible();
  if (!(await option.isVisible())) {
    await createCustom(page, column, singular, name);
    await expect(option).toBeVisible();
  }
  await option.click();
}

/**
 * Same for a short column with no search box (Variant Types, Inserts). The
 * list must have rendered before we decide the row is missing: wait for any
 * row, or the column's own empty message.
 */
export async function selectOrCreateDirect(
  page: Page,
  column: Column,
  singular: string,
  name: string,
): Promise<void> {
  const anyRow = page.getByRole("listbox", { name: column }).getByRole("option").first();
  const empty = page.getByText(`No ${column.toLowerCase()} available`);
  await expect(anyRow.or(empty)).toBeVisible();
  const option = columnOption(page, column, name);
  if (!(await option.isVisible())) {
    await createCustom(page, column, singular, name);
    await expect(option).toBeVisible();
  }
  await option.click();
}

export interface CustomTarget {
  sport?: string;
  year?: string;
  manufacturer?: string;
  setName?: string;
  variantType?: string;
  /** The insert/parallel row under the variant type, e.g. "Base". */
  variant?: string;
}

/** Drill /set-selector to `Sport -> Year -> Manufacturer -> Set` (and a variant type), creating rows as needed. */
export async function drillToCustom(page: Page, target: CustomTarget): Promise<void> {
  await page.goto("/set-selector");
  await expect(setBuilderReady(page)).toBeVisible({ timeout: 20_000 });

  if (target.sport) {
    await selectOrCreate(page, "Sports", "sport", target.sport);
    await expect(columnHeading(page, "Years")).toBeVisible({ timeout: 60_000 });
  }
  if (target.year) {
    await selectOrCreate(page, "Years", "year", target.year);
    await expect(columnHeading(page, "Manufacturers")).toBeVisible();
  }
  if (target.manufacturer) {
    await selectOrCreate(page, "Manufacturers", "manufacturer", target.manufacturer);
    await expect(columnHeading(page, "Sets")).toBeVisible();
  }
  if (target.setName) {
    await selectOrCreate(page, "Sets", "set", target.setName);
    await expect(columnHeading(page, "Variant Types")).toBeVisible();
  }
  if (target.variantType) {
    await selectOrCreateDirect(page, "Variant Types", "variant type", target.variantType);
    await expect(page.getByText("An error occurred. Please refresh the page.")).toBeHidden();
    const column = `${target.variantType}s` as Column;
    await expect(columnHeading(page, column)).toBeVisible();
    if (target.variant) {
      await selectOrCreateDirect(page, column, target.variantType.toLowerCase(), target.variant);
    }
  }
}

/** util-drill-to-custom-set.yaml: E2E Test Sport <worker> -> 2026 -> Topps -> setName -> variant type. */
export async function drillToCustomSet(
  page: Page,
  env: FlowEnv,
  {
    setName,
    variantType = "Insert",
    variant,
  }: { setName: string; variantType?: string; variant?: string },
): Promise<void> {
  await drillToCustom(page, {
    sport: `E2E Test Sport ${env.WORKER_INDEX}`,
    year: "2026",
    manufacturer: "Topps",
    setName,
    variantType,
    variant,
  });
}

export interface CustomCard {
  setName: string;
  variantType?: string;
  insertName?: string;
  cardNumber: string;
  playerName: string;
  cardName?: string;
}

/**
 * util-add-custom-card.yaml: drill to the worker's custom set, add the
 * insert (default "Base") if missing, open it, and add one card.
 */
export async function addCustomCard(page: Page, env: FlowEnv, card: CustomCard): Promise<void> {
  const variantType = card.variantType ?? "Insert";
  const insert = card.insertName ?? "Base";
  await drillToCustomSet(page, env, { setName: card.setName, variantType, variant: insert });

  await addCardByHand(page, card.cardNumber, card.cardName ?? card.playerName);
}

/** Open the Add Card form on the open checklist, add one card, and wait for its row. */
export async function addCardByHand(page: Page, cardNumber: string, name: string): Promise<void> {
  await page.getByRole("button", { name: "Open add card form" }).click();
  // The form has ONE name field ("Card name", placeholder "Player name").
  const cardName = page.getByRole("textbox", { name: "Card name" });
  await expect(cardName).toBeVisible();
  await page.getByRole("textbox", { name: "Card number" }).fill(cardNumber);
  await cardName.fill(name);
  await page.getByRole("button", { name: "Submit new card" }).click();
  await expect(cardName).toBeHidden();
  await expect(page.getByRole("button", { name: `Edit card ${cardNumber}` })).toBeVisible();
}
