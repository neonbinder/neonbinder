// Origin: .maestro/flows/set-selector/checklist-wizard-link-team-saves-alias.yaml (Maestro suite retired in NEO-341; see git history)
//
// ONE FEATURE (NEO-284): linking a checklist TEAM row to an existing team in
// the entity-review wizard remembers the row's raw spelling as one of that
// team's aliases (default on), the commit writes it, and Team Management lists
// it. Also covered, as the flow does: a New Team name that is another team's
// alias is refused (NEO-307), and a past-era club on the checklist links
// instead of being raised as a step (NEO-307 Option A).
//
// Sole writer of the Rickwood Field Negro Leagues set; fresh-only (it mints
// "Pittsburgh Crawfords" and commits the set). Re-seed before re-running.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { drillToSet, pick, syncChecklistButton } from "../../support/set-builder";
import type { Page } from "@playwright/test";

const SET = "Topps MLB at Rickwood Field Negro Leagues Collection";
const RETRO_CLUB = "Pittsburgh Crawfords";

/** The admin Team Management page, filtered to `query`. */
async function openTeams(page: Page, query: string) {
  await page.goto("/admin/teams");
  // A mid-flow reload, the flow's 30 s.
  await expect(page.getByText(/of .* teams/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("textbox", { name: "Filter teams" }).fill(query);
  await expect(page.getByText(/^1 of .* teams/)).toBeVisible();
}

test(
  "Entity review — linking a checklist TEAM to an existing team remembers the checklist's spelling as one of that team's names",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const T = env.ATTEMPT_TOKEN;
    const FIXTURE_TEAM = `Loc${T} Ali${T}`;

    await signIn("/admin/players");
    await expect(page.getByText(/of .* players/)).toBeVisible({ timeout: LAUNCH_GATE });

    // ── PART 1: the fixture teams, created through a player's career editor ──
    await page.getByRole("textbox", { name: "Filter players" }).fill("zzzznotaplayer");
    await expect(page.getByText("No players match that filter.")).toBeVisible();
    const sport = page.getByRole("combobox", { name: "Sport" });
    await sport.selectOption("Baseball");
    await expect(sport.getByRole("option", { selected: true })).toHaveText("Baseball");
    await expect(page.getByText("0 matches", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Add player" }).click();
    await page.getByRole("textbox", { name: "New player name" }).fill(`Alp${T}`);
    await page.getByRole("button", { name: `Create player Alp${T}` }).click();
    await expect(page.getByRole("heading", { name: `Alp${T}`, exact: true })).toBeVisible();
    await expect(page.getByText(`Added Alp${T}`)).toBeVisible();
    await expect(page.getByText("No stints recorded yet.")).toBeVisible();

    const addTeam = page.getByRole("button", { name: "Add team" });
    const teamSearch = page.getByRole("textbox", { name: "Search teams" });

    // The fixture team: Location + Name, no league.
    await addTeam.click();
    await teamSearch.fill(`Ali${T}`);
    await expect(page.getByText("No matches.")).toBeVisible();
    await teamSearch.press("Enter");
    const newAli = page.getByRole("dialog", { name: `New team: Ali${T}` });
    await expect(newAli).toBeVisible();
    await newAli.getByRole("textbox", { name: "New team location (optional)" }).fill(`Loc${T}`);
    // The Create button's name is the composed full name: Location then Name.
    await newAli.getByRole("button", { name: `Create team ${FIXTURE_TEAM}` }).click();
    await expect(page.getByRole("button", { name: `Remove team ${FIXTURE_TEAM}` })).toBeVisible();

    // The retro club, with a closed era and one alias (for the clash below).
    await addTeam.click();
    await teamSearch.fill(RETRO_CLUB);
    await expect(page.getByText("No matches.")).toBeVisible();
    await teamSearch.press("Enter");
    const newRetro = page.getByRole("dialog", { name: `New team: ${RETRO_CLUB}` });
    await expect(newRetro).toBeVisible();
    await newRetro.getByRole("spinbutton", { name: "New team active from (optional)" }).fill("1926");
    await newRetro.getByRole("spinbutton", { name: "New team active to" }).fill("1940");
    await newRetro.getByRole("textbox", { name: "New team aliases (optional)" }).fill(`Pca${T}`);
    await newRetro.getByRole("button", { name: `Create team ${RETRO_CLUB}`, exact: true }).click();
    await expect(page.getByRole("button", { name: `Remove team ${RETRO_CLUB}` })).toBeVisible();

    // ── PART 2: the set; decline SportLots (it does not carry this set), fetch BSC only ──
    await drillToSet(page, env, { set: SET });
    await pick(page, "Variant Types", "Base", { search: false });
    const picker = page.getByRole("dialog", { name: "Select Base Set" });
    await expect(picker).toBeVisible();
    // The picker fetches the year's SportLots catalogue live (the flow's 60 s).
    await expect(picker.getByRole("button", { name: "Confirm Base Set" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(picker.getByRole("option", { name: /^BSC base candidate: / }).first()).toBeVisible();
    const slCandidates = picker.getByRole("option", { name: /^SportLots base candidate: / });
    if (!env.SL_PAUSED) {
      await expect(slCandidates.first()).toBeVisible();
    } else {
      await expect(picker.getByText(/^SportLots returned no base set for /)).toBeVisible();
      await expect(slCandidates).toHaveCount(0);
    }
    await picker.getByRole("button", { name: "Cancel" }).click();
    const cancelled = page.getByText(/Base mapping cancelled/);
    await expect(cancelled).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(cancelled).toBeHidden();
    await expect(page.getByRole("button", { name: "Map Base Set" })).toBeVisible();

    await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible();
    await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();
    await syncChecklistButton(page).click();
    // One live BSC round trip; the solo path says what it kept (NEO-255).
    await expect(page.getByText(/Kept all [0-9]+ cards? from /)).toBeVisible({ timeout: 60_000 });
    const wizard = page.getByRole("dialog", { name: "Confirm New Players & Teams" });
    await expect(wizard).toBeVisible({ timeout: 60_000 });

    // ── PART 3: the first TEAM row ──
    const reviewed = wizard.getByText(/^[0-9]+ of [0-9]+ reviewed/);
    await expect(reviewed).toHaveText(/^0 of [0-9]+ reviewed/);
    // Live Wikidata lookups for the whole batch (the flow's 180 s).
    await expect(wizard.getByText(/still looking up/)).toBeHidden({ timeout: 180_000 });

    const teamSkip = wizard.getByRole("button", { name: /^Skip .* — not a team$/ });
    const leagueSkip = wizard.getByRole("button", { name: /^Skip .* — this team has no league$/ });
    const personSkip = wizard.getByRole("button", { name: /^Skip .* — not a person$/ });
    const stepHeading = wizard.getByRole("heading", { name: /^New (Team|League): / });

    // A club's lookup can stage its LEAGUE as a step ahead of it: skip
    // leagues (a skip creates nothing) until a team row is presented.
    for (let i = 0; i < 20; i++) {
      await expect(teamSkip.or(leagueSkip)).toBeVisible();
      if (await teamSkip.isVisible()) break;
      const name = (await leagueSkip.getAttribute("aria-label")) ?? "";
      await leagueSkip.click();
      await expect(wizard.getByRole("button", { name, exact: true })).toBeHidden();
    }
    await expect(teamSkip).toBeVisible();

    // The row's raw checklist spelling: the string the alias will be.
    const ROW = ((await stepHeading.textContent()) ?? "").replace(/^New Team: /, "").trim();
    expect(ROW.length).toBeGreaterThan(0);
    // The retro club resolves to its row and is never raised as a step.
    expect(ROW).not.toBe(RETRO_CLUB);

    // ── PART 4: link, with the remember-box on ──
    const linkSection = wizard.getByRole("group", { name: "Link to existing team" });
    const searchAll = linkSection.getByRole("combobox", { name: "Search all teams" });
    await expect(searchAll).toBeVisible();
    // Opens EMPTY (NEO-326): no pre-fill with the row's name.
    await expect(searchAll).toHaveValue("");
    await expect(searchAll).toHaveAttribute("placeholder", "Type a team name");
    const remember = linkSection.getByRole("checkbox", {
      name: `Remember “${ROW}” as a name for this team`,
    });
    await expect(remember).toBeVisible();
    // Default on. (Maestro cannot read a checkbox; it proves this through the
    // "remembered as" read-back below, which is asserted too.)
    await expect(remember).toBeChecked();

    // NEO-307: a New Team name that is another team's alias is refused.
    const teamName = wizard.getByRole("textbox", { name: "New team name" });
    await expect(teamName).toHaveValue(ROW);
    await teamName.fill(`Pca${T}`);
    await expect(
      wizard
        .getByText(
          `${RETRO_CLUB} already answers to this name as an alias — remove it there before a team can take the name.`,
        )
        .first(),
    ).toBeVisible();
    await expect(wizard.getByRole("button", { name: `Link to ${RETRO_CLUB} · 1926–1940` })).toBeVisible();
    const countBefore = await reviewed.textContent();
    await expect(wizard.getByRole("button", { name: "Add as New Team" })).toBeDisabled();
    await expect(wizard.getByRole("heading", { name: `New Team: ${ROW}` })).toBeVisible();

    // Link through the search: the typed token finds the fixture by name.
    await searchAll.fill(`Ali${T}`);
    await expect(searchAll).toHaveValue(`Ali${T}`);
    // Still undecided: the refused create recorded nothing.
    await expect(reviewed).toHaveText(countBefore ?? "");
    await page.getByRole("option", { name: new RegExp(`^${FIXTURE_TEAM}`) }).click();
    await expect(wizard.getByRole("heading", { name: `New Team: ${ROW}` })).toBeHidden();

    // Read the decision back: "· remembered as" exists only for a team link
    // whose remember-box was on.
    await wizard.getByRole("button", { name: "Back to previous decision" }).click();
    const decision = wizard.getByRole("group", { name: `Decision for ${ROW}` });
    await expect(decision).toBeVisible();
    await expect(decision).toContainText(`Linked to ${FIXTURE_TEAM} · remembered as “${ROW}”`);
    await decision.getByRole("button", { name: "Next" }).click();

    // ── PART 5: read every other team/league step, then commit ──
    for (let i = 0; i < 20; i++) {
      const anyStepSkip = teamSkip.or(leagueSkip);
      await expect(personSkip.or(anyStepSkip)).toBeVisible();
      if (await personSkip.isVisible()) break;
      const heading = (await stepHeading.textContent()) ?? "";
      const skipName = (await anyStepSkip.getAttribute("aria-label")) ?? "";
      if (skipName.endsWith("has no league")) {
        expect(heading).toMatch(/^New League: /);
      } else {
        expect(heading).toMatch(/^New Team: /);
        expect(heading).not.toBe(`New Team: ${RETRO_CLUB}`);
      }
      await anyStepSkip.click();
      await expect(wizard.getByRole("button", { name: skipName, exact: true })).toBeHidden();
    }
    await expect(personSkip).toBeVisible();

    await wizard.getByRole("button", { name: /Skip remaining names \([0-9]+\)/ }).click();
    const confirmSave = wizard.getByRole("button", { name: /Confirm & Save/ });
    await expect(confirmSave).toBeVisible();
    await confirmSave.click();
    await expect(page.getByText(/Saved [0-9]+ cards/)).toBeVisible();
    // The retro club's card LINKED to its row (an unresolved team prints
    // "<name> (unconfirmed)").
    await expect(page.getByText(new RegExp(`${RETRO_CLUB}(?! \\(unconfirmed\\))`)).first()).toBeVisible();

    // ── PART 6: Team Management shows the alias ──
    await openTeams(page, `Ali${T}`);
    await page.getByRole("button", { name: new RegExp(`Ali${T}`) }).click();
    const aka = page.getByRole("textbox", { name: "Also known as" });
    const currentAliases = page.getByRole("list", { name: "Current aliases" });
    await expect(aka).toHaveValue(ROW);
    await expect(currentAliases).toBeVisible();
    await expect(currentAliases.getByText(ROW, { exact: true })).toBeVisible();

    // ── PART 7: take it back out, and prove the removal persisted ──
    await aka.clear();
    await expect(currentAliases).toBeHidden();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(`Saved ${FIXTURE_TEAM}`)).toBeVisible();

    await openTeams(page, `Ali${T}`);
    await page.getByRole("button", { name: new RegExp(`Ali${T}`) }).click();
    await expect(aka).toHaveValue("");
    await expect(page.getByPlaceholder("LSU, Louisiana State, LSU Tigers baseball")).toBeVisible();
    await expect(currentAliases).toBeHidden();

    // ── PART 8: the retro club is still exactly one row ──
    await openTeams(page, RETRO_CLUB);
  },
);
