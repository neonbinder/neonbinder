// NEO-464 — the signed-in dashboard draws the collector's own shelf, and only
// the sections the collector's data fills. Replaces view-collection.spec.ts,
// which proved the "COMING SOON" page this replaced.
//
// R1: the shelf stands, and a section with nothing behind it stays away: no
// In the Hopper while nothing is in intake, and no Out the Door: the worker's
// account has a saved marketplace sign-in (the bootstrap's) but no order, and
// only a stored order puts the sales section up (Jason, 2026-11-10). New on
// NeonBinder, the catalog's news, shows for everyone.
//
// R7: the hopper's state is this account's own and other specs leave scans in
// it (real-hopper-run-link seeds one), so this spec asks for the state it needs:
// the seed hop's `clearHopper` sets the account's open scans aside first.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test("Dashboard shows the collector's own binder shelf", { tag: ["@smoke", "@dashboard"] }, async ({ page, signIn }) => {
  await signIn("/testing/seed-placeholder-run?clearHopper=1%26redirect=/dashboard");

  // Gate on the dashboard's own greeting (its one h1), not the shared header.
  await expect(page.getByRole("heading", { level: 1, name: "Welcome back, slugger." })).toBeVisible({ timeout: LAUNCH_GATE });
  await expect(page.getByRole("heading", { name: "Your binders" })).toBeVisible();

  // Main is every collector's binder, so it always stands on the shelf. Its
  // spine is named for it: "Main, <n> cards, nothing new".
  const shelf = page.getByRole("list", { name: "Binders on the shelf" });
  const main = shelf.getByRole("button", { name: /^Main, \d+ cards?, / });
  await expect(main).toBeVisible();

  // Sections only when there is data. Out the Door shows only for an account
  // with an order stored; this one has none, whatever logins it saved. Nothing
  // is in intake, so the hopper is not drawn either.
  await expect(page.getByRole("heading", { level: 2, name: "Out the Door", exact: true })).toHaveCount(0);
  await expect(page.getByText("All shipped. Nice.")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2, name: "In the Hopper", exact: true })).toHaveCount(0);

  // With no binder open, the first one on the shelf stands shut beside it, one button to open it.
  await expect(page.getByRole("button", { name: /^Crack open / })).toBeVisible();

  // New on NeonBinder shows every collector the sets whose cards landed last; the seed's
  // 2024 Topps Chrome is one, and its tile opens its checklist.
  const news = page.getByRole("region", { name: "New on NeonBinder" });
  await expect(news).toBeVisible();
  await expect(news.getByRole("link", { name: /Topps Chrome/ }).first()).toHaveAttribute("href", /\/collection\?tab=checklists&set=/);

  await expectAccessible(page, { label: "Dashboard" });
});
