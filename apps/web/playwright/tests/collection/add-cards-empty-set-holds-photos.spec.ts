// NEO-452 (R1): a set with no cards holds Add cards. Cards are matched in the
// set picked, so a set that has none can't start a run: dropped photos wait in
// the browser, no run starts (nothing spends a job start), "Use a scanner" is
// held, and the screen says "That set has no cards to match against yet. Pick
// another one."
//
// How the empty set is reached. The collector's picker hides a set that holds no
// card (NEO-358: the drill never offers nothing), so an empty set can't be picked
// fresh. The spec makes it empty AFTER the pick, the way it happens in life when
// someone clears the set while another tab is open: a hand-made set gets one card
// in the Set Builder, a second tab on Add cards picks that set (it is offered,
// and "Use a scanner" is open), and the card is then deleted in the first tab.
// The second tab's gate answers live, so the hold appears without a reload.
//
// R7/R7a: writes only a hand-made, per-attempt set (`emp-<worker>-<attempt>`,
// SET-REGISTRY.md) under the real Baseball > 2024 > Topps, with no marketplace id
// beneath it: one hand-added card, deleted again. No run is started and no
// player, team or copy is written. The set and its empty Base row stand, per
// attempt. Self-cleaning: a card left by a failure is deleted in the `finally`.
//
// R3: the Set Builder through `support/set-builder.ts`, the card forms through
// `support/cards.ts`, the picker and drop zone through `support/collection.ts`.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addCardViaForm, confirmDeleteCardButton, deleteCardButton, editCardButton, escapeRe } from "../../support/cards";
import { intakeDropzone, pickIntakeSet } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { drillToCustom, setBuilderReady } from "../../support/set-builder";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "intake");
const PHOTOS = ["01-mcfadden-front.jpg", "02-mcfadden-back.jpg"].map((n) => path.join(FIXTURES, n));

test(
  "Add cards: a set with no cards holds photos and the scanner, and says to pick another set",
  { tag: ["@collection"] },
  async ({ page, signIn, env }) => {
    const setName = `emp-${env.WORKER_INDEX}-${env.ATTEMPT_ID}`;
    const number = `73${env.ATTEMPT_TOKEN}`;
    const cardName = `Em${env.ATTEMPT_TOKEN}`;
    const build = {
      sport: "Baseball",
      year: "2024",
      manufacturer: "Topps",
      set: setName,
      variantType: "Insert",
      variant: "Base",
    };
    let cardLeft = false;
    try {
      // --- A set of our own, holding one card -----------------------------------------
      await signIn("/set-selector");
      await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
      await drillToCustom(page, build);
      await addCardViaForm(page, { cardNumber: number, playerName: cardName });
      cardLeft = true;

      // --- Add cards, in a second tab: the set is offered and nothing holds -----------
      const intake = await page.context().newPage();
      await intake.goto("/collection?tab=add");
      await expect(intake.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
      await intake.getByRole("combobox", { name: "Put them in this binder" }).selectOption({ label: "Main" });
      await pickIntakeSet(intake, { sport: "Baseball", year: "2024", manufacturer: "Topps", set: setName }, { under: "Insert" });
      const scanner = intake.getByRole("button", { name: "Use a scanner" });
      const hold = "That set has no cards to match against yet. Pick another one.";
      await expect(scanner).toBeEnabled();
      await expect(intake.getByText(new RegExp(escapeRe(hold)))).toHaveCount(0);

      // --- The card is deleted in the first tab: the second tab holds -----------------
      await deleteCardButton(page, number).click();
      await confirmDeleteCardButton(page, number).click();
      await expect(editCardButton(page, number)).toBeHidden();
      cardLeft = false;
      await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible();

      await expect(scanner).toBeDisabled();
      await expect(scanner).toHaveAccessibleDescription(
        /That set has no cards to match against yet\. Pick another one, then get a code\./,
      );
      // Photos dropped now wait, and no run starts.
      const dropzone = intakeDropzone(intake);
      await dropzone.setInputFiles(PHOTOS);
      const tray = intake.getByRole("status").filter({ hasText: hold });
      await expect(tray).toBeVisible();
      await expect(dropzone).toHaveAccessibleDescription(new RegExp(escapeRe(hold)));
      await expect(intake.getByText("Sending your photos…")).toHaveCount(0);
      await expect(intake).not.toHaveURL(/[?&]run=/);
      await expectAccessible(intake, { label: "Add cards, a set with no cards holds the photos" });

      // Remove photos empties the tray and the keyboard lands on the drop zone.
      await intake.getByRole("button", { name: "Remove photos", exact: true }).click();
      await expect(tray).toHaveCount(0);
      await expect(dropzone).toBeFocused();
      await expect(intake).not.toHaveURL(/[?&]run=/);
    } finally {
      if (cardLeft) {
        await drillToCustom(page, build);
        await deleteCardButton(page, number).click();
        await confirmDeleteCardButton(page, number).click();
        await expect(editCardButton(page, number)).toBeHidden();
      }
    }
  },
);
