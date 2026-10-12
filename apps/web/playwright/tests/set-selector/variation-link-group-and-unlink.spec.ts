// Origin: .maestro/flows/set-selector/variation-link-group-and-unlink.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { addCustomCard } from "../../support/cards";

test(
  "Card variations — point a card at the card it varies, see it group under it, and unlink it back out",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const id = env.ATTEMPT_ID;
    const base = `700-${id}`;
    const vari = `701-${id}`;
    const named = (verb: string, num: string) => new RegExp(`^${verb} card ${num}(, .*)?$`);
    const cardName = page.getByRole("textbox", { name: "Card name" });

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // The base card, then a second card that will vary it.
    await addCustomCard(page, env, {
      set: `cvar-${env.WORKER_INDEX}`,
      cardNumber: base,
      playerName: `Base Player ${id}`,
    });
    await page.getByRole("button", { name: "Open add card form" }).click();
    await page.getByRole("textbox", { name: "Card number" }).fill(vari);
    await cardName.fill(`Variation Player ${id}`);
    await page.getByRole("button", { name: "Submit new card" }).click();
    await expect(page.getByRole("button", { name: named("Edit", vari) })).toBeVisible();
    await expect(page.getByText(`#${base}`, { exact: true })).toBeVisible();
    await expect(page.getByText(`#${vari}`, { exact: true })).toBeVisible();

    // ── Point 701 at 700 from its detail panel ──
    await page.getByRole("button", { name: named("Edit", vari) }).click();
    await expect(cardName).toBeVisible();
    const parent = page.getByRole("textbox", { name: "Card number this one is a variation of" });
    await parent.fill(base);
    await parent.press("Enter");
    await expect(page.getByRole("button", { name: "Clear variation parent" })).toBeVisible();
    await expect(page.getByText(new RegExp(`#${base} Base Player ${id}`))).toBeVisible();

    await page.getByRole("button", { name: "Close card detail" }).click();
    await expect(cardName).toBeHidden();

    // ── It groups under its parent: collapsed, the variation's row is hidden ──
    await expect(page.getByText(`#${vari}`, { exact: true })).toBeHidden();
    const show = page.getByRole("button", { name: named("Show 1 variation of", base) });
    const hide = page.getByRole("button", { name: named("Hide 1 variation of", base) });
    await expect(show).toBeVisible();
    await expect(page.getByText(/1 variation/).first()).toBeVisible();

    await show.click();
    await expect(page.getByText(`#${vari}`, { exact: true })).toBeVisible();
    await expect(hide).toBeVisible();
    await hide.click();
    await expect(page.getByText(`#${vari}`, { exact: true })).toBeHidden();
    await show.click();
    await expect(page.getByText(`#${vari}`, { exact: true })).toBeVisible();

    // ── Unlink it from the variation's own panel ──
    await page.getByRole("button", { name: named("Edit", vari) }).click();
    await expect(cardName).toBeVisible();
    await page.getByRole("button", { name: "Clear variation parent" }).click();
    await expect(parent).toBeVisible();
    await page.getByRole("button", { name: "Close card detail" }).click();
    await expect(cardName).toBeHidden();

    // Back to a plain row: no group toggle on the parent.
    await expect(page.getByText(`#${vari}`, { exact: true })).toBeVisible();
    await expect(show).toBeHidden();
    await expect(hide).toBeHidden();

    // ── Cleanup ──
    for (const num of [vari, base]) {
      await page.getByRole("button", { name: named("Delete", num) }).click();
      await expect(page.getByText("Confirm?")).toBeVisible();
      await page.getByRole("button", { name: named("Confirm delete", num) }).click();
      await expect(page.getByText(`#${num}`, { exact: true })).toBeHidden();
    }
  },
);
