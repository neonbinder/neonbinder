/**
 * Port of .maestro/flows/set-selector/util-fetch-real-set-checklist-to-wizard.yaml
 * — drill a real set's Base, fetch its checklist and land in the entity-review
 * wizard (every row undecided). Read-only: callers leave through Cancel -> Discard.
 */
import type { Maestro } from "../../maestro";
import { utilDrillToBaseVariant } from "./util-drill-to-base-variant";

export interface FetchRealSetOptions {
  /** Default "Topps Big League". */
  SET?: string;
  /** Default "Baseball". */
  SPORT?: string;
  /** Default "2024". */
  YEAR?: string;
  /** Default "Topps". */
  MANUFACTURER?: string;
}

export async function utilFetchRealSetChecklistToWizard(m: Maestro, o: FetchRealSetOptions = {}): Promise<void> {
  await utilDrillToBaseVariant(m, {
    SPORT: o.SPORT || "Baseball",
    YEAR: o.YEAR || "2024",
    MANUFACTURER: o.MANUFACTURER || "Topps",
    SET: o.SET || "Topps Big League",
  });

  // R8 exception: uncentred on purpose (empty-checklist page has no overflow).
  await m.scrollUntilVisible(m.id("Sync card checklist"), { timeout: 7000 });
  await m.tapOn(m.id("Sync card checklist"));

  if (!m.env.SL_PAUSED) {
    await m.waitVisible(".*Match Cards.*", 120000);
  } else {
    await m.waitVisible(".*Kept all [0-9]+ cards? from BSC.*", 120000);
    await m.assertNotVisible("Match Cards.*");
  }

  if (!m.env.SL_PAUSED) {
    // Confirm's own TEXT is the sync point ("Loading…" while streaming).
    await m.waitVisible("^Confirm$", 120000);
    await m.tapOn(m.id("Confirm card matches"));
  } else {
    await m.assertNotVisible(m.id("Confirm card matches"));
  }

  await m.waitVisible("Confirm New Players & Teams", 120000);
}
