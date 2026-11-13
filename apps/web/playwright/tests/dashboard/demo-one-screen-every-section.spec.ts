// R1: the dashboard is ONE screen (NEO-464, Jason 2026-11-10): it shows every
// section the collector's data fills, with no dealer/collector switch. The
// public demo draws that same screen on a fake collector who has a bit of
// everything, so every section shows, an order waiting to ship leads, and the
// Hopper holds one block per open run, each linked to the Add cards tab that
// finishes it (here, the demo's Inventory side), and Out the Door links to the
// Pick List where its orders are pulled (NEO-539). Signed out, fake data, read-only (R7).
// With no binder open, the first stands shut where the pocket page opens; its
// cover opens it. The panels the screen opens (a binder's pocket page, an order's cards) are
// checked for accessibility OPEN, as well as the closed page: the open state is
// what a keyboard or screen-reader user spends their time in, and so is a
// card's panel, which opens over the dashboard; its ↓ steps through the run of
// cards it was opened from, and what it holds agrees with what the dashboard
// said (a New Listing's box). Needs a Look has nothing to
// open (a plain list), so there is no open state of it to check.
import { test, expect, expectAccessible } from "../../support/fixtures";
import { pickList } from "../../support/pick-list";

test(
  "Dashboard demo: one screen with every section, and a hopper run opens Add cards where it is finished",
  { tag: ["@smoke", "@dashboard"] },
  async ({ page }) => {
    // Signed out: every test starts in a fresh browser context (R4).
    await page.goto("/demo");
    await expect(page.getByRole("heading", { level: 1, name: "Welcome back, slugger." })).toBeVisible();

    // One screen: no "Viewing as" switch beside the demo's own Light / Dark control.
    const controls = page.getByRole("region", { name: "Demo controls" });
    await expect(controls).toBeVisible();
    await expect(controls.getByRole("radiogroup", { name: "Viewing as" })).toHaveCount(0);

    // Every section the fake collector's data fills.
    const section = (name: string) => page.getByRole("heading", { level: 2, name, exact: true });
    // The fake collector has boxes in use, so the shelf is "Your binders and boxes" (review round 4).
    for (const name of [
      "Sync status",
      "Out the Door",
      "In the Hopper",
      "Needs a Look",
      "On the Bubble",
      "Your binders and boxes",
      "New Listings",
      "Odds and Ends",
      "New on NeonBinder",
    ]) {
      await expect(section(name), name).toBeVisible();
    }

    // The fake collector finished the 1989 Score set today: the cheer names the
    // card that closed it, and every card it shows opens its panel.
    await expect(page.getByRole("heading", { level: 3, name: "Every bulb lit! 1989 Score is done." })).toBeVisible();
    await expect(page.getByText(/^All 330 in the binder\./)).toBeVisible();
    const cheered = page.getByRole("list", { name: "1989 Score, every card" });
    await expect(cheered.getByRole("link").first()).toBeVisible();
    // Today's pulls hold the card that closed it, and it is on the Want List (graded): the dashed pull.
    const freshPulls = page.getByRole("region", { name: "Fresh Pulls" });
    await expect(freshPulls.getByRole("link", { name: /^1989 Score Barry Sanders #257 .*On your Want List$/ })).toBeVisible();
    // The demo's box lines carry their prices; a few wait on a price.
    const newListings = page.getByRole("region", { name: "New Listings" });
    await expect(newListings.getByRole("link").filter({ hasText: /\$\d+\.\d{2}/ }).first()).toBeVisible();

    // The one ordering rule: orders are waiting to ship, so Out the Door comes before the boards.
    const sections = page.getByRole("heading", { level: 2 });
    const order = await sections.allInnerTexts();
    expect(order.indexOf("Out the Door")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("Out the Door")).toBeLessThan(order.indexOf("On the Bubble"));

    // The hopper leads with what waits on the collector, then one block per run still open (NEO-539).
    // The fake collector's two runs: Show pickups (into a box: Inventory) and Garage shoebox (a binder:
    // Collection). The demo adds a Want List guess to Show pickups, so it waits on one more yes.
    const hopper = page.getByRole("region", { name: "In the Hopper" });
    // A line's parts are joined by a dot on screen and a comma for a reader ("... yes · , 18 ..." in its text).
    await expect(hopper.getByText(/^3 scans need your yes · , 18 to identify$/)).toBeVisible();
    const runs = hopper.getByRole("list", { name: "Runs to finish", exact: true });
    const blockOf = (title: string) =>
      runs.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 3, name: title, exact: true }) });
    const pickups = blockOf("Show pickups on Inventory");
    const shoebox = blockOf("Garage shoebox on Collection");
    await expect(pickups).toBeVisible();
    await expect(shoebox).toBeVisible();
    await expect(runs.getByRole("heading", { level: 3 })).toHaveCount(2);
    await expect(pickups.getByText(/^1 needs your yes · , 2 to identify$/)).toBeVisible();
    await expect(shoebox.getByText(/^2 need your yes · , 16 to identify$/)).toBeVisible();
    // Each block's link names its run and its screen, and goes to that screen's Add cards tab.
    const finishPickups = pickups.getByRole("link", { name: "Finish this run into Show pickups on Inventory", exact: true });
    await expect(finishPickups).toHaveAttribute("href", "/demo/inventory?side=inventory&tab=add");
    await expect(shoebox.getByRole("link", { name: "Finish this run into Garage shoebox on Collection", exact: true })).toHaveAttribute(
      "href",
      "/demo/collection?tab=add",
    );
    // A run sorted is only counted, never a row; no "N of M done" progress is left anywhere.
    await expect(hopper.getByText(/^3 runs sorted this week · , 14 all-time$/)).toBeVisible();
    await expect(page.getByText(/\d+ of \d+ scans? done/)).toHaveCount(0);
    await expect(hopper.getByText(/still being identified/)).toHaveCount(0);
    await expect(hopper.getByText(/scans? processing/)).toHaveCount(0);

    // The demo's Want List guess waits in Show pickups: the block says so, and the guess opens its card panel.
    // The flag's star is a hidden span inside it, so its text reads "★ On your Want List": one pattern
    // for both, and the positive one first, so the zero count below cannot pass on a pattern that finds nothing.
    const wantFlag = /^★?\s*On your Want List$/;
    await expect(pickups.getByText(wantFlag)).toBeVisible();
    await expect(shoebox.getByText(wantFlag)).toHaveCount(0);
    // Each run's guesses are a list of their own, named for the run and its screen.
    const wantedTitle = "1996 Playoff Contenders Deion Sanders #13 Dallas Cowboys Football";
    const pickupGuesses = pickups.getByRole("list", { name: "Best guesses for Show pickups on Inventory", exact: true });
    const wantedGuess = pickupGuesses.getByRole("link", { name: `${wantedTitle}, on your Want List`, exact: true });
    await expect(wantedGuess).toBeVisible();
    const shoeboxGuesses = shoebox.getByRole("list", { name: "Best guesses for Garage shoebox on Collection", exact: true });
    await expect(shoeboxGuesses.getByRole("link")).toHaveCount(2);
    await expect(shoeboxGuesses.getByRole("link", { name: /, on your Want List$/ })).toHaveCount(0);
    await expectAccessible(page, { label: "Dashboard demo" });
    await wantedGuess.click();
    await expect(page).toHaveURL(/\/demo\?(.*&)?detail=[^&]+/);
    const guessPanel = page.getByRole("dialog");
    await expect(guessPanel.getByRole("button", { name: "Close card detail" })).toBeVisible();
    await page.goBack();
    await expect(guessPanel).toBeHidden();
    await expect(page).toHaveURL(/\/demo$/);

    // A run going into a box is finished on Inventory's Add cards tab, and Back comes home.
    await finishPickups.click();
    await expect(page).toHaveURL(/\/demo\/inventory\?(.*&)?tab=add/);
    await expect(page.getByLabel("Put them in this box")).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/demo$/);
    await expect(hopper).toBeVisible();

    // Orders wait to ship, so Out the Door links to the Pick List where they are pulled; Back comes home.
    const orders = page.getByRole("region", { name: "Out the Door" });
    const pullThem = orders.getByRole("link", { name: "Pull them on the Pick List", exact: true });
    await expect(pullThem).toHaveAttribute("href", "/demo/inventory?side=inventory&tab=pick");
    await pullThem.click();
    await expect(page).toHaveURL(/\/demo\/inventory\?side=inventory&tab=pick$/);
    await expect(pickList(page).heading).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/demo$/);
    await expect(orders).toBeVisible();

    // An order opens to every card on it: check the opened order.
    const showCards = orders.getByRole("button", { name: /^Show all \d+ cards? in .+ order / }).first();
    await showCards.click();
    // The button's words flip with the state, so the open one is found by its new name.
    await expect(orders.getByRole("button", { name: /^Hide the cards/, expanded: true }).first()).toBeVisible();
    await expectAccessible(page, { within: orders, label: "Dashboard demo, an order opened" });

    // With none open, the first binder on the shelf stands shut beside it; its cover
    // opens it to a pocket page, as its spine would: check the opened page.
    const shelf = page.getByRole("list", { name: "Binders on the shelf" });
    const spine = shelf.getByRole("button", { name: /^.+, \d+ cards?, / }).first();
    await expect(spine).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: /^Crack open / }).click();
    await expect(spine).toHaveAttribute("aria-expanded", "true");
    const pocketPage = page.getByRole("list", { name: /, page 1 of \d+$/ });
    await expect(pocketPage).toBeVisible();
    await expectAccessible(page, { within: pocketPage, label: "Dashboard demo, a binder's pocket page open" });

    // A card opens its card panel over the dashboard (a Back step), on the demo's own collection: a
    // Fresh Pull here. Checked open, then Back closes it with the keyboard on the pull.
    const pull = page.getByRole("region", { name: "Fresh Pulls" }).getByRole("link").first();
    await pull.click();
    await expect(page).toHaveURL(/\/demo\?(.*&)?detail=[^&]+$/);
    const panel = page.getByRole("dialog");
    await expect(panel.getByRole("button", { name: "Close card detail" })).toBeVisible();
    await expectAccessible(page, { label: "Dashboard demo, a Fresh Pull's card panel open" });
    // ↓ steps through the batch the pull came from, in place: one Back still closes the panel.
    const opened = new URL(page.url()).searchParams.get("detail");
    await expect(panel.getByText(/^Card 1 of \d+/)).toBeVisible();
    await panel.getByRole("button", { name: "Next card" }).click();
    await expect(panel.getByText(/^Card 2 of \d+/)).toBeVisible();
    expect(new URL(page.url()).searchParams.get("detail")).not.toBe(opened);
    await page.goBack();
    await expect(panel).toBeHidden();
    await expect(page).not.toHaveURL(/detail=/);
    await expect(page.getByRole("heading", { level: 1, name: "Welcome back, slugger." })).toBeVisible();
    await expect(pull).toBeFocused();

    // The demo's cards say what their panels say: a New Listing's panel holds the copies in the box
    // its tile names.
    const listing = page.getByRole("region", { name: "New Listings" }).getByRole("link").first();
    const box = (await listing.innerText()).match(/\d+ in (.+)$/m)?.[1];
    expect(box).toBeTruthy();
    await listing.click();
    await expect(page).toHaveURL(/[?&]detail=[^&]+&side=inventory$/);
    await expect(panel.getByText(box!, { exact: false }).first()).toBeVisible();
    await page.goBack();
    await expect(panel).toBeHidden();
  },
);
