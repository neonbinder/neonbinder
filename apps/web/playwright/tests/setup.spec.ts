// Origin: .maestro/flows/setup.yaml (Maestro suite retired in NEO-341; see git history)
//
// THE GLOBAL SEED TRACK.
//
// Runs ONCE, as worker 0, in the seed job, after `e2e-baseline.sh reset`
// (project `setup`, never sharded). Every later spec reads what it builds:
//   * 2024 Topps Chrome Baseball: Base (335 cards, both marketplaces paired),
//     the Future Stars insert (20 cards), the Gold Wave Refractors parallel
//     (300 cards built from Base);
//   * 2024 Topps Stars of MLB Network: Base mapped, checklist left empty
//     (the read-only wizard specs' fixture; NEO-475, it was Topps Big League);
//   * 2026 Bowman: SportLots sets sorted (NEO-312 fixture).
//
// NOT provisioned here, deliberately: the entity-review fixtures each wizard
// spec owns (since NEO-330 the Hockey 1995 minor-league sets, Tulsa Oilers /
// Memphis RiverKings / San Antonio Iguanas / Fort Worth Fire CHL, and the
// Hockey 1995 columns above them). Each set is owned by exactly one spec and
// the fetch helpers handle the cold first-time path, so each spec provisions
// its own set, in parallel. Several workers syncing the shared Hockey 1995
// columns at once double a round-trip and never a row (SET-REGISTRY.md, "The
// 1995 minor-league hockey wizard fixtures"), so those are not pre-synced.
//
// The Base fetch is given the publisher's checklist (NEO-478/482, D8 amended):
// BSC's own per-card answers for 2024 Topps Chrome Base, captured to
// fixtures/checklists/2024-topps-chrome-base.csv with card #300's row left OUT.
// So the fetch asks BSC for the bulk checklist and for ONE card, #300, and the seed
// no longer makes a card-listing call per card (it was about 300 calls, and the
// reason a seed met BSC's 429). The seed is therefore NOT the live proof for
// per-card lookups: those are `checklist-bsc-team-enrichment` (card #300),
// `checklist-fetch-bounds-a-bsc-stall-and-queues-the-cards` and
// `checklist-published-upload-skips-bsc-and-asks-on-disagreement`. The Insert and
// the Gold Wave build stay live syncs.
//
// R5 exempts the seed as a class: every wait below is the flow's own measured
// cold-path value (live marketplace round trips on unwarmed data).
// "A SYNC THAT HALF-WORKED IS A FAILED SEED": after every sync the partial-
// failure banners must be absent (expectNoSyncFailure).
import { test, expect } from "../support/fixtures";
import { loginToSportLots, openBscCredentials } from "../support/credentials";
import {
  addCustomManufacturer,
  ANY_COLUMN_SYNC_FAILED,
  columnHeading,
  columnOption,
  columnSearch,
  columnSyncError,
  drillToBaseVariant,
  drillToColdManufacturer,
  drillToSet,
  pick,
  setBuilderReady,
  syncChecklistButton,
} from "../support/set-builder";
import { CHECKLISTS, expectTeamsFromChecklist, usePublishersChecklist, type ChecklistFacts } from "../support/published-checklist";
import {
  addAsNewStep,
  advanceToSave,
  answerStepAsNew,
  checklistDisagreementHeading,
  confirmSaveButton,
  reviewWizard,
  stepCounter,
} from "../support/wizard";
import type { Page } from "@playwright/test";

const SL_PAUSE_NOTICE = "SportLots is on pause: nothing from SportLots was asked for or changed.";

// NEO-450: ANY_COLUMN_SYNC_FAILED (support/set-builder.ts) matches any
// column's failed-sync sentence; column-sync-failed-shows-only-the-error
// proves it matches the rendered one.
async function expectNoSyncFailure(page: Page) {
  await expect(page.getByText(/could not be reached, so nothing from .* was changed/)).toBeHidden();
  // Count, not visibility: two failed columns would make `toBeHidden` a
  // strict-mode error rather than a failure that names the sentence.
  await expect(page.getByText(ANY_COLUMN_SYNC_FAILED), "a set-builder column's sync failed").toHaveCount(0);
}

/**
 * Fetch a variant's checklist and settle the card-pairing dialog: keep every
 * card only one marketplace has, then confirm. Waits are the caller's (the
 * Base and the insert checklists have different measured ceilings).
 */
