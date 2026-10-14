// Origin: .maestro/flows/set-selector/topps-chrome-add-feature.yaml (Maestro suite retired in NEO-341; see git history)
// Sole writer of the real 2024 Topps Chrome set's Reprint feature. It flips
// the toggle once per session, twice in all, so the stored value restores.
//
// Beyond the flow: Maestro cannot observe the toggle's state, so the flow
// proves re-hydration only as "still saveable after a reload". The toggle is
// a pressed button (aria-pressed), so here the persisted value itself is
// asserted after the reload.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { drillToSet, setBuilderReady } from "../../support/set-builder";
import type { Page } from "@playwright/test";

async function openAttributes(page: Page) {
  // The panel remembers whether it was left open, so open it only if needed.
  const edit = page.getByRole("button", { name: "Edit attributes" });
  const hide = page.getByRole("button", { name: "Hide attributes" });
  await expect(edit.or(hide)).toBeVisible();
  if (await edit.isVisible()) await edit.click();
  await expect(hide).toBeVisible();
}

test(
  "Topps Chrome — toggle the Reprint checkbox feature via SetAttributesPanel and verify save toast + re-hydration across reload (sole-writer)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await drillToSet(page, env);
    await openAttributes(page);

    const reprint = page.getByRole("button", { name: "Value for Reprint" });
    await expect(reprint).toBeVisible();
    await expectAccessible(page, { label: "Topps Chrome set attributes panel" });
    const wasOn = (await reprint.getAttribute("aria-pressed")) === "true";
    await reprint.click();
    await expect(page.getByText(/Saved Reprint/)).toBeVisible();
    await expect(reprint).toHaveAttribute("aria-pressed", String(!wasOn));

    // A fresh page load and re-drill re-hydrates the panel from the stored value.
    await drillToSet(page, env);
    await openAttributes(page);
    await expect(reprint).toHaveAttribute("aria-pressed", String(!wasOn));

    // Still saveable; this second flip restores the original value.
    await reprint.click();
    await expect(page.getByText(/Saved Reprint/)).toBeVisible();
    await expect(reprint).toHaveAttribute("aria-pressed", String(wasOn));
  },
);
