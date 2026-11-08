// NEO-462: the "Possible matches" panel on the /admin/players add form describes
// each candidate, so two men who share a name read as two different men: the
// name, "b. <birth year>" and the (up to two) teams he spent longest with, each
// with short year ranges, then "+N more" for the rest. The row's accessible name
// speaks the same facts in words ("born 1962, ... plus 1 more").
//
// FIXTURE (built through the product, no seed): three players who share ONE minted
// surname token in this worker's custom sport, forked apart by birth year. The
// custom sport has no sportConfig.wikidata, so no player or team create here
// reaches a Wikidata lookup (GUIDE "Enrichment fixtures"), and the minted single
// tokens never collide with another run's rows.
//   - 1975: nothing else on file. First created, so the add form promotes him to
//           the primary "Open ..." button (server order is creation order).
//   - 1962: three teams, so only the two he spent longest with are named and the
//           third is counted as "+1 more".
//   - 1988: one team, two stints, so a repeat stint prints on one line.
// The two rows left in the panel are the feature. Nothing a spec creates is
// removed, so every name carries this attempt's token. Desktop and mobile each
// mint their own (ATTEMPT_TOKEN carries the project).
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { emptyListAndPickSport, expectPlayersLoaded } from "../../support/players";
import { customSport, drillToCustom } from "../../support/set-builder";

test(
  "Player Management — the Possible matches panel describes each candidate with his birth year and the teams he spent longest with",
  { tag: ["@admin"] },
  async ({ page, signIn, env }) => {
    const token = env.ATTEMPT_TOKEN;
    const surname = `Wlk${token}`;
    const teamA = `Tma${token}`;
    const teamB = `Tmb${token}`;
    const teamC = `Tmc${token}`;

    await signIn("/admin/players");
    await expectPlayersLoaded(page, LAUNCH_GATE);

    // The worker's own custom sport (hand-made, idempotent), then back to the list.
    await drillToCustom(page, { sport: customSport(env) });
    await page.goto("/admin/players");
    await expectPlayersLoaded(page, 20_000);
    await emptyListAndPickSport(page, customSport(env));

    const addButton = page.getByRole("button", { name: "Add player" });
    const newName = page.getByLabel("New player name");
    const birthYear = page.getByLabel(/^Birth year \(optional\)/);

    // Open the add form, type the shared surname and a birth year, create.
    const addPlayer = async (year: string, anyway: boolean) => {
      await addButton.click();
      await expect(page.getByRole("heading", { name: "Add a player" })).toBeVisible();
      await newName.fill(surname);
      await birthYear.fill(year);
      await page
        .getByRole("button", { name: anyway ? `Create player ${surname} anyway` : `Create player ${surname}` })
        .click();
      await expect(page.getByText(`Added ${surname}.`)).toBeVisible();
    };

    // Stint helper on the open player's career editor. A team seen for the first
    // time is created from the search's "No matches." through the New Team
    // dialog; a team a stint already used is picked from the typeahead.
    const addStint = async (team: string, from: string, to: string, isNewTeam: boolean) => {
      await page.getByRole("button", { name: "Add team" }).click();
      const search = page.getByRole("textbox", { name: "Search teams" });
      await search.fill(team);
      if (isNewTeam) {
        await expect(page.getByText("No matches.")).toBeVisible();
        await search.press("Enter");
        const dialog = page.getByRole("dialog", { name: `New team: ${team}` });
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: `Create team ${team}` }).click();
      } else {
        await page.getByRole("option", { name: new RegExp(`^Add ${team}`) }).click();
      }
      await expect(page.getByRole("button", { name: `Remove team ${team}` })).toBeVisible();
      await page.getByRole("heading", { name: "Career history" }).click(); // closes the typeahead
      await page.getByLabel(/Stint from year/).fill(from);
      await page.getByLabel(/Stint to year/).fill(to);
      await page.getByRole("button", { name: "Add stint" }).click();
      await expect(
        page.getByRole("link", { name: new RegExp(`${team} · ${from}`) }).first(),
      ).toBeVisible();
    };
    const saveStints = async () => {
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText(new RegExp(`Saved ${surname}`))).toBeVisible();
    };

    // 1975 first: he becomes the promoted primary and stays out of the panel.
    await addPlayer("1975", false);

    // 1962: three teams, longest first by total seasons (A 12, C 5, B 2).
    await addPlayer("1962", true);
    await addStint(teamA, "2001", "2012", true);
    await addStint(teamB, "2013", "2014", true);
    await addStint(teamC, "1995", "1999", true);
    await saveStints();

    // 1988: one team, two stints.
    await addPlayer("1988", true);
    await addStint(teamA, "2015", "2016", false);
    await addStint(teamA, "2019", "2019", false);
    await saveStints();

    // The feature: type the shared surname into a fresh add form.
    await addButton.click();
    await expect(page.getByRole("heading", { name: "Add a player" })).toBeVisible();
    await newName.fill(surname);
    // The first-created exact row is the primary; the other two are the panel.
    await expect(
      page.getByRole("button", { name: `Open ${surname}, b. 1975`, exact: true }),
    ).toBeVisible();
    const panel = page.getByRole("list", { name: "Possible player matches" });
    await expect(panel.getByRole("listitem")).toHaveCount(2);

    // Visible text: birth year, then the two longest teams with short ranges and a
    // count of the rest.
    const rowOf1962 = panel.getByRole("listitem").filter({ hasText: "b. 1962" });
    await expect(rowOf1962).toContainText(`b. 1962 · ${teamA} 2001–12 · ${teamC} 1995–99 +1 more`);
    const rowOf1988 = panel.getByRole("listitem").filter({ hasText: "b. 1988" });
    await expect(rowOf1988).toContainText(`b. 1988 · ${teamA} 2015–16, 2019`);

    // The same facts are in the row's accessible name, in words (all three share a name, so each ends "same name").
    await expect(
      rowOf1962.getByRole("button", {
        name: `Open ${surname}, born 1962, ${teamA} 2001 to 2012, ${teamC} 1995 to 1999, plus 1 more — same name`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      rowOf1988.getByRole("button", {
        name: `Open ${surname}, born 1988, ${teamA} 2015 to 2016 and 2019 — same name`,
        exact: true,
      }),
    ).toBeVisible();

    await expectAccessible(page, { label: "Player Management, Possible matches with descriptions" });

    // The described row is the man it says: opening it lands on his detail
    // (his three stints, A first by year). Back is deliberately not walked: the
    // Players screen selects with a replace, so Back is an exit from it.
    await rowOf1962.getByRole("button").click();
    await expect(page.getByRole("heading", { name: surname, exact: true })).toBeVisible();
    const stints = page.getByRole("list", { name: "Career history" }).getByRole("listitem");
    await expect(stints).toHaveCount(3);
    await expect(stints.filter({ hasText: `${teamA} · 2001–2012` })).toHaveCount(1);
  },
);