async function fetchChecklist(
  page: Page,
  facts: ChecklistFacts,
  { open, settle }: { open: number; settle: number },
) {
  const pairing = page.getByRole("dialog", { name: /^Match Cards/ });
  const wizard = reviewWizard(page);
  const saved = page.getByText(/Saved [0-9]+/);

  await syncChecklistButton(page).click();
  // NEO-496 (D10, NQ1): the uploaded checklist is a source of its own, so Match Cards opens on
  // both branches: live it lines up BSC, SportLots and the checklist; with SportLots paused, BSC
  // and the checklist (two sources, as two marketplaces always were).
  await expect(pairing).toBeVisible({ timeout: open });
  // The confirm button reads "Loading…" until every source has streamed in and the teams landed.
  const confirm = pairing.getByRole("button", { name: "Confirm card matches" });
  await expect(confirm).toHaveText("Confirm", { timeout: 120_000 });
  await expect(pairing.getByRole("button", { name: "Confirm card matches", disabled: false })).toBeVisible();
  // The result line is the proof the file, not BSC, supplied the teams (N read off the file). It
  // is on the page while the dialog is open; after Confirm only the saved line repeats it.
  await expectTeamsFromChecklist(page, facts);
  for (const side of ["BSC", "SportLots"]) {
    // Each side's unmatched section is headed "<side> only (<n>)"; a card the file leaves out (the
    // Base's #300) waits there and is discarded unless kept. The seed keeps every marketplace card.
    const unmatched = pairing.getByRole("heading", { name: new RegExp(`^${side} only \\([1-9][0-9]*\\)$`) });
    if (await unmatched.isVisible()) {
      await pairing.getByRole("button", { name: `Keep all ${side}-only cards` }).click();
      await expect(pairing.getByRole("heading", { name: `${side} only (0)` })).toBeVisible();
    }
  }
  // Checklist rows no card paired are left in their column: the seed saves the marketplace's cards.
  await confirm.click();
  await expect(pairing).toBeHidden({ timeout: settle });
  await expect(wizard.or(saved).first()).toBeVisible({ timeout: settle });
}

/**
 * Walk the entity-review wizard of a freshly fetched Base checklist to its
 * Save step and save: bulk-add the unknown players, then answer every team,
 * league and pick step one at a time (live enrichment lookups), leave the
 * post-name steps on their defaults, confirm. Shared by the seed's big Base
 * checklists; `maxSteps` bounds the walk (a team/league/pick step each).
 */
