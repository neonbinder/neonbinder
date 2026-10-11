/**
 * Port of .maestro/flows/set-selector/util-cross-list-cards.yaml — from an open
 * checklist, open "Add Cross-Release Cards", pick the source set, type the
 * numbers and submit. Leaves the modal open on its result panel.
 */
import { expect } from "@playwright/test";
import { mrx, type Maestro } from "../../maestro";
import { utilPickCrossListSource } from "./util-pick-cross-list-source";

export interface CrossListCardsOptions {
  CARD_NUMBERS: string;
  SOURCE_SET: string;
  /** Default "E2E Test Sport <worker>". */
  SOURCE_SPORT?: string;
  /** Default "2026". */
  SOURCE_YEAR?: string;
  /** Default "Topps". */
  SOURCE_MANUFACTURER?: string;
  /** Default "Insert". */
  SOURCE_VARIANT_TYPE?: string;
  /** Default "Base". */
  SOURCE_VARIANT?: string;
}

export async function utilCrossListCards(m: Maestro, o: CrossListCardsOptions): Promise<void> {
  // visibilityPercentage: 50 has no equivalent (dropped).
  await m.scrollUntilVisible(m.id("Open add cross-release cards form"), { centerElement: true, timeout: 7000 });
  await m.tapOn(m.id("Open add cross-release cards form"));
  await m.waitVisible(m.id("Add cross-release cards"), 7000);

  await utilPickCrossListSource(m, {
    SOURCE_SPORT: o.SOURCE_SPORT || "E2E Test Sport " + (m.env.WORKER_INDEX || 0),
    SOURCE_YEAR: o.SOURCE_YEAR || "2026",
    SOURCE_MANUFACTURER: o.SOURCE_MANUFACTURER || "Topps",
    SOURCE_SET: o.SOURCE_SET,
    SOURCE_VARIANT_TYPE: o.SOURCE_VARIANT_TYPE || "Insert",
    SOURCE_VARIANT: o.SOURCE_VARIANT || "Base",
  });

  await m.tapOn(m.id("Card numbers to cross-list"));
  await m.inputText(o.CARD_NUMBERS);
  // assertVisible { id, text }: the box must READ what was typed.
  await expect(m.id("Card numbers to cross-list").first()).toHaveValue(mrx(o.CARD_NUMBERS), { timeout: 7000 });

  await m.tapOn(m.id("Link cross-release cards"));

  await m.waitVisible(".*Linked [0-9]+ card.*", 7000);
}
