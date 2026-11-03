// NEO-424: a player name already linked on a COMMITTED card elsewhere in the
// same set links to that same player when another variant of the set is synced,
// whatever sport the player is filed under, and the wizard SHOWS the link in its
// Decided list ("Linked to <name> (<sport>) · already on another card in this
// set") with a Change that reopens the
// step on the suggestion ("Link to <name> (<sport>)", creating demoted to
// "Add as New Player anyway"). Proved on live data through the operator's own
// path (Sync card checklist -> "Tidy up this set" -> Confirm & Save), twice:
//   1. Base: ONE name (STAR) is moved to Football and added as a new player with
//      "Also add Baseball to their sports" left unticked, every other name
//      skipped, saved. STAR is therefore a Football player, on a Baseball card.
//   2. The set's one INSERT is synced: the wizard opens with STAR already
//      decided, "Linked to STAR (Football) · already on another card in this
//      set", in the Decided list. Change
//      reopens the step on "Link to STAR (Football)"; pressing it reads back as
//      "Linked to STAR"; the rest are skipped and the insert is saved.
//   3. STAR's player page lists BOTH cards, each a Baseball guest card (the
//      auto-link never added the set's sport to the player), and no second
//      STAR was minted.
//
// FIXTURE (SET-REGISTRY.md -> "Baseball -> 2023 -> Topps Chrome NPB -- the
// NEO-424 set-history fixture", approved by Jason 2026-11-03): SOLE WRITER of
// Baseball -> 2023 -> Topps -> Topps Chrome NPB (its Base and one Insert), BSC
// only; FRESH-ONLY (R7a): it commits both checklists, so a re-run on the same
// seed fails at "No cards in this checklist yet." by name; each project gets its
// own seed (GUIDE "Desktop and mobile"). It never touches 2024 Topps Chrome NPB,
// which belongs to checklist-wizard-same-name-pick-step.
//
// The names are REAL checklist names, not minted ones (the same exception the
// same-name pick-step spec records): STAR and INSERT are TO BE CONFIRMED by the
// probe on dev (the plan is in SET-REGISTRY.md). STAR must be (a) a name on the
// Base that the reference catalogue does NOT hold in Baseball (else the Base
// wizard never presents it), (b) a card in INSERT, spelled the same way, and
// (c) absent from the 2024 NPB Base the pick-step spec fetches.
//
// The Football add reaches the enrichment lookup (the switch re-queues it): a
// name the recording does not hold in Football is answered no-match and logged
// as refused (NEO-413). See the registry entry's open question.
import type { Page } from "@playwright/test";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import {
  columnHeading,
  columnOption,
  columnSearch,
  drillToSet,
  openInsertsReconcile,
  setBuilderReady,
  syncChecklistButton,
} from "../../support/set-builder";
import { expectPlayersLoaded, PLAYERS_MATCHES, playersCounter } from "../../support/players";
import {
  answerPlayerAsNew,
  advanceToSave,
  confirmSaveButton,
  expectStepLeft,
  fetchOneMarketplaceSetChecklistToWizard,
  openDecidedList,
  personSkip,
  readBackDecision,
  readStep,
  reviewWizard,
  stepCounter,
  walkToPlayerRow,
} from "../../support/wizard";

const TARGET = { sport: "Baseball", year: "2023", manufacturer: "Topps", set: "Topps Chrome NPB" };
/** TO BE CONFIRMED by the probe: a Base name unknown to the Baseball catalogue that is also on the insert. */
const STAR = "Roki Sasaki";
/** TO BE CONFIRMED by the probe: the one insert of the set that carries STAR. */
const INSERT = "Rookie Autographs";
/** A live BSC (+ SportLots) checklist round trip: GUIDE hard rule 3, a marketplace round trip on data not pre-synced. */
const CHECKLIST_FETCH = 60_000;
/** The wizard opens behind the entity check's batch (a live round trip of our own backend, then the batch's lookups). */
const WIZARD_OPENS = 60_000;

