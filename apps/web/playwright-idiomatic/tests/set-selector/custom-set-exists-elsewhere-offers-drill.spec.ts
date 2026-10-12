// Spec: .maestro/flows/set-selector/custom-set-exists-elsewhere-offers-drill.yaml
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { drillToCustom } from "../../support/batch3/custom";

test(
  "Custom entry — a name that already exists under another brand offers to go to it instead of making a second row (NEO-219)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const w = env.WORKER_INDEX;
    const sport = `xp-sport-${w}`;
    const brandA = `xp-${w}-A`;
    const brandB = `xp-${w}-B`;
    const setName = `xp-${w}-${env.ATTEMPT_ID} Chrome`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // A year is four digits: a typo is refused and the form stays open.
    await drillToCustom(page, { sport });
    await page.getByRole("button", { name: "Add custom Years" }).click();
    await expect(page.getByText("Add Custom Entry")).toBeVisible();
    const value = page.getByPlaceholder("Enter custom value...");
    await value.fill("2o24");
    await value.press("Enter");
    await expect(page.getByText("Year must be a four-digit number")).toBeVisible();
    await expect(page.getByText("Add Custom Entry")).toBeVisible();

    // Create the set under brand B.
    await drillToCustom(page, { sport, year: "2026", manufacturer: brandB, set: setName });
    const attributes = page.getByRole("heading", { name: `Attributes for ${setName}` });
    await expect(attributes).toBeVisible();
    await expect(page.getByText(`2026 › ${brandB} › ${setName}`)).toBeVisible();

    // The same name under brand A is offered as a trip to the existing row.
    await drillToCustom(page, { sport, year: "2026", manufacturer: brandA });
    await page.getByRole("button", { name: "Add custom Sets" }).click();
    await expect(page.getByText("Add Custom Entry")).toBeVisible();
    await page.getByPlaceholder("Enter custom value...").fill(setName);
    await page.getByPlaceholder("Enter custom value...").press("Enter");
    await expect(page.getByText(`'${setName}' already exists under 2026 › ${brandB}`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Create here anyway" })).toBeVisible();

    await page.getByRole("button", { name: "Go to it" }).click();
    await expect(page.getByText("Add Custom Entry")).toBeHidden();
    await expect(attributes).toBeVisible();
    await expect(page.getByText(`2026 › ${brandB} › ${setName}`)).toBeVisible();
  },
);
