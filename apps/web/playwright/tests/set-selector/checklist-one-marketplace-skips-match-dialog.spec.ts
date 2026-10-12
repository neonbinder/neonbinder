// Origin: .maestro/flows/set-selector/checklist-one-marketplace-skips-match-dialog.yaml (Maestro suite retired in NEO-341; see git history)
// A set with exactly ONE marketplace attached (BSC; SportLots carries no
// 1995 Roanoke Express ECHL base) skips the Match Cards dialog and keeps every
// fetched card, then the committed set lists them as "BSC only" and a card
// added by hand titles itself from the set, not from "Unknown"/"All Brands".
//
// Sole writer of the Roanoke Express ECHL set; fresh-only (it commits the
// checklist). Re-seed before re-running.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import {
  columnHeading,
  columnOption,
  columnSearch,
  columnSelection,
  drillToColdManufacturer,
  setBuilderReady,
  syncChecklistButton,
} from "../../support/set-builder";
import { editCardButton } from "../../support/cards";

const SET = "Roanoke Express ECHL";
const YEAR = "1995";

test(
  "Checklist — a set with exactly ONE marketplace attached skips the Match Cards dialog and keeps every fetched card",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // All Brands, so the set is reachable under Unknown.
    await drillToColdManufacturer(page, env, { sport: "Hockey", year: YEAR, manufacturer: "All Brands" });
    await expect(columnHeading(page, "Sets")).toBeVisible({ timeout: 15_000 });
    await columnSearch(page, "Sets").fill(SET);
    await columnOption(page, "Sets", SET).click();
    await expect(columnHeading(page, "Variant Types")).toBeVisible({ timeout: 20_000 });
    await expect(columnSelection(page, "Manufacturers", "Unknown")).toBeVisible();
    await expect(columnOption(page, "Variant Types", "Base")).toBeVisible({ timeout: 60_000 });

    // The picker opens for the unmapped base; BSC offers it, SportLots does not carry it.
    await columnOption(page, "Variant Types", "Base").click();
    const picker = page.getByRole("dialog", { name: "Select Base Set" });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole("button", { name: "Confirm Base Set" })).toBeVisible({ timeout: 60_000 });
    await expect(picker.getByRole("option", { name: /^BSC base candidate: / }).first()).toBeVisible();
    const slCandidates = picker.getByRole("option", { name: /^SportLots base candidate: / });
    if (!env.SL_PAUSED) {
      await expect(slCandidates.first()).toBeVisible();
    } else {
      await expect(picker.getByText(/^SportLots returned no base set for /)).toBeVisible();
      await expect(slCandidates).toHaveCount(0);
    }

    // Cancel: BSC alone stays attached (no Base mapping).
    await picker.getByRole("button", { name: "Cancel" }).click();
    const cancelled = page.getByText(/Base mapping cancelled/);
    await expect(cancelled).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(cancelled).toBeHidden();
    await expect(page.getByRole("button", { name: "Map Base Set" })).toBeVisible();

    await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible();
    await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();
    await syncChecklistButton(page).click();

    // One live BSC round trip, and the solo path says what it kept (NEO-255).
    const kept = page.getByText(/Kept all [0-9]+ cards? from /);
    await expect(kept).toBeVisible({ timeout: 60_000 });
    const FETCHED = Number(((await kept.textContent()) ?? "").match(/[0-9]+/)?.[0]);
    expect(FETCHED).toBeGreaterThan(0);
    await expect(
      page.getByText(
        new RegExp(`Kept all ${FETCHED} cards? from BSC\\. Nothing to match, no other marketplace attached\\.`),
      ),
    ).toBeVisible();

    // No pairing dialog: straight to the entity review.
    await expect(page.getByText(/^Match Cards/)).toBeHidden();
    const wizard = page.getByRole("dialog", { name: "Confirm New Players & Teams" });
    await expect(wizard).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/^Match Cards/)).toBeHidden();
    await expect(wizard.getByRole("button", { name: "Back to matching" })).toBeHidden();

    await wizard.getByRole("button", { name: /Skip remaining names \([0-9]+\)/ }).click();
    await expect(wizard.getByRole("button", { name: /Confirm & Save/ })).toBeVisible({ timeout: 60_000 });
    await expect(wizard.getByText(new RegExp(`All reviewed — save ${FETCHED} cards?`))).toBeVisible();
    await wizard.getByRole("button", { name: /Confirm & Save/ }).click();
    await expect(page.getByText(new RegExp(`Saved ${FETCHED} cards`))).toBeVisible({ timeout: 60_000 });

    // Every card is BSC only; nothing is SL only.
    await expect(page.getByText(new RegExp(`\\(${FETCHED}\\)`)).first()).toBeVisible();
    await expect(page.getByText("BSC only").first()).toBeVisible();
    await expect(page.getByText("SL only")).toBeHidden();

    // A card added by hand titles itself from the set, not from Unknown/All Brands.
    const card = `NB272-${env.ATTEMPT_ID}`;
    await page.getByRole("button", { name: "Open add card form" }).click();
    const number = page.getByRole("textbox", { name: "Card number" });
    await expect(number).toBeVisible();
    await number.fill(card);
    await page.getByRole("button", { name: "Submit new card" }).click();
    await editCardButton(page, card).click();
    const title = page.getByRole("dialog").getByRole("textbox", { name: "Card title" });
    await expect(title).toBeVisible();
    await expect(title).toHaveValue(new RegExp(SET));
    await expect(title).not.toHaveValue(/Unknown/);
    await expect(title).not.toHaveValue(/All Brands/);
  },
);