/**
 * Walk the open Base wizard to STAR's New Player step, skipping every team,
 * league and player step in front of it (a skip creates nothing). Contract:
 * ENTRY the wizard is open. EXIT STAR's "Skip STAR - not a person" is on
 * screen, undecided. Bounded; a Base that never presents STAR fails by name.
 */
async function skipUntilPlayerRow(page: Page, name: string): Promise<void> {
  const wizard = reviewWizard(page);
  const target = wizard.getByRole("button", { name: `Skip ${name} — not a person`, exact: true });
  const anySkip = wizard.getByRole("button", {
    name: /^Skip .* — (not a person|not a team|this team has no league)$/,
    disabled: false,
  });
  for (let i = 0; i < 80; i++) {
    await expect(anySkip.first(), `the Base wizard never presented ${name}`).toBeVisible();
    if (await target.isVisible()) return;
    // The step's own skip names it, so its going away means the step moved on.
    const label = (await anySkip.first().getAttribute("aria-label")) ?? "";
    await anySkip.first().click();
    await expect(wizard.getByRole("button", { name: label, exact: true })).toBeHidden();
  }
  await expect(target, `${name} was not within 80 steps of the Base wizard's start`).toBeVisible();
}

/**
 * Decide every name still undecided as a skip and stop on the names-done
 * footer. Teams and leagues one by one (their lookups settle only as earlier
 * steps are decided), players in one "Skip remaining names" press; repeated,
 * bounded, because a player's lookup can stage a late career team. Contract:
 * ENTRY the wizard is open. EXIT "Next (Enter)" or Confirm & Save is on screen.
 */
async function skipEverythingLeft(page: Page): Promise<void> {
  const wizard = reviewWizard(page);
  const person = personSkip(page);
  const stepSkip = wizard.getByRole("button", {
    name: /^Skip .* — (not a team|this team has no league)$/,
    disabled: false,
  });
  const skipRemaining = wizard.getByRole("button", { name: /Skip remaining names \([0-9]+\)/ });
  const namesDone = wizard.getByRole("button", { name: "Next (Enter)", exact: true }).or(confirmSaveButton(page));
  for (let i = 0; i < 40; i++) {
    await expect(person.or(stepSkip).or(namesDone).first()).toBeVisible();
    if (await namesDone.isVisible()) break;
    // x is the decided count plus one on a name step, so any decision moves it.
    const { x } = await readStep(page);
    if (await stepSkip.first().isVisible()) {
      await stepSkip.first().click();
    } else {
      await skipRemaining.click();
    }
    await expectStepLeft(page, x);
  }
  await expect(namesDone).toBeVisible();
}

