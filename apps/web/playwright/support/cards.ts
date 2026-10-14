/**
 * Card checklist helpers for the hand-made ("custom") subtree a worker owns.
 * Origins:
 *   .maestro/flows/set-selector/util-add-custom-card.yaml -> addCustomCard / addCardViaForm
 *   .maestro/flows/set-selector/util-drill-to-custom.yaml (its VARIANT step) -> openVariant
 * (Maestro suite retired in NEO-341; the YAML is in git history.)
 */
import { expect, type Locator, type Page } from "@playwright/test";
import type { FlowEnv } from "./env";
import {
  columnHeading,
  columnOption,
  columnSearch,
  CUSTOM_CONFIRM,
  drillToCustomSet,
  type Column,
} from "./set-builder";

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A checklist row's edit control; its name may carry the card's title after a comma. */
export function editCardButton(page: Page, cardNumber: string): Locator {
  return page.getByRole("button", { name: new RegExp(`^Edit card ${escapeRe(cardNumber)}(, .*)?$`) });
}

export function deleteCardButton(page: Page, cardNumber: string): Locator {
  return page.getByRole("button", { name: new RegExp(`^Delete card ${escapeRe(cardNumber)}(, .*)?$`) });
}

export function confirmDeleteCardButton(page: Page, cardNumber: string): Locator {
  return page.getByRole("button", {
    name: new RegExp(`^Confirm delete card ${escapeRe(cardNumber)}(, .*)?$`),
  });
}

/** The column the drill opens after `column` (none past Sets: the variant columns name their own marker). */
const NEXT: Partial<Record<Column, Column>> = {
  Sports: "Years",
  Years: "Manufacturers",
  Manufacturers: "Sets",
  Sets: "Variant Types",
};

/** Columns whose rows are picked straight from the list rather than through the search box. */
function picksFromList(column: Column): boolean {
  return column === "Variant Types" || column === "Inserts" || column === "Parallels";
}

/**
 * Make sure `name` exists in `column` and return with it selected, ALWAYS
 * going through the "+ Custom" form (typing a name the column already holds
 * selects it with no confirm). The form therefore either advances the drill
 * (`advanced` appears; by default the next column's heading) or asks to
 * confirm the create, after which the new row is picked.
 */
export async function ensureAndSelect(
  page: Page,
  column: Column,
  name: string,
  advanced?: Locator,
): Promise<void> {
  await page.getByRole("button", { name: `Add custom ${column}` }).click();
  await expect(page.getByText("Add Custom Entry")).toBeVisible();
  const value = page.getByPlaceholder("Enter custom value...");
  await value.fill(name);
  await value.press("Enter");
  const create = page.getByRole("button", { name: CUSTOM_CONFIRM[column], exact: true });
  const next = NEXT[column];
  const marker = advanced ?? (next ? columnHeading(page, next) : undefined);
  await expect(marker ? create.or(marker) : create).toBeVisible();
  if (await create.isVisible()) {
    await create.click();
    await expect(page.getByText("Add Custom Entry")).toBeHidden();
    if (!picksFromList(column)) await columnSearch(page, column).fill(name);
    await columnOption(page, column, name).click();
  }
  await expect(page.getByText("Add Custom Entry")).toBeHidden();
}

/**
 * Open (creating it through "+ Custom" when missing) the `variant` row of the
 * open variant type's column, leaving its checklist on screen.
 */
export async function openVariant(page: Page, variantType: string, variant: string): Promise<void> {
  await ensureAndSelect(
    page,
    `${variantType}s` as Column,
    variant,
    page.getByRole("button", { name: "Open add card form" }),
  );
  await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible();
}

export interface CardFormInput {
  cardNumber: string;
  /** What the flow types into the form's one name field ("Card name", placeholder "Player name"). */
  playerName: string;
  /** Replaces the player name in that field, when the flow sets one. */
  cardName?: string;
  /** Runs with the form open and filled, before Submit (e.g. to pick a team). */
  beforeSubmit?: () => Promise<void>;
}

/**
 * The second half of util-add-custom-card.yaml: open the open checklist's
 * add-card form, fill it, submit, and wait for the new card's row.
 */
export async function addCardViaForm(page: Page, card: CardFormInput): Promise<void> {
  const { cardNumber, playerName, cardName, beforeSubmit } = card;
  await page.getByRole("button", { name: "Open add card form" }).click();
  const name = page.getByRole("textbox", { name: "Card name", exact: true });
  const number = page.getByRole("textbox", { name: "Card number", exact: true });
  await expect(name).toBeVisible({ timeout: 15_000 });
  await number.fill(cardNumber);
  await name.fill(cardName ?? playerName);
  if (beforeSubmit) await beforeSubmit();
  await page.getByRole("button", { name: "Submit new card" }).click();
  await expect(name).toBeHidden();
  await expect(number).toBeHidden();
  await expect(editCardButton(page, cardNumber)).toBeVisible();
}

export interface CustomCard extends Omit<CardFormInput, "beforeSubmit"> {
  /** The per-worker custom set (under E2E Test Sport <worker> / 2026 / Topps). */
  set: string;
  variantType?: string;
  /** The row created (if missing) and opened in the variant type's column. Default "Base". */
  insertName?: string;
}

/**
 * util-add-custom-card.yaml: drill to the worker's custom set, make sure the
 * insert row exists and is open, and add one card. Leaves the new card's
 * "Edit card" control on screen.
 */
export async function addCustomCard(page: Page, env: FlowEnv, card: CustomCard): Promise<void> {
  const { set, variantType = "Insert", insertName = "Base", cardNumber, playerName, cardName } = card;
  await drillToCustomSet(page, env, { set, variantType, variant: insertName });
  await addCardViaForm(page, { cardNumber, playerName, cardName });
}
