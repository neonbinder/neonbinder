/**
 * Cross-release import helpers for batch 4. Specs:
 *   .maestro/flows/set-selector/util-pick-cross-list-source.yaml
 *   .maestro/flows/set-selector/util-cross-list-cards.yaml
 */
import { expect, type Page } from "@playwright/test";
import type { FlowEnv } from "../env";

export interface CrossListSource {
  sport?: string;
  year?: string;
  manufacturer?: string;
  set: string;
  variantType?: string;
  variant?: string;
}

/** Open the "Add cross-release cards" modal from an open checklist. */
export async function openCrossListForm(page: Page) {
  await page.getByRole("button", { name: "Open add cross-release cards form" }).click();
  const modal = page.getByRole("dialog", { name: "Add cross-release cards" });
  await expect(modal).toBeVisible();
  return modal;
}

/** Walk the modal's own cascade to the source (home) set; each pick shows as a "Change X" chip. */
export async function pickCrossListSource(
  page: Page,
  env: FlowEnv,
  source: CrossListSource,
): Promise<void> {
  const {
    sport = `E2E Test Sport ${env.WORKER_INDEX}`,
    year = "2026",
    manufacturer = "Topps",
    set,
    variantType = "Insert",
    variant = "Base",
  } = source;
  const modal = page.getByRole("dialog", { name: "Add cross-release cards" });

  const step = async (level: string, value: string, filter?: string) => {
    if (filter) {
      const box = modal.getByRole("textbox", { name: filter });
      // Long lists offer a filter; short ones do not.
      if (await box.isVisible()) await box.fill(value);
    }
    await modal.getByRole("button", { name: `Pick ${level} ${value}` }).click();
    await expect(modal.getByRole("button", { name: `Change ${level}` })).toContainText(value);
  };

  await step("Sport", sport, "Filter Sport options");
  await step("Year", year);
  await step("Manufacturer", manufacturer);
  await step("Set", set, "Filter Set options");
  await step("Variant", variantType);
  await step("Insert", variant);
  await expect(modal.getByText(`Source set: ${variant}`)).toBeVisible();
}

/** util-cross-list-cards: link cards printed in another set into the open checklist. */
export async function crossListCards(
  page: Page,
  env: FlowEnv,
  source: CrossListSource,
  cardNumbers: string,
): Promise<void> {
  const modal = await openCrossListForm(page);
  await pickCrossListSource(page, env, source);
  const numbers = modal.getByRole("textbox", { name: "Card numbers to cross-list" });
  await numbers.fill(cardNumbers);
  await expect(numbers).toHaveValue(cardNumbers);
  await modal.getByRole("button", { name: "Link cross-release cards" }).click();
  await expect(modal.getByText(/Linked \d+ card/)).toBeVisible();
}
