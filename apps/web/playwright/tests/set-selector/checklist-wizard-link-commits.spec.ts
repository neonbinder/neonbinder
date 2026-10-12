// Origin: .maestro/flows/set-selector/checklist-wizard-link-commits.yaml (Maestro suite retired in NEO-341; see git history)
// Fresh-only: commits the Topps Brooklyn Collection checklist.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { addPlayerByHand } from "../../support/players";
import { fetchChecklistToWizard, openDecidedList, reviewedLine, reviewWizard, walkToPlayerRow } from "../../support/wizard";

test(
  "Entity review — Link to Existing decisions, including one to a player of another sport, are carried through Confirm & Save into the committed checklist",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const gw = `Gw${env.ATTEMPT_TOKEN}`;

    await signIn("/admin/players");
    await expect(page.getByText(/ of .* players/)).toBeVisible({ timeout: LAUNCH_GATE });
    // A Football player to link a Baseball name to, across sports.
    await addPlayerByHand(page, gw, "Football");

    await fetchChecklistToWizard(page, env, { set: "Topps Brooklyn Collection" });
    const wizard = reviewWizard(page);
    await expect(reviewedLine(page)).toHaveText(/^0 of [0-9]+ reviewed/);

    // Row 1: link to an existing player by search.
    await walkToPlayerRow(page);
    await wizard.getByRole("button", { name: "Link to existing instead" }).click();
    await wizard.getByRole("textbox", { name: "Search existing players" }).fill("Ohtani");
    const linkOhtani = wizard.getByRole("option", { name: "Link to Shohei Ohtani" });
    await expect(linkOhtani).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, link search results" });
    await linkOhtani.click();
    // The history collapses past five decided names, so open it first.
    const decidedNames = await openDecidedList(page);
    await expect(decidedNames.getByText("Linked to Shohei Ohtani")).toBeVisible();

    // Row 2: change the sport this name belongs to, Baseball -> Football.
    await walkToPlayerRow(page);
    const sportBaseball = wizard.getByRole("button", { name: "Sport for this name: Baseball" });
    await expect(sportBaseball).toBeVisible();
    await sportBaseball.click();
    const chooser = wizard.getByRole("listbox", { name: "Choose a sport" });
    await expect(chooser).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, sport chooser open" });
    await chooser.getByRole("option", { name: "Football" }).click();
    await expect(wizard.getByRole("button", { name: "Sport for this name: Football" })).toBeVisible();

    // Row 2 again (still undecided, now Football): link it to the Football player we made.
    await walkToPlayerRow(page);
    await expect(wizard.getByRole("button", { name: "Sport for this name: Football" })).toBeVisible();
    await wizard.getByRole("button", { name: "Link to existing instead" }).click();
    await wizard.getByRole("textbox", { name: "Search existing players" }).fill(gw);
    await wizard.getByRole("option", { name: `Link to ${gw}` }).click();
    // The next row opens on the default sport again.
    await expect(wizard.getByRole("button", { name: "Sport for this name: Football" })).toBeHidden();
    await expect(wizard.getByRole("button", { name: "Sport for this name: Baseball" })).toBeVisible();

    await wizard.getByRole("button", { name: /Skip remaining names \([0-9]+\)/ }).click();
    const confirmSave = wizard.getByRole("button", { name: /Confirm & Save/ });
    await expect(confirmSave).toBeVisible({ timeout: 120_000 });
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, summary" });
    await confirmSave.click();
    await expect(page.getByText(/Saved [0-9]+ cards/)).toBeVisible({ timeout: 60_000 });

    // The cross-sport link is on the player's committed card list.
    await page.goto("/admin/players");
    await expect(page.getByText(/ of .* players/)).toBeVisible({ timeout: 20_000 });
    await page.getByRole("textbox", { name: "Filter players" }).fill(gw);
    await expect(page.getByText(/matches/)).toBeVisible();
    await page.getByRole("button", { name: gw }).click();
    const cards = page.getByRole("list", { name: `Cards for ${gw}` });
    await expect(cards).toContainText("Brooklyn Collection");
    // Linked across sports: the card keeps its own sport.
    await expect(cards).toContainText("Baseball");
    await expectAccessible(page, { label: "Player detail with the cross-sport linked card" });
  },
);
