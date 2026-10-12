// Origin: .maestro/flows/set-selector/set-fill-teams-from-teammate-card.yaml (Maestro suite retired in NEO-341; see git history)
// NEO-279/306: a teamless card borrows the team its player carries on another
// card of the same set, from the checklist's "N cards need a team" button,
// after a preview the operator confirms. Per-worker, per-attempt custom set
// under E2E Test Sport <worker> > 2026 > Topps; every minted name is a single
// search token.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady, drillToCustom, selectOrCreate } from "../../support/set-builder";

test(
  "Fill teams — a teamless card borrows the team its player carries on another card of the same set, from the checklist's N-cards-need-a-team button, after a preview the operator confirms (NEO-279, NEO-306)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const A = env.ATTEMPT_ID;
    const T = env.ATTEMPT_TOKEN;
    const PLAYER = `FTP${T}`;
    const TEAM = `FTT${T}`;
    const FULL_TEAM = `Loc${T} ${TEAM}`;
    const needsTeam = (n: string) =>
      page.getByRole("img", { name: new RegExp(`^Card ${n}-${A}(,.*)? needs attention: no team on this card yet$`) });

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await drillToCustom(page, {
      sport: `E2E Test Sport ${env.WORKER_INDEX}`,
      year: "2026",
      manufacturer: "Topps",
      set: `ftl-${env.WORKER_INDEX}-${A}`,
    });
    await selectOrCreate(page, "Variant Types", "Insert", { via: "list" });
    await expect(page.getByRole("heading", { name: "Inserts", exact: true })).toBeVisible();
    await selectOrCreate(page, "Inserts", "Base", { via: "list" });

    const cardName = page.getByRole("textbox", { name: "Card name" });

    // ── Card 781: a brand-new player AND a brand-new team (no league).
    await page.getByRole("button", { name: "Open add card form" }).click();
    await expect(cardName).toBeVisible();
    await page.getByRole("textbox", { name: "Card number" }).fill(`781-${A}`);
    await cardName.fill(`Fill Alpha ${A}`);

    await page.getByRole("button", { name: "Add a player to the new card" }).click();
    const findPlayer = page.getByRole("textbox", { name: "Find a player for the new card" });
    await findPlayer.fill(PLAYER);
    // The create row is offered and labelled with the name it would create, and it
    // is on screen: with the trigger at the fold of the 1024x629 window the popover
    // flips above it rather than opening below the viewport (NEO-341).
    const createPlayer = page.getByRole("option", { name: `Create player ${PLAYER}` });
    await expect(createPlayer).toBeVisible();
    await expectAccessible(page, { label: "Quick-add player picker open" });
    await createPlayer.click();
    await expect(page.getByRole("button", { name: `Remove player ${PLAYER}` })).toBeVisible();
    await cardName.click();
    await expect(findPlayer).toBeHidden();

    await page.getByRole("button", { name: "Add team" }).click();
    const searchTeams = page.getByRole("textbox", { name: "Search teams" });
    await searchTeams.fill(TEAM);
    await expect(page.getByText("No matches.")).toBeVisible();
    const newTeamRow = page.getByRole("button", { name: `New team ${TEAM}`, exact: true });
    await expect(newTeamRow).toBeVisible();
    await newTeamRow.click();
    const newTeam = page.getByRole("dialog", { name: `New team: ${TEAM}` });
    await expect(newTeam).toBeVisible();
    await expect(newTeam.getByRole("textbox", { name: "New team name" })).toHaveValue(TEAM);
    await expectAccessible(page, { within: newTeam, label: "New Team dialog" });
    await newTeam.getByRole("textbox", { name: "New team location (optional)" }).fill(`Loc${T}`);
    const league = newTeam.getByRole("combobox", { name: "League" });
    await league.fill("No lea");
    await newTeam.getByRole("option", { name: "No league" }).click();
    await expect(league).toHaveValue("No league");
    await newTeam.getByRole("button", { name: `Create team ${FULL_TEAM}` }).click();
    await expect(page.getByRole("button", { name: `Remove team ${FULL_TEAM}` })).toBeVisible();
    await cardName.click();
    await expect(searchTeams).toBeHidden();

    await page.getByRole("button", { name: "Submit new card" }).click();
    await expect(cardName).toBeHidden();
    await expect(page.getByRole("button", { name: `Edit card 781-${A}` })).toBeVisible();
    // The row prints its team, and it is not flagged.
    await expect(page.getByText(FULL_TEAM, { exact: true })).toBeVisible();
    await expect(needsTeam("781")).toBeHidden();
    await expectAccessible(page, { label: "Checklist with a teamed card" });

    // ── Card 782: the SAME player (picked from the existing list), no team.
    await page.getByRole("button", { name: "Open add card form" }).click();
    await expect(cardName).toBeVisible();
    await page.getByRole("textbox", { name: "Card number" }).fill(`782-${A}`);
    await cardName.fill(`Fill Bravo ${A}`);
    await page.getByRole("button", { name: "Add a player to the new card" }).click();
    await findPlayer.fill(PLAYER);
    await expect(page.getByRole("option", { name: `Create player ${PLAYER}` })).toBeHidden();
    const existingPlayer = page.getByRole("option", { name: `Add ${PLAYER}` });
    await expect(existingPlayer).toBeVisible();
    await existingPlayer.click();
    await expect(page.getByRole("button", { name: `Remove player ${PLAYER}` })).toBeVisible();
    await cardName.click();
    await expect(findPlayer).toBeHidden();
    await page.getByRole("button", { name: "Submit new card" }).click();
    await expect(cardName).toBeHidden();
    await expect(page.getByRole("button", { name: `Edit card 782-${A}` })).toBeVisible();
    await expect(needsTeam("782")).toBeVisible();
    await expectAccessible(page, { label: "Checklist with a card needing a team" });

    // ── Fill teams: a preview the operator confirms.
    await page.getByRole("button", { name: "1 card needs a team" }).click();
    const preview = page.getByRole("dialog", { name: "Fill teams on 1 card?" });
    await expect(preview).toBeVisible();
    await expect(preview.getByText("1 from the same player's other cards here.")).toBeVisible();
    const who = preview.getByRole("group", { name: "Who gets which team" });
    await expect(who).toBeVisible();
    await expect(who.getByText(PLAYER)).toBeVisible();
    await expect(who.getByText(FULL_TEAM)).toBeVisible();
    await expectAccessible(page, { within: preview, label: "Fill teams preview dialog" });
    await expect(preview.getByText(/1 card . same player in this set/)).toBeVisible();
    await preview.getByRole("button", { name: "Yes, fill" }).click();

    await expect(page.getByText("Filled teams on 1 card")).toBeVisible();
    await expect(preview).toBeHidden();
    await expect(page.getByRole("button", { name: /^[0-9]+ cards? needs? a team$/ })).toBeHidden();

    // Card 782's drawer carries the borrowed team; it is no longer flagged.
    await page.getByRole("button", { name: `Edit card 782-${A}` }).click();
    await expect(cardName).toBeVisible();
    await expect(page.getByRole("button", { name: `Remove team ${FULL_TEAM}` })).toBeVisible();
    await expectAccessible(page, { label: "Card drawer with the borrowed team" });
    await page.getByRole("button", { name: "Done editing card" }).click();
    await expect(cardName).toBeHidden();
    await expect(needsTeam("782")).toBeHidden();
    await expect(page.getByRole("button", { name: `Edit card 781-${A}` })).toBeVisible();
    await expect(page.getByText(FULL_TEAM, { exact: true }).first()).toBeVisible();

    // Cleanup: delete both cards, leaving the set's checklist empty.
    for (const [n, label] of [["781", "Fill Alpha"], ["782", "Fill Bravo"]] as const) {
      await page.getByRole("button", { name: `Delete card ${n}-${A}` }).click();
      await expect(page.getByText("Confirm?")).toBeVisible();
      await page.getByRole("button", { name: `Confirm delete card ${n}-${A}` }).click();
      await expect(page.getByText(`${label} ${A}`)).toBeHidden();
    }
    await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();
  },
);
