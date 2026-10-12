// Origin: .maestro/flows/admin/player-add-spaced-initials-opens-roster-row.yaml (Maestro suite retired in NEO-341; see git history)
// NEO-322: typing "J. T. Realmuto" in the add form recognises the roster
// player "J.T. Realmuto" (2024 Topps Chrome #261, committed by the seed): the
// primary button becomes "Open <roster name>", creation is demoted to "Create
// anyway", and Open lands on the existing row. READ-ONLY.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { emptyListAndPickSport, expectPlayersLoaded } from "../../support/players";

test(
  "Player Management — typing spaced initials finds the roster player written without the spaces",
  { tag: ["@admin"] },
  async ({ page, signIn }) => {
    await signIn("/admin/players");
    await expectPlayersLoaded(page, LAUNCH_GATE);

    // STEP 1, precondition: the roster row exists, its initials carry no space
    // (a roster row already spelled "J. T." would prove nothing about the join).
    const filter = page.getByLabel("Filter players");
    await filter.fill("Realmuto");
    await expect(page.getByRole("button", { name: /^J\.?T\.? Realmuto/ }).first()).toBeVisible();

    // STEP 2: empty the list, pick Baseball, open the add form.
    await emptyListAndPickSport(page, "Baseball");
    await page.getByRole("button", { name: "Add player" }).click();
    await expect(page.getByRole("heading", { name: "Add a player" })).toBeVisible();

    // The SPACED spelling, which no row carries.
    await page.getByLabel("New player name").fill("J. T. Realmuto");

    // STEP 3, the feature: the demoted control exists only when the normalised
    // keys are equal ("exact" near match); creation is no longer the primary.
    await expect(
      page.getByRole("button", { name: "Create player J. T. Realmuto anyway" }),
    ).toBeVisible();
    const open = page.getByRole("button", { name: /^Open J\.?T\.? Realmuto/ });
    await expect(open).toBeVisible();
    await expect(page.getByRole("button", { name: "Create player J. T. Realmuto", exact: true })).toBeHidden();

    // STEP 4: Open lands on the existing roster row, not on a typed-spelling row.
    await open.click();
    await expect(page.getByRole("heading", { name: /^J\.?T\.? Realmuto$/ })).toBeVisible();
    await expect(page.getByText("Sport: Baseball")).toBeVisible();
  },
);
