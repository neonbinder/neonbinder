// Origin: .maestro/flows/set-selector/rename-selector-option.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady, drillToCustom, selectOrCreate } from "../../support/set-builder";
import type { Page } from "@playwright/test";

/** Rename the option the attributes panel is showing, via its pencil control. */
async function rename(page: Page, from: string, to: string, what: string) {
  await page.getByRole("button", { name: `Rename ${from}` }).click();
  const field = page.getByRole("textbox", { name: `Edit name for ${from}` });
  await expect(field).toBeVisible();
  await expectAccessible(page, { label: `Rename field open (${what})` });
  await field.fill(to);
  await field.press("Enter");
}

test(
  "Selector rename — a set AND a variant type can each be renamed from the attributes panel, and the selection follows the new name (per-worker hand-made set)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const set = `rnm-${env.WORKER_INDEX}-${env.ATTEMPT_ID}`;
    const renamedSet = `rnmx-${env.WORKER_INDEX}-${env.ATTEMPT_ID}`;
    const type = `vt-${env.WORKER_INDEX}-${env.ATTEMPT_ID}`;
    const renamedType = `vtx-${env.WORKER_INDEX}-${env.ATTEMPT_ID}`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // A hand-made set under the real Baseball / 2024 / Topps.
    await drillToCustom(page, { sport: "Baseball", year: "2024", manufacturer: "Topps", set });
    await expect(page.getByRole("heading", { name: `Attributes for ${set}` })).toBeVisible();

    // Rename the set; the panel and the selection follow.
    await rename(page, set, renamedSet, "set");
    await expect(page.getByRole("heading", { name: `Attributes for ${renamedSet}` })).toBeVisible();
    await expect(page.getByText(set, { exact: true })).toBeHidden();

    // A hand-made variant type, selected, then renamed the same way.
    await selectOrCreate(page, "Variant Types", type, { confirm: "required" });
    await expect(page.getByRole("heading", { name: `Attributes for ${type}` })).toBeVisible();
    await rename(page, type, renamedType, "variant type");
    await expect(page.getByRole("heading", { name: `Attributes for ${renamedType}` })).toBeVisible();
    await expect(page.getByText(type, { exact: true })).toBeHidden();
    await expectAccessible(page, { label: "Renamed variant type panel" });
  },
);
