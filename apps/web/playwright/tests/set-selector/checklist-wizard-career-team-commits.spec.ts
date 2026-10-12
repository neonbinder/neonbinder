// Origin: .maestro/flows/set-selector/checklist-wizard-career-team-commits.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { fetchChecklistToWizard, reviewedLine, reviewWizard, walkToPlayerRow } from "../../support/wizard";

test(
  "Entity review — a hand-staged career team survives the commit and becomes a real team row",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const team = `MintedTeam${env.ATTEMPT_TOKEN}`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await fetchChecklistToWizard(page, env, { set: "Topps Baltimore Orioles" });
    const wizard = reviewWizard(page);
    await expect(reviewedLine(page)).toHaveText(/^0 of [0-9]+ reviewed/);
    await walkToPlayerRow(page);

    // Stage a career team by hand on the first player row.
    await wizard.getByRole("combobox", { name: "Career team name" }).fill(team);
    await wizard.getByRole("spinbutton", { name: "From year" }).fill("2001");
    await wizard.getByRole("spinbutton", { name: /^To year/ }).fill("2005");
    await wizard.getByRole("button", { name: "Add career team" }).click();

    // The new name is looked up (live), then raised as its own New Team step.
    const lookingUp = wizard.getByText(/still looking up/);
    const newTeam = wizard.getByRole("heading", { name: `New Team: ${team}` });
    await expect(newTeam.or(lookingUp)).toBeVisible();
    await expect(lookingUp).toBeHidden({ timeout: 180_000 });
    await expect(newTeam).toBeVisible();
    await wizard.getByRole("button", { name: "Add as New Team" }).click();

    // Back on the player row, the staged team shows with its era.
    await expect(wizard.getByRole("combobox", { name: "Career team name" })).toBeVisible({ timeout: 30_000 });
    await expect(wizard.getByText(new RegExp(`${team} \\(2001.2005\\)`))).toBeVisible();
    await wizard.getByRole("button", { name: "Add as New Player" }).click();
    await expect(wizard.getByText("Added as new")).toBeVisible();

    await wizard.getByRole("button", { name: /Skip remaining names \([0-9]+\)/ }).click();
    const confirmSave = wizard.getByRole("button", { name: /Confirm & Save/ });
    await expect(confirmSave).toBeVisible({ timeout: 120_000 });
    await confirmSave.click();
    await expect(page.getByText(/Saved [0-9]+ cards/)).toBeVisible({ timeout: 60_000 });

    // The staged team is now a real row in Team Management.
    await page.goto("/admin/teams");
    await expect(page.getByText(/of .* teams/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("textbox", { name: "Filter teams" }).fill(team);
    const count = page.getByText(/^1 of .* teams/);
    await expect(count).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: new RegExp(team) })).toBeVisible();
  },
);