async function walkWizardToSave(page: Page, maxSteps: number) {
  const wizard = reviewWizard(page);
  await wizard.getByRole("button", { name: /^Add remaining players as new/ }).click();
  // Enabled only: the button is aria-disabled while the row's enrichment
  // lookup is in flight, and between rows.
  // Any state: a league step's primary is held until a level is pressed
  // (NEO-331), and answerStepAsNew presses "Other" first.
  const addAsNew = addAsNewStep(page);
  // NEO-335: "names done" is two footer states. With every name decided the
  // wizard walks on to "Cards with no team" / "Card titles" (footer "Next
  // (Enter)", no Confirm & Save), then "Ready to save" (the only step with
  // Confirm & Save). Neither button is on screen while a name is undecided.
  const namesDone = wizard.getByRole("button", { name: /^Next \(Enter\)$|Confirm & Save/ });
  // NEO-330: with the reference catalogue loaded the Base batch is a
  // handful of names, and some are same-name players the bulk leaves for
  // the operator. Such a row is the PICK step (NEO-332), inserted ready, so
  // it can be on screen from the start. It is answered by LINKING the top
  // candidate, never `Add as New Player` (that mints one more same-name
  // player). No spec reads these rows and the reset rebuilds them. Scoped
  // to the candidate list so the footer's `Link to existing instead` is out.
  const pickStep = wizard.getByRole("heading", { level: 3, name: /^Which .* is this\?$/ });
  const firstCandidate = wizard
    .getByRole("list", { name: "Players already filed under this name" })
    .getByRole("button", { name: /^Link to / })
    .first();
  // Teams and leagues are walked one at a time (enrichment lookups; the
  // flow's 240 s per step and 250 steps at most). The wait wakes on every
  // answerable outcome: a team/league step, a pick step, or the end.
  for (let i = 0; i < maxSteps; i++) {
    await expect(addAsNew.or(pickStep).or(namesDone).first()).toBeVisible({ timeout: 240_000 });
    if (await namesDone.isVisible()) break;
    if (await pickStep.isVisible()) {
      const step = ((await pickStep.textContent()) ?? "").trim();
      await firstCandidate.click();
      // By the exact heading: a following pick step has another name.
      await expect(
        wizard.getByRole("heading", { level: 3, name: step, exact: true }),
        `"${step}" is still on screen after Link to`,
      ).toBeHidden();
    } else {
      await answerStepAsNew(page);
    }
  }
  // The teams / titles steps, each left on its defaults by Next (the answers
  // the old final step's Confirm & Save saved), then the Save step. The seed
  // is a data-loading track; it proves none of those steps.
  await advanceToSave(page);
  await confirmSaveButton(page).click();
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
  "Setup — global reset + warm + sync 2024 Topps Chrome Baseball (Base + Insert + Parallel) + 2024 Topps Stars of MLB Network (Base mapped) + 2026 Bowman's SportLots review",
  { tag: ["@setup"] },
  async ({ page, signIn, env }) => {
    // ── sign in, per-user reset, seed creds, land on /admin ────────────────
    await signIn("/testing/reset?redirect=/testing/seed-credentials?redirect=/admin");
    await expect(page.getByText(/Build set parameters from marketplace data/)).toBeVisible({
      timeout: 120_000,
    });
    // NEO-445: the seed hop above already signed in live; the Test press is proven by test-credentials and credentials-lifecycle, and a BSC stall must not fail the seed.
    await openBscCredentials(page);
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
      // Paused: the Set Builder strip is the pause's proof at the root. The
      // Sports column's own "done" notice only exists when a Sports sync RAN,
      // and the reference-seed bundle (NEO-330) loads the sport rows, ids and
      // all, so there is nothing to sync and no per-column notice is asserted here (one
      // may exist if a forced Sync Sports ran earlier, which is order). The
      // per-column paused sentence now shows under Years, the first sync that
      // runs with SportLots' ids in hand (asserted below).
      await expect(page.getByText("SportLots is on pause.")).toBeVisible();
    }
    await pick(page, "Sports", "Baseball", { search: false });

    // ── Years → 2024 ───────────────────────────────────────────────────────
    await expect(columnHeading(page, "Years")).toBeVisible({ timeout: 20_000 });
    // A failed sync shows the column's alert and no listbox: wake on it too
    // and fail at once, by name (NEO-450).
    await expect(
      page.getByRole("listbox", { name: "Years" }).or(columnSyncError(page, "Years")).first(),
    ).toBeVisible({ timeout: 90_000 });
    await expectNoSyncFailure(page);
    if (env.SL_PAUSED) {
      // Baseball carries SportLots' id from the seeded catalogue, so SportLots
      // is resolvable here and the pause is what kept it from being asked.
      // Scoped to Years' own notice (the one carrying "Dismiss Years notice"),
      // so a Sports notice left by a forced Sports sync cannot make it ambiguous.
      await expect(
        page
          .getByRole("status")
          .filter({ has: page.getByRole("button", { name: "Dismiss Years notice" }) })
          .getByText(SL_PAUSE_NOTICE),
      ).toBeVisible();
    }
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
      // NEO-450: a failed sync hides the idle line and shows the column's
      // alert instead; wake on either so a failure reds here, by name.
      const noManufacturers = page.getByText("No manufacturers available. Sync from marketplaces to populate.");
      await expect(noManufacturers.or(columnSyncError(page, "Manufacturers"))).toBeVisible({ timeout: 45_000 });
      await expectNoSyncFailure(page);
      await expect(noManufacturers).toBeVisible();
      await addCustomManufacturer(page, "Topps");
      await columnOption(page, "Manufacturers", "Topps").click();
    }

    // ── Sets → Topps Chrome ────────────────────────────────────────────────
    await expect(columnHeading(page, "Sets")).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByRole("listbox", { name: "Sets" }).or(columnSyncError(page, "Sets")).first(),
    ).toBeVisible({ timeout: 45_000 });
    await expectNoSyncFailure(page);
    await pick(page, "Sets", "Topps Chrome");

    // ── Variant Types: Base / Insert / Parallel ────────────────────────────
    await expect(columnHeading(page, "Variant Types")).toBeVisible({ timeout: 20_000 });
    const base = columnOption(page, "Variant Types", "Base");
    const noTypes = page.getByText("No variant types available. Sync from marketplaces to populate.");
    // NEO-450: a failed sync hides the idle line and shows the column's alert
    // instead. Either one earns the seed's single retry (the `Sync Variant
    // Types` press below), exactly as forgiving as before; a second failure
    // leaves no Base and fails the hard asserts after it.
    const typesError = columnSyncError(page, "Variant Types");
    await expect(base.or(noTypes).or(typesError).first()).toBeVisible({ timeout: 45_000 });
    if ((await noTypes.isVisible()) || (await typesError.isVisible())) {
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
    // The captured checklist goes in before the Sync: the fetch then asks BSC for no card
    // the file answers (a seed with a card-listing call per card met BSC's 429).
    const facts = await usePublishersChecklist(page, CHECKLISTS.toppsChrome2024Base);
    await fetchChecklist(page, facts, { open: 60_000, settle: 60_000 });

    // First run: confirm every new player/team/league the checklist names.
    // NEO-335: the wizard's dialog name is "Tidy up this set"; "Confirm New
    // Players & Teams" is gone.
    const wizard = reviewWizard(page);
    if (await wizard.isVisible()) {
      // The file is BSC's own answers, so it cannot disagree with BSC: a "Checklist says
      // otherwise" step here means the capture is stale (re-capture it, SET-REGISTRY.md),
      // and the walk below would sit on a step it has no answer for until its 240 s ran out.
      await expect(stepCounter(page)).toBeVisible();
      await expect(
        checklistDisagreementHeading(page),
        "the seed's 2024-topps-chrome-base.csv disagrees with BSC (Checklist says otherwise): the capture is stale",
      ).toBeHidden();
      await walkWizardToSave(page, 250);
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
    // The seed's Future Stars checklist is BSC's own answers (the 20 cards), so the fetch asks BSC
    // for no card (D4): the BSC listing specs that read this set no longer depend on 20 live reads.
    const futureStars = await usePublishersChecklist(page, CHECKLISTS.futureStars2024);
    await fetchChecklist(page, futureStars, { open: 90_000, settle: 90_000 });
    // Every Future Stars player is already known from Base: no NAMES review.
    // NEO-335: one wizard shape is legitimate here, NO NAMES and past-the-names
    // steps only: a card that would save with no team (a SportLots-only card
    // never carries one) or a new card whose title gets trimmed opens the
    // review straight onto "Cards with no team" / "Card titles" (Step 1 of ...).
    // fetchChecklist waited for the wizard or the "Saved" banner, so which one
    // is up is settled and read once. The seed answers nothing on those steps.
    if (await wizard.isVisible()) {
      // The file is BSC's own answers, so a "Checklist says otherwise" step means the capture is stale.
      await expect(stepCounter(page)).toBeVisible();
      await expect(
        checklistDisagreementHeading(page),
        "the seed's 2024-topps-chrome-insert-future-stars.csv disagrees with BSC (Checklist says otherwise): the capture is stale",
      ).toBeHidden();
      // A names review fails here, by name: nothing is undecided.
      await expect(wizard.getByRole("button", { name: /Skip remaining names|Add remaining players as new/ })).toHaveCount(0);
      await expect(wizard.getByText(/^(Cards with no team|Card titles)$/)).toBeVisible();
      await expect(wizard.getByText(/^Step 1 of [0-9]+$/)).toBeVisible();
      await advanceToSave(page);
      // The Save step, for all 20; the strict count below then pins the save.
      await expect(wizard.getByRole("heading", { name: "Save 20 cards?" })).toBeVisible();
      await confirmSaveButton(page).click();
    }
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
    await expect(reviewWizard(page)).toBeHidden();
    await expect(page.getByText(/^#[0-9]/).first()).toBeVisible({ timeout: 15_000 });
    if (!env.SL_PAUSED) {
      await expect(page.getByText("SL", { exact: true }).first()).toBeVisible();
    } else {
      await expect(page.getByText("BSC", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("BSC only", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("SL", { exact: true })).toHaveCount(0);
    }

    // ── 2024 Topps Stars of MLB Network: base mapped, checklist left empty ──
    // The read-only wizard specs' fixture (fetchChecklistToWizard's default;
    // SET-REGISTRY.md "Topps Stars of MLB Network"). NEO-475: it replaced Topps
    // Big League (310 cards) with a 10-card set, so every wizard fetch reads 10
    // BSC cards instead of 310. Filed under 2024 Topps by its name, so the
    // year-wide Sets sync above already listed it. The live branch is
    // UNMEASURED on this set (retargeted while SportLots was paused): the
    // drill maps the picker's first SportLots candidate, as it did on Big
    // League; the first live run must check that candidate is this set.
    await drillToBaseVariant(page, env, { set: "Topps Stars of MLB Network" });
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

    await drillToColdManufacturer(page, env, { sport: "Baseball", year: "2026", manufacturer: BRAND, expectSets: true });
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
