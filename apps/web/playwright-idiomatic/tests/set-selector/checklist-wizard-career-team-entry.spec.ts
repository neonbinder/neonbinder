// Spec: .maestro/flows/set-selector/checklist-wizard-career-team-entry.yaml
// Cancels out at the end and discards, so nothing is committed.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import {
  discardResumedReviewBatch,
  fetchChecklistToWizard,
  reviewedLine,
  reviewWizard,
  walkToPlayerRow,
} from "../../support/batch4/wizard";

test(
  "Entity review — a player row takes hand-entered career teams, refuses an entry with no from-year, and carries the staged history into the Add as New decision",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const token = env.ATTEMPT_TOKEN;
    const probe = `ProbeTeam${token}`;
    const temp = `TempTeam${token}`;
    const league = `Lg${token}`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await fetchChecklistToWizard(page, env);
    await discardResumedReviewBatch(page, env);
    const wizard = reviewWizard(page);
    await walkToPlayerRow(page);

    const careerName = wizard.getByRole("combobox", { name: "Career team name" });
    const fromYear = wizard.getByRole("spinbutton", { name: "From year" });
    const toYear = wizard.getByRole("spinbutton", { name: "To year (optional)" });
    const addCareer = wizard.getByRole("button", { name: "Add career team" });
    const lookingUp = wizard.getByText(/still looking up/);

    // A team with no from-year is refused: nothing is staged.
    await expect(careerName).toBeVisible();
    await careerName.fill(probe);
    await expect(careerName).toHaveValue(probe);
    await expect(addCareer).toBeDisabled();
    await expect(wizard.getByRole("list", { name: "Staged career teams" })).toBeHidden();

    // With a from-year the team stages, and its name is raised as a New Team step.
    await fromYear.fill("2001");
    await toYear.fill("2005");
    await addCareer.click();
    const probeStep = wizard.getByRole("heading", { name: `New Team: ${probe}` });
    await expect(probeStep.or(lookingUp)).toBeVisible();
    await expect(lookingUp).toBeHidden({ timeout: 180_000 });
    await expect(probeStep).toBeVisible();

    // Make the team a league of its own: the League step comes first, then the team.
    await wizard.getByRole("combobox", { name: "League" }).fill(league);
    await wizard.getByRole("option", { name: `Create “${league}”` }).click();
    await expect(wizard.getByRole("heading", { name: `New League: ${league}` })).toBeVisible();
    await wizard.getByRole("button", { name: "Add as New League" }).click();
    await expect(probeStep).toBeVisible();
    await expect(wizard.getByRole("combobox", { name: "League" })).toHaveValue(`${league} (new)`);
    await wizard.getByRole("button", { name: "Add as New Team" }).click();

    // Back on the player row, the staged team shows with its era.
    await expect(careerName).toBeVisible({ timeout: 30_000 });
    await expect(wizard.getByText(new RegExp(`${probe} \\(2001.2005\\)`))).toBeVisible();

    // Enter commits a staged entry from the keyboard; a second team opens ended "present".
    await careerName.fill(temp);
    const before = ((await reviewedLine(page).textContent()) ?? "").match(/^[0-9]+/)?.[0] ?? "";
    await careerName.press("Enter");
    await expect(careerName).toHaveValue(temp);
    await fromYear.fill("2010");
    await fromYear.press("Enter");
    await expect(fromYear).not.toHaveValue("2010");
    const tempStep = wizard.getByRole("heading", { name: `New Team: ${temp}` });
    await expect(tempStep.or(lookingUp)).toBeVisible();
    await expect(lookingUp).toBeHidden({ timeout: 180_000 });
    await expect(tempStep).toBeVisible();
    await expect(reviewedLine(page)).toHaveText(new RegExp(`^${before} of [0-9]+ reviewed`));

    await wizard.getByRole("combobox", { name: "League" }).fill(token);
    await wizard.getByRole("option", { name: `${league} (new)` }).click();
    await expect(wizard.getByRole("combobox", { name: "League" })).toHaveValue(`${league} (new)`);
    await wizard.getByRole("button", { name: "Add as New Team" }).click();
    await expect(careerName).toBeVisible({ timeout: 30_000 });
    const tempChip = wizard.getByText(new RegExp(`${temp} \\(2010.present\\)`));
    await expect(tempChip).toBeVisible();

    // A staged team can be taken back out.
    await wizard.getByRole("button", { name: `Remove ${temp}` }).click();
    await expect(tempChip).toBeHidden();
    await expect(wizard.getByText(new RegExp(`${probe} \\(2001.2005\\)`))).toBeVisible();

    // Add as New Player carries the staged history into the decision.
    const playerName = ((await wizard.getByRole("heading", { level: 3 }).textContent()) ?? "").trim();
    await wizard.getByRole("button", { name: "Add as New Player" }).click();
    await expect(
      wizard.getByRole("listitem").filter({ hasText: playerName }).filter({ hasText: "Added as new" }),
    ).toBeVisible();
    await expect(wizard.getByText(new RegExp(`${probe} \\(2001.2005\\)`))).toBeHidden();

    // Leave without committing anything.
    await wizard.getByRole("button", { name: "Cancel (Esc)" }).click();
    await expect(page.getByText(/Discard [0-9]+ decisions?/)).toBeVisible();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(page.getByText("Fetch cancelled — no cards saved.")).toBeVisible();
  },
);
