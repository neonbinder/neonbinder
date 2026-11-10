// NEO-464 — the signed-in dashboard draws the collector's own shelf, and only
// the sections the collector's data fills. Replaces view-collection.spec.ts,
// which proved the "COMING SOON" page this replaced.
//
// R1: the shelf stands, and a section with nothing behind it stays away: no
// In the Hopper while nothing is in intake. The worker's account sells (the
// bootstrap saves its BuySportsCards sign-in) and has no orders, so Out the Door
// stands too, with its "All shipped" line; its absence for an account that
// sells nothing is not reachable here without removing that sign-in (a live
// login round trip on a shared seller), so it is proved on the public demo's
// and the unit tests' side, not by this spec.
//
// R7: the hopper's state is this account's own and other specs leave scans in
// it (real-hopper-run-link seeds one), so this spec asks for the state it needs:
// the seed hop's `clearHopper` sets the account's open scans aside first.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { nameOf } from "../../support/collection";

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

  // Sections only when there is data. An account that sells shows Out the Door,
  // here with nothing to ship; nothing is in intake, so the hopper is not drawn.
  await expect(page.getByRole("heading", { level: 2, name: "Out the Door", exact: true })).toBeVisible();
  await expect(page.getByText("All shipped. Nice.")).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "In the Hopper", exact: true })).toHaveCount(0);

  // The empty-shelf line shows exactly when the shelf holds no card. Main's own
  // count tells which state this account is in; with cards in it, the line is
  // gone, and with none and no other binder, it stands.
  const emptyShelf = page.getByRole("link", { name: "Add a card on Collection" });
  const mainCards = Number(/^Main, (\d+) cards?, /.exec(await nameOf(main))?.[1]);
  const spines = await shelf.getByRole("button", { name: /^.+, \d+ cards?, / }).count();
  if (mainCards > 0) {
    await expect(emptyShelf).toHaveCount(0);
  } else if (spines === 1) {
    await expect(emptyShelf).toBeVisible();
  }

  await expectAccessible(page, { label: "Dashboard" });
});
