// Origin: .maestro/flows/set-selector/checklist-one-marketplace-skips-match-dialog.yaml (Maestro suite retired in NEO-341; see git history)
// A set with exactly ONE marketplace attached (BSC; SportLots carries no
// 1995 Roanoke Express ECHL base) and the publisher's checklist: BSC and the
// checklist are two sources (NEO-496, D10/NQ1), so Match Cards opens even with one
// marketplace; the card the checklist leaves out is BSC's alone and is kept, so
// every fetched card is saved. The committed set lists them as "BSC only" and a
// card added by hand titles itself from the set, not from "Unknown"/"All Brands".
// (Renamed from checklist-one-marketplace-skips-match-dialog in NEO-496: with a
// checklist in play the dialog is no longer skipped.)
//
// NEO-335 rides this fixture too (the suite's one set where every card saves
// TEAMLESS, already committed here, and a real BSC-linked fetch + commit is the
// only way to put a card through the commit-time stamp): the pre-save "Tidy up
// this set" wizard's teams step ("Cards with no team"), the pre-fill from a
// created player's one in-window career team, "Other team..." creating a team
// nobody offered, the "N need you" count being FINAL at "Saved", the answers
// read back off the cards in the drawer, and a teams-only re-sync review.
//
// WRITES BEYOND THE CARDS, deliberately: ONE player (Chris Pollack, below) and TWO
// teams: the career team, a real one-word club
// from support/recorded-names.ts (NEO-413: it is looked up when it stages, and the
// recording holds it as a Hockey no-match the catalogue does not hold, so the
// lookup sends nothing to Wikidata and its step still reads "New Team"), and
// `RXO<token>T` (the "Other team..." create, never looked up), a single search
// token per attempt. RXO ends in a LETTER so it cannot be a prefix of another
// attempt's longer token (Convex search treats the last term as a prefix,
// which would turn the picker's "No matches." into a match and Enter into a
// pick). All three are global; the same trade
// checklist-wizard-career-team-commits makes.
//
// ONE LIVE BSC LOOKUP PER SYNC, ON PURPOSE (NEO-489). Both syncs (STEP 5 and the
// STEP 10 re-sync) upload `roanokeExpress1995OneLive` first: the publisher's
// checklist for 24 of the 25 cards, Chris Pollack's row LEFT OUT. A team the
// checklist names is a data claim that stays (components/SetSelector/teams-on-cards.ts,
// `checklistClaim`): no rule fills another team over it and skipping the New Team
// step does not release it (NEO-478, tried 2026-11-10 with the whole file and put
// back). That is exactly why ONE card keeps its live lookup: Chris Pollack's card
// is asked of BSC, whose "Roanoke Express" the New Team step's skip DOES release,
// so the created player's career-team PRE-FILL (STEP 6, the NEO-335 behaviour this
// spec exists to prove) still happens on his card. The other 24 cards are claimed:
// they land on "Cards with no players" under Leave for later with nothing pre-filled,
// which is all this spec ever asked of them. Before this the two syncs made 50
// live BSC lookups (25 cards twice), enough to get the next spec rate-limited.
//
// BOTH OUTCOMES OF THAT ONE LOOKUP PASS (NEO-489, Jason 2026-11-11): BSC rate-limits the live
// card now and then, and a 429 or an already-open cooldown means the lookup is skipped and his
// card is asked of the operator instead. STEP 6 accepts either (BSC answered: the career team is
// pre-checked; skipped: it is offered and the spec picks it), annotates which one ran
// (`bsc-lookup`), and every later assert is the same in both.
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
import { bscLookupOutcome, expectAfterMarketplace } from "../../support/marketplace-wait";
import { recordedNoMatchName } from "../../support/recorded-names";
import {
  CHECKLISTS,
  confirmChecklistMatchCards,
  expectTeamsFromChecklist,
  matchCardsDialog,
  usePublishersChecklist,
} from "../../support/published-checklist";
import {
  addAsNewPlayerButton,
  answerPlayerAsNew,
  advanceToSave,
  awaitLookupsSettled,
  confirmSaveButton,
  LOOKUPS,
  personSkip,
  readStep,
  reviewWizard,
  stepCounter,
} from "../../support/wizard";

