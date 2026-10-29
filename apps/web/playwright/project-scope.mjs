// Specs that skip a project, read by playwright.config.ts (testIgnore) and
// shard-plan.mjs (planning and e2e.yml's gate) so the three always agree.
// Paths are relative to playwright/tests/.
//
// Every spec runs on both projects unless it is listed here, and a listing
// needs a reason: the phone run of it must add no UI coverage. A skipped
// result would fail the gate, so a spec never skips a project with
// test.skip(); it is left out of that project's plan instead.
/** @type {Record<string, string[]>} */
export const PROJECT_IGNORE = {
  "e2e-mobile": [
    // NEO-389: waits 1.6-4.7 min on the heavy preprocess model's cold start,
    // the longest spec in the suite. The notice and pairing it then checks
    // render the same on a phone, and preprocess-crop-matrix covers the
    // geometry. Desktop keeps it.
    "placeholders/pipeline-escalation-cold-start.spec.ts",
  ],
};

/**
 * The specs `project` leaves out, relative to playwright/tests/.
 * @param {string} project
 * @returns {string[]}
 */
export function ignoredSpecs(project) {
  return PROJECT_IGNORE[project] ?? [];
}
