// Spec: .maestro/flows/set-selector/set-attributes-card-prefix.yaml
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { drillToCustomSet, selectOrCreate } from "../../support/batch3/custom";
import type { Page } from "@playwright/test";

/** The panel remembers whether it was left open, so open it only if needed. */
async function openAttributes(page: Page) {
  const edit = page.getByRole("button", { name: "Edit attributes" });
  const hide = page.getByRole("button", { name: "Hide attributes" });
  await expect(edit.or(hide)).toBeVisible();
  if (await edit.isVisible()) await edit.click();
  await expect(hide).toBeVisible();
}

async function collapseAndReopen(page: Page) {
  await page.getByRole("button", { name: "Hide attributes" }).click();
  await expect(page.getByRole("button", { name: "Edit attributes" })).toBeVisible();
  await page.getByRole("button", { name: "Edit attributes" }).click();
  await expect(page.getByRole("button", { name: "Hide attributes" })).toBeVisible();
}

test(
  "SetAttributesPanel — Card prefix edits, persists across collapse/expand, and clears (per-worker custom set)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await drillToCustomSet(page, env, { set: `cpx-${env.WORKER_INDEX}`, variantType: "Insert" });
    await selectOrCreate(page, "Inserts", "CPXROW");

    await openAttributes(page);
    const prefix = page.getByRole("textbox", { name: "Value for Card prefix" });

    // Edit twice: each commit on Enter toasts a save.
    await prefix.fill("ZZ-");
    await prefix.press("Enter");
    await expect(page.getByText(/Saved Card prefix/)).toBeVisible();

    await prefix.fill("CPX-");
    await prefix.press("Enter");
    await expect(page.getByText(/Saved Card prefix/)).toBeVisible();

    // The stored value re-hydrates after a collapse and expand.
    await collapseAndReopen(page);
    await expect(prefix).toHaveValue("CPX-");

    // Clearing it: empty field shows the placeholder, Enter commits the clear.
    await prefix.clear();
    await expect(prefix).toHaveAttribute("placeholder", "e.g. DK-");
    await prefix.press("Enter");
    await expect(page.getByText(/Cleared Card prefix/)).toBeVisible();

    await collapseAndReopen(page);
    await expect(prefix).toHaveValue("");
    await expect(prefix).toHaveAttribute("placeholder", "e.g. DK-");
    await expect(page.getByText("Card prefix", { exact: true })).toBeVisible();
  },
);
