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
  // NEO-453, TEMPORARY, Jason 2026-11-06: eBay's sandbox refuses every publish
  // (400 / 25002) for any seller on our keyset, so this spec cannot pass. Restore
  // it, its entry in SELLER_SPECS and its seller tag as soon as publish works.
  e2e: ["collection/inventory-ebay-sandbox-listing-2024-topps-chrome-future-stars.spec.ts"],
  "e2e-mobile": [
    "collection/inventory-ebay-sandbox-listing-2024-topps-chrome-future-stars.spec.ts",
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

// Specs that write to a marketplace seller account shared by EVERY PR's CI
// (NEO-415): one BuySportsCards test seller and one eBay sandbox seller. Two
// PRs running one at once clobber each other (one preview's sync zeroes the
// other's listings; overlapping BSC sheet reads make BSC create twin rows),
// and sharding cannot fix that. So they are planned in NO shard: e2e.yml's
// `seller-desktop` / `seller-mobile` jobs run them, one PR at a time repo-wide
// (a queue, never a cancel), and the `e2e` gate still requires a passing
// result for each on BOTH projects.
//
// Each listed spec carries the tag below; shard-plan.mjs refuses to plan if the
// tag and this list disagree in either direction, so a new seller spec cannot
// slip into a shard (or a listed one lose its tag) unnoticed. Paths are
// relative to playwright/tests/.
export const SELLER_TAG = "@marketplace-seller";
/** @type {string[]} */
export const SELLER_SPECS = [
  "collection/inventory-bsc-listing-2024-topps-chrome-future-stars.spec.ts",
  "collection/inventory-bsc-listing-2026-bowman-chrome-prefix.spec.ts",
];
