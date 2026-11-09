// NEO-464 — the signed-in dashboard draws the collector's own shelf. Replaces
// view-collection.spec.ts, which proved the "COMING SOON" page this replaced.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test("Dashboard shows the collector's own binder shelf", { tag: ["@smoke", "@dashboard"] }, async ({ page, signIn }) => {
  await signIn("/dashboard");

  // Gate on the dashboard's own greeting (its one h1), not the shared header.
  await expect(page.getByRole("heading", { level: 1, name: "Welcome back, slugger." })).toBeVisible({ timeout: LAUNCH_GATE });
  await expect(page.getByRole("heading", { name: "Your binders" })).toBeVisible();

  // Main is every collector's binder, so it always stands on the shelf. Its
  // spine is named for it: "Main, <n> cards, nothing new".
  const shelf = page.getByRole("list", { name: "Binders on the shelf" });
  await expect(shelf.getByRole("button", { name: /^Main, \d+ cards?, / })).toBeVisible();

  await expectAccessible(page, { label: "Dashboard" });
});
