// Origin: .maestro/flows/admin/league-management-add-and-edit.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { expectTeamsLoaded } from "../../support/players";

test(
  "League Management — add a league by hand, classify it, and edit what we know about it",
  { tag: ["@admin"] },
  async ({ page, signIn, env }) => {
    // Every minted name is ONE search token carrying worker AND attempt
    // (NEO-330: a hyphenated name is several search terms, and a reference
    // catalogue of real leagues sits on every CI preview). The abbreviation
    // stays under createByAdmin's 16-character cap.
    const token = env.ATTEMPT_TOKEN;
    const name = `Lg${token}`;
    const abbreviation = `L${token}`;
    const aliasOne = `Alias${token}`;
    const aliasTwo = `Second${token}`;

    // The count is shown and also announced in an sr-only live region; read the announcement.
    const count = (pattern: RegExp) => page.getByRole("status").filter({ hasText: pattern });

    await signIn("/admin/leagues");
    await expect(count(/ of .* leagues/)).toBeVisible({ timeout: LAUNCH_GATE });
    await expectAccessible(page, { label: "League Management" });

    // Empty the list, then pick Baseball so the add form opens with it.
    await page.getByLabel("Filter leagues").fill("zzzznotaleague");
    await expect(page.getByText("No leagues match that filter.")).toBeVisible();
    await expect(count(/^0 of .* leagues/)).toBeVisible();
    await page.getByLabel("Sport", { exact: true }).selectOption({ label: "Baseball" });

    await page.getByRole("button", { name: "Add league" }).click();
    await expect(page.getByRole("heading", { name: "Add a league" })).toBeVisible();
    await expectAccessible(page, { label: "League Management, Add a league form" });
    await page.getByLabel("New league name").fill(name);
    await page.getByLabel("Abbreviation").fill(abbreviation);

    // NEO-331: Level is required and opens with nothing chosen, so Create is
    // held (aria-disabled reads as disabled) until one is pressed.
    const level = page.getByRole("radiogroup", { name: "Level" });
    const create = page.getByRole("button", { name: `Create league ${name}` });
    await expect(level.getByRole("radio", { checked: true })).toHaveCount(0);
    await expect(create).toBeDisabled();
    const minor = level.getByRole("radio", { name: "Minor", exact: true });
    await minor.click();
    await expect(minor).toBeChecked();
    await expect(create).toBeEnabled();
    await create.click();

    // The new league's panel: confirmation, sport read back.
    await expect(page.getByText(new RegExp(`Added ${name}`))).toBeVisible();
    await expect(page.getByText("Sport: Baseball")).toBeVisible();
    await expectAccessible(page, { label: "League Management, new league panel" });

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
    // NEO-331: a stored league opens with its level pressed.
    await expect(page.getByRole("radiogroup", { name: "Level" }).getByRole("radio", { name: "Minor", exact: true })).toBeChecked();
    await expect(page.getByText(aliasOne)).toBeVisible();
    await expect(page.getByText(aliasTwo)).toBeVisible();
    await expect(page.getByLabel("Active from")).toHaveValue("1901");
    await expect(page.getByText("No teams yet.")).toBeVisible();
    await expectAccessible(page, { label: "League Management, league selected" });

    // The Teams screen offers the league in its filter, abbreviation and all.
    await page.goto("/admin/teams");
    await expectTeamsLoaded(page, 30_000);
    await expect(
      page.getByLabel("League", { exact: true }).getByRole("option", { name: abbreviation }),
    ).toBeAttached();
  },
);
