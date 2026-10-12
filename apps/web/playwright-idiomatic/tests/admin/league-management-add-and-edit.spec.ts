// Spec: .maestro/flows/admin/league-management-add-and-edit.yaml
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";

test(
  "League Management — add a league by hand, classify it, and edit what we know about it",
  { tag: ["@admin"] },
  async ({ page, signIn, env }) => {
    const name = `LG-${env.WORKER_INDEX}-${env.ATTEMPT_ID}`;
    const abbreviation = `L${env.ATTEMPT_ID}`;
    const aliasOne = `Alias-${env.ATTEMPT_ID}`;
    const aliasTwo = `Second-${env.ATTEMPT_ID}`;

    // The count is shown and also announced in an sr-only live region; read the announcement.
    const count = (pattern: RegExp) => page.getByRole("status").filter({ hasText: pattern });

    await signIn("/admin/leagues");
    await expect(count(/ of .* leagues/)).toBeVisible({ timeout: LAUNCH_GATE });

    // Empty the list, then pick Baseball so the add form opens with it.
    await page.getByLabel("Filter leagues").fill("zzzznotaleague");
    await expect(page.getByText("No leagues match that filter.")).toBeVisible();
    await expect(count(/^0 of .* leagues/)).toBeVisible();
    await page.getByLabel("Sport", { exact: true }).selectOption({ label: "Baseball" });

    await page.getByRole("button", { name: "Add league" }).click();
    await expect(page.getByRole("heading", { name: "Add a league" })).toBeVisible();
    await page.getByLabel("New league name").fill(name);
    await page.getByLabel("Abbreviation").fill(abbreviation);
    const minor = page.getByRole("button", { name: "Minor", exact: true });
    await minor.click();
    await expect(minor).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: `Create league ${name}` }).click();

    // The new league's panel: confirmation, sport read back.
    await expect(page.getByText(new RegExp(`Added ${name}`))).toBeVisible();
    await expect(page.getByText("Sport: Baseball")).toBeVisible();

    // Edit what we know: founding year and aliases.
    await page.getByLabel("Active from").fill("1901");
    await page.getByLabel("Aliases").fill(`${aliasOne}, ${aliasTwo}`);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(new RegExp(`Saved ${name}`))).toBeVisible();

    // Reload: the league row carries the classification and abbreviation, and
    // its panel the edits.
    await page.goto("/admin/leagues");
    await expect(count(/ of .* leagues/)).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("Filter leagues").fill(name);
    await expect(count(/^1 of .* leagues/)).toBeVisible();
    await expect(
      page.getByText("Select a league to see its teams and edit what we know about it."),
    ).toBeVisible();
    const row = page.getByRole("button", { name });
    await expect(row.getByText("Minor", { exact: true })).toBeVisible();
    await expect(row.getByText(abbreviation, { exact: true })).toBeVisible();

    await row.click();
    await expect(page.getByText(aliasOne)).toBeVisible();
    await expect(page.getByText(aliasTwo)).toBeVisible();
    await expect(page.getByLabel("Active from")).toHaveValue("1901");
    await expect(page.getByText("No teams yet.")).toBeVisible();

    // The Teams screen offers the league in its filter, abbreviation and all.
    await page.goto("/admin/teams");
    await expect(page.getByText(/ of .* teams/)).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByLabel("League", { exact: true }).getByRole("option", { name: abbreviation }),
    ).toBeAttached();
  },
);
