// Origin: .maestro/flows/set-selector/features-propagation.yaml (Maestro suite retired in NEO-341; see git history)
// A set-level feature edit saves that single row (Saved toast) and does NOT
// cascade to a card that has its own value (per-worker custom set).
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { columnHeading, setBuilderReady, drillToCustom } from "../../support/set-builder";
import { confirmDeleteCardButton, deleteCardButton, editCardButton, ensureAndSelect, openVariant } from "../../support/cards";
import type { Page } from "@playwright/test";

/** Edit Country of Origin on the attributes panel of whatever is selected; expects the Saved toast. */
async function saveSetCountry(page: Page, value: string) {
  // The panel remembers whether it was left open: expand only if collapsed.
  const edit = page.getByRole("button", { name: "Edit attributes" });
  const hide = page.getByRole("button", { name: "Hide attributes" });
  await expect(edit.or(hide)).toBeVisible();
  if (await edit.isVisible()) await edit.click();
  await expect(hide).toBeVisible();

  const coo = page.getByRole("textbox", { name: "Value for Country of Origin" });
  await coo.fill(value);
  await coo.press("Enter");
  await expect(page.getByText(/Saved Country of Origin/)).toBeVisible();
}

test(
  "Set-level feature edit saves that single row (Saved toast) and does NOT cascade to a card with its own value (per-worker custom set)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const A = env.ATTEMPT_ID;
    const W = env.WORKER_INDEX;
    const card = `992-${A}`;
    const player = `Propagation Test Player ${A}`;
    const target = {
      sport: "Baseball",
      year: "2024",
      manufacturer: "Topps",
      set: `fp-${W}`,
    };
    const insertName = `fp-insert-${W}`;
    const insertsHeading = columnHeading(page, "Inserts");
    const pickInsert = () =>
      ensureAndSelect(page, "Variant Types", "Insert", insertsHeading);

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // ── Set-level edit #1 ──
    await drillToCustom(page, target);
    await expect(columnHeading(page, "Variant Types")).toBeVisible();
    await saveSetCountry(page, `CooTest-SET1-${A}`);

    // ── A card with its own value, under Insert / fp-insert ──
    await pickInsert();
    await openVariant(page, "Insert", insertName);
    await page.getByRole("button", { name: "Open add card form" }).click();
    await page.getByRole("textbox", { name: "Card number" }).fill(card);
    await page.getByRole("textbox", { name: "Card name" }).fill(player);
    await page.getByRole("button", { name: "Submit new card" }).click();
    await expect(page.getByText(player)).toBeVisible();

    await editCardButton(page, card).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByRole("textbox", { name: "Card name" })).toBeVisible({ timeout: 15_000 });
    await drawer.getByRole("button", { name: "Show features editor" }).click();
    await expect(drawer.getByLabel("Card features editor", { exact: true })).toBeVisible();
    const cardCoo = drawer.getByRole("textbox", { name: "Value for Country of Origin" });
    await cardCoo.fill("CooTest-CARD");
    await cardCoo.press("Enter");
    await expect(cardCoo).toHaveValue("CooTest-CARD");
    await drawer.getByRole("button", { name: "Done editing card" }).click();
    await expect(drawer.getByRole("textbox", { name: "Card name" })).toBeHidden();
    await expect(page.getByText(player)).toBeVisible();

    // ── Set-level edit #2, from a fresh load ──
    await drillToCustom(page, target);
    await expect(columnHeading(page, "Variant Types")).toBeVisible();
    await saveSetCountry(page, `CooTest-SET2-${A}`);

    // ── The card keeps its own value ──
    await pickInsert();
    await openVariant(page, "Insert", insertName);
    await editCardButton(page, card).click();
    await expect(drawer.getByRole("textbox", { name: "Card name" })).toBeVisible({ timeout: 15_000 });
    await drawer.getByRole("button", { name: "Show features editor" }).click();
    await expect(drawer.getByLabel("Card features editor", { exact: true })).toBeVisible();
    await expect(cardCoo).toHaveValue(/CooTest-CARD/);
    await expect(drawer.getByText(/CooTest-SET2/)).toBeHidden();
    await expect(cardCoo).not.toHaveValue(/CooTest-SET2/);
    await drawer.getByRole("button", { name: "Done editing card" }).click();
    await expect(drawer.getByRole("textbox", { name: "Card name" })).toBeHidden();
    await expect(page.getByText(player)).toBeVisible();

    // ── Clean up ──
    await deleteCardButton(page, card).click();
    await expect(page.getByText("Confirm?")).toBeVisible();
    await confirmDeleteCardButton(page, card).click();
    await expect(page.getByText(player)).toBeHidden();
  },
);
