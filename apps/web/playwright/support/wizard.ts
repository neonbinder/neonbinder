/**
 * Entity-review wizard helpers the checklist-wizard specs share. Origins:
 * .maestro/flows/set-selector/util-fetch-real-set-checklist-to-wizard.yaml,
 * util-discard-resumed-review-batch.yaml, util-wizard-walk-to-player-row.yaml,
 * util-wizard-walk-to-player-row-creating-teams.yaml and (NEO-335) util-wizard-
 * advance-to-save.yaml, util-wizard-read-back-decision.yaml (Maestro suite
 * retired in NEO-341; see git history).
 *
 * The wizard since NEO-335 ("Tidy up this set"): names -> teams -> titles ->
 * save, ONE "Step x of y" counter (WizardChrome). On a NAME step x is the
 * decided count plus one, so "Step 1 of N" is a batch with nothing decided;
 * y grows as staged steps arrive, so pin x, never y. Past the names come a
 * "Cards with no team" step and a "Card titles" step (each only when needed,
 * each with a footer "Next (Enter)" and NO Confirm & Save), then "Ready to
 * save", the only step with Confirm & Save. Since NEO-345 an "Autographed
 * cards" step sits between teams and titles when a card the save will create
 * carries BSC's AU tag on a part with no autograph format; its answer is
 * REQUIRED (Next stays aria-disabled until one is picked), so `advanceToSave`
 * answers it. The post-save attention walker
 * wears the same title; tell them apart by the walker's "Skip for now, card
 * <number>" or by this wizard's footer.
 *
 * `util-wizard-career-form-into-view.yaml` (NEO-335) has NO Playwright
 * counterpart on purpose: it only dragged the body so Maestro's tap would not
 * land on the footer over a clipped form. Playwright's click scrolls the
 * target into view and refuses to click through an overlapping control (it
 * waits, then fails by name), so the clipped-form failure cannot pass
 * silently here and a spec simply clicks the field.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { expectAccessible } from "./fixtures";
import type { FlowEnv } from "./env";
import { settleMatchCards } from "./pairing";
import {
  columnHeading,
  columnOption,
  columnSearch,
  drillToBaseVariant,
  drillToColdManufacturer,
  syncChecklistButton,
  VARIANT_TYPES_SYNC,
  type DrillTarget,
} from "./set-builder";

/** A live marketplace fetch, or a whole batch's lookups (the flows' 120 s / 180 s). */
const FETCH = 120_000;
const LOOKUPS = 180_000;

/**
 * The open pre-save wizard, by its dialog name (WizardChrome `WIZARD_TITLE`;
 * it was "Confirm New Players & Teams" before NEO-335). Contract: a locator,
 * nothing waited for. The post-save attention walker shares this name.
 */
export function reviewWizard(page: Page): Locator {
  return page.getByRole("dialog", { name: "Tidy up this set" });
}

/**
 * The header's one counter ("Step 3 of 12", a `role="status"` node, so one
 * element). Replaces the "N of M reviewed" line. Contract: a locator; on a
 * name step x is the decided count plus one, y grows, so match on x only.
 */
export function stepCounter(page: Page): Locator {
  return reviewWizard(page).getByText(/^Step [0-9]+ of [0-9]+$/);
}

/**
 * `{ x, y }` read off `stepCounter`. Contract: waits (7 s) for the counter to
 * be visible, then returns the numbers it shows at that instant.
 */
export async function readStep(page: Page): Promise<{ x: number; y: number }> {
  const counter = stepCounter(page);
  await expect(counter).toBeVisible();
  const match = ((await counter.textContent()) ?? "").match(/^Step ([0-9]+) of ([0-9]+)$/);
  expect(match, "the wizard header shows a Step x of y counter").toBeTruthy();
  return { x: Number(match![1]), y: Number(match![2]) };
}

/**
 * Wait until the counter has left step `x` (a decision or a Next landed).
 * Anchored "Step x of" so "Step 5" cannot answer for "Step 15". Contract: a
 * 7 s web-first assert; pair it with a positive assert on where you expect to be.
 */
