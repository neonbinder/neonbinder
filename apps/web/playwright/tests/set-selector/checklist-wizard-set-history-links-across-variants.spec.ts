// NEO-424: set history. A name already linked on a COMMITTED card elsewhere in
// the same set links to that same player when another variant of the set is
// synced, whatever sport the player is filed under, and the wizard SHOWS the
// link in its Decided list with a Change that reopens the step. Proved on live
// data through the operator's own path (Sync card checklist -> "Tidy up this
// set" -> Confirm & Save), insert to insert (set history covers the whole set,
// and the Base's 62 s live fetch is over the 7 s budget, so the spec skips it).
// Four phases in one test, all inside Baseball -> 2010 -> Topps -> Topps:
//   0. FIXTURE, from the UI: a FOOTBALL player "Michael Brantley" on
//      /admin/players (rule E2's one-namesake case).
//   1. Team Bonus: its one unknown name, STAR, is moved to Football and added as
//      a new player ("Also add Baseball to their sports" left unticked), saved.
//   2. Silk Collection (rule A, cross-sport, and E2): STAR arrives already linked,
//      "Linked to STAR (Football) · already on another card in this set"; Change
//      reopens "Link to STAR (Football)", pressed and read back. Its other
//      unknown name, Brantley, shows E2: "Link to Michael Brantley (Football)"
//      primary, "Add as New Player anyway" demoted, the reason line; skipped.
//   3. Peak Performance (Hall of Fame tie-break): Bob Gibson and Joe Morgan, two
//      on file each and none active in 2010, arrive linked as "the Hall of
//      Famer"; Change on Joe Morgan lists both namesakes, then re-links; the
//      St. Louis Browns are LINKED to the catalogue's 1902-1953 row from the
//      team step.
// Finally STAR's player page lists exactly his two cards as Baseball guest cards.
//
// FIXTURE (SET-REGISTRY.md -> "Baseball -> 2010 -> Topps -> Topps -- the NEO-424
// set-history fixture"; the set approved by Jason 2026-11-03, the variants chosen
// by the dev probe): SOLE WRITER of those three inserts and of the year, BSC only;
// FRESH-ONLY (R7a): it commits three checklists, so a re-run on the same seed
// fails at "No cards in this checklist yet." by name; each project gets its own
// seed (GUIDE "Desktop and mobile"). No other flow touches 2010.
//
// The names are REAL checklist names, not minted ones (the same exception the
// same-name pick-step spec records). Every lookup the flow reaches is in the
// enrichment recording (convex/adapters/__fixtures__/enrichment-lookups.json,
// docs/operations/neo289-enrichment-fixtures.md section 4a): STAR in Baseball
// and Football, Brantley in Football, the Browns and the Senators, so nothing
// goes to Wikidata and no refusal is logged.
import type { Page } from "@playwright/test";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import {
  COLD_SYNC,
  columnHeading,
  columnOption,
  columnSearch,
  drillToColdManufacturer,
  drillToSet,
  openInsertsReconcile,
  pick,
  setBuilderReady,
  syncChecklistButton,
  VARIANT_TYPES_SYNC,
} from "../../support/set-builder";
import { addPlayerByHand, expectPlayersLoaded, PLAYERS_MATCHES, playersCounter } from "../../support/players";
import {
  answerPlayerAsNew,
  advanceToSave,
  confirmSaveButton,
  expectStepLeft,
  openDecidedList,
  personSkip,
  readBackDecision,
  readStep,
  reviewWizard,
  stepCounter,
  walkToPlayerRow,
} from "../../support/wizard";

