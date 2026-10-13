// Origin: .maestro/flows/set-selector/checklist-wizard-career-team-commits.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { expectTeamsLoaded, teamsCounter } from "../../support/players";
import {
  advanceToSave,
  fetchOneMarketplaceSetChecklistToWizard,
  readStep,
  reviewWizard,
  stepCounter,
  walkToPlayerRow,
} from "../../support/wizard";

// Sole writer of the 1995 Memphis RiverKings CHL set (SET-REGISTRY.md), BSC
// only; fresh-only (it commits the checklist). Approved by Jason 2026-10-10
// (NEO-330), replacing Topps Baltimore Orioles: the reference catalogue knows
// every Orioles player, so that fetch committed straight through with no
// wizard. MEASURED on PR #314's preview: 18 cards, 15 unknown names, all
// players, 0 teams. Re-seed before re-running.
const SET = "Memphis RiverKings CHL";

test(
  "Entity review — a hand-staged career team survives the commit and becomes a real team row",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const team = `MintedTeam${env.ATTEMPT_TOKEN}`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await fetchOneMarketplaceSetChecklistToWizard(page, env, { set: SET });
    const wizard = reviewWizard(page);
    await expect(stepCounter(page)).toHaveText(/^Step 1 of [0-9]+$/);
    // readyToCreate: this spec creates the player, so the walk also passes any
    // player whose create is held by a career team it skipped.
    await walkToPlayerRow(page, { readyToCreate: true });

    // Stage a career team by hand on the first player row.
    await expect(wizard.getByRole("combobox", { name: "Career team name" })).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, career team entry" });
    await wizard.getByRole("combobox", { name: "Career team name" }).fill(team);
    await wizard.getByRole("spinbutton", { name: "From year" }).fill("2001");
    await wizard.getByRole("spinbutton", { name: /^To year/ }).fill("2005");
    await wizard.getByRole("button", { name: "Add career team" }).click();

    // The new name is looked up (live), then raised as its own New Team step.
    const lookingUp = wizard.getByText(/still looking up/);
    const newTeam = wizard.getByRole("heading", { name: `New Team: ${team}` });
    await expect(newTeam.or(lookingUp).first()).toBeVisible();
    await expect(lookingUp).toBeHidden({ timeout: 180_000 });
    await expect(newTeam).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, New Team step for a career team" });
    await wizard.getByRole("button", { name: "Add as New Team" }).click();

    // Back on the player row (one decision write plus the walk's return: 7 s,
    // no external round trip). Since NEO-330 the walk comes BACK to the player
    // the team was typed on, not the first undecided player in batch order. The
    // chip renders only on the row it was typed on and keeps its years across
    // the hop, so this chip IS the proof the presented row is the same player.
    await expect(wizard.getByRole("combobox", { name: "Career team name" })).toBeVisible();
    await expect(wizard.getByText(new RegExp(`${team} \\(2001.2005\\)`))).toBeVisible();

    // "Add as New Player" records exactly ONE decision: the header's "Step x of
    // y" has x = decided + 1 on a name step, so x moves by exactly one. Pin x,
    // not y (y grows as staged steps arrive); the pattern is anchored at both
    // ends, so "Step 5" cannot answer for "Step 15".
    const { x: stepBefore } = await readStep(page);
    await wizard.getByRole("button", { name: "Add as New Player" }).click();
    await expect(stepCounter(page)).toHaveText(new RegExp(`^Step ${stepBefore + 1} of [0-9]+$`));

    await wizard.getByRole("button", { name: /Skip remaining names \([0-9]+\)/ }).click();
    // The walk already waited every lookup out, so the bulk is one mutation of
    // our own: 7 s (R5; measured 0.34 s on PR #314's preview). Past the names
    // come the teams / titles steps (NEO-335): this spec's feature is the staged
    // team, so they stay on their defaults and the walk goes to the Save step.
    await advanceToSave(page);
    const confirmSave = wizard.getByRole("button", { name: /Confirm & Save/ });
    await expect(confirmSave).toBeVisible();
    // The Save step's summary omits a zero line, so this one is present only
    // because the create above (and the team step's) landed; everything else
    // was skipped.
    await expect(wizard.getByText("New players and teams", { exact: true })).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, summary" });
    await confirmSave.click();
    await expect(page.getByText(/Saved [0-9]+ cards/)).toBeVisible();

    // The staged team is now a real row in Team Management.
    await page.goto("/admin/teams");
    await expectTeamsLoaded(page, 30_000);
    await page.getByRole("textbox", { name: "Filter teams" }).fill(team);
    // The debounced server search narrows the list to exactly this team
    // (measured 0.35 s on PR #314's preview).
    await expect(teamsCounter(page, "1 match")).toBeVisible();
    await expect(page.getByRole("button", { name: new RegExp(team) })).toBeVisible();
    await expectAccessible(page, { label: "Team Management filtered to the new career team" });
  },
);
