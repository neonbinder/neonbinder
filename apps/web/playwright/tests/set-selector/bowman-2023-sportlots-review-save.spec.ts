// Origin: .maestro/flows/set-selector/bowman-2023-sportlots-review-save.yaml (NEO-339; Maestro suite retired in NEO-341)
//
// R1 — ONE FEATURE: A BRAND'S SPORTLOTS-ONLY SETS WAIT IN A REVIEW, AND THE
// REVIEW FILES THEM (NEO-306). Live, Baseball -> 2023 -> Bowman:
//   1. a cold `Sync Sets` asks SportLots (no skip sentence) and mints NO
//      SportLots-only name as a set (the own-set name below is searched in the
//      Sets column and is not there);
//   2. the brand's `N SportLots sets to sort` pill opens the review; every row
//      is filed under Bowman › Parallel in bulk (picking the set syncs its
//      Variant Types inside the dialog), one row under Bowman › Insert, one
//      row back to its own set;
//   3. Save files exactly that (`Saved 1 set, N parallels, 1 insert.`), the
//      pill is gone, and the own set is a row of the Sets column.
// This was the retired seed's 2026 Bowman step; the scripted seed now saves
// 2026 Bowman's review server-side, so the review's UI is proved here, on a
// brand-year no other spec touches.
//
// R3 — NOT RE-PROVED HERE: what the filed rows become later (the two 2026
// Bowman specs); twin suffixes and name clashes (SlSetReviewModal unit tests).
//
// R7a — SOLE WRITER of Baseball -> 2023 (SET-REGISTRY.md -> "2023 Bowman"):
// it pays the year's cold Manufacturers sync, Bowman's Sets sync and the
// review save. Paused, the cold drill hand-makes the `Bowman` row. Fresh-only:
// a re-run finds no pill and the own set already a row, and fails by name at
// claim 1. Each CI pass (desktop, mobile) runs on its own reset and seed.
//
// THE ROWS (measured read-only 2026-10-12 on a seeded PR preview): 143 rows,
// no twins, sorted by folded label (`Base Set` first).
//   * OWN_LABEL `Best` -> default set name `Bowman Best`, not a substring of
//     any 2023 BSC set (`Bowman's Best` has the apostrophe). `Best` is the
//     first row its own filter shows.
//   * INSERT_ROW `Prospect Autos` (not `Prospects`: 15 `Best Top Prospects …`
//     rows would contain it). The first row its own filter shows.
//   * Every other row (141) is filed under Bowman › Parallel.
//
// PAUSED (NEO-287): SportLots is never asked, so the Sets column ends with the
// skip sentence and there is no review and no pill. That is the whole paused
// assertion.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { COLD_SYNC, columnOption, columnSearch, drillToColdManufacturer, setBuilderReady } from "../../support/set-builder";

const BRAND = "Bowman";
const YEAR = "2023";
const OWN_LABEL = "Best";
const OWN_SET = "Bowman Best";
const INSERT_ROW = "Prospect Autos";