const TARGET = { sport: "Baseball", year: "2010", manufacturer: "Topps", set: "Topps" };
/** Unknown to the Baseball catalogue, on both inserts below (measured on dev 2026-11-03). */
const STAR = "Kendry Morales";
/** Fetched and committed first: STAR is its only unknown name. */
const FIRST = "Team Bonus";
/** Fetched second: STAR arrives linked; Michael Brantley is its one other unknown name. */
const SECOND = "Silk Collection";
/** Hall of Fame phase: Bob Gibson and Joe Morgan, two on file each, none active in 2010. */
const THIRD = "Peak Performance";
const INSERTS = [FIRST, SECOND, THIRD];
const BRANTLEY = "Michael Brantley";
const GIBSON = "Bob Gibson";
const MORGAN = "Joe Morgan";
const BROWNS = "St. Louis Browns";
/**
 * GUIDE hard rule 3, the exception "a step that directly drives a live
 * BSC/SportLots round trip on data that is not pre-synced": a fetch of an
 * insert never fetched before, and the column's first sync. Only those waits
 * carry it; the wizard opening afterwards is our own backend at the 7 s default.
 */
const LIVE_BSC_FETCH = 60_000;

/**
 * Walk the open wizard to `name`'s step, skipping every team, league and player
 * step in front of it (a skip creates nothing). Contract: ENTRY the wizard is
 * open. EXIT `name`'s own skip ("Skip <name> - not a person" / "- not a team")
 * is on screen, undecided. Bounded; a fetch that never presents `name` fails by
 * name.
 */