const SET = "Roanoke Express ECHL";
const YEAR = "1995";
/**
 * The one card left out of the uploaded checklist (its row is not in
 * `roanokeExpress1995OneLive`), so BSC is asked about it live. A Hockey no-match in the
 * enrichment recording that the catalogue does not hold, so the review offers "Add as New
 * Player" (never a "Link to" preselect, as Daniel Berthiaume and Matt DelGuidice get).
 */
const LIVE_PLAYER = "Chris Pollack";

/**
 * Walk the review's name steps to LIVE_PLAYER's row: each team/league step is skipped ("that is
 * not a team": a skip creates nothing, and it is what releases a live-looked-up team from
 * the card), and every other person is skipped via "not a person". A skipped person creates no
 * player and raises none of the per-team steps. Contract: ENTRY the wizard is open on a name
 * step. EXIT `Skip <LIVE_PLAYER> - not a person` is on screen and nothing is pressed on it.
 * Bounded (200, the runaway guard walkToPlayerRow uses); each press is proved to have landed (its own skip goes) before the next look.
 */
async function walkToLivePlayer(page: Page): Promise<void> {
  const wizard = reviewWizard(page);
  const person = personSkip(page);
  const stepSkip = wizard.getByRole("button", {
    name: /^Skip .* — (not a team|this team has no league)$/,
    disabled: false,
  });
  for (let i = 0; i < 200; i++) {
    await awaitLookupsSettled(page);
    // The batch-lookups ceiling walkToPlayerRow waits at (support/wizard.ts LOOKUPS): the rows
    // behind a decided step settle in the deployment-wide lookup pool, shared with every shard.
    const skip = person.or(stepSkip).first();
    await expect(skip).toBeVisible({ timeout: LOOKUPS });
    const name = (await skip.getAttribute("aria-label")) ?? "";
    if (name === `Skip ${LIVE_PLAYER} — not a person`) return;
    await skip.click();
    await expect(wizard.getByRole("button", { name, exact: true })).toBeHidden();
  }
  await expect(person, `${LIVE_PLAYER} was never presented`).toBeVisible();
}

/**
 * Press the drawer's "Next card" until a card with a team chip is on screen.
 * Each press is proved to have MOVED the drawer (the Card name field changes)
 * before the chip is looked for, so a press that did not land cannot make the
 * walk skip a teamed card. `maxCards` is a runaway guard. Returns how many
 * chipless cards it stood on (the one it started on included).
 */
async function nextCardUntilTeamChip(page: Page, maxCards = 30): Promise<number> {
  const chip = page.getByRole("button", { name: /^Remove team / });
  const cardName = page.getByRole("textbox", { name: "Card name" });
  const next = page.getByRole("button", { name: "Next card" });
  let passed = 0;
  for (let i = 0; i < maxCards; i++) {
    if (await chip.first().isVisible()) return passed;
    passed++;
    const before = await cardName.inputValue();
    await next.click();
    await expect(cardName).not.toHaveValue(before);
  }
  await expect(chip.first(), "no further card carries a team chip").toBeVisible();
  return passed;
}

/**
 * From the card the drawer is on, press "Next card" to the end of the checklist and prove
 * every card it lands on carries NO team chip. Each landing is proved by the Card name field
 * changing and the picker's "Add team" button being on screen (the positive the empty chip
 * list is read against). Returns how many cards it landed on. `maxCards` is a runaway guard.
 */
async function expectNoTeamChipsToTheEnd(page: Page, maxCards = 40): Promise<number> {
  const dialog = page.getByRole("dialog");
  const chip = dialog.getByRole("button", { name: /^Remove team / });
  const addTeam = dialog.getByRole("button", { name: "Add team", exact: true });
  const cardName = dialog.getByRole("textbox", { name: "Card name" });
  const next = dialog.getByRole("button", { name: "Next card" });
  let landed = 0;
  while (await next.isEnabled()) {
    expect(landed, "the drawer never reached the end of the checklist").toBeLessThan(maxCards);
    const before = await cardName.inputValue();
    await next.click();
    await expect(cardName).not.toHaveValue(before);
    await expect(addTeam).toBeVisible();
    await expect(chip).toHaveCount(0);
    landed++;
  }
  return landed;
}