export async function expectStepLeft(page: Page, x: number): Promise<void> {
  await expect(stepCounter(page), `the wizard is still on Step ${x}`).not.toHaveText(
    new RegExp(`^Step ${x} of `),
  );
}

/** The footer's forward button on the teams / autograph / titles steps. */
function nextStepButton(page: Page): Locator {
  return reviewWizard(page).getByRole("button", { name: "Next (Enter)", exact: true });
}

/** The Save step's commit button. */
export function confirmSaveButton(page: Page): Locator {
  return reviewWizard(page).getByRole("button", { name: /Confirm & Save/ });
}

/**
 * NEO-345: the wizard's "Autographed cards" step. ALL of this copy is
 * placeholder wording that Jason will replace; it lives here, once, so the
 * specs do not each restate it. The step's subtitle (pinned in the header).
 */
export const AUTOGRAPH_STEP_SUBTITLE = "Autographed cards"; // mirrors STEP_SUBTITLE.autograph

/** What the step says when its held Next is pressed with nothing picked (placeholder). */
export const AUTOGRAPH_BLOCKED_HINT = "Pick how they're signed first"; // mirrors AUTOGRAPH_NEXT_BLOCKED

/** The step's two answers, as the tiles read ("On card" / "Sticker"; placeholder). */
export type AutographChoice = "On card" | "Sticker";

/**
 * The step's radio group, named by its question ("14 of these cards are
 * autographed. How are they signed?", "1 of these cards is autographed. How
 * is it signed?"). Contract: a locator, nothing waited for; a count is NOT
 * pinned here (the caller knows its fixture).
 */
export function autographChoices(page: Page): Locator {
  return reviewWizard(page).getByRole("radiogroup", {
    name: /^[0-9]+ of these cards? (is|are) autographed\. How (is it|are they) signed\?$/,
  });
}

/** One tile of `autographChoices`, by its visible name. */
export function autographChoice(page: Page, choice: AutographChoice): Locator {
  return autographChoices(page).getByRole("radio", { name: choice, exact: true });
}

/**
 * Pick `choice` on the open "Autographed cards" step and prove it took.
 * Contract: ENTRY the step is on screen. EXIT the tile is checked (so the
 * footer's Next is released); nothing is pressed after it.
 */
export async function answerAutographStep(page: Page, choice: AutographChoice = "On card"): Promise<void> {
  const tile = autographChoice(page, choice);
  await tile.click();
  await expect(tile).toBeChecked();
}

/**
 * Press Next through the steps before "Autographed cards" (a teamless-card
 * step, say) until its radio group is up. Answers nothing.
 *
 * Contract: ENTRY every name is decided (the names-done footer is up). EXIT
 * the step is showing. A wizard that never offers the step fails here, by
 * name: the caller is the spec whose FEATURE is that step. A runaway guard of
 * 3 (only the teams step can sit before it).
 */
export async function walkToAutographStep(page: Page): Promise<void> {
  const group = autographChoices(page);
  const next = nextStepButton(page);
  for (let i = 0; i < 3; i++) {
    await expect(next, "the wizard offers Next on its way to the Autographed cards step").toBeVisible();
    if (await group.isVisible()) break;
    const { x } = await readStep(page);
    await next.click();
    await expectStepLeft(page, x);
  }
  await expect(group, "the wizard reached its Autographed cards step").toBeVisible();
}

/**
 * util-fetch-real-set-checklist-to-wizard.yaml: drill to a real set's Base
 * checklist (Topps Big League by default), fetch it from the marketplaces,
 * confirm the card pairing when both marketplaces answered, and land in the
 * entity-review wizard.
 *
 * Match Cards conflicts the live data raises (NEO-339) are answered with the
 * first value each offers (`settleMatchCards`, support/pairing.ts): this
 * helper's product is the wizard, never a card-name decision.
 *
 * Contract: EXIT the "Tidy up this set" dialog is open and axe-clean, every
 * row undecided ("Step 1 of N"; callers assert that themselves). Live, the
 * pairing session is PARKED behind it ("Back to Match Cards" is offered);
 * with SportLots paused it is the one-marketplace solo path and there is no
 * parked session.
 */
