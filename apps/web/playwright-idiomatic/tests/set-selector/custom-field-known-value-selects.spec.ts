// Spec: .maestro/flows/set-selector/custom-field-known-value-selects.yaml
// Typing a value that already exists as synced data into the Sports "+ Custom"
// form selects it (closes the form, advances the drill) instead of creating a
// duplicate. Reads only; creates nothing.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { columnHeading, columnOption, setBuilderReady } from "../../support/set-builder";

test(
  "Custom field — typing a known synced value selects it instead of creating a duplicate",
  { tag: ["@set-selector"] },
  async ({ page, signIn }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // Baseball is the idle signal: the seed synced it into the Sports column.
    await expect(columnHeading(page, "Sports")).toBeVisible();
    await expect(columnOption(page, "Sports", "Baseball")).toBeVisible();

    await page.getByRole("button", { name: "Add custom Sports" }).click();
    await expect(page.getByText("Add Custom Entry")).toBeVisible();
    // The form's input is focused when it mounts.
    const value = page.getByPlaceholder("Enter custom value...");
    await expect(value).toBeFocused();
    await value.fill("Baseball");
    await value.press("Enter");

    // No error, no duplicate: the form closes and the drill advances.
    await expect(page.getByText("Add Custom Entry")).toBeHidden();
    await expect(columnHeading(page, "Years")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sync Years" })).toBeVisible();
  },
);
