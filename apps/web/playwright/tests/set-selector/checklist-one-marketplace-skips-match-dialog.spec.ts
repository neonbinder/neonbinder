// Origin: .maestro/flows/set-selector/checklist-one-marketplace-skips-match-dialog.yaml (Maestro suite retired in NEO-341; see git history)
// A set with exactly ONE marketplace attached (BSC; SportLots carries no
// 1995 Roanoke Express ECHL base) skips the Match Cards dialog and keeps every
// fetched card, then the committed set lists them as "BSC only" and a card
// added by hand titles itself from the set, not from "Unknown"/"All Brands".
//
// NEO-335 rides this fixture too (the suite's one set where every card saves
// TEAMLESS, already committed here, and a real BSC-linked fetch + commit is the
// only way to put a card through the commit-time stamp): the pre-save "Tidy up
// this set" wizard's teams step ("Cards with no team"), the pre-fill from a
// created player's one in-window career team, "Other team..." creating a team
// nobody offered, the "N need you" count being FINAL at "Saved", the answers
// read back off the cards in the drawer, and a teams-only re-sync review.
//
// WRITES BEYOND THE CARDS, deliberately: ONE player (whichever Roanoke name the
// wizard presents first) and TWO teams, `RXT<token>` (the career team) and
// `RXO<token>T` (the "Other team..." create), each a single search token per
// attempt. RXO ends in a LETTER so it cannot be a prefix of another attempt's
// longer token (Convex search treats the last term as a prefix, which would
// turn the picker's "No matches." into a match and Enter into a pick). All
// three are global; the same trade checklist-wizard-career-team-commits makes.
//
// Sole writer of the Roanoke Express ECHL set; fresh-only (it commits the
// checklist). Re-seed before re-running.
import type { Page } from "@playwright/test";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import {
  columnHeading,
  columnOption,
  columnSearch,
  columnSelection,
  drillToColdManufacturer,
  setBuilderReady,
  syncChecklistButton,
} from "../../support/set-builder";
import { editCardButton } from "../../support/cards";
import {
  advanceToSave,
  confirmSaveButton,
  readStep,
  reviewWizard,
  stepCounter,
  walkToPlayerRow,
} from "../../support/wizard";

const SET = "Roanoke Express ECHL";
const YEAR = "1995";

/**
 * Press the drawer's "Next card" until a card with a team chip is on screen.
 * Each press is proved to have MOVED the drawer (the Card name field changes)
 * before the chip is looked for, so a press that did not land cannot make the
 * walk skip a teamed card. `maxCards` is a runaway guard.
 */
async function nextCardUntilTeamChip(page: Page, maxCards = 30): Promise<void> {
  const chip = page.getByRole("button", { name: /^Remove team / });
  const cardName = page.getByRole("textbox", { name: "Card name" });
  const next = page.getByRole("button", { name: "Next card" });
  for (let i = 0; i < maxCards; i++) {
    if (await chip.first().isVisible()) return;
    const before = await cardName.inputValue();
    await next.click();
    await expect(cardName).not.toHaveValue(before);
  }
  await expect(chip.first(), "no further card carries a team chip").toBeVisible();
}