export async function fetchChecklistToWizard(
  page: Page,
  env: FlowEnv,
  target: DrillTarget = {},
): Promise<void> {
  await drillToBaseVariant(page, env, { set: "Topps Big League", ...target });
  await syncChecklistButton(page).click();

  const confirmMatches = page.getByRole("button", { name: "Confirm card matches" });
  if (!env.SL_PAUSED) {
    await expect(page.getByText(/Match Cards/).first()).toBeVisible({ timeout: FETCH });
    // The button reads "Loading…" (aria-disabled) while cards still stream in,
    // then is held on any conflict the live data raised (NEO-339): this helper's
    // feature is the wizard, so it answers those with the first value each
    // offers and clicks the released Confirm (support/pairing.ts).
    const ready = await settleMatchCards(page, page.getByRole("dialog", { name: /^Match Cards/ }), { timeout: FETCH });
    await ready.click();
  } else {
    // One marketplace answered: the solo path keeps its cards without pairing.
    await expect(page.getByText(/Kept all [0-9]+ cards? from BSC/)).toBeVisible({ timeout: FETCH });
    await expect(page.getByText(/Match Cards/)).toBeHidden();
    await expect(confirmMatches).toBeHidden();
  }
  await expect(reviewWizard(page)).toBeVisible({ timeout: FETCH });
  // The helper's product is this screen, so it checks it (GUIDE "Accessibility checks").
  await expectAccessible(page, { within: reviewWizard(page), label: "entity-review wizard" });
}

export interface OneMarketplaceSet {
  /** The set's NB name, as the Sets column lists it. */
  set: string;
  /** Ancestors; default Hockey / 1995 / the pinned "All Brands" view. */
  sport?: string;
  year?: string;
  manufacturer?: string;
}

/**
 * util-open-one-marketplace-set-base.yaml (NEO-330): drill to a REAL set that
 * carries ONE marketplace (BuySportsCards), select it, open `Base`, and CANCEL
 * the base picker so exactly one side stays attached. Nothing is fetched. The
 * Base stays unmapped on SportLots ("Map Base Set" is on screen) and the
 * checklist section is below it. A flow that has committed the set calls this
 * again for a fresh load of its checklist (the picker re-opens on a committed
 * set too: only the SportLots slot counts as a mapping, and cancelling never
 * writes one).
 */
export async function openOneMarketplaceSetBase(
  page: Page,
  env: FlowEnv,
  { set, sport = "Hockey", year = "1995", manufacturer = "All Brands" }: OneMarketplaceSet,
): Promise<void> {
  await drillToColdManufacturer(page, env, { sport, year, manufacturer });

  // The drill's own "Syncing Sets" gate can report done while the year-wide
  // BSC phase is still storing, so the rows can still be one marketplace round
  // trip away (the util's 15 s, an R5 marketplace exception).
  await expect(page.getByRole("listbox", { name: "Sets" })).toBeVisible({ timeout: 15_000 });
  await columnSearch(page, "Sets").fill(set);
  await columnOption(page, "Sets", set).click();
  // Selecting the set fires its cold, BSC-only variant-type sync (measured ~15 s).
  await expect(columnHeading(page, "Variant Types")).toBeVisible({ timeout: 20_000 });
  await expect(columnOption(page, "Variant Types", "Base")).toBeVisible({ timeout: VARIANT_TYPES_SYNC });

  // An unmapped Base (`baseHasMapping` counts the SportLots slot only) opens the picker.
  await columnOption(page, "Variant Types", "Base").click();
  const picker = page.getByRole("dialog", { name: "Select Base Set" });
  await expect(picker).toBeVisible();
  // The confirm reads "Loading…" until the picker's live SportLots + BSC round trip lands (measured ~8 s).
  await expect(picker.getByRole("button", { name: "Confirm Base Set" })).toBeVisible({ timeout: 60_000 });
  // R2 precondition: BSC really answers for this set, so the fetch is a real one-marketplace fetch.
  await expect(picker.getByRole("option", { name: /^BSC base candidate: / }).first()).toBeVisible();
  const slCandidates = picker.getByRole("option", { name: /^SportLots base candidate: / });
  if (!env.SL_PAUSED) {
    // Live, the year's SportLots catalogue is OFFERED (offering is not attaching) and declined.
    await expect(slCandidates.first()).toBeVisible();
  } else {
    await expect(picker.getByText(/^SportLots returned no base set for /)).toBeVisible();
    await expect(slCandidates).toHaveCount(0);
  }
  await expectAccessible(page, { within: picker, label: "Select Base Set picker, one marketplace offers a base" });

  // Cancelling writes nothing and is what keeps exactly one marketplace attached.
  await picker.getByRole("button", { name: "Cancel" }).click();
  const cancelled = page.getByText(/Base mapping cancelled/);
  await expect(cancelled).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(cancelled).toBeHidden();
  // Positive proof that Cancel left the row UNMAPPED: a Base that had picked up
  // a SportLots mapping would offer "Re-map Base" instead.
  await expect(page.getByRole("button", { name: "Map Base Set" })).toBeVisible();
}

