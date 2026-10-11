/**
 * Port of .maestro/flows/set-selector/util-discard-resumed-review-batch.yaml —
 * discard a review batch left behind by an earlier flow, then refetch. The
 * 7000 poll on the normal path ("0 of N reviewed" present) is deliberate.
 */
import type { Maestro } from "../../maestro";
import { utilFetchRealSetChecklistToWizard } from "./util-fetch-real-set-checklist-to-wizard";

export async function utilDiscardResumedReviewBatch(m: Maestro, _o: Record<string, never> = {}): Promise<void> {
  if (await m.isNotVisible("0 of [0-9]+ reviewed.*")) {
    // retryTapIfNoChange has no equivalent. The pattern tolerates the literal
    // parentheses (Maestro's full-regex reading of "Cancel (Esc)" drops them).
    await m.tapOn("Cancel \\(?Esc\\)?");
    await m.waitVisible("Discard [0-9]+ decisions?.*", 15000);
    await m.tapOn("Discard");
    await m.waitVisible("Fetch cancelled — no cards saved.", 30000);
    await utilFetchRealSetChecklistToWizard(m);
  }
}
