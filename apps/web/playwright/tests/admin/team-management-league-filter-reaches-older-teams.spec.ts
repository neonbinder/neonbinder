// NEO-495: Team Management's League dropdown lists the league's own teams, not
// whichever of the newest 2,000 rows happen to carry that league.
//
// Read-only (R7): it only opens /admin/teams and drives the League dropdown.
// The fixture is the seeded reference catalogue, which is prod-shaped: "All
// leagues" is the newest 2,000 rows of ~10,500, and every real MLB club (the
// Astros, the Yankees) is an older row outside that window. Before NEO-495 the
// dropdown filtered that window in the browser, so MLB showed a handful of
// recent MLB-tagged rows and none of the clubs. The spec names two real clubs,
// proves they are absent from the All leagues rows, then proves MLB lists them
// and that "No league" and the counter follow the choice.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { expectTeamsLoaded, TEAMS_BROWSING } from "../../support/players";

test(
  "Team Management — choosing a league lists its older teams that the All leagues window misses",
  { tag: ["@admin"] },
  async ({ page, signIn }) => {
    await signIn("/admin/teams");
    await expect(page.getByText("Team Management", { exact: true })).toBeVisible({
      timeout: LAUNCH_GATE,
    });
    await expectTeamsLoaded(page);

    const league = page.getByLabel("League", { exact: true });
    const counter = page.getByText(TEAMS_BROWSING).first();
    // A team row is a button named by the team's full name and era
    // ("Houston Astros · 1965–present"). Match on the full-name prefix.
    const astros = page.getByRole("button", { name: /^Houston Astros · / });
    const yankees = page.getByRole("button", { name: /^New York Yankees · / });
    // The one list that holds the rows: its items are the rows the counter counts.
    const rowsOf = (club: typeof astros) =>
      page.getByRole("list").filter({ has: club }).getByRole("listitem");

    // All leagues is the newest-2,000 window: full (the counter says so, which
    // also proves the rows loaded) and without the real clubs.
    await expect(league.getByRole("option", { selected: true })).toHaveText("All leagues");
    await expect(counter).toHaveText(/^2,000 teams/);
    await expect(astros).toHaveCount(0);
    await expect(yankees).toHaveCount(0);

    // MLB: the clubs the window misses are listed, and the counter is the
    // league's own count, not the window's.
    await league.selectOption({ label: "MLB" });
    await expect(astros).toBeVisible();
    await expect(yankees).toBeVisible();
    const mlbCount = Number(((await counter.textContent()) ?? "").match(/^([\d,]+) teams?/)?.[1].replace(/,/g, ""));
    expect(mlbCount).toBeGreaterThan(17);
    expect(mlbCount).toBeLessThan(2000);
    await expect(rowsOf(astros)).toHaveCount(mlbCount);
    await expectAccessible(page, { label: "Team Management, filtered to MLB" });

    // No league: the rows that carry none, and not the MLB clubs.
    await league.selectOption({ label: "No league" });
    const unleagued = page.getByRole("button", { name: /^United States National Baseball Team · / });
    await expect(unleagued).toBeVisible();
    await expect(astros).toHaveCount(0);
    const noLeagueCount = Number(((await counter.textContent()) ?? "").match(/^([\d,]+) teams?/)?.[1].replace(/,/g, ""));
    expect(noLeagueCount).toBeGreaterThan(0);
    expect(noLeagueCount).toBeLessThan(mlbCount);
    await expect(rowsOf(unleagued)).toHaveCount(noLeagueCount);

    // Back to All leagues: the window again.
    await league.selectOption({ label: "All leagues" });
    await expect(counter).toHaveText(/^2,000 teams/);
    await expect(astros).toHaveCount(0);
  },
);