/**
 * util-fetch-one-marketplace-set-checklist-to-wizard.yaml (NEO-330): the
 * one-marketplace twin of `fetchChecklistToWizard`. Opens the set's Base
 * (`openOneMarketplaceSetBase`), syncs the never-fetched checklist and lands
 * in the entity-review wizard with nothing decided ("Step 1 of N"). There is
 * no parked pairing session behind it ("Back to Match Cards" is not offered).
 * The caller owns the exit: Cancel -> Discard for a reader, Confirm & Save
 * (after `advanceToSave`) for the set's sole writer (SET-REGISTRY.md).
 *
 * Contract: ENTRY the set is registered one-marketplace and never fetched.
 * EXIT the "Tidy up this set" dialog is open and axe-clean. NEO-335: a
 * one-sided fetch with unknown names (every current caller) opens on a name
 * step; one whose only open question is teams or titles opens the same dialog
 * straight onto "Cards with no team" / "Card titles", so the title gate holds
 * for both shapes.
 */
export async function fetchOneMarketplaceSetChecklistToWizard(
  page: Page,
  env: FlowEnv,
  target: OneMarketplaceSet,
): Promise<void> {
  await openOneMarketplaceSetBase(page, env, target);

  // The precondition for a FIRST fetch (a committed set re-syncs instead, and a
  // re-sync raises no review). A local re-run against an already-committed
  // preview fails here, by name, which is correct: re-seed first.
  await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();
  await syncChecklistButton(page).click();

  // One live BSC round trip. `soloKeptMessage` prints only on the NEO-255
  // branch, once the streamed batch has arrived in full, and names the one side
  // it asked: both the sync point and the proof that one marketplace was attached.
  await expect(page.getByText(/Kept all [0-9]+ cards? from BSC/)).toBeVisible({ timeout: 60_000 });

  // Every fetched name the deployment does not hold is queued, each behind a
  // lookup (measured ~0.8 s to open on a 25-card set; the flow's 60 s). Gated
  // on the wizard's title, "Tidy up this set" since NEO-335.
  await expect(reviewWizard(page)).toBeVisible({ timeout: 60_000 });
  await expectAccessible(page, { within: reviewWizard(page), label: "entity-review wizard" });
}

/** Cancel out of the wizard and discard its decisions (the flows' ending). */
export async function cancelAndDiscard(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Cancel (Esc)" }).click();
  await expect(page.getByText(/Discard [0-9]+ decisions?/)).toBeVisible();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByText("Fetch cancelled — no cards saved.")).toBeVisible();
}