test(
  "Entity review — a name linked on a committed card of the set links to the same player on the set's next variant, shows in the Decided list, and Change reopens it on the suggestion (NEO-424)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const wizard = reviewWizard(page);
    const reconcile = page.getByRole("dialog", { name: "Reconcile Inserts" });

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // ── STEP 1: the Base. Fetch it BSC only; the wizard opens with nothing decided ──
    // One-marketplace helper: its precondition ("No cards in this checklist
    // yet.") is the fresh-only guard, and it leaves the wizard open, axe-clean.
    await fetchOneMarketplaceSetChecklistToWizard(page, env, TARGET);
    await expect(stepCounter(page)).toHaveText(/^Step 1 of [0-9]+$/);

    // Walk the team/league steps first (the shared walk, with its sanctioned
    // lookup waits), then skip forward to STAR's own row.
    await walkToPlayerRow(page);
    await skipUntilPlayerRow(page, STAR);
    await expect(wizard.getByRole("heading", { level: 3, name: `New Player: ${STAR}` })).toBeVisible();

    // ── STEP 2: STAR is a FOOTBALL player on this Baseball card, Baseball not added ──
    await wizard.getByRole("button", { name: `Sport for this name: ${TARGET.sport}` }).click();
    const chooser = wizard.getByRole("listbox", { name: "Choose a sport" });
    await expect(chooser).toBeVisible();
    await chooser.getByRole("option", { name: "Football" }).click();
    await expect(chooser).toBeHidden();
    // The switch re-queues the row's lookup and the walk can lead away from the
    // row for a moment; skipping forward again lands back on it (same contract).
    await skipUntilPlayerRow(page, STAR);
    await expect(wizard.getByRole("button", { name: "Sport for this name: Football" })).toBeVisible();
    // The cross-sport checkbox is offered, and left UNTICKED: the set's sport is
    // not added to his sports, which is what makes his Baseball cards guest cards.
    const alsoBaseball = wizard.getByRole("checkbox", { name: `Also add ${TARGET.sport} to their sports` });
    await expect(alsoBaseball).toBeVisible();
    await expect(alsoBaseball).not.toBeChecked();
    await answerPlayerAsNew(page);
    // Read the create back off STAR's own row, never the Decided list.
    await readBackDecision(page, "Added as new");
    await expect(wizard.getByRole("group", { name: `Decision for ${STAR}` })).toBeVisible();
    await wizard
      .getByRole("group", { name: `Decision for ${STAR}` })
      .getByRole("button", { name: "Next", exact: true })
      .click();
    await expect(wizard.getByText(/^Already decided:/)).toHaveCount(0);

    // ── STEP 3: every other name skipped (no other player is minted), then Save ──
    await skipEverythingLeft(page);
    await advanceToSave(page);
    await confirmSaveButton(page).click();
    // The commit: our own write, the 7 s bar.
    await expect(page.getByText(/Saved [1-9][0-9]* cards?/)).toBeVisible();

    // ── STEP 4: the insert. Warm drill (every level is synced now), open Insert ──
    await drillToSet(page, env, TARGET);
    await columnOption(page, "Variant Types", "Insert").click();
    if (!env.SL_PAUSED) {
      // Live: the column's own two-sided sync opens the Reconcile Inserts dialog
      // (or "Sync Inserts" does when the column is saved). This spec makes ONLY
      // its insert a set, by its exact button, never "Keep all".
      await openInsertsReconcile(page);
      await reconcile.getByRole("textbox", { name: "Filter NeonBinder sets" }).fill(INSERT);
      await reconcile.getByRole("textbox", { name: "Filter BSC items" }).fill(INSERT);
      const insertSet = reconcile.getByRole("textbox", { name: `NeonBinder set name for ${INSERT}`, exact: true });
      const makeOwn = reconcile.getByRole("button", { name: `Make its own set: ${INSERT}`, exact: true });
      await expect(insertSet.or(makeOwn)).toBeVisible();
      if (await makeOwn.isVisible()) await makeOwn.click();
      await expect(insertSet).toBeVisible();
      await reconcile.getByRole("button", { name: /^Save [0-9]+ sets/ }).click();
      await expect(reconcile).toBeHidden();
      await drillToSet(page, env, TARGET);
      await columnOption(page, "Variant Types", "Insert").click();
    } else {
      // Paused: one marketplace, nothing to reconcile; the column fills from BSC
      // alone (a live round trip on data nothing synced yet, GUIDE hard rule 3).
      await expect(columnHeading(page, "Inserts")).toBeVisible();
      await expect(reconcile).toBeHidden();
    }
    // The paused column fills from BSC when it is opened (the live one was saved
    // above): the listed row is the sync's proof, a live round trip.
    await columnSearch(page, "Inserts").fill(INSERT);
    await expect(columnOption(page, "Inserts", INSERT)).toBeVisible({ timeout: CHECKLIST_FETCH });
    await columnOption(page, "Inserts", INSERT).click();
    await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();
    await syncChecklistButton(page).click();

    // A SportLots set paired with the insert opens "Match Cards"; one source takes
    // the one-marketplace path. NEO-287: paused, the dialog is the bug.
    const matchCards = page.getByText(/Match Cards/).first();
    const kept = page.getByText(/Kept all [0-9]+ cards? from BSC/);
    await expect(matchCards.or(kept).or(wizard).first()).toBeVisible({ timeout: CHECKLIST_FETCH });
    if (env.SL_PAUSED) await expect(matchCards).toBeHidden();
    if (await matchCards.isVisible()) {
      const confirm = page.getByRole("button", { name: "Confirm card matches", disabled: false });
      await expect(confirm).toBeVisible({ timeout: CHECKLIST_FETCH });
      await confirm.click();
      await expect(page.getByText(/Match Cards/)).toBeHidden();
    }

    // ── STEP 5: the wizard opens BECAUSE of the auto-link, and shows it ──
    // REQUIRED (R2): the batch opens whenever the set's history resolved a name,
    // even if nothing is unknown; a fetch that saved straight through, or that
    // asked for STAR as a New Player, did not link him from the set.
    await expect(wizard, "the insert sync opens Tidy up this set for a name matched from the set").toBeVisible({
      timeout: WIZARD_OPENS,
    });
    const decided = await openDecidedList(page);
    const starRow = decided.getByRole("listitem").filter({ has: page.getByText(STAR, { exact: true }) });
    await expect(
      starRow.getByText(`Linked to ${STAR} (Football) · already on another card in this set`),
    ).toBeVisible();
    await expect(starRow.getByRole("button", { name: `Change decision for ${STAR}` })).toBeVisible();
    // The positive above is paired with its negative: he is not an undecided name.
    await expect(wizard.getByRole("button", { name: `Skip ${STAR} — not a person`, exact: true })).toBeHidden();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, a name matched from this set" });

    // ── STEP 6: Change reopens the step on the suggestion; pressing it links him ──
    await starRow.getByRole("button", { name: `Change decision for ${STAR}` }).click();
    const decision = wizard.getByRole("group", { name: `Decision for ${STAR}` });
    const linkSuggested = decision.getByRole("button", { name: `Link to ${STAR} (Football)`, exact: true });
    await expect(linkSuggested).toBeVisible();
    await expect(decision.getByRole("button", { name: "Add as New Player anyway", exact: true })).toBeVisible();
    await expect(
      wizard.getByText(`Another card in this set is already linked to ${STAR} (Football). Same one?`),
    ).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, suggested player after Change" });
    await linkSuggested.click();
    await readBackDecision(page, `Linked to ${STAR}`, { resume: true });

    // ── STEP 7: skip the rest, save the insert ──
    await skipEverythingLeft(page);
    await advanceToSave(page);
    await confirmSaveButton(page).click();
    await expect(page.getByText(/Saved [1-9][0-9]* cards?/)).toBeVisible();

    // ── STEP 8: STAR's page lists both cards as Baseball GUEST cards ──
    await page.goto("/admin/players");
    await expectPlayersLoaded(page);
    await page.getByRole("textbox", { name: "Filter players" }).fill(STAR);
    await expect(playersCounter(page, PLAYERS_MATCHES)).toBeVisible();
    await page.getByRole("button", { name: STAR }).click();
    await expect(page.getByText("Sport: Football").first()).toBeVisible();
    const cards = page.getByRole("list", { name: `Cards for ${STAR}` });
    // Exactly the Base card and the insert card; no second player was minted
    // for the insert (a second STAR would split them).
    await expect(cards.getByRole("listitem")).toHaveCount(2);
    await expect(cards).toContainText(INSERT);
    // Each card is tagged with its own sport only when it is NOT one of the
    // player's: two Baseball tags mean Baseball was never added to his sports.
    await expect(cards.getByText(TARGET.sport, { exact: true })).toHaveCount(2);
    await expectAccessible(page, { label: "Player detail with the Base and insert cards linked" });
  },
);
