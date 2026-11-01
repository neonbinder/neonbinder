// NEO-350 (R1): a signed-in collector reaches the collection demo at
// /collection and its tabs switch. Smoke only: the demo is hard-coded data
// that never reaches Convex.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test(
  "Collection demo: signed-in /collection loads and its tabs switch",
  { tag: ["@smoke", "@home"] },
  async ({ page, signIn }) => {
    await signIn("/collection");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({
      timeout: LAUNCH_GATE,
    });
    // The page says plainly that it is the demo (sample data).
    const about = page.getByRole("region", { name: "About this demo" });
    await expect(about.getByText("Demo binder", { exact: true })).toBeVisible();
    const tabs = page.getByRole("navigation", { name: "Collection sections" });
    await expect(page.getByRole("heading", { level: 2, name: "Sets I'm building" })).toBeVisible();
    await expectAccessible(page, { label: "Collection demo, signed in" });

    await tabs.getByRole("link", { name: "Checklists" }).click();
    await expect(page.getByRole("searchbox", { name: "Search every card" })).toBeVisible();

    await tabs.getByRole("link", { name: "My Binders" }).click();
    await expect(page.getByRole("list", { name: "Your binders" })).toBeVisible();

    // Browser Back returns to the previous tab.
    await page.goBack();
    await expect(page.getByRole("searchbox", { name: "Search every card" })).toBeVisible();
  },
);
