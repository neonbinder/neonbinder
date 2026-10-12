// Origin: .maestro/flows/set-selector/checklist-wizard-link-team-saves-alias.yaml (Maestro suite retired in NEO-341; see git history)
//
// ONE FEATURE (NEO-284): linking a checklist TEAM row to an existing team in
// the entity-review wizard remembers the row's raw spelling as one of that
// team's aliases (default on), the commit writes it, and Team Management lists
// it. Also covered, as the flow does: a New Team name that is another team's
// alias is refused (NEO-307).
//
// NEO-307's past-era claims (a card resolving a club whose era ended before the
// set's year, or the operator's link of one) moved out in NEO-330 to
// checklist-wizard-past-era-team-link-commits: this set's clubs are absent
// from the reference catalogue, so it has neither shape (Jason, 2026-10-10).
//
// Sole writer of the 1996 Line Up Venezuelan Winter League set (BSC only;
// SET-REGISTRY.md); fresh-only (it mints the fixture team and commits the
// set). Re-seed before re-running. MEASURED on PR #314's preview: 300 cards,
// 200 new players + 8 new teams, 211 rows once every lookup settled (the 8
// Venezuelan Professional Baseball League clubs, one staged league, two staged
// career teams). The catalogue holds none of the eight clubs. Two of the 200
// players are same-name rows (NEO-332) and open as pick steps; an untouched
// pick step yields to the first settled team like any player row.
//
// THE ROW UNDER TEST IS NAMED, not "whichever comes first": the walk reads
// each team/league step's heading, acts on the checklist club "Navegantes del
// Magallanes" and skips every other step (a skip creates nothing, R7).
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { expectPlayersLoaded, expectTeamsLoaded, teamsCounter } from "../../support/players";
import { fetchOneMarketplaceSetChecklistToWizard } from "../../support/wizard";
import type { Page } from "@playwright/test";

const SET = "Line Up Venezuelan Winter League";
const ROW = "Navegantes del Magallanes";

/** The admin Team Management page, filtered to `query`. */
async function openTeams(page: Page, query: string) {
  await page.goto("/admin/teams");
  // A mid-flow reload, the flow's 30 s.
  await expectTeamsLoaded(page, 30_000);
  await page.getByRole("textbox", { name: "Filter teams" }).fill(query);
  await expect(teamsCounter(page, "1 match")).toBeVisible();
}

