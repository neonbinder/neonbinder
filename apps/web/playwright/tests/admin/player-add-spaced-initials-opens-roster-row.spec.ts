// Origin: .maestro/flows/admin/player-add-spaced-initials-opens-roster-row.yaml (Maestro suite retired in NEO-341; see git history)
// NEO-322: typing "J.T. Realmuto" in the add form recognises the roster
// player "J. T. Realmuto": the primary button becomes "Open <roster name>",
// creation is demoted to "Create anyway", and Open lands on the existing row.
// READ-ONLY.
//
// DATA DEPENDENCY (NEO-330): the roster row comes from the reference catalogue
// every CI preview loads before setup, and it is spelled WITH a space between
// the initials ("J. T. Realmuto", key "jt realmuto"). The seed's 2024 Topps
// Chrome commit (#261, which BSC spells "J.T. Realmuto") keys to the same thing
// and ADOPTS that row, so the spaced spelling is the only Realmuto on the
// preview. The catalogue turned the old fixture round, so the spec types the
// UNSPACED spelling at the spaced row. The proof stays symmetric: under the
// pre-NEO-322 key the two spellings still differ, so only the join makes them
// an exact match. STEP 1 asserts the row exists AND that its initials are
// spaced (a row spelled "J.T." would match on the old key too and prove
// nothing). If the catalogue ever respells or drops him, STEP 1 fails by name;
// swap to another catalogue player whose initials are spaced ("A. J. ...",
// "C. J. ..."), checking the bundle rather than guessing.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { emptyListAndPickSport, expectPlayersLoaded } from "../../support/players";

test(
  "Player Management — initials typed without the spaces find the roster player written with them",
  { tag: ["@admin"] },
  async ({ page, signIn }) => {
    await signIn("/admin/players");
    await expectPlayersLoaded(page, LAUNCH_GATE);

    // STEP 1, precondition: the roster row exists, its initials are SPACED
    // (a roster row already spelled "J.T." would prove nothing about the join).
    const filter = page.getByLabel("Filter players");
    await filter.fill("Realmuto");
    await expect(page.getByRole("button", { name: /^J\. T\. Realmuto/ }).first()).toBeVisible();

    // STEP 2: empty the list, pick Baseball, open the add form.
    await emptyListAndPickSport(page, "Baseball");
    await page.getByRole("button", { name: "Add player" }).click();
    await expect(page.getByRole("heading", { name: "Add a player" })).toBeVisible();

    // The UNSPACED spelling, which no row carries.
    await page.getByLabel("New player name").fill("J.T. Realmuto");

    // STEP 3, the feature: the demoted control exists only when the normalised
    // keys are equal ("exact" near match); creation is no longer the primary.
    await expect(
      page.getByRole("button", { name: "Create player J.T. Realmuto anyway" }),
    ).toBeVisible();
    const open = page.getByRole("button", { name: /^Open J\. T\. Realmuto/ });
    await expect(open).toBeVisible();
    await expect(page.getByRole("button", { name: "Create player J.T. Realmuto", exact: true })).toBeHidden();
    await expectAccessible(page, { label: "Player Management, add form with an existing match" });

    // STEP 4: Open lands on the existing roster row (spaced spelling), not on a typed-spelling row.
    await open.click();
    await expect(page.getByRole("heading", { name: /^J\. T\. Realmuto$/ })).toBeVisible();
    await expect(page.getByText("Sport: Baseball")).toBeVisible();
    await expectAccessible(page, { label: "Player Management, player panel" });
  },
);
