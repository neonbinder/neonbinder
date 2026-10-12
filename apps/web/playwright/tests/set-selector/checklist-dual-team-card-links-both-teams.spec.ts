// Origin: .maestro/flows/set-selector/checklist-dual-team-card-links-both-teams.yaml (Maestro suite retired in NEO-341; see git history)
//
// NEO-333: a BSC team value that names two clubs ("Boston Red Sox, Detroit
// Tigers") becomes TWO team links, never one combined team. Proved on live
// data through the operator's own path (Sync card checklist -> Confirm New
// Players & Teams -> Confirm & Save):
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
import { expectTeamsLoaded, teamsCounter } from "../../support/players";
import { newStepHeading, personSkip, reviewWizard } from "../../support/wizard";

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
  "Checklist — a BSC dual-team card links both of its teams, never one combined team (NEO-333)",
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
    // from BSC"), and with every name known (the catalogue) that path commits
    // at once, the commit's "Saved N cards" REPLACING the Kept-all line (the
    // checklist holds one notice). "Saved" is accepted as the same fetch's
    // later state: the checklist was empty a step ago, so it can only be this
    // fetch's. A fetch that lost the BSC side would carry no BSC team values,
    // and STEP 6's row read fails it by name. BSC's per-card team lookup (the
    // code NEO-333 changed) runs INSIDE this fetch: live round trip.
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
    // TWO LEGITIMATE SHAPES, and the gate names both (R2): "Saved N cards" (the
    // fetch committed straight through; EXPECTED on the catalogue, where every
    // player and club on the set is known, and itself the proof of (a) on that
    // path: an unsplit value would have opened the wizard), or the wizard
    // (something was staged: a catalogue refresh dropped a name, a SportLots
    // pairing brought its own spellings, or the split regressed), which is
    // drained below with every team/league step checked before it is answered.
    // The wizard opens behind the entity check's batch and the direct commit
    // behind the card write (the flow's 60 s, a live round trip).
    await expect(wizard.or(saved).first()).toBeVisible({ timeout: WIZARD_OPENS });
    if (await wizard.isVisible()) {
      await expectAccessible(page, { within: wizard, label: "Confirm New Players & Teams wizard" });

      // Wait out the lookups first: team rows go through the same Wikidata pool
      // as players and are presented only once settled, so draining earlier
      // would let a still-pending combined row be skipped unseen by "Skip
      // remaining names" below, and (a) would pass without looking.
      await expect(wizard.getByText(/still looking up/)).toBeHidden({ timeout: LOOKUPS });

      const person = personSkip(page);
      const confirmSave = wizard.getByRole("button", { name: /Confirm & Save/ });
      const stepSkip = wizard.getByRole("button", {
        name: /^Skip .* — (not a team|this team has no league)$/,
        disabled: false,
      });
      // The settled wizard is presenting a row (a team, a league or a player),
      // or every row is decided (a batch that staged teams and no player), so
      // the loop cannot exit on a blank or wedged dialog.
      await expect(person.or(confirmSave).or(stepSkip)).toBeVisible();

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
          await expect(person.or(confirmSave).or(stepSkip)).toBeVisible({ timeout: LOOKUPS });
          if ((await person.isVisible()) || (await confirmSave.isVisible())) break;
          const name = (await stepSkip.first().getAttribute("aria-label")) ?? "";
          expect(name, "a team/league step must not be a comma-joined name or a half of PDA-WW's value").toMatch(stepName);
          await expect(newStepHeading(page).filter({ hasText: commaOrHalf })).toHaveCount(0);
          await stepSkip.first().click();
          // The step's own skip names it, so its going away means the step moved on.
          await expect(wizard.getByRole("button", { name, exact: true })).toBeHidden();
        }
        await expect(person.or(confirmSave)).toBeVisible();
      }

      // The players are not what this spec is about: skip them all in one press.
      // Landing on the first player can stage its Wikidata career teams a few
      // seconds later; those are Wikidata labels, not BSC values, so they are
      // skipped with the players. That is why the press is repeated until the
      // commit is offered: a late staged row leaves one row undecided.
      const skipRemaining = wizard.getByRole("button", { name: /Skip remaining names \([0-9]+\)/ });
      await expect(async () => {
        if (await skipRemaining.isVisible()) await skipRemaining.click();
        await expect(confirmSave).toBeVisible({ timeout: 1_500 });
      }).toPass({ timeout: 7_000 });
      await confirmSave.click();
    }

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