/**
 * util-discard-resumed-review-batch.yaml: a batch an earlier flow left behind
 * opens with decisions already on it ("Step k+1 of M", k names decided);
 * throw it away and fetch again so this flow starts at "Step 1 of N".
 *
 * Contract: ENTRY the wizard is open. EXIT a batch is on screen with nothing
 * expired; a resumed one has been discarded and re-fetched (via
 * `fetchChecklistToWizard`, default set). Not a licence to ignore a dirty
 * batch: the caller still asserts `Step 1 of N` itself right after.
 */
export async function discardResumedReviewBatch(page: Page, env: FlowEnv): Promise<void> {
  await expect(stepCounter(page)).toBeVisible();
  if (!/^Step 1 of /.test((await stepCounter(page).textContent()) ?? "")) {
    await page.getByRole("button", { name: "Cancel (Esc)" }).click();
    await expect(page.getByText(/Discard [0-9]+ decisions?/)).toBeVisible();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(page.getByText("Fetch cancelled — no cards saved.")).toBeVisible({ timeout: 30_000 });
    await fetchChecklistToWizard(page, env);
  }
  // A fresh batch opens at "Step 1 of N", but its own lookups start settling
  // rows at once, so by the time this is read x may already have moved: what
  // must hold is that a batch is on screen with nothing expired.
  await expect(stepCounter(page)).toHaveText(/^Step [0-9]+ of [1-9][0-9]*$/);
}

/**
 * The decided-names history of the open wizard, opened. The product collapses
 * it once more than five names are decided (a batch's lookups settle dozens of
 * rows on their own), so a row decided a moment ago is in the DOM but hidden.
 * Opening it is the user's own step; the hard assert after it is the proof.
 */
export async function openDecidedList(page: Page): Promise<Locator> {
  const wizard = reviewWizard(page);
  const names = wizard.getByRole("list", { name: "Decided names" });
  const summary = wizard.getByText(/^Decided \([0-9]+\)$/);
  await expect(summary).toBeVisible();
  if (!(await names.isVisible())) await summary.click();
  await expect(names).toBeVisible();
  return names;
}

/** The "not a person" skip: its presence means the wizard is on a player row. */
export function personSkip(page: Page): Locator {
  return reviewWizard(page).getByRole("button", { name: /^Skip .* — not a person$/ });
}

/** The presented New Team / New League step's primary action, in any state (held, enabled). */
export function addAsNewStep(page: Page): Locator {
  return reviewWizard(page).getByRole("button", { name: /^Add as New (Team|League)$/ });
}

/**
 * The presented New Team / New League step's heading ("New League: Pacific
 * League"). Its accessible name is the step's identity: it goes away exactly
 * when the step does.
 */
export function newStepHeading(page: Page): Locator {
  return reviewWizard(page).getByRole("heading", { level: 3, name: /^New (Team|League): / });
}

/**
 * util-wizard-answer-step-as-new.yaml (NEO-331): answer the wizard's
 * presented New Team / New League step as a create, and return once the
 * wizard has moved off it.
 *
 * A league cannot be added without a level and none is pre-pressed (its
 * primary stays aria-disabled until one is), so a league step first gets
 * `level` (default "Other", what the step pre-pressed before NEO-331; a
 * drain claims nothing), checked before the primary is pressed. A team step
 * is one tap. The league's Wikidata lookup is not waited for: the step says
 * "Add it now", and the lookup fills the fields nobody touched when it lands.
 *
 * It ends by waiting for the step's heading to go. Until the decision write
 * returns, the step just answered stays on screen with its primary
 * aria-disabled, so a caller looping on "a primary is visible" would read the
 * OLD step, press a level on it, and leave the next league with none pressed
 * (CI run 38195356897: a 180 s wait on a held "Add as New League").
 */