test(
  "Checklist — a set with exactly ONE marketplace attached skips the Match Cards dialog and keeps every fetched card",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // All Brands, so the set is reachable under Unknown.
    await drillToColdManufacturer(page, env, { sport: "Hockey", year: YEAR, manufacturer: "All Brands" });
    await expect(columnHeading(page, "Sets")).toBeVisible({ timeout: 15_000 });
    await columnSearch(page, "Sets").fill(SET);
    await columnOption(page, "Sets", SET).click();
    await expect(columnHeading(page, "Variant Types")).toBeVisible({ timeout: 20_000 });
    await expect(columnSelection(page, "Manufacturers", "Unknown")).toBeVisible();
    await expect(columnOption(page, "Variant Types", "Base")).toBeVisible({ timeout: 60_000 });

    // The picker opens for the unmapped base; BSC offers it, SportLots does not carry it.
    await columnOption(page, "Variant Types", "Base").click();
    const picker = page.getByRole("dialog", { name: "Select Base Set" });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole("button", { name: "Confirm Base Set" })).toBeVisible({ timeout: 60_000 });
    await expect(picker.getByRole("option", { name: /^BSC base candidate: / }).first()).toBeVisible();
    const slCandidates = picker.getByRole("option", { name: /^SportLots base candidate: / });
    if (!env.SL_PAUSED) {
      await expect(slCandidates.first()).toBeVisible();
    } else {
      await expect(picker.getByText(/^SportLots returned no base set for /)).toBeVisible();
      await expect(slCandidates).toHaveCount(0);
    }
    await expectAccessible(page, { within: picker, label: "Select Base Set picker, one marketplace offers a base" });

    // Cancel: BSC alone stays attached (no Base mapping).
    await picker.getByRole("button", { name: "Cancel" }).click();
    const cancelled = page.getByText(/Base mapping cancelled/);
    await expect(cancelled).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(cancelled).toBeHidden();
    await expect(page.getByRole("button", { name: "Map Base Set" })).toBeVisible();

    await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible();
    await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();
    await expectAccessible(page, { label: "Empty checklist with an unmapped base" });
    await syncChecklistButton(page).click();

    // One live BSC round trip, and the solo path says what it kept (NEO-255).
    const kept = page.getByText(/Kept all [0-9]+ cards? from /);
    await expect(kept).toBeVisible({ timeout: 60_000 });
    const FETCHED = Number(((await kept.textContent()) ?? "").match(/[0-9]+/)?.[0]);
    expect(FETCHED).toBeGreaterThan(0);
    await expect(
      page.getByText(
        new RegExp(`Kept all ${FETCHED} cards? from BSC\\. Nothing to match, no other marketplace attached\\.`),
      ),
    ).toBeVisible();
    await expectAccessible(page, { label: "Checklist fetched through the one-marketplace path" });

    // No pairing dialog: straight to the entity review.
    await expect(page.getByText(/^Match Cards/)).toBeHidden();
    const wizard = reviewWizard(page);
    await expect(wizard).toBeVisible({ timeout: 60_000 });
    // NEO-335 Phase 2: the sitting starts at its first step, nothing decided
    // (on a name step x is the decided count plus one; y grows, so it is left free).
    await expect(stepCounter(page)).toHaveText(/^Step 1 of [0-9]+$/);
    await expect(page.getByText(/^Match Cards/)).toBeHidden();
    await expect(wizard.getByRole("button", { name: "Back to Match Cards" })).toBeHidden();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, first row" });

    // ── STEP 6: create ONE player with ONE career team, then skip every other name ──
    // NEO-335 needs ONE card whose team the evidence knows, and none of these
    // cards carries a team, so the evidence has to be a player's career. The
    // cheapest honest source is the review itself: create the first player the
    // wizard presents with ONE career team staged by hand. A career pre-fills
    // only when EXACTLY ONE of its teams covers [setYear-1, setYear]
    // (careerTeamVerdict): the set year is 1995 and the staged stint 1994-1996
    // covers it. The mechanics are checklist-wizard-career-team-commits, reused
    // step for step. readyToCreate: this spec creates the player.
    const team = `RXT${env.ATTEMPT_TOKEN}`;
    const other = `RXO${env.ATTEMPT_TOKEN}T`;
    await walkToPlayerRow(page, { readyToCreate: true });
    const careerTeam = wizard.getByRole("combobox", { name: "Career team name" });
    await expect(careerTeam).toBeVisible();
    await expect(wizard.getByText("New player", { exact: true })).toBeVisible();
    await careerTeam.fill(team);
    await wizard.getByRole("spinbutton", { name: "From year" }).fill("1994");
    await wizard.getByRole("spinbutton", { name: /^To year/ }).fill("1996");
    await wizard.getByRole("button", { name: "Add career team" }).click();

    // The staged club's New Team step appears once ITS Wikidata lookup settles
    // (a live round trip, the 180 s lookup ceiling the walk util uses).
    const lookingUp = wizard.getByText(/still looking up/);
    const newTeam = wizard.getByRole("heading", { name: `New Team: ${team}` });
    await expect(newTeam.or(lookingUp).first()).toBeVisible();
    await expect(lookingUp).toBeHidden({ timeout: 180_000 });
    await expect(newTeam).toBeVisible();
    await expect(wizard.getByText("New team", { exact: true })).toBeVisible();
    // One tap accepts the pre-filled Location (blank: the name has no place in
    // it), Name and League; the name is unique, so the button cannot have
    // relabelled itself to "Link to ...".
    await wizard.getByRole("button", { name: "Add as New Team" }).click();
    // Back on the player, the staged stint survived the hop, years and all.
    await expect(careerTeam).toBeVisible();
    await expect(wizard.getByText(new RegExp(`${team} \\(1994.1996\\)`))).toBeVisible();
    // "Add as New Player" records exactly ONE decision (x moves by one).
    const { x: stepBefore } = await readStep(page);
    await wizard.getByRole("button", { name: "Add as New Player" }).click();
    await expect(stepCounter(page)).toHaveText(new RegExp(`^Step ${stepBefore + 1} of [0-9]+$`));

    // Every other name is SKIPPED, the cheapest way to a commit: it decides every
    // remaining row, lookups included, creates no players and raises none of
    // the per-team New Team steps. The end of the names is the footer's "Next
    // (Enter)": every card here is teamless, so the wizard MUST walk on to its
    // teams step; a straight Confirm & Save would mean the step never came.
    // Bounded: press, wait for the end of the names, and press once more if a
    // late row turned up (the 60 s ceiling this wait always had).
    const next = wizard.getByRole("button", { name: "Next (Enter)", exact: true });
    const skipRemaining = wizard.getByRole("button", { name: /Skip remaining names \([0-9]+\)/ });
    await expect(async () => {
      if (await skipRemaining.isVisible()) await skipRemaining.click();
      await expect(next).toBeVisible({ timeout: 7_000 });
    }).toPass({ timeout: 60_000 });

    // ── STEP 6b: the cards that would save with NO team get their own step ──
    await expect(wizard.getByText("Cards with no team", { exact: true })).toBeVisible();
    // ...and the step OPENS AT ITS TOP: the intro is in view, not scrolled up behind the header.
    const intro = wizard.getByText("Pick a team for each card, or leave it for later.");
    await expect(intro).toBeVisible();
    await expect(intro).toBeInViewport();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, Cards with no team step" });

    // THE SHARED NO-PLAYERS LINE. Every card whose name was skipped has no
    // players and all of them are ONE line, keyed on having no players. How many
    // is the catalogue's business (a Roanoke player it already holds keeps his
    // player and gets a line of his own), so the count is READ off the line's
    // heading and every later check is exact against it. Cards 1 and 2 below
    // need two cards in the line.
    const noPlayers = wizard.getByText(/^Cards with no players \([0-9]+\)$/).first();
    await expect(noPlayers).toBeVisible();
    const noPlayersCount = ((await noPlayers.textContent()) ?? "").match(/[0-9]+/)![0];
    expect(Number(noPlayersCount)).toBeGreaterThanOrEqual(2);
    expect(Number(noPlayersCount)).toBeLessThanOrEqual(FETCHED - 1);
    const line = `Cards with no players (${noPlayersCount})`;
    // "Leave for later" is its default: nothing is known about a card nobody is
    // on, so nothing is pre-filled.
    const lineLater = wizard.getByRole("radio", { name: `Leave for later — ${line}`, exact: true });
    await expect(lineLater).toBeChecked();

    // Open its cards (the button reads the line's card numbers and count).
    await wizard.getByRole("button", { name: new RegExp(`^#.* · ${noPlayersCount} cards`) }).click();
    const justThisCard = wizard.getByRole("button", { name: /^Just this card. — #/ });
    await expect(justThisCard.nth(2)).toBeVisible();

    // CARD 1: "No team on this card". "Just this card..." gives card 1 its own
    // answers, starting from the line's; its button turns into "Match the others".
    await justThisCard.first().click();
    await expect(wizard.getByRole("button", { name: /^Match the others — #/ })).toHaveCount(1);
    // Card 1's own row is the only per-card row open, so its "No team on this
    // card" is the only one on screen. Recorded on the card at commit as the
    // operator's answer, so it is not flagged after the save.
    const noTeam = wizard.getByRole("radio", { name: /^No team on this card — #/ });
    await noTeam.click();
    await expect(noTeam).toBeChecked();
    // ...and the LINE, untouched, is still left for later.
    await expect(lineLater).toBeChecked();

    // CARD 2: "Other team..." CREATES A TEAM NOBODY OFFERED. Card 1's button now
    // reads "Match the others", so the first "Just this card..." is card 2's.
    await justThisCard.first().click();
    await expect(wizard.getByRole("button", { name: /^Match the others — #/ })).toHaveCount(2);
    // Two per-card rows are open, card 1's above card 2's, so card 2's
    // "Other team..." is the second (the line's own is owned "Cards with no
    // players (N)", the player line's by his name; neither matches `— #`).
    await wizard.getByRole("button", { name: /^Other team. — #/ }).nth(1).click();
    const teamSearch = wizard.getByLabel("Team name to find", { exact: true });
    await expect(teamSearch).toBeVisible();
    await teamSearch.fill(other);
    // NOTHING MATCHES THAT NAME: the precondition for creating it, and the proof
    // that Enter below can only mean "create" (the field shows "No matches." only
    // once the search has answered for exactly what was typed).
    await expect(wizard.getByText("No matches.")).toBeVisible();
    await teamSearch.press("Enter");
    // THE DIALOG, labelled and seeded; portalled to the page, so not under the wizard.
    const newTeamDialog = page.getByRole("dialog", { name: `New team: ${other}` });
    await expect(newTeamDialog).toBeVisible();
    await expect(newTeamDialog.getByRole("textbox", { name: "New team name" })).toHaveValue(other);
    // THE WRITE. Location blank and no League picked, so the composed name is
    // exactly what was typed.
    await newTeamDialog.getByRole("button", { name: `Create team ${other}` }).click();
    // The created team joins card 2's row SELECTED.
    await expect(wizard.getByRole("radio", { name: new RegExp(`^${other} — #`) })).toBeChecked();

    // THE PRE-FILL. The created player's line offers his one in-window career
    // team and has it CHECKED by default; nobody touched it.
    await expect(wizard.getByRole("radio", { name: new RegExp(`^${team} — `) })).toBeChecked();

    // What the checklist must say once this saves: every card left for later is
    // flagged; the one answered "no team" is not, nor the pre-filled one, nor the
    // one given RXO: K - 3 (one Roanoke card per player, SET-REGISTRY
    // measurement 5). The catalogue-known players' cards are left for later too.
    // LEFT is the bare number the re-sync in STEP 10 finds on its no-players
    // line: that line less the two cards answered above.
    const needYouCount = String(FETCHED - 3);
    const needYou = needYouCount === "1" ? "1 needs you" : `${needYouCount} need you`;
    const left = String(Number(noPlayersCount) - 2);

    // ── STEP 6c: Next (Enter) leaves the teams step for the Save step ──
    // y is read on the teams step AFTER its answers (a team answer can change a
    // card's title, and a title that then needs a look would add the "Card
    // titles" step) and held to on the Save step, which is always "Step y of y".
    const teamsStep = await readStep(page);
    expect(teamsStep.x, "the teams step is never the last step: Save comes after it").toBeLessThan(teamsStep.y);
    await advanceToSave(page);
    await expect(stepCounter(page)).toHaveText(`Step ${teamsStep.y} of ${teamsStep.y}`);
    await expect(wizard.getByText(new RegExp(`Save ${FETCHED} cards?\\?`))).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, Save step" });
    // Never gated by the teams step's answers: Confirm & Save is the Save step's footer button.
    await confirmSaveButton(page).click();
    await expect(page.getByText(new RegExp(`Saved ${FETCHED} cards`))).toBeVisible({ timeout: 60_000 });
    // The banner is "Saved N cards." NEO-335 removed the attention count that
    // used to trail it.

    // ── STEP 7: the count is FINAL at "Saved" (NEO-335) ──
    // The header's amber pill counts the cards that need a person and must read
    // K - 3 now. Before NEO-335 a BSC card was not flagged until the background
    // queue re-asked BSC (a measured ~15 s tail), so the count started near 0
    // and climbed; now the commit stamps every card whose fetch-time lookup
    // answered. 7 s is the R5 bar and the discriminator: the old climb could not
    // finish inside it. Exact name, so a count that is still moving fails by its number.
    await expect(page.getByRole("button", { name: needYou, exact: true })).toBeVisible();

    // Every card is BSC only; nothing is SL only.
    await expect(page.getByText(new RegExp(`\\(${FETCHED}\\)`)).first()).toBeVisible();
    await expect(page.getByText("BSC only").first()).toBeVisible();
    await expect(page.getByText("SL only")).toBeHidden();
    await expectAccessible(page, { label: "Committed checklist, every card BSC only" });

    // A card added by hand titles itself from the set, not from Unknown/All Brands.
    const card = `NB272-${env.ATTEMPT_ID}`;
    await page.getByRole("button", { name: "Open add card form" }).click();
    const number = page.getByRole("textbox", { name: "Card number" });
    await expect(number).toBeVisible();
    await number.fill(card);
    await page.getByRole("button", { name: "Submit new card" }).click();
    await editCardButton(page, card).click();
    const title = page.getByRole("dialog").getByRole("textbox", { name: "Card title" });
    await expect(title).toBeVisible();
    await expect(title).toHaveValue(new RegExp(SET));
    await expectAccessible(page, { within: page.getByRole("dialog"), label: "Card detail drawer with an auto title" });
    await expect(title).not.toHaveValue(/Unknown/);
    await expect(title).not.toHaveValue(/All Brands/);

    // ── STEP 9: both teams answered in the wizard are on their cards (NEO-335) ──
    // The pre-filled RXT on the created player's card, and the RXO created with
    // "Other team..." on the second card of the shared no-players line. The
    // drawer opened above is the way to those cards: every committed card is NNO
    // and its name is the marketplace's, so no selector can pick the row, but
    // "Next card" walks the checklist in its display order and NB272-... sorts
    // FIRST, so walking forward visits every committed card once. Those two are
    // the ONLY cards with a team (the rest were left for later, answered "no
    // team", or are NB272), and which the walk meets first is the checklist's
    // order, not this spec's to know. So the walk stops on the first drawer
    // showing ANY team chip, waits for it to name one of the two, reads WHICH,
    // steps past it, and walks on to the next teamed card, which must name the
    // other. Each chip is the drawer's TeamPicker reading the stored row.
    const dialog = page.getByRole("dialog");
    const chipOf = (name: string) => dialog.getByRole("button", { name: `Remove team ${name}`, exact: true });
    await nextCardUntilTeamChip(page);
    const firstChip = dialog.getByRole("button", {
      name: new RegExp(`^Remove team (${team}|${other})( · .*)?$`),
    });
    await expect(firstChip).toBeVisible();
    const firstName = ((await firstChip.getAttribute("aria-label")) ?? "").replace(/^Remove team /, "").split(" · ")[0];
    const secondName = firstName === other ? team : other;
    expect([team, other], "the first teamed card names one of the wizard's two teams").toContain(firstName);
    // Step past it, and wait for its chip to go, so the walk below cannot stop on
    // the drawer it is leaving (the positive wait under the walk is what makes
    // this negative mean something on a live page).
    await dialog.getByRole("button", { name: "Next card" }).click();
    await expect(chipOf(firstName)).toBeHidden();
    await nextCardUntilTeamChip(page);
    await expect(dialog.getByRole("button", { name: new RegExp(`^Remove team ${secondName}( · .*)?$`) })).toBeVisible();
    await page.getByRole("button", { name: "Done editing card" }).click();
    await expect(title).toBeHidden();

    // ── STEP 10: a re-sync with no names left opens the review TEAMS-ONLY (NEO-335) ──
    // Every name on these cards is now known (the created player) or skipped for
    // this set (the skip records the commit wrote), and LEFT cards are stored
    // with no team. So the next sync has no names to ask but cards that would
    // save teamless, and the review opens straight onto its teams step: "Step 1
    // of 2", teams then Save (a re-synced row is not a NEW row, so no "Card
    // titles" step joins them).
    //
    // THE CONTENT REVIEW COMES FIRST, AND IT ALWAYS COMES. A re-sync diffs every
    // incoming card against its stored row (NEO-203): the pre-filled card is
    // stored WITH the RXT team and arrives with none, and every skipped card is
    // stored with no player link against an incoming name, both content
    // changes, so "Skip changes" (apply nothing, keep NeonBinder's version) is
    // the deterministic way through. No Match Cards: still one marketplace attached.
    await syncChecklistButton(page).click();
    // A live BSC fetch, then the diff: the 60 s ceiling STEP 5 has.
    const skipChanges = page.getByRole("button", { name: "Skip reviewing changes and continue" });
    await expect(skipChanges).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/^Match Cards/)).toBeHidden();
    await skipChanges.click();

    // THE FEATURE: the same review, teams only. Entity resolution runs no lookups
    // here (nothing is unknown), so this is our own server answering: 7 s.
    await expect(wizard).toBeVisible();
    await expect(stepCounter(page)).toHaveText("Step 1 of 2");
    await expect(wizard.getByText("Cards with no team", { exact: true })).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, teams-only re-sync" });
    // No names: neither bulk link exists, because nothing is undecided. Paired
    // with the positives above, so a dead page cannot satisfy them.
    await expect(wizard.getByRole("button", { name: /Skip remaining names/ })).toBeHidden();
    await expect(wizard.getByRole("button", { name: /Add remaining players as new/ })).toBeHidden();
    // The LEFT cards, exactly, on one shared line, back on "Leave for later".
    // Full match on the count, so a step that re-asked the "no team" or RXO card
    // reads LEFT+1 or LEFT+2 and fails here...
    await expect(
      wizard.getByRole("radio", { name: `Leave for later — Cards with no players (${left})`, exact: true }),
    ).toBeChecked();
    // ...and the settled pre-filled card is NOT asked again: its line would be the
    // created player's, offering (and pre-filling) the RXT team from his stored
    // card and career. Paired with the positive above.
    await expect(wizard.getByRole("radio", { name: new RegExp(`^${team} — `) })).toHaveCount(0);

    // Next leaves every line on its default and lands on Save, "Step 2 of 2", for
    // every fetched card again.
    await advanceToSave(page);
    await expect(stepCounter(page)).toHaveText("Step 2 of 2");
    await expect(wizard.getByText(new RegExp(`Save ${FETCHED} cards?\\?`))).toBeVisible();

    // Never gated: Confirm & Save with every line on its default saves the same
    // cards again, and the count must hold. EXACTLY "Saved N cards.", with NO
    // tail: every name was answered in the first sitting, so this commit has
    // nothing to report beyond the count. The banner is ONE text node holding
    // the count and every note the commit appends, so any note fails here by
    // name (the one this pins: "N names were not reviewed; those cards have no
    // player/team link", the commit treating names found in the set's stored
    // skips as unanswered and stamping them back as pending names).
    await confirmSaveButton(page).click();
    await expect(page.getByText(new RegExp(`^Saved ${FETCHED} cards\\.$`))).toBeVisible();
  },
);
