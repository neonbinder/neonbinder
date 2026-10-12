// Origin: .maestro/flows/setup.yaml (Maestro suite retired in NEO-341; see git history)
//
// THE GLOBAL SEED TRACK.
//
// Runs ONCE, as worker 0, in the seed job, after `e2e-baseline.sh reset`
// (project `setup`, never sharded). Every later spec reads what it builds:
//   * 2024 Topps Chrome Baseball: Base (335 cards, both marketplaces paired),
//     the Future Stars insert (20 cards), the Gold Wave Refractors parallel
//     (300 cards built from Base);
//   * 2024 Topps Big League: Base mapped, checklist left empty;
//   * 2026 Bowman: SportLots sets sorted (NEO-312 fixture).
//
// R5 exempts the seed as a class: every wait below is the flow's own measured
// cold-path value (live marketplace round trips on unwarmed data).
// "A SYNC THAT HALF-WORKED IS A FAILED SEED": after every sync the partial-
// failure banners must be absent (expectNoSyncFailure).
import { test, expect } from "../support/fixtures";
import { loginToBsc, loginToSportLots } from "../support/credentials";
import {
  addCustomManufacturer,
  columnHeading,
  columnOption,
  columnSearch,
  drillToBaseVariant,
  drillToColdManufacturer,
  drillToSet,
  pick,
  setBuilderReady,
  syncChecklistButton,
} from "../support/set-builder";
import { addAsNewStep, answerStepAsNew } from "../support/wizard";
import type { Page } from "@playwright/test";

const SL_PAUSE_NOTICE = "SportLots is on pause: nothing from SportLots was asked for or changed.";

async function expectNoSyncFailure(page: Page) {
  await expect(page.getByText(/could not be reached, so nothing from .* was changed/)).toBeHidden();
  await expect(page.getByText(/Couldn.t sync options/)).toBeHidden();
}

/**
 * Fetch a variant's checklist and settle the card-pairing dialog: keep every
 * card only one marketplace has, then confirm. Waits are the caller's (the
 * Base and the insert checklists have different measured ceilings).
 */
async function fetchChecklist(
  page: Page,
  slPaused: boolean,
  { open, settle }: { open: number; settle: number },
) {
  const pairing = page.getByRole("dialog", { name: /^Match Cards/ });
  const wizard = page.getByRole("dialog", { name: "Confirm New Players & Teams" });
  const saved = page.getByText(/Saved [0-9]+/);

  await syncChecklistButton(page).click();
  await expect(pairing.or(wizard).or(saved).first()).toBeVisible({ timeout: open });

  if (!slPaused) {
    if (await pairing.isVisible()) {
      // The confirm button reads "Loading…" until both sides have streamed in.
      const confirm = pairing.getByRole("button", { name: "Confirm card matches" });
      await expect(confirm).toHaveText("Confirm", { timeout: 120_000 });
      for (const side of ["BSC", "SportLots"]) {
        // Each side's unmatched section is headed "<side> only (<n>)"; there
        // is no section at all when everything paired.
        const unmatched = pairing.getByRole("heading", { name: new RegExp(`^${side} only \\([1-9][0-9]*\\)$`) });
        if (await unmatched.isVisible()) {
          await pairing.getByRole("button", { name: `Keep all ${side}-only cards` }).click();
        }
      }
      await confirm.click();
      await expect(pairing).toBeHidden({ timeout: settle });
    }
  } else {
    // One marketplace only: nothing to pair, the dialog never opens.
    await expect(pairing).toBeHidden();
  }
  await expect(wizard.or(saved).first()).toBeVisible({ timeout: settle });
}

/**
 * Open an insert/parallel level and get `name` listed: the first visit opens
 * the reconciliation dialog for the whole level (save every ready set),
 * a later one just lists the rows.
 */
