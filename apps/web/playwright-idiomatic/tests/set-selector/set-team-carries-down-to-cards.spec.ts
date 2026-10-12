// Spec: .maestro/flows/set-selector/set-team-carries-down-to-cards.yaml
// NEO-277: Team is a SET-level attribute. Picked once on the set it is copied
// to every card created beneath it; when it changes it cascades to the cards
// that inherited it and leaves a hand-set card alone, and the confirm in front
// of that cascade states both counts. Per-worker, per-attempt custom set under
// E2E Test Sport <worker> > 2026 > Topps (the synthetic sport keeps the League
// combobox to what THIS worker minted). Every minted name is a single token.
//
// The three teams answer the New Team dialog's League question three ways:
//   STA creates a league from the typed text, STB picks that league as an
//   EXISTING option, STC answers "No league".
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { addCardByHand, drillToCustom, selectOrCreateDirect } from "../../support/batch6/custom";
import type { Locator, Page } from "@playwright/test";

test(
  "Set-level Team carries down to cards — new cards are born with it, a change cascades to the cards that inherited it and leaves a hand-set card alone (NEO-277)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const A = env.ATTEMPT_ID;
    const T = env.ATTEMPT_TOKEN;
    const SET = `stt-${env.WORKER_INDEX}-${A}`;
    const LEAGUE = `STL${T}L`;
    const teamA = { short: `STA${T}`, full: `Loc${T} STA${T}` };
    const teamB = { short: `STB${T}`, full: `Loc${T} STB${T}` };
    const teamC = { short: `STC${T}`, full: `Loc${T} STC${T}` };
    const target = {
      sport: `E2E Test Sport ${env.WORKER_INDEX}`,
      year: "2026",
      manufacturer: "Topps",
      setName: SET,
    };

    const panel = page.getByRole("region", { name: "Set attributes panel" });
    const edit = panel.getByRole("button", { name: "Edit attributes" });
    const hide = panel.getByRole("button", { name: "Hide attributes" });
    const cardName = page.getByRole("textbox", { name: "Card name" });
    // A checklist row is one run of text: "#<number> <name> <team> ...".
    const rowWithTeam = (n: string, team: string) =>
      page.getByText(new RegExp(`#${n}-${A}.*${team}`));
    const removeChip = (full: string) => page.getByRole("button", { name: `Remove team ${full}` });

    async function openPanel() {
      await expect(edit.or(hide)).toBeVisible();
      if (await edit.isVisible()) await edit.click();
      await expect(hide).toBeVisible();
    }

    /** Pick a brand-new team in the SET picker: the dialog's Location, then `answerLeague`. */
    async function createSetTeam(
      team: { short: string; full: string },
      answerLeague: (dialog: Locator) => Promise<void>,
    ) {
      await panel.getByRole("button", { name: "Add set team" }).click();
      const find = page.getByRole("textbox", { name: "Find a team for the set" });
      await expect(find).toBeVisible();
      await find.fill(team.short);
      await expect(page.getByRole("button", { name: `New team ${team.short}` })).toBeVisible();
      await find.press("Enter");
      const dialog = page.getByRole("dialog", { name: `New team: ${team.short}` });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("textbox", { name: "New team name" })).toHaveValue(team.short);
      await dialog.getByRole("textbox", { name: "New team location (optional)" }).fill(`Loc${T}`);
      await answerLeague(dialog);
      await dialog.getByRole("button", { name: `Create team ${team.full}` }).click();
    }

    async function noLeague(dialog: Locator) {
      const league = dialog.getByRole("combobox", { name: "League" });
      await league.fill("No lea");
      await dialog.getByRole("option", { name: "No league" }).click();
      await expect(league).toHaveValue("No league");
    }

    async function deleteCard(p: Page, n: string, label: string) {
      await p.getByRole("button", { name: `Delete card ${n}-${A}` }).click();
      await expect(p.getByText("Confirm?")).toBeVisible();
      await p.getByRole("button", { name: `Confirm delete card ${n}-${A}` }).click();
      await expect(p.getByText(`${label} ${A}`)).toBeHidden();
    }

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // ── STEP 1: the set is the deepest selection, so the panel scopes to it.
    await drillToCustom(page, target);
    await expect(page.getByRole("heading", { name: "Variant Types", exact: true })).toBeVisible();
    await openPanel();

    // ── STEP 2: the FIRST team on a set with nothing beneath it asks no
    // question, saves, and the cascade it schedules lands.
    await createSetTeam(teamA, async (dialog) => {
      // The League combobox: typed text no league answers to offers a create
      // option, which opens the dialog's league form pre-filled.
      const league = dialog.getByRole("combobox", { name: "League" });
      await league.fill(LEAGUE);
      await dialog.getByRole("option", { name: `Create “${LEAGUE}”` }).click();
      await expect(dialog.getByRole("textbox", { name: "New league name" })).toHaveValue(LEAGUE);
      await dialog.getByRole("button", { name: "Add league" }).click();
      await expect(league).toHaveValue(LEAGUE);
    });
    await expect(page.getByText("Team applied to cards")).toBeVisible();
    await expect(removeChip(teamA.full)).toBeVisible();

    // ── STEP 3: two cards under the set's Base, NO team picked on the way in,
    // are born with the set's team.
    await selectOrCreateDirect(page, "Variant Types", "variant type", "Insert");
    await expect(page.getByRole("heading", { name: "Inserts", exact: true })).toBeVisible();
    await selectOrCreateDirect(page, "Inserts", "insert", "Base");

    await addCardByHand(page, `771-${A}`, `Set Team Alpha ${A}`);
    // Card #1's row sub-line prints the set's team.
    await expect(rowWithTeam("771", teamA.full)).toBeVisible();
    await addCardByHand(page, `772-${A}`, `Set Team Bravo ${A}`);

    // ── STEP 4: card #2 is hand-set to a second team in its drawer.
    await page.getByRole("button", { name: `Edit card 772-${A}` }).click();
    await expect(cardName).toBeVisible();
    // Born with the set's team (the drawer chip) ...
    await expect(removeChip(teamA.full)).toBeVisible();
    // ... which the operator takes off, then replaces with a team of its own.
    await removeChip(teamA.full).click();
    await expect(page.getByText("Saved Teams")).toBeVisible();
    await expect(removeChip(teamA.full)).toBeHidden();

    await page.getByRole("button", { name: "Add team" }).click();
    const searchTeams = page.getByRole("textbox", { name: "Search teams" });
    await searchTeams.fill(teamB.short);
    await expect(page.getByText("No matches.")).toBeVisible();
    await searchTeams.press("Enter");
    const newB = page.getByRole("dialog", { name: `New team: ${teamB.short}` });
    await expect(newB).toBeVisible();
    await expect(newB.getByRole("textbox", { name: "New team name" })).toHaveValue(teamB.short);
    await newB.getByRole("textbox", { name: "New team location (optional)" }).fill(`Loc${T}`);
    // STB picks the league STA created as an EXISTING option: the option only
    // exists if that league row now exists in this sport.
    const leagueB = newB.getByRole("combobox", { name: "League" });
    await leagueB.fill(`${T}L`);
    await newB.getByRole("option", { name: LEAGUE }).click();
    await expect(leagueB).toHaveValue(LEAGUE);
    await newB.getByRole("button", { name: `Create team ${teamB.full}` }).click();
    await expect(removeChip(teamB.full)).toBeVisible();
    await cardName.click();
    await expect(searchTeams).toBeHidden();
    await page.getByRole("button", { name: "Done editing card" }).click();
    await expect(cardName).toBeHidden();

    // ── STEP 5: change the set's team. A fresh drill returns to the set.
    await drillToCustom(page, target);
    await expect(panel.getByRole("heading", { name: `Attributes for ${SET} (Set)` })).toBeVisible();
    await expect(panel.getByText(teamA.short).first()).toBeVisible();
    await openPanel();

    // The x on the chip writes nothing: it offers "Keep <team>" / "Clear team".
    await panel.getByRole("button", { name: `Remove team ${teamA.full}` }).click();
    await expect(panel.getByRole("button", { name: `Keep ${teamA.full}` })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Clear team" })).toBeVisible();

    // Picking a third team opens the confirm that counts both groups.
    await createSetTeam(teamC, noLeague);
    const apply = page.getByRole("dialog", { name: `Apply ${teamC.full} to this set?` });
    await expect(apply).toBeVisible();
    await expect(
      apply.getByText(`1 card under this set will get ${teamC.full}. 1 card carries a different team — these will not change.`),
    ).toBeVisible();
    await apply.getByRole("button", { name: "Yes, apply" }).click();
    await expect(page.getByText("Team applied to cards")).toBeVisible();
    await expect(panel.getByRole("button", { name: `Remove team ${teamC.full}` })).toBeVisible();
    await expect(panel.getByRole("button", { name: `Remove team ${teamA.full}` })).toBeHidden();

    // Card #1 now reads the third team; card #2 still reads its own.
    await selectOrCreateDirect(page, "Variant Types", "variant type", "Insert");
    await expect(page.getByRole("heading", { name: "Inserts", exact: true })).toBeVisible();
    await selectOrCreateDirect(page, "Inserts", "insert", "Base");
    await expect(page.getByRole("button", { name: `Edit card 771-${A}` })).toBeVisible();
    await expect(rowWithTeam("771", teamC.full)).toBeVisible();
    await expect(rowWithTeam("772", teamB.full)).toBeVisible();

    // Cleanup: both cards go, leaving the checklist empty.
    await deleteCard(page, "771", "Set Team Alpha");
    await deleteCard(page, "772", "Set Team Bravo");
    await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();
  },
);