export async function answerStepAsNew(
  page: Page,
  { level = "Other" }: { level?: "Major" | "Minor" | "College" | "International" | "Independent" | "Other" } = {},
): Promise<void> {
  const wizard = reviewWizard(page);
  const heading = newStepHeading(page);
  await expect(heading).toBeVisible();
  const step = ((await heading.textContent()) ?? "").trim();
  const isLeague = step.startsWith("New League: ");
  // When the name already exists (another spec, or the batch itself, created
  // it earlier in the run) the step leads with "Link to <name>" and offers
  // "Add as New Team anyway"; the util taps "Add as New" either way.
  const primary = wizard.getByRole("button", {
    name: isLeague ? /^Add as New League( anyway)?$/ : /^Add as New Team( anyway)?$/,
  });
  if (isLeague) {
    const radio = wizard.getByRole("radio", { name: level, exact: true });
    await radio.click();
    await expect(radio, `Level "${level}" is not pressed on "${step}"`).toBeChecked();
  }
  // No lookup holds the primary: only a missing level (pressed above), a
  // draft error, or a decision write in flight, so it is a UX budget, not a
  // lookup wait.
  await expect(primary, `"${step}": its Add as New is still held`).toBeEnabled();
  await primary.click();
  await expect(
    wizard.getByRole("heading", { level: 3, name: step, exact: true }),
    `"${step}" is still on screen after Add as New`,
  ).toBeHidden();
}

/**
 * util-wizard-skip-held-pick-step.yaml (NEO-339): skip the same-name pick step
 * the wizard is HOLDING, so its league and team steps come next.
 *
 * Since NEO-339 a "Which <name> is this?" step (NEO-332) holds its place,
 * touched or not, until the operator answers it; no league or team settling
 * elsewhere takes it away. A same-name row is inserted ready (no lookup) while
 * every other name waits on one, so the wizard usually OPENS on the pick step
 * and is still on it once the batch settles. It is a player row, so a team
 * drain started under it would exit at once and answer no team. This is what
 * an operator who is not here for that player does: skip it. Answering it
 * hands control back to the walk (leagues -> teams -> players); any OTHER
 * same-name row comes up only after the teams, so one call before a drain is
 * enough. Dependency surfacing still comes first (a new player's new team, a
 * new team's new league), so a held pick step is the only player row that can
 * be presented ahead of a settled team.
 *
 * Detection is perceivable only: a pick step's footer offers "Create new"
 * where any other player step offers "Add as New Player" (or "... anyway"); a
 * team or league step offers its own "Skip <name> — not a team" / "— this
 * team has no league"; past the names the footer is "Next (Enter)" or
 * Confirm & Save. One of them MUST be up (7 s), so a blank or wedged dialog
 * fails here by name; only "Create new" leads to the skip.
 *
 * The skip is proved by the counter: x (decided count plus one on a name step)
 * moves by exactly one, whichever step comes next. Nothing races it: a held
 * step stays put, and a pick row has no lookup of its own to stage steps.
 *
 * Contract: ENTRY the wizard is open and the caller has waited its lookups
 * out. EXIT the wizard is NOT on a pick step it was holding; returns whether
 * it skipped one.
 */
export async function skipHeldPickStep(page: Page): Promise<boolean> {
  const wizard = reviewWizard(page);
  const createNew = wizard.getByRole("button", { name: "Create new", exact: true });
  const presented = createNew
    .or(wizard.getByRole("button", { name: /^Add as New Player( anyway)?$/ }))
    .or(wizard.getByRole("button", { name: /^Skip .* — (not a team|this team has no league)$/ }))
    .or(nextStepButton(page))
    .or(confirmSaveButton(page));
  await expect(presented.first(), "the wizard presents a step (pick, player, team, league or post-name)").toBeVisible();
  if (!(await createNew.isVisible())) return false;

  const { x } = await readStep(page);
  await wizard.getByRole("button", { name: /^Skip .* — not a person$/ }).click();
  await expect(stepCounter(page), "skipping the held pick step records exactly one decision").toHaveText(
    new RegExp(`^Step ${x + 1} of [0-9]+$`),
  );
  return true;
}

