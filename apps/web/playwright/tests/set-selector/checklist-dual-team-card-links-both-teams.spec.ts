// Origin: .maestro/flows/set-selector/checklist-dual-team-card-links-both-teams.yaml (Maestro suite retired in NEO-341; see git history)
//
// NEO-333: a BSC team value that names two clubs ("Boston Red Sox, Detroit
// Tigers") becomes TWO team links, never one combined team. Proved on live
// data through the operator's own path (Sync card checklist -> the "Tidy up
// this set" wizard -> Confirm & Save):
//   (a) the fetch stages no team named after a comma-joined value. On the
//       reference catalogue (NEO-330) every name on the set is known, so the
//       correct fetch commits straight to "Saved N cards" with no wizard (an
//       UNSPLIT value resolves to no team, is an unknown team, and always
//       opens the wizard). Whenever the wizard does open, no team step it
//       presents is about a comma-joined name, nor about either half of
//       PDA-WW's value;
//   (b) after the save, the dual card's row reads both clubs, resolved;
//   (c) Team Management holds exactly ONE team containing "Boston Red Sox"
//       (the row alone cannot tell two links from one combined team, so the
//       count is what closes it; memory: multi-team-row-needs-a-team-count).
//
// FIXTURE (SET-REGISTRY.md -> "Baseball -> 2025 -- the NEO-333 dual-team
// fixture"): Baseball -> 2025 -> Bowman > Bowman Draft > Insert > Prospect
// Dual Autographs. SOLE WRITER of Baseball -> 2025; FRESH-ONLY (a re-run
// finds the Insert column already saved and the checklist committed, and
// fails at the reconcile gate, by name: re-seed first). Mints no player,
// team or league: every wizard step is skipped, which is what lets (c) count
// to exactly one. It mints no names either, so no env-minted marker is
// needed; the per-project run only differs in the signed-in worker.
//
// NEO-345 rides the same fixture (it cannot be split out: the fixture is a
// fresh-only sole-writer real set, and a second spec writing to it breaks R7a;
// a second real set needs the owner's approval). These cards are autographs,
// so the sync's "Tidy up this set" wizard now ALSO asks "Autographed cards"
// (on card or sticker: no marketplace says which, so it is the operator's
// answer, once per synced part) and:
//   (d) the step is REQUIRED: its Next stays held until a tile is picked;
//   (e) after the save, the dual card reads autographed ON CARD in its drawer
//       and Signed By holds BOTH players, seeded from the card's players;
//   (f) Set details' "Autograph format" row changes the part's answer, and
//       the card's drawer follows it to sticker;
//   (g) a stored part whose AU cards read "None" and which has no format shows
//       the checklist header's one-line prompt; answering it formats the card.
// All NEO-345 copy (subtitle, question, tiles, row, prompt) is PLACEHOLDER
// wording: it is matched here as it reads today (`support/wizard.ts` holds the
// wizard's) and WILL change; update the strings, not the assertions.
// PRINT RUN is not asserted: BSC lists this set's numbering ("SN99") only in the
// card's product name, never in its attribute field (measured 2026-10-13 on
// BSC's public catalogue: every card's attribute list empty), and the sync
// reads attributes. The print-run rule is covered by convex unit tests.
import type { Locator } from "@playwright/test";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import {
  COLD_SYNC,
  columnHeading,
  columnOption,
  columnSearch,
  drillToColdManufacturer,
  drillToSet,
  pick,
  setBuilderReady,
  syncChecklistButton,
  VARIANT_TYPES_SYNC,
} from "../../support/set-builder";
import { editCardButton } from "../../support/cards";
import { expectTeamsLoaded, teamsCounter } from "../../support/players";
import {
  advanceToSave,
  AUTOGRAPH_STEP_SUBTITLE,
  autographChoice,
  autographChoices,
  confirmSaveButton,
  expectStepLeft,
  newStepHeading,
  personSkip,
  readStep,
  reviewWizard,
  walkToAutographStep,
  answerAutographStep,
} from "../../support/wizard";