test(
  "2023 Bowman — Sync Sets mints no SportLots-only set, and the brand's review files them as a set, an insert and parallels (NEO-339)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // ── STEP 1: cold Sync Sets; no SportLots-only name is a set ──
    // R9: Baseball (warm, the seed's) -> 2023 -> Bowman, each cold level on the
    // helper's R5 marketplace ceilings.
    await drillToColdManufacturer(page, env, { sport: "Baseball", year: YEAR, manufacturer: BRAND });
    // THE SYNC IS OVER on its one positive signal: the idle `Sync Sets` button,
    // mounted only once the status row has left "syncing" (the SportLots phase
    // can still be running after the helper's BSC-row gate). The review is
    // written at the END of the SportLots phase. R5 marketplace exception: the
    // cold helper's own ceiling for this same sync (BSC's year list + SportLots'
    // brand set list), observed here; measured 52.9 s with the drill on 2026.
    const syncSets = page.getByRole("button", { name: "Sync Sets", exact: true });
    await expect(syncSets).toBeVisible({ timeout: COLD_SYNC });
    const skipped = page.getByText("SportLots skipped: no SportLots ids on this path.");
    const toSort = page.getByRole("button", { name: /^[0-9]+ SportLots sets? to sort$/ });
    const anyPill = page.getByRole("button", { name: /^[0-9]+ SportLots sets? (to sort|left — save again)$/ });

    if (env.SL_PAUSED) {
      // Nothing was asked of SportLots: the skip sentence, and no pill (positive first).
      await expect(skipped).toBeVisible();
      await expect(anyPill).toHaveCount(0);
      await expectAccessible(page, { label: "2023 Bowman Sets column, SportLots on pause" });
      return;
    }

    // 1a: SportLots WAS asked (paired with the positive idle button above).
    await expect(skipped).toHaveCount(0);
    // 1b: CLAIM 1, by search. "No matches found" renders only once the filter
    // applies to a live, populated column, so the negative after it cannot pass
    // on a dead page.
    await columnSearch(page, "Sets").fill(OWN_SET);
    await expect(page.getByText("No matches found", { exact: true })).toBeVisible();
    await expect(columnOption(page, "Sets", OWN_SET)).toHaveCount(0);
    await expectAccessible(page, { label: "2023 Bowman Sets column, synced, own set absent" });

    // ── STEP 2: the review files every row ──
    // The pill renders once the review summary query resolves (one query after
    // the button): our own read, 7 s.
    await toSort.click();
    const sort = page.getByRole("dialog", { name: `Sort SportLots sets for ${BRAND}` });
    await expect(sort).toBeVisible();
    await expectAccessible(page, { within: sort, label: "Sort SportLots sets dialog" });

    const applyAny = sort.getByRole("button", { name: /^Apply to [1-9][0-9]* selected$/ });
    const applyNone = sort.getByRole("button", { name: "Apply to 0 selected" });
    const bulkSet = (choice: string | RegExp) =>
      sort.getByRole("button", {
        name: typeof choice === "string" ? `${choice}: set the selected rows belong to` : choice,
      });
    const bulkType = (choice: string | RegExp) =>
      sort.getByRole("button", {
        name: typeof choice === "string" ? `${choice}: where the selected rows are filed` : choice,
      });
    const typeOption = (type: string) =>
      sort
        .getByRole("group", { name: `Types under ${BRAND}` })
        .getByRole("button")
        .filter({ has: page.getByText(type, { exact: true }) });
    const onlyLinked = sort.getByText("Missing a set? Only sets that can sync their variant types show here.");

    // 2a: BULK, every row -> Bowman › Parallel. The Apply count is the proof the
    // tick took every row (it read "Apply to 0 selected").
    await sort.getByRole("checkbox", { name: "Select all shown" }).click();
    await expect(applyAny).toBeVisible();
    await bulkSet(/: set the selected rows belong to$/).click();
    await expect(onlyLinked).toBeVisible();
    await sort
      .getByRole("group", { name: "Sets the selected rows can belong to" })
      .getByRole("button")
      .filter({ has: page.getByText(BRAND, { exact: true }) })
      .click();
    // Picking the set runs its Variant Types sync (forced, once per dialog) and
    // the type picker is inert until it lands. R5 marketplace exception: a live
    // BSC + SportLots variant-type fetch, the 2024 Topps Chrome drill's 60 s
    // (measured 7.8 s on 2026 Bowman). The status is shown AND announced in a
    // live region, so both copies must go; the positives right after pair it.
    await expect(sort.getByText(`Syncing ${BRAND}'s variant types…`)).toHaveCount(0, { timeout: 60_000 });
    await expect(bulkSet(BRAND)).toBeVisible();
    await bulkType(/: where the selected rows are filed$/).click();
    await typeOption("Parallel").click();
    await expect(bulkType("Parallel")).toBeVisible();
    await applyAny.click();
    // Applying clears the selection.
    await expect(applyNone).toBeVisible();

    // 2b: ONE row -> Bowman › Insert, filtered first (the filter narrows the
    // view, not the selection or the save). The bulk set is still Bowman.
    const filter = sort.getByRole("searchbox", { name: "Find a SportLots set" });
    await filter.fill(INSERT_ROW);
    await sort.getByRole("checkbox", { name: `Select ${INSERT_ROW}`, exact: true }).click();
    await expect(sort.getByRole("button", { name: "Apply to 1 selected" })).toBeVisible();
    await bulkType("Parallel").click();
    await typeOption("Insert").click();
    await expect(bulkType("Insert")).toBeVisible();
    await sort.getByRole("button", { name: "Apply to 1 selected" }).click();
    await expect(applyNone).toBeVisible();
    // The row's own type picker names its new choice: the apply reached it.
    await expect(sort.getByRole("button", { name: `Insert: where ${INSERT_ROW} is filed`, exact: true })).toBeVisible();

    // 2c: PER ROW, OWN_LABEL back to its own set through its own picker. Its
    // picker names its current choice first: 2a put it under Bowman (R2
    // precondition). Exact, so `… set Best Autos belongs to` cannot answer.
    await filter.fill(OWN_LABEL);
    await sort.getByRole("button", { name: `${BRAND}: set ${OWN_LABEL} belongs to`, exact: true }).click();
    await expect(onlyLinked).toBeVisible();
    await sort
      .getByRole("group", { name: `Where ${OWN_LABEL} goes` })
      .getByRole("button")
      .filter({ has: page.getByText("Its own set", { exact: true }) })
      .click();
    await expect(
      sort.getByRole("button", { name: `Its own set: set ${OWN_LABEL} belongs to`, exact: true }),
    ).toBeVisible();
    await expectAccessible(page, { within: sort, label: "Sort SportLots sets dialog, every row filed" });

    // 2d: SAVE. The footer's tally covers EVERY row (the filter narrows the view,
    // not the save): one set, one insert, every other row a parallel.
    await expect(sort.getByText(/^Save will file: 1 set · [0-9]+ parallels? · 1 insert$/)).toBeVisible();
    await sort.getByRole("button", { name: /^Save [0-9]+ SportLots sets?$/ }).click();
    // The server's own counts, no "skipped" tail: this spec is 2023's only
    // writer. An NB write: the 7 s bar (measured 0.71 s on 2026 Bowman).
    await expect(page.getByText(/^Saved 1 set, [0-9]+ parallels?, 1 insert\.$/)).toBeVisible();
    await expect(sort).toBeHidden();

    // ── STEP 3: the review is gone; the own set is a row ──
    // The review doc is deleted once every row is filed. Positive first.
    await expect(syncSets).toBeVisible();
    await expect(anyPill).toHaveCount(0);
    // The Sets filter still holds OWN_SET from claim 1, so the new row appears
    // under it as soon as the column's read lands: the same search that found
    // nothing before the save.
    await expect(columnOption(page, "Sets", OWN_SET)).toBeVisible();
    await expectAccessible(page, { label: "2023 Bowman Sets column after the review saved" });
  },
);