async function skipUntilRow(page: Page, name: string): Promise<void> {
  const wizard = reviewWizard(page);
  const target = wizard
    .getByRole("button", { name: `Skip ${name} — not a person`, exact: true })
    .or(wizard.getByRole("button", { name: `Skip ${name} — not a team`, exact: true }));
  const anySkip = wizard.getByRole("button", {
    name: /^Skip .* — (not a person|not a team|this team has no league)$/,
    disabled: false,
  });
  for (let i = 0; i < 80; i++) {
    await expect(anySkip.first(), `the wizard never presented ${name}`).toBeVisible();
    if (await target.isVisible()) return;
    // The step's own skip names it, so its going away means the step moved on.
    const label = (await anySkip.first().getAttribute("aria-label")) ?? "";
    await anySkip.first().click();
    await expect(wizard.getByRole("button", { name: label, exact: true })).toBeHidden();
  }
  await expect(target, `${name} was not within 80 steps of the wizard's start`).toBeVisible();
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

/**
 * Open `name` under the set's Insert type and fetch its checklist, leaving the
 * wizard open. Contract: ENTRY the Variant Types column is open with Insert
 * listed. `reconcile` (live only) makes this spec's three inserts their own
 * sets in the Reconcile Inserts dialog, by their exact buttons, never "Keep
 * all"; the paused column fills from BSC alone and has nothing to reconcile.
 * EXIT the "Tidy up this set" dialog is open (a fetch that saved straight
 * through fails here, by name).
 */
async function fetchInsertToWizard(
  page: Page,
  env: Parameters<typeof drillToSet>[1],
  name: string,
  { reconcile }: { reconcile: boolean },
): Promise<void> {
  const wizard = reviewWizard(page);
  const dialog = page.getByRole("dialog", { name: "Reconcile Inserts" });
  await columnOption(page, "Variant Types", "Insert").click();
  if (!env.SL_PAUSED && reconcile) {
    await openInsertsReconcile(page);
    for (const insert of INSERTS) {
      await dialog.getByRole("textbox", { name: "Filter NeonBinder sets" }).fill(insert);
      await dialog.getByRole("textbox", { name: "Filter BSC items" }).fill(insert);
      const insertSet = dialog.getByRole("textbox", { name: `NeonBinder set name for ${insert}`, exact: true });
      const makeOwn = dialog.getByRole("button", { name: `Make its own set: ${insert}`, exact: true });
      await expect(insertSet.or(makeOwn)).toBeVisible();
      if (await makeOwn.isVisible()) await makeOwn.click();
      await expect(insertSet).toBeVisible();
    }
    await dialog.getByRole("button", { name: /^Save [0-9]+ sets/ }).click();
    await expect(dialog).toBeHidden();
    // Saving leaves the columns at the offset the dialog opened from: re-drill.
    await drillToSet(page, env, TARGET);
    await columnOption(page, "Variant Types", "Insert").click();
  } else if (env.SL_PAUSED) {
    await expect(columnHeading(page, "Inserts")).toBeVisible();
    await expect(dialog).toBeHidden();
  }
  // The paused column fills from BSC when it is opened (the live one was saved
  // above): the listed row is the sync's proof, a live round trip.
  await columnSearch(page, "Inserts").fill(name);
  await expect(columnOption(page, "Inserts", name)).toBeVisible({ timeout: LIVE_BSC_FETCH });
  await columnOption(page, "Inserts", name).click();
  // The empty-checklist assert makes the saved cards below THIS fetch's (fresh-only guard).
  await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();
  await syncChecklistButton(page).click();

  // A SportLots set paired with the insert opens "Match Cards"; one source takes
  // the one-marketplace path. NEO-287: paused, the dialog is the bug.
  const matchCards = page.getByText(/Match Cards/).first();
  const kept = page.getByText(/Kept all [0-9]+ cards? from BSC/);
  await expect(matchCards.or(kept).or(wizard).first()).toBeVisible({ timeout: LIVE_BSC_FETCH });
  if (env.SL_PAUSED) await expect(matchCards).toBeHidden();
  if (await matchCards.isVisible()) {
    const confirm = page.getByRole("button", { name: "Confirm card matches", disabled: false });
    await expect(confirm).toBeVisible({ timeout: LIVE_BSC_FETCH });
    await confirm.click();
    await expect(page.getByText(/Match Cards/)).toBeHidden();
  }
  // Our own backend after the live fetch: the 7 s default.
  await expect(wizard, `${name}'s sync opens Tidy up this set`).toBeVisible();
}

test(
  "Entity review — a name linked on a committed card of the set links to the same player on the set's next variant (a player of another sport, a Hall of Famer), shows in the Decided list, and Change reopens it on the suggestion (NEO-424)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const wizard = reviewWizard(page);

    // ── PHASE 0: the fixture, from the UI: a FOOTBALL Michael Brantley ──
    // Rule E2 needs exactly one player of the name in some OTHER sport. His
    // Football lookup is a recorded no-match, so the add sends nothing to Wikidata.
    await signIn("/admin/players");
    await expectPlayersLoaded(page, LAUNCH_GATE);
    await addPlayerByHand(page, BRANTLEY, "Football");

    // ── PHASE 1: cold drill to Baseball / 2010 / Topps / Topps, open Insert ──
    // No spec has opened 2010, so every column arrives empty and syncs itself
    // (the helper pays those waits). Paused, the helper hand-makes the `Topps`
    // manufacturer row: nothing syncs the brand list from SportLots, and this
    // spec is that row's only writer.
    await drillToColdManufacturer(page, env, { sport: TARGET.sport, year: TARGET.year, manufacturer: TARGET.manufacturer });
    // The Sets column's LISTBOX renders only once it holds a row (GUIDE hard rule 3, a live BSC round trip).
    await expect(page.getByRole("listbox", { name: "Sets" })).toBeVisible({ timeout: LIVE_BSC_FETCH });
    await pick(page, "Sets", TARGET.set);
    await expect(columnHeading(page, "Variant Types")).toBeVisible();
    await expect(columnOption(page, "Variant Types", "Insert")).toBeVisible({ timeout: VARIANT_TYPES_SYNC });

    // FIRST. Its one unknown name is STAR; he is a FOOTBALL player on a Baseball card.
    await fetchInsertToWizard(page, env, FIRST, { reconcile: true });
    await expect(stepCounter(page)).toHaveText(/^Step 1 of [0-9]+$/);
    await walkToPlayerRow(page);
    await skipUntilRow(page, STAR);
    // The step is a New player step (the subtitle) headed by the name alone.
    await expect(wizard.getByRole("heading", { level: 3, name: STAR, exact: true })).toBeVisible();
    await expect(wizard.getByText("New player", { exact: true })).toBeVisible();
    await wizard.getByRole("button", { name: `Sport for this name: ${TARGET.sport}` }).click();
    const chooser = wizard.getByRole("listbox", { name: "Choose a sport" });
    await expect(chooser).toBeVisible();
    await chooser.getByRole("option", { name: "Football" }).click();
    await expect(chooser).toBeHidden();
    // The switch re-queues the row's lookup and the walk can lead away from the
    // row for a moment; skipping forward again lands back on it (same contract).
    await skipUntilRow(page, STAR);
    await expect(wizard.getByRole("button", { name: "Sport for this name: Football" })).toBeVisible();
    // The cross-sport checkbox is offered, and left UNTICKED: the set's sport is
    // not added to his sports, which is what makes his Baseball cards guest cards.
    const alsoBaseball = wizard.getByRole("checkbox", { name: `Also add ${TARGET.sport} to their sports` });
    await expect(alsoBaseball).toBeVisible();
    await expect(alsoBaseball).not.toBeChecked();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, a name moved to Football" });
    await answerPlayerAsNew(page);
    // Read the create back off STAR's own row, never the Decided list.
    await readBackDecision(page, "Added as new");
    await expect(wizard.getByRole("group", { name: `Decision for ${STAR}` })).toBeVisible();
    await wizard
      .getByRole("group", { name: `Decision for ${STAR}` })
      .getByRole("button", { name: "Next", exact: true })
      .click();
    await expect(wizard.getByText(/^Already decided:/)).toHaveCount(0);

    // Every other name skipped (none should be left), then Save.
    await skipEverythingLeft(page);
    await advanceToSave(page);
    await confirmSaveButton(page).click();
    // The commit: our own write, the 7 s bar.
    await expect(page.getByText(/Saved [1-9][0-9]* cards?/)).toBeVisible();

    // ── PHASE 2: SECOND. STAR arrives linked from the set's history; Brantley is rule E2 ──
    await drillToSet(page, env, TARGET);
    await fetchInsertToWizard(page, env, SECOND, { reconcile: false });

    // The one undecided name is Brantley, and he is a SUGGESTION: exactly one
    // Michael Brantley is on file (the Football player made above), so the
    // primary reads "Link to ..." and creating is demoted. Nothing is linked: he is skipped.
    const brantleyStep = wizard.getByRole("group", { name: `Decision for ${BRANTLEY}` });
    await expect(brantleyStep.getByRole("button", { name: `Link to ${BRANTLEY} (Football)`, exact: true })).toBeVisible();
    await expect(brantleyStep.getByRole("button", { name: "Add as New Player anyway", exact: true })).toBeVisible();
    await expect(
      wizard.getByText(`We've only got one ${BRANTLEY} (Football) on file. Same one?`),
    ).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, one namesake on file (rule E2)" });
    await wizard.getByRole("button", { name: `Skip ${BRANTLEY} — not a person`, exact: true }).click();
    await expect(brantleyStep).toBeHidden();

    // STAR was never an undecided step: he is in the Decided list, linked, with the reason.
    await expect(wizard.getByRole("button", { name: `Skip ${STAR} — not a person`, exact: true })).toBeHidden();
    const decided = await openDecidedList(page);
    const starRow = decided.getByRole("listitem").filter({ has: page.getByText(STAR, { exact: true }) });
    await expect(
      starRow.getByText(`Linked to ${STAR} (Football) · already on another card in this set`),
    ).toBeVisible();
    await expect(starRow.getByRole("button", { name: `Change decision for ${STAR}` })).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, a name matched from this set" });

    // Change reopens the step on the suggestion; pressing it links him.
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

    await skipEverythingLeft(page);
    await advanceToSave(page);
    await confirmSaveButton(page).click();
    await expect(page.getByText(/Saved [1-9][0-9]* cards?/)).toBeVisible();

    // ── PHASE 3: THIRD. The Hall of Fame tie-break, and a team LINKED from its step ──
    await drillToSet(page, env, TARGET);
    await fetchInsertToWizard(page, env, THIRD, { reconcile: false });
    const hofDecided = await openDecidedList(page);
    const decidedRow = (who: string) => hofDecided.getByRole("listitem").filter({ has: page.getByText(who, { exact: true }) });
    for (const who of [GIBSON, MORGAN]) {
      // Two on file each, none active in 2010: exactly one is in the Hall of Fame,
      // so the batch linked him. Baseball players, so the line carries no sport.
      await expect(decidedRow(who).getByText(`Linked to ${who} · the Hall of Famer`)).toBeVisible();
      await expect(decidedRow(who).getByRole("button", { name: `Change decision for ${who}` })).toBeVisible();
    }
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, Hall of Famers linked" });

    // Change on Joe Morgan: the pick step lists BOTH namesakes; the Hall of
    // Famer (b. 1943) is linked again by hand and read back off its own row.
    await decidedRow(MORGAN).getByRole("button", { name: `Change decision for ${MORGAN}` }).click();
    await expect(wizard.getByRole("heading", { level: 3, name: `Which ${MORGAN} is this?` })).toBeVisible();
    const namesakes = wizard
      .getByRole("list", { name: "Players already filed under this name" })
      .getByRole("button", { name: new RegExp(`^Link to ${MORGAN}, `) });
    await expect(namesakes).toHaveCount(2);
    await wizard.getByRole("button", { name: new RegExp(`^Link to ${MORGAN}, b\\. 1943`) }).click();
    await readBackDecision(page, new RegExp(`^Linked to ${MORGAN}, b\\. 1943`), { resume: true });

    // The St. Louis Browns: LINKED to the catalogue's row of that exact name
    // (the 1902-1953 era), from the team step. The remember-box is unticked so
    // no alias is written, and the decision line carries no "remembered as".
    await skipUntilRow(page, BROWNS);
    await expect(wizard.getByRole("heading", { level: 3, name: `New Team: ${BROWNS}` })).toBeVisible();
    const remember = wizard.getByRole("checkbox", { name: `Remember “${BROWNS}” as a name for this team` });
    await remember.uncheck();
    await expect(remember).not.toBeChecked();
    await wizard.getByRole("combobox", { name: "Search all teams" }).click();
    await page.getByRole("option", { name: /same name . [A-Z]+ . 1902.1953/ }).click();

    // The other historic clubs and every other name are skipped; nothing else is minted.
    await skipEverythingLeft(page);
    await advanceToSave(page);
    // Read the link back off the Save step's summary of the batch (the Decided
    // list is not rendered once every name is decided, and the footer's Back
    // opens the batch's last row, not the one decided a moment ago). A FULL
    // match: no "remembered as" tail.
    await expect(wizard.getByText(`Linked to ${BROWNS}`, { exact: true })).toBeVisible();
    await confirmSaveButton(page).click();
    await expect(page.getByText(/Saved [1-9][0-9]* cards?/)).toBeVisible();

    // ── PHASE 4: STAR's page lists both cards as Baseball GUEST cards ──
    await page.goto("/admin/players");
    await expectPlayersLoaded(page);
    await page.getByRole("textbox", { name: "Filter players" }).fill(STAR);
    await expect(playersCounter(page, PLAYERS_MATCHES)).toBeVisible();
    await page.getByRole("button", { name: STAR }).click();
    await expect(page.getByText("Sport: Football").first()).toBeVisible();
    const cards = page.getByRole("list", { name: `Cards for ${STAR}` });
    // Exactly the two inserts' cards; no second player was minted for the
    // second insert (a second STAR would split them).
    await expect(cards.getByRole("listitem")).toHaveCount(2);
    await expect(cards).toContainText(FIRST);
    await expect(cards).toContainText(SECOND);
    // Each card is tagged with its own sport only when it is NOT one of the
    // player's: two Baseball tags mean Baseball was never added to his sports.
    await expect(cards.getByText(TARGET.sport, { exact: true })).toHaveCount(2);
    await expectAccessible(page, { label: "Player detail with both inserts' cards linked" });
  },
);