test(
  "Entity review — linking a checklist TEAM to an existing team remembers the checklist's spelling as one of that team's names",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const T = env.ATTEMPT_TOKEN;
    const FIXTURE_TEAM = `Loc${T} Ali${T}`;

    await signIn("/admin/players");
    await expectPlayersLoaded(page, LAUNCH_GATE);

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
    await expectAccessible(page, { label: "Player detail, new player with no stints" });

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
    // The alias holder for the NEO-307 refusal below: inert, no checklist carries it.
    await newAli.getByRole("textbox", { name: "New team aliases (optional)" }).fill(`Pca${T}`);
    await expectAccessible(page, { within: newAli, label: "New team dialog, location and name" });
    // The Create button's name is the composed full name: Location then Name.
    await newAli.getByRole("button", { name: `Create team ${FIXTURE_TEAM}` }).click();
    await expect(page.getByRole("button", { name: `Remove team ${FIXTURE_TEAM}` })).toBeVisible();

    // ── PART 2: the set; decline SportLots (it does not carry this set), fetch BSC only ──
    await fetchOneMarketplaceSetChecklistToWizard(page, env, { sport: "Baseball", year: "1996", set: SET });
    const wizard = page.getByRole("dialog", { name: "Confirm New Players & Teams" });

    // ── PART 3: walk the team and league steps, acting on one club by name ──
    const reviewed = wizard.getByText(/^[0-9]+ of [0-9]+ reviewed/);
    await expect(reviewed).toHaveText(/^0 of [0-9]+ reviewed/);
    // Wait the batch's lookups out so every step the walk reads is settled and
    // nothing that settles later out-ranks the row under test (leagues before
    // teams before players). Marketplace-class wait: one lookup per unknown
    // name through the deployment-wide pool (the flow's 180 s; measured ~144 s
    // live, the NEO-289 recording answers every lookup this batch makes, so
    // this stays the live-lane ceiling until a CI run measures the recorded one).
    await expect(wizard.getByText(/still looking up/)).toBeHidden({ timeout: 180_000 });

    const teamSkip = wizard.getByRole("button", { name: /^Skip .* — not a team$/ });
    const leagueSkip = wizard.getByRole("button", { name: /^Skip .* — this team has no league$/ });
    const personSkip = wizard.getByRole("button", { name: /^Skip .* — not a person$/ });
    const stepHeading = wizard.getByRole("heading", { name: /^New (Team|League): / });

    // A player row coming up is the product saying there are no more team steps.
    let aliasDone = false;
    for (let i = 0; i < 20; i++) {
      const anyStepSkip = teamSkip.or(leagueSkip);
      await expect(personSkip.or(anyStepSkip)).toBeVisible();
      if (await personSkip.isVisible()) break;
      const heading = ((await stepHeading.textContent()) ?? "").trim();
      if (heading !== `New Team: ${ROW}`) {
        // Another club, a league or a staged career team: skip (creates nothing).
        const skipName = (await anyStepSkip.getAttribute("aria-label")) ?? "";
        await anyStepSkip.click();
        await expect(wizard.getByRole("button", { name: skipName, exact: true })).toBeHidden();
        continue;
      }

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
      await expectAccessible(page, { within: wizard, label: "Entity review wizard, team step with the link section" });

      // NEO-307: a New Team name that is another team's alias is refused.
      const teamName = wizard.getByRole("textbox", { name: "New team name" });
      await expect(teamName).toHaveValue(ROW);
      await teamName.fill(`Pca${T}`);
      await expect(
        wizard
          .getByText(
            `${FIXTURE_TEAM} already answers to this name as an alias — remove it there before a team can take the name.`,
          )
          .first(),
      ).toBeVisible();
      await expect(wizard.getByRole("button", { name: `Link to ${FIXTURE_TEAM}` })).toBeVisible();
      const countBefore = await reviewed.textContent();
      await expect(wizard.getByRole("button", { name: "Add as New Team" })).toBeDisabled();
      await expect(wizard.getByRole("heading", { name: `New Team: ${ROW}` })).toBeVisible();
      await expectAccessible(page, { within: wizard, label: "Entity review wizard, new team name refused as an alias" });

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
      await expectAccessible(page, { within: wizard, label: "Entity review wizard, decided team link" });
      await decision.getByRole("button", { name: "Next" }).click();
      aliasDone = true;
    }
    await expect(personSkip).toBeVisible();
    expect(aliasDone, `the "${ROW}" team step must be presented`).toBe(true);

    await wizard.getByRole("button", { name: /Skip remaining names \([0-9]+\)/ }).click();
    const confirmSave = wizard.getByRole("button", { name: /Confirm & Save/ });
    await expect(confirmSave).toBeVisible();
    await confirmSave.click();
    await expect(page.getByText(/Saved [0-9]+ cards/)).toBeVisible();

    // ── PART 6: Team Management shows the alias ──
    await openTeams(page, `Ali${T}`);
    await page.getByRole("button", { name: new RegExp(`Ali${T}`) }).click();
    const aka = page.getByRole("textbox", { name: "Also known as" });
    const currentAliases = page.getByRole("list", { name: "Current aliases" });
    await expect(aka).toHaveValue(ROW);
    await expect(currentAliases).toBeVisible();
    await expect(currentAliases.getByText(ROW, { exact: true })).toBeVisible();
    await expectAccessible(page, { label: "Team Management, team detail with its remembered alias" });

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
  },
);