async function reconcileAndFind(page: Page, column: "Inserts" | "Parallels", name: string, query: string) {
  const reconcile = page.getByRole("dialog", { name: `Reconcile ${column}` });
  const row = columnOption(page, column, name);
  const search = columnSearch(page, column);

  if (!(await reconcile.isVisible())) await search.fill(query);
  // A cold level reconciles BSC and SportLots sets live.
  await expect(reconcile.or(row).first()).toBeVisible({ timeout: 240_000 });

  if (await reconcile.isVisible()) {
    await expect(reconcile.getByText(/[0-9]+ ready/)).toBeVisible();
    await expect(reconcile.getByText(/Ready \([0-9]+\)/)).toBeVisible();
    await reconcile.getByRole("button", { name: /^Save [0-9]+ sets/ }).click();
    await expect(reconcile).toBeHidden({ timeout: 30_000 });
    if (!(await row.isVisible())) await search.fill(query);
  }
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expectNoSyncFailure(page);
  await row.click();
}

test(
  "Setup — global reset + warm + sync 2024 Topps Chrome Baseball (Base + Insert + Parallel) + 2026 Bowman's SportLots review",
  { tag: ["@setup"] },
  async ({ page, signIn, env }) => {
    // ── sign in, per-user reset, seed creds, land on /admin ────────────────
    await signIn("/testing/reset?redirect=/testing/seed-credentials?redirect=/admin");
    await expect(page.getByText(/Build set parameters from marketplace data/)).toBeVisible({
      timeout: 120_000,
    });
    await loginToBsc(page);
    await loginToSportLots(page, env);

    // ── Sports → Baseball ──────────────────────────────────────────────────
    await page.goto("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: 20_000 });
    await expect(columnHeading(page, "Sports")).toBeVisible({ timeout: 10_000 });
    // The first visit syncs the sport list from both marketplaces.
    await expect(columnOption(page, "Sports", "Baseball")).toBeVisible({ timeout: 60_000 });
    await expectNoSyncFailure(page);
    if (!env.SL_PAUSED) {
      await expect(page.getByText(SL_PAUSE_NOTICE)).toBeHidden();
    } else {
      await expect(page.getByText(SL_PAUSE_NOTICE)).toBeVisible({ timeout: 10_000 });
    }
    await pick(page, "Sports", "Baseball", { search: false });

    // ── Years → 2024 ───────────────────────────────────────────────────────
    await expect(columnHeading(page, "Years")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("listbox", { name: "Years" })).toBeVisible({ timeout: 90_000 });
    await expectNoSyncFailure(page);
    await pick(page, "Years", "2024");

    // ── Manufacturers → Topps ──────────────────────────────────────────────
    await expect(columnHeading(page, "Manufacturers")).toBeVisible({ timeout: 20_000 });
    if (!env.SL_PAUSED) {
      await columnSearch(page, "Manufacturers").fill("Topps");
      const topps = columnOption(page, "Manufacturers", "Topps");
      await expect(topps).toBeVisible({ timeout: 45_000 });
      await expectNoSyncFailure(page);
      await topps.click();
    } else {
      await expect(page.getByText("Syncing Manufacturer Options")).toBeHidden({ timeout: 45_000 });
      await expect(
        page.getByText("No manufacturers available. Sync from marketplaces to populate."),
      ).toBeVisible({ timeout: 45_000 });
      await expect(page.getByText("SportLots skipped: no SportLots ids on this path.")).toBeVisible();
      await expectNoSyncFailure(page);
      await addCustomManufacturer(page, "Topps");
      await columnOption(page, "Manufacturers", "Topps").click();
    }

    // ── Sets → Topps Chrome ────────────────────────────────────────────────
    await expect(columnHeading(page, "Sets")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("listbox", { name: "Sets" })).toBeVisible({ timeout: 45_000 });
    await expectNoSyncFailure(page);
    await pick(page, "Sets", "Topps Chrome");

    // ── Variant Types: Base / Insert / Parallel ────────────────────────────
    await expect(columnHeading(page, "Variant Types")).toBeVisible({ timeout: 20_000 });
    const base = columnOption(page, "Variant Types", "Base");
    const noTypes = page.getByText("No variant types available. Sync from marketplaces to populate.");
    await expect(base.or(noTypes)).toBeVisible({ timeout: 45_000 });
    if (await noTypes.isVisible()) {
      await page.getByRole("button", { name: "Sync Variant Types" }).click();
      await expect(page.getByText("Syncing Variant Types")).toBeHidden({ timeout: 45_000 });
      const close = page.getByRole("button", { name: "Close", exact: true });
      if (await close.isVisible()) {
        await close.click();
        await expect(page.getByRole("button", { name: "Sync Variant Types" })).toBeVisible({
          timeout: 10_000,
        });
      }
    }
    await expect(base).toBeVisible({ timeout: 10_000 });
    await expect(columnOption(page, "Variant Types", "Insert")).toBeVisible();
    await expect(columnOption(page, "Variant Types", "Parallel")).toBeVisible();
    await expectNoSyncFailure(page);

    // ── Base: map the base set, fetch + save the checklist ─────────────────
    await base.click();
    await expect(page.getByText("An error occurred. Please refresh the page.")).toBeHidden();

    const picker = page.getByRole("dialog", { name: "Select Base Set" });
    const remap = page.getByRole("button", { name: "Re-map Base" });
    await expect(picker.or(remap)).toBeVisible({ timeout: 60_000 });
    if (await picker.isVisible()) {
      const confirm = picker.getByRole("button", { name: "Confirm Base Set" });
      await expect(confirm).toBeVisible({ timeout: 45_000 });
      const sl = picker.getByRole("option", { name: /^SportLots base candidate: / });
      if (!env.SL_PAUSED) {
        await picker.getByRole("option", { name: /^BSC base candidate: / }).first().click();
        await sl.first().click();
      } else {
        await expect(picker.getByText(/^SportLots returned no base set for /)).toBeVisible();
        await expect(sl).toHaveCount(0);
        await picker.getByRole("option", { name: /^BSC base candidate: / }).first().click();
      }
      await confirm.click();
      await expect(picker).toBeHidden({ timeout: 30_000 });
    }
    if (!env.SL_PAUSED) {
      await expect(remap).toBeVisible({ timeout: 30_000 });
    } else {
      await expect(picker).toBeHidden();
      await expect(page.getByText("An error occurred. Please refresh the page.")).toBeHidden();
    }

    await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(syncChecklistButton(page)).toBeVisible();
    await fetchChecklist(page, env.SL_PAUSED, { open: 60_000, settle: 60_000 });

    if (!env.SL_PAUSED) {
      // Pairing confirmed: no partial-pairing notice.
    } else {
      await expect(page.getByText(/Kept all [0-9]+ cards? from BSC/)).toBeVisible();
    }

    // First run: confirm every new player/team/league the checklist names.
    const wizard = page.getByRole("dialog", { name: "Confirm New Players & Teams" });
    if (await wizard.isVisible()) {
      await wizard.getByRole("button", { name: /^Add remaining players as new/ }).click();
      // Enabled only: the button is aria-disabled while the row's enrichment
      // lookup is in flight, and between rows.
      // Any state: a league step's primary is held until a level is pressed
      // (NEO-331), and answerStepAsNew presses "Other" first.
      const addAsNew = addAsNewStep(page);
      const confirmSave = wizard.getByRole("button", { name: /Confirm & Save/ });
      // Teams and leagues are walked one at a time (enrichment lookups; the
      // flow's 240 s per step and 250 steps at most).
      for (let i = 0; i < 250; i++) {
        await expect(addAsNew.or(confirmSave).first()).toBeVisible({ timeout: 240_000 });
        if (await confirmSave.isVisible()) break;
        await answerStepAsNew(page);
      }
      await confirmSave.click();
    }
    await expect(page.getByText(/Saved 335 cards/)).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(/^#[0-9]/).first()).toBeVisible();

    // ── Insert: reconcile, Future Stars checklist ──────────────────────────
    await drillToSet(page, env);
    await pick(page, "Variant Types", "Insert", { search: false });
    await expect(columnHeading(page, "Inserts")).toBeVisible({ timeout: 20_000 });
    await reconcileAndFind(page, "Inserts", "Future Stars", "Future Star");
    await expect(page.getByText(/Attributes for Future Stars/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible({
      timeout: 30_000,
    });
    await fetchChecklist(page, env.SL_PAUSED, { open: 90_000, settle: 90_000 });
    // Every Future Stars player is already known from Base: no review.
    await expect(page.getByRole("dialog", { name: "Confirm New Players & Teams" })).toBeHidden();
    await expect(page.getByText(/Saved 20 cards/)).toBeVisible({ timeout: 120_000 });

    // ── Parallel: reconcile, Gold Wave Refractors built from Base ──────────
    await drillToSet(page, env);
    await pick(page, "Variant Types", "Parallel", { search: false });
    await expect(columnHeading(page, "Parallels")).toBeVisible({ timeout: 20_000 });
    await reconcileAndFind(page, "Parallels", "Gold Wave Refractors", "Gold Wave Refractor");
    await expect(page.getByText(/Attributes for Gold Wave Refractors/)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible({
      timeout: 30_000,
    });
    // A parallel is built from Base, never fetched.
    const buildFromBase = page.getByRole("button", { name: "Build from Base", exact: true });
    await expect(buildFromBase).toBeVisible({ timeout: 30_000 });
    await expect(syncChecklistButton(page)).toBeHidden();
    await buildFromBase.click();
    await expect(
      page.getByText(/^Gold Wave Refractors — Built 300 cards(, [^.]+)?\./),
    ).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole("dialog", { name: /^Match Cards/ })).toBeHidden();
    await expect(page.getByRole("dialog", { name: "Confirm New Players & Teams" })).toBeHidden();
    await expect(page.getByText(/^#[0-9]/).first()).toBeVisible({ timeout: 15_000 });
    if (!env.SL_PAUSED) {
      await expect(page.getByText("SL", { exact: true }).first()).toBeVisible();
    } else {
      await expect(page.getByText("BSC", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("BSC only", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("SL", { exact: true })).toHaveCount(0);
    }

    // ── 2024 Topps Big League: base mapped, checklist left empty ───────────
    await drillToBaseVariant(page, env, { set: "Topps Big League" });
    if (!env.SL_PAUSED) {
      await expect(page.getByRole("button", { name: /Re-map Base/ })).toBeVisible({
        timeout: 60_000,
      });
    } else {
      await expect(page.getByRole("button", { name: "Map Base Set" })).toBeVisible({
        timeout: 60_000,
      });
    }
    await expect(page.getByText("No cards in this checklist yet.")).toBeVisible({ timeout: 15_000 });

    // ── 2026 Bowman: sort SportLots sets (NEO-312 fixture) ─────────────────
    const BRAND = "Bowman";
    const SL_SET = "Bowman Blue";
    const OWN_LABEL = "Bowman Sterling";
    const OWN_SET = "Bowman Sterling";
    const INSERT_ROW = "All-America Game Autos";
    const SOURCE_ROW = "All-America Game Autos Red Ink";

    await drillToColdManufacturer(page, env, { sport: "Baseball", year: "2026", manufacturer: BRAND });
    const sets = page.getByRole("listbox", { name: "Sets" });
    await expect(page.getByRole("button", { name: "Sync Sets" })).toBeVisible({ timeout: 150_000 });
    await expect(columnOption(page, "Sets", "Bowman Chrome")).toBeVisible();
    await expect(columnOption(page, "Sets", "Bowman Sapphire Edition")).toBeVisible();
    const toSort = page.getByRole("button", { name: /^[0-9]+ SportLots sets? to sort$/ });

    if (env.SL_PAUSED) {
      await expect(page.getByText("SportLots skipped: no SportLots ids on this path.")).toBeVisible();
      await expect(toSort).toBeHidden();

      await drillToSet(page, env, { year: "2026", manufacturer: BRAND, set: BRAND });
      await expect(columnOption(page, "Variant Types", "Insert")).toBeVisible();
      await expect(columnOption(page, "Variant Types", "Parallel")).toBeVisible();
      return;
    }

    // The sort count is the SportLots side's own arrival (the helper's wait is
    // on BSC's sets); the negative checks below pass on a column still empty.
    await expect(toSort).toBeVisible({ timeout: 150_000 });
    await expect(page.getByText("SportLots skipped: no SportLots ids on this path.")).toBeHidden();
    // SportLots-only names wait to be sorted; none lands as a set by itself.
    for (const name of [SL_SET, "Bowman Gold", "Bowman Neon Green"]) {
      await expect(sets.getByText(name, { exact: true })).toBeHidden();
    }
    await toSort.click();
    const sort = page.getByRole("dialog", { name: `Sort SportLots sets for ${BRAND}` });
    await expect(sort).toBeVisible();

    // File every row under Bowman › Parallel in one bulk apply…
    await sort.getByRole("checkbox", { name: "Select all shown" }).click();
    await expect(sort.getByRole("button", { name: /^Apply to [1-9][0-9]* selected$/ })).toBeVisible();
    await sort.getByRole("button", { name: /: set the selected rows belong to$/ }).click();
    const onlyLinked = sort.getByText(
      "Missing a set? Only sets that can sync their variant types show here.",
    );
    await expect(onlyLinked).toBeVisible();
    await sort
      .getByRole("group", { name: "Sets the selected rows can belong to" })
      .getByRole("button")
      .filter({ has: page.getByText(BRAND, { exact: true }) })
      .click();
    // Picking the set syncs its variant types live. The status is shown in
    // the bulk bar AND announced in a live region; both must move on.
    await expect(sort.getByText(`Syncing ${BRAND}'s variant types…`)).toHaveCount(0, {
      timeout: 60_000,
    });
    await expect(
      sort.getByRole("button", { name: `${BRAND}: set the selected rows belong to` }),
    ).toBeVisible();

    const bulkType = (value: string | RegExp) =>
      sort.getByRole("button", {
        name: typeof value === "string" ? `${value}: where the selected rows are filed` : value,
      });
    const typeOption = (type: string) =>
      sort
        .getByRole("group", { name: `Types under ${BRAND}` })
        .getByRole("button")
        .filter({ has: page.getByText(type, { exact: true }) });

    await bulkType(/: where the selected rows are filed$/).click();
    await typeOption("Parallel").click();
    await expect(bulkType("Parallel")).toBeVisible();
    await sort.getByRole("button", { name: /^Apply to [1-9][0-9]* selected$/ }).click();
    await expect(sort.getByRole("button", { name: "Apply to 0 selected" })).toBeVisible();

    // …then re-file the one insert row under Bowman › Insert.
    await sort.getByRole("checkbox", { name: `Select ${INSERT_ROW}`, exact: true }).click();
    await expect(sort.getByRole("button", { name: "Apply to 1 selected" })).toBeVisible();
    await bulkType("Parallel").click();
    await typeOption("Insert").click();
    await expect(bulkType("Insert")).toBeVisible();
    await sort.getByRole("button", { name: "Apply to 1 selected" }).click();
    await expect(sort.getByRole("button", { name: "Apply to 0 selected" })).toBeVisible();
    await expect(sort.getByRole("button", { name: `Insert: where ${INSERT_ROW} is filed` })).toBeVisible();
    await expect(
      sort.getByRole("button", { name: `Parallel: where ${SOURCE_ROW} is filed` }),
    ).toBeVisible();

    // One row stays its own set.
    await sort.getByRole("searchbox", { name: "Find a SportLots set" }).fill(OWN_LABEL);
    await sort.getByRole("button", { name: `${BRAND}: set ${OWN_LABEL} belongs to` }).click();
    await expect(onlyLinked).toBeVisible();
    await sort
      .getByRole("group", { name: `Where ${OWN_LABEL} goes` })
      .getByRole("button")
      .filter({ has: page.getByText("Its own set", { exact: true }) })
      .click();
    await expect(
      sort.getByRole("button", { name: `Its own set: set ${OWN_LABEL} belongs to` }),
    ).toBeVisible();

    await expect(sort.getByText(/^Save will file: 1 set · [0-9]+ parallels? · 1 insert$/)).toBeVisible();
    await sort.getByRole("button", { name: /^Save [0-9]+ SportLots sets?$/ }).click();
    await expect(page.getByText(/^Saved 1 set, [0-9]+ parallels?, 1 insert\.$/)).toBeVisible();

    await expect(page.getByRole("button", { name: "Sync Sets" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^[0-9]+ SportLots sets? (to sort|left — save again)$/ }),
    ).toBeHidden();
    await expect(sets.getByText(OWN_SET, { exact: true })).toBeVisible();
    await expect(columnOption(page, "Sets", "Bowman Sapphire Edition")).toBeVisible();
    await expect(sets.getByText("Bowman Gold", { exact: true })).toBeHidden();
  },
);