const INSERT = "Prospect Dual Autographs";
const BOWMAN_DRAFT = { sport: "Baseball", year: "2025", manufacturer: "Bowman", set: "Bowman Draft" };
/** A live BSC (+ SportLots) round trip: the flow's cold-insert and checklist ceilings. */
const COLD_INSERT_FETCH = 240_000;
const CHECKLIST_FETCH = 120_000;
/** The wizard opens behind the live lookups the batch queues. */
const WIZARD_OPENS = 60_000;
/** A live Wikidata round trip per unknown name, five-wide over a shared pool. */
const LOOKUPS = 180_000;

test(
  "Checklist — a BSC dual-team card links both of its teams, never one combined team (NEO-333), and its autograph format is asked, applied and changeable (NEO-345)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const reconcile = page.getByRole("dialog", { name: "Reconcile Inserts" });
    const wizard = reviewWizard(page);

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // ── STEP 1: cold drill to Baseball / 2025 / Bowman, then pick `Bowman Draft` ──
    // No spec has opened 2025, so every column arrives empty and syncs itself;
    // the helper pays those waits (its COLD_SYNC marketplace ceilings).
    await drillToColdManufacturer(page, env, { sport: "Baseball", year: "2025", manufacturer: "Bowman" });
    // The Sets column's LISTBOX renders only once it holds a row. The helper
    // waited the sync out with SportLots live; paused, BSC's sets can still be
    // landing, so this carries the helper's own cold-sync ceiling.
    await expect(page.getByRole("listbox", { name: "Sets" })).toBeVisible({ timeout: COLD_SYNC });
    await pick(page, "Sets", "Bowman Draft");
    await expect(columnHeading(page, "Variant Types")).toBeVisible();
    // Selecting the set fires its COLD variant-type sync (BSC + SportLots).
    const insertType = columnOption(page, "Variant Types", "Insert");
    await expect(insertType).toBeVisible({ timeout: VARIANT_TYPES_SYNC });

    // ── STEP 2: make the insert an NB set: the Inserts reconcile (sole writer) ──
    await insertType.click();

    if (!env.SL_PAUSED) {
      // The column is EMPTY on a fresh preview, so selecting the type fires
      // its own two-sided sync, which opens the reconcile. REQUIRED: if it
      // does not open the year is dirty and this fails here, by name. A COLD
      // insert-level BSC + SportLots fetch.
      await expect(reconcile).toBeVisible({ timeout: COLD_INSERT_FETCH });

      // Narrow both lists to the insert; the Save still writes every Ready set.
      await reconcile.getByRole("textbox", { name: "Filter NeonBinder sets" }).fill(INSERT);
      const filterBsc = reconcile.getByRole("textbox", { name: "Filter BSC items" });
      await filterBsc.fill(INSERT);

      // Two legitimate shapes, named by this gate so the branch after it can
      // only choose between them: Ready already, or Pending (BSC only).
      const insertSet = reconcile.getByRole("textbox", { name: `NeonBinder set name for ${INSERT}`, exact: true });
      const makeOwn = reconcile.getByRole("button", { name: `Make its own set: ${INSERT}`, exact: true });
      await expect(insertSet.or(makeOwn)).toBeVisible();
      // Pending: "Keep all" on the FILTERED BSC column makes every item it
      // shows its own set (the insert, plus any parallel BSC lists under the
      // same words: sets in a year this spec owns).
      if (await makeOwn.isVisible()) {
        await reconcile.getByRole("button", { name: /^Keep all [1-9][0-9]*, BSC sets?$/ }).click();
      }
      await expect(insertSet).toBeVisible();
      await expectAccessible(page, { within: reconcile, label: "Reconcile Inserts dialog (Prospect Dual Autographs)" });

      await reconcile.getByRole("button", { name: /^Save [0-9]+ sets/ }).click();
      await expect(reconcile).toBeHidden();

      // Saving leaves the columns at the offset the dialog opened from: re-drill
      // (every level is warm now) and reopen the Insert column.
      await drillToSet(page, env, BOWMAN_DRAFT);
      await columnOption(page, "Variant Types", "Insert").click();
    } else {
      // Paused: one marketplace, nothing to reconcile; the column fills
      // straight from BSC (the same cold fetch).
      await expect(columnHeading(page, "Inserts")).toBeVisible({ timeout: COLD_INSERT_FETCH });
      await expect(reconcile).toBeHidden();
    }

    // ── STEP 3: select the insert ──
    await columnSearch(page, "Inserts").fill(INSERT);
    await columnOption(page, "Inserts", INSERT).click();

    // ── STEP 4: fetch from the marketplaces on the insert ──
    // The empty-checklist assert makes the saved cards below THIS fetch's.
    await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();
    await syncChecklistButton(page).click();

    // Legitimate shapes: a SportLots set paired with the insert opens "Match
    // Cards"; one source takes the one-marketplace path ("Kept all N cards
    // from BSC"). Before NEO-345 that path with every name known (the
    // catalogue) committed at once, "Saved N cards" REPLACING the Kept-all line
    // (the checklist holds one notice); these cards are autographs now, so the
    // wizard opens instead and STEP 5 requires it. "Saved" stays in this gate
    // only so that a fetch that lost the AU tag fails at STEP 5 by name rather
    // than here by timeout. A fetch that lost the BSC side would carry no BSC
    // team values, and STEP 6's row read fails it by name. BSC's per-card team
    // lookup (the code NEO-333 changed) runs INSIDE this fetch: live round trip.
    const matchCards = page.getByText(/Match Cards/).first();
    const kept = page.getByText(/Kept all [0-9]+ cards? from BSC/);
    const saved = page.getByText(/Saved [1-9][0-9]* cards?/);
    await expect(matchCards.or(kept).or(saved).first()).toBeVisible({ timeout: CHECKLIST_FETCH });
    // NEO-287: paused, nothing was asked of SportLots, so the pairing dialog is the bug.
    if (env.SL_PAUSED) await expect(matchCards).toBeHidden();
    if (await matchCards.isVisible()) {
      // The dialog OPENING is not the fetch FINISHING: Confirm reads
      // "Loading…" and is inert until the action resolves.
      const confirm = page.getByRole("button", { name: "Confirm card matches", disabled: false });
      await expect(confirm).toBeVisible({ timeout: CHECKLIST_FETCH });
      await expect(page.getByText(new RegExp(`Match Cards — ${INSERT}`))).toBeVisible();
      await expectAccessible(page, {
        within: page.getByRole("dialog", { name: /^Match Cards/ }),
        label: "Match Cards dialog (Prospect Dual Autographs)",
      });
      await confirm.click();
      await expect(page.getByText(/Match Cards/)).toBeHidden();
    }

    // ── STEP 5: claim (a): no team step is a comma-joined name ──
    // THE WIZARD ALWAYS OPENS (NEO-345, R2): these cards carry BSC's AU tag and
    // this part has no autograph format yet, so the save is never direct any
    // more, even on the catalogue where every player and club is known (there
    // it opens straight onto "Autographed cards"). That is also the old proof
    // of (a) on that path: an unsplit value is an unknown team and would have
    // opened the wizard on a comma-joined `New Team:` step instead, which the
    // drain below checks for whenever it presents a team or league step. A
    // fetch that SAVED without opening the wizard did not see AU, and fails
    // here by name. The wizard opens behind the entity check's batch (the
    // flow's 60 s, a live round trip).
    await expect(wizard, "the sync opens the Tidy up this set wizard for AU cards with no autograph format").toBeVisible({
      timeout: WIZARD_OPENS,
    });
    await expectAccessible(page, { within: wizard, label: "Tidy up this set wizard" });

    // Wait out the lookups first: team rows go through the same Wikidata pool
    // as players and are presented only once settled, so draining earlier
    // would let a still-pending combined row be skipped unseen by "Skip
    // remaining names" below, and (a) would pass without looking.
    await expect(wizard.getByText(/still looking up/)).toBeHidden({ timeout: LOOKUPS });

    const person = personSkip(page);
    const confirmSave = confirmSaveButton(page);
    // The names-done footer (NEO-335): "Next (Enter)" on a teams / titles step,
    // else Confirm & Save on the Save step. Neither renders while a name is
    // undecided. The wizard may also have opened for its post-name steps only
    // (no name was unknown: a teamless card, a title that needs a look).
    const namesDone = wizard.getByRole("button", { name: "Next (Enter)", exact: true }).or(confirmSave);
    const stepSkip = wizard.getByRole("button", {
      name: /^Skip .* — (not a team|this team has no league)$/,
      disabled: false,
    });
    // The settled wizard is presenting a row (a team, a league or a player),
    // or every name is decided (a batch that staged teams and no player, or
    // none unknown), so the loop cannot exit on a blank or wedged dialog.
    await expect(person.or(namesDone).or(stepSkip)).toBeVisible();

    // Every settled undecided team (and the league step staged ahead of a team
    // that needs one) is presented before any player, so "a player is
    // presented" is the product saying the team queue is empty. Two passes,
    // as walkToPlayerRow: rows behind a step settle only once it is decided.
    // Each presented step is CHECKED on its footer control's accessible name
    // (which carries the row's name), then SKIPPED. Skipping, never "Add as
    // New": this spec mints no team, which is what lets STEP 7 count to one.
    //  * `[^,]+` is the claim "this step's name has no comma" (before NEO-333
    //    the wizard presented `New Team: Cleveland Guardians, Washington
    //    Nationals`);
    //  * a step named for either HALF of PDA-WW's value means the split
    //    happened but a part failed to resolve (both clubs are seeded current
    //    teams), and the card would commit with that club missing.
    const stepName = /^Skip (?!Boston Red Sox —|Detroit Tigers —)[^,]+ — (not a team|this team has no league)$/;
    const commaOrHalf = /^New Team: (Boston Red Sox|Detroit Tigers)$|^New (Team|League): .*,/;
    for (let pass = 0; pass < 2; pass++) {
      await expect(wizard.getByText(/still looking up/)).toBeHidden({ timeout: LOOKUPS });
      for (let i = 0; i < 40; i++) {
        await expect(person.or(namesDone).or(stepSkip)).toBeVisible({ timeout: LOOKUPS });
        if ((await person.isVisible()) || (await namesDone.isVisible())) break;
        const name = (await stepSkip.first().getAttribute("aria-label")) ?? "";
        expect(name, "a team/league step must not be a comma-joined name or a half of PDA-WW's value").toMatch(stepName);
        await expect(newStepHeading(page).filter({ hasText: commaOrHalf })).toHaveCount(0);
        await stepSkip.first().click();
        // The step's own skip names it, so its going away means the step moved on.
        await expect(wizard.getByRole("button", { name, exact: true })).toBeHidden();
      }
      await expect(person.or(namesDone)).toBeVisible();
    }

    // The players are not what this spec is about: skip them all in one press.
    // Landing on the first player can stage its Wikidata career teams a few
    // seconds later; those are Wikidata labels, not BSC values, so they are
    // skipped with the players. That is why the press is repeated until the
    // names-done footer is offered: a late staged row leaves one row undecided.
    const skipRemaining = wizard.getByRole("button", { name: /Skip remaining names \([0-9]+\)/ });
    await expect(async () => {
      if (await skipRemaining.isVisible()) await skipRemaining.click();
      await expect(namesDone).toBeVisible({ timeout: 1_500 });
    }).toPass({ timeout: 7_000 });
    // NEO-335: deciding the last name no longer lands on Save. The wizard walks
    // up to two more screens first ("Cards with no team" for a skipped team
    // spelling's teamless card, "Card titles"), each with "Next (Enter)" and no
    // Confirm & Save. Teams and titles are not this spec's claim (STEP 6 reads
    // what the save stored), so they stay on their defaults. PDA-WW is not on
    // the teams step: both its clubs resolve, so it never saves teamless. The
    // one step with a REQUIRED answer is the autograph one, driven below.

    // ── STEP 5b: claims (d) and (e): the Autographed cards step ──
    // NEO-335's walk is names -> teams -> autograph -> titles -> save; the
    // names are decided (or never staged), so Next goes on to the step.
    await walkToAutographStep(page);
    const group = autographChoices(page);
    const onCard = autographChoice(page, "On card");
    const sticker = autographChoice(page, "Sticker");
    const next = wizard.getByRole("button", { name: "Next (Enter)", exact: true });
    await expect(wizard.getByText(AUTOGRAPH_STEP_SUBTITLE, { exact: true })).toBeVisible();
    // Two answers, neither pre-picked (the format is not guessable: no
    // marketplace says it), and the way on is held until one is picked.
    await expect(onCard).toBeVisible();
    await expect(sticker).toBeVisible();
    await expect(onCard).not.toBeChecked();
    await expect(sticker).not.toBeChecked();
    await expect(next).toBeDisabled();
    await expectAccessible(page, { within: wizard, label: "Tidy up this set wizard, Autographed cards step" });

    // "On card": the pick releases Next, and Next moves the counter on (the
    // step is counted in "Step x of y", so the Save step is one further).
    await answerAutographStep(page, "On card");
    await expect(next).toBeEnabled();
    const { x } = await readStep(page);
    await next.click();
    await expectStepLeft(page, x);
    await expect(group).toBeHidden();
    // Titles (when a title needs a look) and Save: the answer travels with the commit.
    await advanceToSave(page);
    await confirmSave.click();

    // The commit: our own write, the 7 s bar.
    await expect(page.getByText(/Saved [1-9][0-9]* cards?/)).toBeVisible();

    // ── STEP 6: claim (b): PDA-WW's row reads both clubs, resolved ──
    // The rows render from getCardChecklist after the commit: a read-back of
    // what was stored, not an echo of the wizard's draft. The sub-line is ONE
    // text node (linked teams' full names joined ", ", then " · /N", ...), so
    // a FULL match means an `<name> (unconfirmed)` tail, or a card linked to
    // only one club, cannot answer. Either order is accepted. No other card
    // in the set carries either club, so the pair IS PDA-WW, the list's last
    // row (the list opens on it). The links are written BY THE SAVE (the
    // NEO-333 fence), so the 7 s bar is the whole budget.
    await expect(
      page.getByText(/^(Boston Red Sox, Detroit Tigers|Detroit Tigers, Boston Red Sox)( · .*)?$/),
    ).toBeVisible();
    await expectAccessible(page, { label: "Prospect Dual Autographs checklist, dual-team card saved" });

    // ── STEP 6b: claim (e): the drawer reads the card autographed ON CARD ──
    // Read off the stored row (the drawer is built from getCardChecklist), not
    // off the wizard's draft. The card is the same PDA-WW: the list's last row.
    const dual = {
      onCard: /Value for Autographed: Auto \(On Card\)/,
      sticker: /Value for Autographed: Auto \(Sticker\)/,
      // Signed By is seeded from the card's players, comma-joined, in the card's order.
      signedBy: /^(Kyson Witherspoon, Malachi Witherspoon|Malachi Witherspoon, Kyson Witherspoon)$/,
    };
    const openDualCard = async () => {
      await editCardButton(page, "PDA-WW").click();
      const drawer = page.getByRole("dialog");
      await expect(drawer.getByRole("textbox", { name: "Card name" })).toBeVisible();
      await expect(drawer.getByText(/Card #PDA-WW/)).toBeVisible();
      return drawer;
    };
    const closeDrawer = async (drawer: Locator) => {
      await drawer.getByRole("button", { name: "Done editing card" }).click();
      await expect(drawer.getByRole("textbox", { name: "Card name" })).toBeHidden();
      await expect(syncChecklistButton(page)).toBeVisible();
    };
    const expectSignedByBoth = async (drawer: Locator) => {
      const showFeatures = drawer.getByRole("button", { name: "Show features editor" });
      const hideFeatures = drawer.getByRole("button", { name: "Hide features editor" });
      // The editor remembers whether it was left open, so open it only if needed.
      await expect(showFeatures.or(hideFeatures)).toBeVisible();
      if (await showFeatures.isVisible()) await showFeatures.click();
      await expect(drawer.getByRole("textbox", { name: "Value for Signed By" })).toHaveValue(dual.signedBy);
    };

    let drawer = await openDualCard();
    await expect(drawer.getByRole("button", { name: dual.onCard })).toHaveAttribute("aria-pressed", "true");
    await expect(drawer.getByRole("button", { name: dual.sticker })).toHaveAttribute("aria-pressed", "false");
    await expectSignedByBoth(drawer);
    await expectAccessible(page, { within: drawer, label: "Card drawer, autographed on card, Signed By seeded" });
    await closeDrawer(drawer);

    // ── STEP 6c: claim (f): Set details' "Autograph format" row ──
    // The row holds the wizard's answer (a stored value, read back), and changing
    // it cascades to the part's AU cards: the same card now reads sticker.
    const editAttributes = page.getByRole("button", { name: "Edit attributes" });
    const hideAttributes = page.getByRole("button", { name: "Hide attributes" });
    // The panel remembers whether it was left open, so open it only if needed.
    await expect(editAttributes.or(hideAttributes)).toBeVisible();
    if (await editAttributes.isVisible()) await editAttributes.click();
    await expect(hideAttributes).toBeVisible();
    const format = page.getByRole("combobox", { name: "Value for Autograph format" });
    const formatShown = format.getByRole("option", { selected: true });
    await expect(format).toBeVisible();
    await expect(formatShown).toHaveText("On card");
    await expectAccessible(page, { label: "Set details open on the insert, Autograph format row" });

    await format.selectOption({ label: "Sticker" });
    await expect(page.getByText(/Saved Autograph format/)).toBeVisible();
    await expect(formatShown).toHaveText("Sticker");
    drawer = await openDualCard();
    // The cascade is our own server write behind the select: the 7 s bar.
    await expect(drawer.getByRole("button", { name: dual.sticker })).toHaveAttribute("aria-pressed", "true");
    await expect(drawer.getByRole("button", { name: dual.onCard })).toHaveAttribute("aria-pressed", "false");
    await expectSignedByBoth(drawer);
    await closeDrawer(drawer);

    // ── STEP 6d: claim (g): a stored part with an unformatted AU card prompts ──
    // No second sync (SET-REGISTRY: no new set): the part is put in the state a
    // stored, never-answered part is in by the operator's own controls. Clear
    // the part's format ("No value" touches no card), then take the dual card's
    // autograph off by hand. Exactly one AU card now reads "None" on a part
    // with no format, so the header asks, for that one card.
    await format.selectOption({ label: "No value" });
    await expect(page.getByText(/Cleared Autograph format/)).toBeVisible();
    await expect(formatShown).toHaveText("No value");
    drawer = await openDualCard();
    await drawer.getByRole("button", { name: dual.sticker }).click();
    await expect(drawer.getByRole("button", { name: dual.sticker })).toHaveAttribute("aria-pressed", "false");
    await expect(drawer.getByRole("button", { name: dual.onCard })).toHaveAttribute("aria-pressed", "false");
    await closeDrawer(drawer);

    const prompt = page.getByRole("group", { name: "1 autographed card — on card or sticker?", exact: true });
    await expect(prompt).toBeVisible();
    await expect(prompt.getByRole("button", { name: "Sticker", exact: true })).toBeVisible();
    await expectAccessible(page, { within: prompt, label: "Checklist header, autograph format prompt" });
    await prompt.getByRole("button", { name: "On card", exact: true }).click();
    // The answer is saved in place: the prompt says so and the part's row holds it.
    await expect(page.getByRole("status").filter({ hasText: "Autographs saved as on card." }).first()).toBeVisible();
    await expect(prompt).toBeHidden();
    await expect(formatShown).toHaveText("On card");
    drawer = await openDualCard();
    await expect(drawer.getByRole("button", { name: dual.onCard })).toHaveAttribute("aria-pressed", "true");
    await expect(drawer.getByRole("button", { name: dual.sticker })).toHaveAttribute("aria-pressed", "false");
    await expectSignedByBoth(drawer);
    await closeDrawer(drawer);

    // ── STEP 7: claim (c): no combined team exists ──
    // Exactly one team on the deployment has "Boston Red Sox" in its full name
    // or an alias: the seed's club. A team minted from the joined value would
    // contain it too, whichever half came first, and make this "2 matches". The
    // filter is a SUBSTRING match, so "1 match" is the positive and
    // the negative in one read. Scoped to this club, not a bare ",": other
    // specs' comma-bearing teams are not this claim. A reload separates the
    // database from the session.
    await page.goto("/admin/teams");
    await expectTeamsLoaded(page, 30_000);
    await page.getByRole("textbox", { name: "Filter teams" }).fill("Boston Red Sox");
    // The counter is a bare "1 match" for exactly one (not "11 matches"), the
    // positive and the negative in one read.
    await expect(teamsCounter(page, "1 match")).toBeVisible();
    // And the one row is the club (the master row is labelled with the full name).
    await expect(page.getByRole("button", { name: /^Boston Red Sox/ })).toBeVisible();
    await expectAccessible(page, { label: "Team Management, filtered to Boston Red Sox" });
  },
);