/**
 * util-wizard-walk-to-player-row(-creating-teams).yaml: move the wizard past
 * every team/league step to the first player row. `creatingTeams: false`
 * skips each team/league step (a skip creates nothing); `true` adds each as
 * new instead.
 *
 * `readyToCreate: true` (READY_TO_CREATE, NEO-335) is for a caller that must
 * CREATE the player it lands on. A skipped staged career-team step says "that
 * is not a team", so the player it was staged for then holds its create (the
 * footer reads "<team> still needs a team decision, or untick it." and
 * `Add as New Player` is aria-disabled); the batch-order walk can reach such
 * a player at any time. This walks past each held player as a SKIP (creates
 * nothing; never by unticking the chip) until it stands on a player whose
 * create is live. Link/skip callers leave it off.
 *
 * NEO-339: after the first lookup wait it skips a same-name pick step the
 * wizard is holding (`skipHeldPickStep`), one more "Skipped" decision, so
 * callers read counts relative to where the walk left them. A spec that wants
 * to stay ON a pick step does not call this.
 *
 * Contract: ENTRY the wizard is open on a name step. EXIT a player row is
 * presented (its "Skip ... - not a person" is up), lookups drained, and with
 * `readyToCreate` its create is not held.
 */
export async function walkToPlayerRow(
  page: Page,
  { creatingTeams = false, readyToCreate = false }: { creatingTeams?: boolean; readyToCreate?: boolean } = {},
): Promise<void> {
  const wizard = reviewWizard(page);
  const person = personSkip(page);
  // A step's skip stays aria-disabled while that row's live lookup is in
  // flight, so only the usable one counts (the lookups' 180 s budget).
  const stepSkip = wizard.getByRole("button", {
    name: /^Skip .* — (not a team|this team has no league)$/,
    disabled: false,
  });

  // A pass over the team/league steps; run twice because the lookups of the
  // rows behind them settle only once the earlier steps are decided.
  for (let pass = 0; pass < 2; pass++) {
    await expect(wizard.getByText(/still looking up/)).toBeHidden({ timeout: LOOKUPS });
    // NEO-339: a held same-name pick step would end the drain before a single
    // team step (it is a player row), so it is skipped first. Once only: after
    // the teams the walk reaches players in batch order, as it always did.
    if (pass === 0) await skipHeldPickStep(page);
    for (let i = 0; i < 200; i++) {
      await expect(person.or(stepSkip)).toBeVisible({ timeout: LOOKUPS });
      if (await person.isVisible()) break;
      // The step's own skip names it, so its going away means the step moved on.
      const name = (await stepSkip.first().getAttribute("aria-label")) ?? "";
      if (creatingTeams) {
        await answerStepAsNew(page);
      } else {
        await stepSkip.first().click();
      }
      await expect(wizard.getByRole("button", { name, exact: true })).toBeHidden();
    }
    await expect(person).toBeVisible({ timeout: 30_000 });
  }

  if (readyToCreate) {
    // The footer line that explains a held create (one node; the chip's own
    // "needs a team decision" lives in the body and is not matched).
    const held = wizard.getByText(/team decisions?, or untick (it|them)\./);
    // `times` is a runaway guard: a batch whose every remaining player is held
    // runs out of players and fails the visibility assert below.
    for (let i = 0; i < 20; i++) {
      await expect(person).toBeVisible();
      if (!(await held.isVisible())) break;
      // Wait for THIS skip to land before looking again: until the decision
      // round-trips the held row is still up, and a second pass would skip the
      // player after it too. On a name step x moving is the decision landing.
      const { x } = await readStep(page);
      await person.click();
      await expectStepLeft(page, x);
    }
    await expect(person).toBeVisible();
    await expect(held, "the player the walk stopped on still holds its create").toBeHidden();
  }
}

