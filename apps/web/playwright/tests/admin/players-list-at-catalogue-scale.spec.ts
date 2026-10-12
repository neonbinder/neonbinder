// Origin: .maestro/flows/admin/players-list-at-catalogue-scale.yaml (Maestro suite retired in NEO-341; see git history)
// R1: at production scale the two big admin master lists stop at their read cap.
// /admin/players lists at most 500 rows (PLAYER_MANAGEMENT_CAP, convex/players.ts)
// and /admin/teams at most 2000 (TEAM_MANAGEMENT_CAP, convex/teams.ts). NEO-330
// dropped the "N of M" wording: the unfiltered counter reads "{N} players" /
// "{N} teams" (en-US thousands separator), so the proof of scale is that the
// UNFILTERED counter sits exactly AT the cap, "500 players" and "2,000 teams",
// on a preview holding far more rows than either cap. A list that read past
// its cap, or stopped short of it, fails.
//
// WHY THIS CAN BE PROVED AT ALL: every CI preview starts each run holding
// prod's reference catalogue (~113k players, ~10.5k teams), loaded before the
// seed. No spec could or should mint that many rows. Until a preview carries
// the catalogue this spec is RED by design.
//
// R2: each assertion is the counter's FULL text, anchored at both ends. The
// Teams counter may carry a " · N need attention" suffix (catalogue teams
// without colours); that count is data, not feature, so it is the one optional
// part (teamsCounter). R7/R7a: READ-ONLY. Nothing is typed, created or edited;
// no set is touched, so there is no SET-REGISTRY.md entry and no minted name.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { expectPlayersLoaded, expectTeamsLoaded, playersCounter, teamsCounter } from "../../support/players";

test(
  "Admin lists at catalogue scale — Players and Teams stop at their cap",
  { tag: ["@admin"] },
  async ({ page, signIn }) => {
    await signIn("/admin/players");
    // Gate on the COUNTER, not the heading: the heading paints while the list
    // query is in flight, the counter only once it has answered.
    await expectPlayersLoaded(page, LAUNCH_GATE);

    // Players: nothing typed and "All sports" picked, so this is the
    // unfiltered read and the cap is the only thing bounding it.
    await expect(playersCounter(page, "500 players")).toBeVisible();
    await expectAccessible(page, { label: "Player Management, list at its cap" });

    // Teams: the unfiltered list sits at the 2,000 cap. A reload repeats the
    // Clerk session handshake before the page can query, hence the 30 s gate
    // used by every full-page return to /admin/teams in this area.
    await page.goto("/admin/teams");
    await expectTeamsLoaded(page, 30_000);
    await expect(teamsCounter(page, "2,000 teams")).toBeVisible();
    await expectAccessible(page, { label: "Team Management, list at its cap" });
  },
);
