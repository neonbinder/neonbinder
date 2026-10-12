// Spec: .maestro/flows/set-selector/cross-release-card-appears-in-guest-checklist.yaml
// A card printed in another product (the "home" set) is linked into this set's
// checklist as a guest, badged with the set it came from; removing it from this
// set leaves it gone from the checklist.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { addCustomCard, crossListCards, drillToCustom, escapeRe, openVariant } from "../../support/batch5/custom";

test(
  "Cross-release — a card printed in another product shows up in this set's checklist, badged with the set it came from",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const W = env.WORKER_INDEX;
    const card = `951-${env.ATTEMPT_ID}`;
    const sport = `E2E Test Sport ${W}`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // The home set owns the card.
    await addCustomCard(page, {
      setName: `xsrc-${W}`,
      variantType: "Insert",
      insertName: "Base",
      cardNumber: card,
      playerName: `Cross Home ${env.ATTEMPT_ID}`,
      workerIndex: W,
    });

    // The guest set receives it.
    await drillToCustom(page, {
      sport,
      year: "2026",
      manufacturer: "Topps",
      set: `xag-${W}`,
      variantType: "Insert",
    });
    await openVariant(page, "Insert", "Base");

    await crossListCards(page, { sourceSport: sport, sourceSet: `xsrc-${W}`, cardNumbers: card });
    await expect(page.getByText(/Linked 1 card/)).toBeVisible();

    await page.getByRole("button", { name: "Cancel cross-release import" }).click();
    await expect(page.getByRole("dialog", { name: "Add cross-release cards" })).toBeHidden();

    // The guest card is listed and badged with the set it came from.
    await expect(page.getByText(`#${card}`)).toBeVisible();
    await expect(page.getByText(new RegExp(`2026 Topps xsrc-${W}`)).first()).toBeVisible();

    // Remove it from this set; it leaves the checklist.
    const remove = page.getByRole("button", {
      name: new RegExp(`^Remove card ${escapeRe(card)}(, .*)? from this set$`),
    });
    await remove.click();
    await page
      .getByRole("button", { name: new RegExp(`^Confirm remove card ${escapeRe(card)}(, .*)? from this set$`) })
      .click();
    await expect(page.getByText(`#${card}`)).toBeHidden();
  },
);
