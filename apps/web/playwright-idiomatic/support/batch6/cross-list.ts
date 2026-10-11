/**
 * The Add Cross-Release Cards modal (batch 6). Specs:
 *   .maestro/flows/set-selector/util-cross-list-cards.yaml
 *   .maestro/flows/set-selector/util-pick-cross-list-source.yaml
 *
 * From an open checklist: open the form, pick the SOURCE (home) set down
 * Sport > Year > Manufacturer > Set > Variant type > Insert, type the card
 * numbers, and press Link. Leaves the modal open on its "Linked N card"
 * confirmation for the caller to read and close.
 */
import { expect, type Page } from "@playwright/test";
import type { FlowEnv } from "../../../playwright/support/env";

export interface CrossListSource {
  sport?: string;
  year?: string;
  manufacturer?: string;
  set: string;
  variantType?: string;
  variant?: string;
}

export async function crossListCards(
  page: Page,
  env: FlowEnv,
  source: CrossListSource,
  cardNumbers: string,
): Promise<void> {
  await page.getByRole("button", { name: "Open add cross-release cards form" }).click();
  const modal = page.getByRole("dialog", { name: "Add cross-release cards" });
  await expect(modal).toBeVisible();

  const sport = source.sport ?? `E2E Test Sport ${env.WORKER_INDEX}`;
  const year = source.year ?? "2026";
  const manufacturer = source.manufacturer ?? "Topps";
  const variantType = source.variantType ?? "Insert";
  const variant = source.variant ?? "Base";

  // Each level offers a "Pick <Level> <name>" button and, once picked, a
  // "Change <Level>" button showing the choice. Long levels (Sport, Set) get
  // a filter box first.
  async function pickLevel(level: string, name: string, filter = false): Promise<void> {
    if (filter) await modal.getByRole("textbox", { name: `Filter ${level} options` }).fill(name);
    await modal.getByRole("button", { name: `Pick ${level} ${name}`, exact: true }).click();
    await expect(modal.getByRole("button", { name: `Change ${level}` })).toContainText(name);
  }
  await pickLevel("Sport", sport, true);
  await pickLevel("Year", year);
  await pickLevel("Manufacturer", manufacturer);
  await pickLevel("Set", source.set, true);
  await pickLevel("Variant", variantType);
  await modal.getByRole("button", { name: `Pick Insert ${variant}`, exact: true }).click();
  await expect(modal.getByRole("button", { name: "Change Insert" })).toContainText(variant);
  await expect(modal.getByText(`Source set: ${variant}`)).toBeVisible();

  const numbers = modal.getByRole("textbox", { name: "Card numbers to cross-list" });
  await numbers.fill(cardNumbers);
  await expect(numbers).toHaveValue(cardNumbers);
  await modal.getByRole("button", { name: "Link cross-release cards" }).click();
  await expect(modal.getByText(/Linked [0-9]+ cards?/)).toBeVisible();
}