/**
 * util-wizard-advance-to-save.yaml (NEO-335): from "every name decided" walk
 * the teams / autograph / titles steps to the Save step, and answer nothing
 * on them that the product does not REQUIRE.
 *
 * Contract:
 * - ENTRY the wizard is open and every name is decided: its footer shows
 *   "Next (Enter)" or "Confirm & Save". (Waited for here, 7 s.)
 * - Presses Next until the Save step is up; each press is proved to have MOVED
 *   the wizard (the "Step x of y" x it left is gone), so a Next that does
 *   nothing fails by name. Next leaves every line on its default (a pre-filled
 *   team, else "Leave for later"; every title kept) - the same answers the old
 *   final step's Confirm & Save saved. A spec whose FEATURE is the teams or
 *   titles step drives that step itself and does not call this.
 * - NEO-345: the "Autographed cards" step (new AU cards on a part with no
 *   autograph format) is the one step whose answer is REQUIRED - its Next is
 *   aria-disabled until a tile is picked - so this picks "On card" there
 *   (`answerAutographStep`). A caller that must not decide it for the part
 *   (the spec whose feature is that step) calls `walkToAutographStep` and
 *   answers it itself BEFORE this.
 * - EXIT the Save step: subtitle "Ready to save" and Confirm & Save on screen,
 *   nothing pressed. The caller asserts its own "Save N cards?" and owns the
 *   commit.
 *
 * All 7 s: Next is a client-side step change. The loop is a runaway guard of 4
 * (at most three screens sit between the names and Save).
 */
export async function advanceToSave(page: Page): Promise<void> {
  const wizard = reviewWizard(page);
  const next = nextStepButton(page);
  const save = confirmSaveButton(page);
  const autograph = autographChoices(page);
  for (let i = 0; i < 4; i++) {
    await expect(next.or(save)).toBeVisible();
    if (await save.isVisible()) break;
    const { x } = await readStep(page);
    if (await autograph.isVisible()) await answerAutographStep(page);
    await next.click();
    await expectStepLeft(page, x);
  }
  await expect(save).toBeVisible();
  // The subtitle is pinned in the header with the footer, not body content.
  await expect(wizard.getByText("Ready to save", { exact: true })).toBeVisible();
}

/**
 * util-wizard-read-back-decision.yaml (NEO-335): read the decision just made
 * back off its own row, then (optionally) walk on.
 *
 * Why not the "Decided (N)" list: it is in batch order, collapsed past five
 * entries, and a row decided a moment ago may not be in view. The footer's
 * Back presents the MOST RECENT decision read-only, in a group named
 * "Decision for <name>" reading "Already decided: <decision>" - the only such
 * group on screen while it is up.
 *
 * Contract:
 * - ENTRY a decision was just made on a name step; the walk has moved to the
 *   next name step or, if that was the last name, to the first post-name step.
 *   Either footer offers a Back, so this takes "Back to previous decision" or
 *   "Back to previous step".
 * - `decision` the decision line, matched exactly when a string ("Skipped",
 *   "Added as new", "Linked to Shohei Ohtani") or by the regex given.
 * - `resume: true` presses the panel's "Next", handing the walk back its own
 *   rule: EXIT the panel is gone and a name step is presented again (its skip
 *   control is up) or, when every name is decided, the names-done footer
 *   ("Next (Enter)" / Confirm & Save). Callers that leave the wizard next
 *   (Cancel -> Discard) omit it; EXIT is then the panel, still up.
 * - The Maestro util's conditional drag to bring Next above the footer has no
 *   Playwright counterpart: click() scrolls the body itself.
 */
export async function readBackDecision(
  page: Page,
  decision: string | RegExp,
  { resume = false }: { resume?: boolean } = {},
): Promise<Locator> {
  const wizard = reviewWizard(page);
  await wizard.getByRole("button", { name: /^Back to previous (decision|step)$/ }).click();
  const panel = wizard.getByRole("group", { name: /^Decision for / });
  await expect(
    panel.getByText(decision, typeof decision === "string" ? { exact: true } : undefined),
  ).toBeVisible();

  if (resume) {
    await panel.getByRole("button", { name: "Next", exact: true }).click();
    await expect(wizard.getByText(/^Already decided:/)).toHaveCount(0);
    // The positive half (a negative alone passes on a dead page): a name step
    // is presented again, or every name is decided and the names-done footer
    // is up.
    await expect(
      wizard
        .getByRole("button", { name: /^Skip .* — (not a person|not a team|this team has no league)$/ })
        .or(nextStepButton(page))
        .or(confirmSaveButton(page))
        .first(),
    ).toBeVisible();
  }
  return panel;
}
