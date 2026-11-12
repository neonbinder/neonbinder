// NEO-464 — the signed-in dashboard draws the collector's own shelf, and only
// the sections the collector's data fills. Replaces view-collection.spec.ts,
// which proved the "COMING SOON" page this replaced.
//
// R1: the shelf stands, and a section with nothing behind it stays away: no
// In the Hopper while nothing is in intake, and no Out the Door: the worker's
// account has a saved marketplace sign-in (the bootstrap's) but no order (the
// spec clears any test order other specs left), and
// only a stored order puts the sales section up (Jason, 2026-11-10). New on
// NeonBinder, the catalog's news, shows for everyone, and its tiles open real
// checklists. It lists only the six newest uploads (`NEW_SETS_SHOWN`), so the spec
// makes its own: a hand-made set with a Base and one card, uploaded a few seconds
// before the dashboard is read, is always on the list. (The seed's 2024 Topps Chrome
// is not: every other spec's hand-made set is newer than the seed's load.)
//
// R7: the hopper's state is this account's own and other specs leave scans in
// it (real-hopper-run-link seeds one), so this spec asks for the state it needs:
// the seed hop's `clearHopper` sets the account's open scans aside first.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { addCardViaForm } from "../../support/cards";
import { customSport, drillToCustom, selectOrCreate, setBuilderReady } from "../../support/set-builder";

test("Dashboard shows the collector's own binder shelf", { tag: ["@smoke", "@dashboard"] }, async ({ page, signIn, env }) => {
  // R7: a hand-made set of this worker's own, in its own sport, with a Base type and one card:
  // the newest checklist load in the catalog, so New on NeonBinder lists it as a whole set.
  const setName = `shelf-${env.WORKER_KEY}-${env.ATTEMPT_ID}`;
  const setTitle = `2026 Topps ${setName}`;
  await signIn("/set-selector");
  await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
  await drillToCustom(page, { sport: customSport(env), year: "2026", manufacturer: "Topps", set: setName });
  await selectOrCreate(page, "Variant Types", "Base", { via: "list" });
  await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible();
  await addCardViaForm(page, { cardNumber: "1", playerName: `Shelf${env.ATTEMPT_TOKEN}` });

  // R7: no stored order, asked for, not assumed: other specs on this worker leave
  // test orders behind (inventory-pick-list ships its orders and leaves them to the
  // bootstrap's reset). The clear removes only the caller's marked test orders and
  // forwards to the dashboard.
  await page.goto("/testing/seed-dashboard?clear=1");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome back, slugger." })).toBeVisible({ timeout: LAUNCH_GATE });

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

  // New on NeonBinder shows every collector the latest checklist uploads, grouped by set; the
  // set this spec just filled is the newest. Each tile opens a checklist a collector can read: the
  // set's Base for a whole set, else the variant itself (Jason, round 2).
  const news = page.getByRole("region", { name: "New on NeonBinder" });
  await expect(news).toBeVisible();
  // The whole-set tile reads "<set> <sport>, <n> cards" with no variant in its name (a lone
  // variant's tile would read "<set> <variant> <sport>, ..."), so it is the tile that must open
  // the set's Base.
  const tile = news.getByRole("link", { name: new RegExp(`^${setTitle} ${customSport(env)}, 1 card$`) });
  await expect(tile).toBeVisible();
  await expect(tile).toHaveAttribute("href", /^\/collection\?tab=checklists&set=[^&]+&type=[^&]+$/);

  await expectAccessible(page, { label: "Dashboard" });

  // A real move: the set's Base checklist opens (the Variant Types step reads Base, and the
  // checklist is "2026 <set> Base", not an insert or parallel), and Back returns to the dashboard.
  await tile.click();
  await expect(page).toHaveURL(/\/collection\?tab=checklists&set=[^&]+&type=[^&]+$/);
  const base = page.getByRole("region", { name: `2026 ${setName} Base`, exact: true });
  await expect(base.getByRole("heading", { level: 3, name: `2026 ${setName} Base`, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Variant Types: Base, change", exact: true })).toBeVisible();
  await expect(base.getByRole("button", { name: /^Details for #/ }).first()).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name: "Welcome back, slugger." })).toBeVisible();
});