test(
  "Checklist — a set with exactly ONE marketplace attached and its publisher's checklist opens Match Cards, keeps the card the checklist leaves out, and saves every fetched card",
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
    // The publisher's checklist, 24 of the 25 cards (LIVE_PLAYER's row left out), so BSC is
    // asked about ONE card and not 25 (NEO-489).
    const facts = await usePublishersChecklist(page, CHECKLISTS.roanokeExpress1995OneLive);
    await syncChecklistButton(page).click();

    // NEO-496 (D10, NQ1): ONE marketplace plus the publisher's checklist are TWO sources, so the
    // fetch opens Match Cards (before NEO-496 it skipped the dialog and kept every card itself).
    // One live BSC round trip (the one lookup): 7 s of our own time plus however long BuySportsCards
    // held it (NEO-487), never a flat ceiling.
    const matchCards = matchCardsDialog(page);
    await expectAfterMarketplace(page, matchCards, { platform: "BuySportsCards", what: "Match Cards after the fetch" });
    const confirmMatches = matchCards.getByRole("button", { name: "Confirm card matches", disabled: false });
    await expectAfterMarketplace(page, confirmMatches, { platform: "BuySportsCards", what: "Confirm unlocked after the fetch" });
    // The teams line is said while the dialog is open (once the wizard takes over, only the save repeats it).
    await expectTeamsFromChecklist(page, facts);
    // Every row of the file pairs with its card by number; LIVE_PLAYER's card, the one the file
    // leaves out, is BSC's alone, and no row is left over.
    await expect(matchCards.getByRole("heading", { name: "BSC only (1)" })).toBeVisible();
    const keepLive = matchCards.getByRole("button", { name: new RegExp(`^Keep #\\S+ ${LIVE_PLAYER} as BSC-only$`) });
    await expect(keepLive).toBeVisible();
    await expect(matchCards.getByRole("heading", { name: "Checklist only (0)" })).toBeVisible();
    await expect(matchCards.getByText(`Matched (${facts.rows})`)).toBeVisible();
    await expectAccessible(page, { within: matchCards, label: "Match Cards, one marketplace and a publisher's checklist" });
    // Keep it, so every fetched card saves: the file's rows plus LIVE_PLAYER's card.
    await keepLive.click();
    await expect(matchCards.getByRole("heading", { name: "BSC only (0)" })).toBeVisible();
    await expect(matchCards.getByRole("heading", { name: "Keeping (1)" })).toBeVisible();
    const FETCHED = facts.rows + 1;
    await confirmMatches.click();
    await expect(matchCards).toBeHidden();

    // Then the entity review, with the pairing session parked behind it.
    const wizard = reviewWizard(page);
    await expect(wizard).toBeVisible({ timeout: 60_000 });
    // NEO-335 Phase 2: the sitting starts at its first step, nothing decided
    // (on a name step x is the decided count plus one; y grows, so it is left free).
    await expect(stepCounter(page)).toHaveText(/^Step 1 of [0-9]+$/);
    await expect(wizard.getByRole("button", { name: "Back to Match Cards" })).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, first row" });

    // ── STEP 6: create ONE player with ONE career team, then skip every other name ──
    // NEO-335 needs ONE card whose team the evidence knows, and none of these
    // cards carries a team the evidence can fill, so the evidence has to be a
    // player's career. The cheapest honest source is the review itself: create
    // LIVE_PLAYER (the one card BSC is asked about, so his card is the one a
    // checklist claim does not hold) with ONE career team staged by hand. A career
    // pre-fills only when EXACTLY ONE of its teams covers [setYear-1, setYear]
    // (careerTeamVerdict): the set year is 1995 and the staged stint 1994-1996
    // covers it. The mechanics are checklist-wizard-career-team-commits, reused
    // step for step.
    const team = recordedNoMatchName(env, "checklist-one-marketplace-match-cards-keeps-every-card");
    const other = `RXO${env.ATTEMPT_TOKEN}T`;
    await walkToLivePlayer(page);
    // Not a "Link to <name>" preselect and not held: this spec creates the player.
    await expect(addAsNewPlayerButton(page)).toHaveText("Add as New Player");
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
    await expect(lookingUp).toBeHidden({ timeout: LOOKUPS });
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
    await answerPlayerAsNew(page);
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

    // THE PRE-FILL, or invariant 8's hold-back (NEO-489, Jason 2026-11-11: a 429 or an open
    // cooldown on the live card is a pass). The wizard opened behind the team fence (every
    // lookup settled), so BSC's answer for his card is final here. The line ALWAYS offers his
    // one in-window career team. Answered: it is CHECKED by default, nobody touched it.
    // Cooldown: the lookup was skipped, the line rests on "Leave for later" and the operator
    // picks the team. Either way he ends on the career team, so everything after is unconditional.
    const careerTeamRadio = wizard.getByRole("radio", { name: `${team} — ${LIVE_PLAYER}`, exact: true });
    const prefilled = wizard.getByRole("radio", { name: `${team} — ${LIVE_PLAYER}`, exact: true, checked: true });
    const heldBack = wizard.getByRole("radio", { name: `Leave for later — ${LIVE_PLAYER}`, exact: true, checked: true });
    await expect(careerTeamRadio).toBeVisible();
    await expect(prefilled.or(heldBack)).toBeVisible();
    const answered = await prefilled.isVisible();
    bscLookupOutcome(answered ? "answered" : "cooldown", LIVE_PLAYER);
    if (!answered) {
      await expect(careerTeamRadio).not.toBeChecked();
      await careerTeamRadio.check();
    }
    await expect(careerTeamRadio).toBeChecked();

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
    // the only cards that carry a team CHIP: the card answered "no team" and the
    // rest left for later hold none, and neither does NB272. The 24 cards the
    // publisher's checklist claimed (NEO-489) are in that chipless group: a
    // checklist claim holds the guess back and writes no team of its own, which the
    // walk to the end of the checklist below proves card by card. Which teamed card
    // the walk meets first is the checklist's order, not this spec's to know. So
    // the walk stops on the first drawer showing ANY team chip, waits for it to
    // name one of the two, reads WHICH, steps past it, and walks on to the next
    // teamed card, which must name the other. Each chip is the drawer's
    // TeamPicker reading the stored row.
    const dialog = page.getByRole("dialog");
    const chipOf = (name: string) => dialog.getByRole("button", { name: `Remove team ${name}`, exact: true });
    const chiplessBefore = await nextCardUntilTeamChip(page);
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
    const chiplessBetween = await nextCardUntilTeamChip(page);
    await expect(dialog.getByRole("button", { name: new RegExp(`^Remove team ${secondName}( · .*)?$`) })).toBeVisible();
    // THE CLAIMED CARDS (NEO-489): every card after the second teamed one, to the end of the
    // checklist, shows the picker with no team chip. Together with the cards the walks stood
    // on, that is every committed card but the two: FETCHED + NB272 - 2, none claimed onto a team.
    const chiplessAfter = await expectNoTeamChipsToTheEnd(page);
    expect(
      chiplessBefore + chiplessBetween + chiplessAfter,
      "every card but the two teamed ones was seen without a team chip",
    ).toBe(FETCHED - 1);
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
    // the deterministic way through.
    // The same checklist again (the chip may still hold it): ONE live BSC lookup this time too.
    await usePublishersChecklist(page, CHECKLISTS.roanokeExpress1995OneLive);
    await syncChecklistButton(page).click();
    // A live BSC fetch: Match Cards again (two sources, NEO-496), with LIVE_PLAYER's card kept so
    // every card comes back through (the helper keeps every BSC-only card, proves the teams line).
    await confirmChecklistMatchCards(page, { facts, what: "the re-sync" });
    // Then the diff: our own server, 7 s.
    const skipChanges = page.getByRole("button", { name: "Skip reviewing changes and continue" });
    await expect(skipChanges).toBeVisible();
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
    // cards again, and the count must hold. EXACTLY "Saved N cards." plus the
    // checklist's own tail ("Teams from your checklist: 24 of N cards."), and NOTHING
    // else: every name was answered in the first sitting, so this commit has nothing
    // more to report. The banner is ONE text node holding the count and every note
    // the commit appends, so any other note fails the full-string anchor by name
    // (the one this pins: "N names were not reviewed; those cards have no
    // player/team link", the commit treating names found in the set's stored
    // skips as unanswered and stamping them back as pending names).
    await confirmSaveButton(page).click();
    await expect(
      page.getByText(
        new RegExp(`^Saved ${FETCHED} cards\\. Teams from your checklist: ${facts.matched} of ${FETCHED} cards\\.$`),
      ),
    ).toBeVisible();
  },
);
