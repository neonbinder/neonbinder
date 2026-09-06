/**
 * NEO-221 — the navigation rule, tested as a function.
 *
 * FILE EXTENSION, deliberately: `.test.tsx` for a file with no JSX in it. The
 * collection globs in `vitest.include.mjs` pair extensions with roots —
 * `.test.ts` is collected under `convex/` and `lib/` only, `.test.tsx` under
 * `components/`, `src/` and `app/`. A `components/**\/*.test.ts` is collected by
 * nothing and runs silently never (that exact pairing is called out in the
 * verifier's own header as the realistic miss). Renaming the file is a smaller
 * change than widening a glob shared with `verify-test-completeness.mjs`.
 *
 * `resolveNav` is the whole "which row is on screen" contract in one place, so
 * the cases that used to be reproducible only by racing a reactive query
 * against a click are ordinary table tests here: a sibling lookup landing, a
 * row disappearing under a resume, and the operator pinning a decided row.
 *
 * The identity assertions are load-bearing, not stylistic. The wizard's advance
 * effect bails with `if (next === nav) return`, so a "no change" that returned
 * a fresh object would re-render forever.
 */

import { describe, expect, it } from "vitest";
import {
  countDecided,
  countPendingUndecided,
  describeDecision,
  nextUndecided,
  resolveNav,
  summarizeDecisions,
  type NavRow,
} from "./entity-review-nav";

function row(
  id: string,
  status: NavRow["status"] = "ready",
  decision?: NavRow["decision"],
): NavRow {
  return { _id: id, status, decision };
}

/** A player row — the only kind the NEO-236 blocking rule applies TO. */
function player(
  id: string,
  status: NavRow["status"] = "ready",
  decision?: NavRow["decision"],
): NavRow {
  return { _id: id, status, decision, kind: "player" };
}

/**
 * A team row the batch staged for a player's career list — the only kind the
 * blocking rule applies FROM. `getBatch` emits these AHEAD of their player,
 * which is what makes Jason's "New Team, New Team, then the player" order fall
 * out of `nextUndecided` once they are settled.
 */
function careerTeamOf(
  id: string,
  playerRowId: string,
  status: NavRow["status"] = "ready",
  decision?: NavRow["decision"],
): NavRow {
  return {
    _id: id,
    status,
    decision,
    kind: "team",
    source: { kind: "careerTeamOf", playerRowId },
  };
}

describe("nextUndecided", () => {
  it("returns the first settled, undecided row", () => {
    const rows = [row("a", "ready", { action: "create" }), row("b"), row("c")];
    expect(nextUndecided(rows)?._id).toBe("b");
  });

  it("steps over a still-pending row rather than blocking on it", () => {
    // NEO-99: the Wikidata pool completes out of insertion order, so a
    // straggler at the head of the batch must not stall the whole review.
    const rows = [row("a", "pending"), row("b", "ready")];
    expect(nextUndecided(rows)?._id).toBe("b");
  });

  it("treats an errored lookup as settled — there is still a decision to make", () => {
    expect(nextUndecided([row("a", "error")])?._id).toBe("a");
  });

  it("returns null when every row is decided", () => {
    expect(
      nextUndecided([row("a", "ready", { action: "skip" })]),
    ).toBeNull();
  });

  it("returns null for an empty batch", () => {
    expect(nextUndecided([])).toBeNull();
  });
});

/**
 * NEO-236 — a player waits for the teams its own career list staged.
 *
 * Jason, 2026-09-05: "I think we should show 3 modals in the walker: 1. New
 * Team: Sydney Blue Sox 2. New Team: Oregon State Beavers 3. New Player Travis
 * Bazzana which can now use the 2 new teams that were created."
 *
 * `getBatch` already emits the staged team rows ahead of their player, which is
 * enough only while those rows are SETTLED — the "step over a pending row" rule
 * above would otherwise put the player first and hand the operator a step they
 * cannot complete (every chip reading "needs a team decision", the primary
 * blocked). So the player is held until each of its staged teams carries an
 * answer, whatever that answer is.
 */
describe("nextUndecided — a player waits on its staged career teams", () => {
  it("presents the staged team first even though the player was inserted first", () => {
    const rows = [player("p1"), careerTeamOf("t1", "p1")];
    expect(nextUndecided(rows)?._id).toBe("t1");
  });

  it("walks Jason's sequence: both teams, then the player", () => {
    const sydney = careerTeamOf("t-sydney", "p1");
    const oregon = careerTeamOf("t-oregon", "p1");
    const bazzana = player("p1");

    // `getBatch` order: the staged teams sit ahead of the player they came
    // from, so a settled batch simply reads left to right.
    let rows = [sydney, oregon, bazzana];
    expect(nextUndecided(rows)?._id).toBe("t-sydney");

    rows = [{ ...sydney, decision: { action: "create" } }, oregon, bazzana];
    expect(nextUndecided(rows)?._id).toBe("t-oregon");

    rows = [
      { ...sydney, decision: { action: "create" } },
      { ...oregon, decision: { action: "create" } },
      bazzana,
    ];
    expect(nextUndecided(rows)?._id).toBe("p1");
  });

  it("stops blocking once the team is decided, whatever the decision is", () => {
    for (const decision of [
      { action: "create" } as const,
      { action: "link", linkedTeamId: "team_1" } as const,
      // "Skip" means "that is not a team". The player's own step is where that
      // is dealt with — untick the chip, or change the team's decision — so
      // refusing to present the player would leave nowhere to do either.
      { action: "skip" } as const,
    ]) {
      const rows = [player("p1"), careerTeamOf("t1", "p1", "ready", decision)];
      expect(nextUndecided(rows)?._id).toBe("p1");
    }
  });

  it("keeps holding the player while its staged team is still being looked up", () => {
    // The pending team is stepped over by the general rule AND still blocks the
    // player, so there is nothing to present. The wizard says it is still
    // looking names up, which is exactly what is happening.
    const rows = [player("p1"), careerTeamOf("t1", "p1", "pending")];
    expect(nextUndecided(rows)).toBeNull();
  });

  it("holds only on ITS OWN staged teams", () => {
    // Two players in one batch. p2's outstanding team is not p1's problem, so
    // p1 is offered normally while p2 waits.
    const rows = [player("p1"), careerTeamOf("t2", "p2", "pending"), player("p2")];
    expect(nextUndecided(rows)?._id).toBe("p1");

    // With p1 answered there is genuinely nothing left to show: t2 is still
    // being looked up and p2 is waiting on it.
    const p1Done = [
      player("p1", "ready", { action: "create" }),
      careerTeamOf("t2", "p2", "pending"),
      player("p2"),
    ];
    expect(nextUndecided(p1Done)).toBeNull();

    // t2 lands, and it is what comes next — ahead of the player it belongs to.
    const t2Ready = [
      player("p1", "ready", { action: "create" }),
      careerTeamOf("t2", "p2"),
      player("p2"),
    ];
    expect(nextUndecided(t2Ready)?._id).toBe("t2");
  });

  it("never blocks a TEAM row, even one that is itself staged", () => {
    // The rule is about a player waiting on its teams. A team row waiting on a
    // team row would be a cycle with no operator step to break it.
    const rows = [careerTeamOf("t1", "p1"), careerTeamOf("t2", "p1")];
    expect(nextUndecided(rows)?._id).toBe("t1");
  });

  it("leaves rows that carry no kind/source untouched", () => {
    // Every pre-NEO-236 caller passes three-field literals; the rule has to be
    // inert for them rather than needing them all updated.
    const rows = [row("a"), row("b")];
    expect(nextUndecided(rows)?._id).toBe("a");
  });

  it("cannot deadlock: a blocker is either reachable or still being looked up", () => {
    // A blocking row is by definition undecided, so it is either settled — and
    // then reached FIRST, because it sorts ahead of the player — or pending,
    // and the lookup pool (or `sweepStalePendingRows`) settles it. There is no
    // third state in which the walk has nothing to offer and nothing arriving.
    const blocked = [player("p1"), careerTeamOf("t1", "p1", "pending")];
    expect(nextUndecided(blocked)).toBeNull();

    const settled = [player("p1"), careerTeamOf("t1", "p1", "ready")];
    expect(nextUndecided(settled)?._id).toBe("t1");

    const answered = [
      player("p1"),
      careerTeamOf("t1", "p1", "ready", { action: "create" }),
    ];
    expect(nextUndecided(answered)?._id).toBe("p1");
  });

  it("counts a blocked player as undecided, not as done", () => {
    // The progress line must not claim a row is finished because the walk is
    // not showing it.
    const rows = [player("p1"), careerTeamOf("t1", "p1", "pending")];
    expect(countDecided(rows)).toBe(0);
    expect(countPendingUndecided(rows)).toBe(1);
  });
});

describe("resolveNav — the staged-team hold", () => {
  it("presents nothing while every remaining row is blocked or pending", () => {
    // The loop guard again: null in, null out, SAME object.
    const nav = { rowId: null, explicit: false };
    const rows = [player("p1"), careerTeamOf("t1", "p1", "pending")];
    expect(resolveNav(rows, nav)).toBe(nav);
  });

  it("moves to the player the moment its last staged team is answered", () => {
    const rows = [player("p1"), careerTeamOf("t1", "p1")];
    const onTeam = resolveNav(rows, { rowId: null, explicit: false });
    expect(onTeam).toEqual({ rowId: "t1", explicit: false });

    const decided = [
      player("p1"),
      careerTeamOf("t1", "p1", "ready", { action: "create" }),
    ];
    expect(resolveNav(decided, onTeam)).toEqual({ rowId: "p1", explicit: false });
  });

  it("YIELDS an implicitly-presented player the moment its staged teams appear", () => {
    /*
     * Jason, CI run 5, on the FIRST player of a fresh batch: he was shown the
     * New Player step with its career chips, and never saw a New Team step at
     * all.
     *
     * This is the sequence. The player's lookup is what STAGES its career
     * teams, and the wizard is already presenting that player when the lookup
     * lands (it is the first settled row in the batch). The staged rows are
     * inserted ahead of it by `walkOrder` and `nextUndecided` correctly refuses
     * to offer the player — but `resolveNav` never asked, because a present,
     * undecided, implicitly-presented row was not "stale". So the pin won and
     * the New Team steps were never shown.
     *
     * An IMPLICIT pin is the wizard's own walk, not a decision the operator
     * made, so it must yield. The explicit case below is the one that stays.
     */
    const before = [player("p1")];
    const onPlayer = resolveNav(before, { rowId: null, explicit: false });
    expect(onPlayer).toEqual({ rowId: "p1", explicit: false });

    // The lookup lands and stages two steps for this very player.
    const after = [
      player("p1"),
      careerTeamOf("t1", "p1"),
      careerTeamOf("t2", "p1"),
    ];
    expect(resolveNav(after, onPlayer)).toEqual({ rowId: "t1", explicit: false });
  });

  it("comes back to the player once those steps are answered", () => {
    const rows = [
      player("p1"),
      careerTeamOf("t1", "p1", "ready", { action: "create" }),
      careerTeamOf("t2", "p1", "ready", { action: "create" }),
    ];
    expect(resolveNav(rows, { rowId: "t2", explicit: false })).toEqual({
      rowId: "p1",
      explicit: false,
    });
  });

  it("holds at nothing when the newly staged steps are still looking up", () => {
    // Not a regression to the old behaviour: the player must not be presented
    // (its chips would be unanswerable), and neither can a pending step be.
    const onPlayer = { rowId: "p1", explicit: false };
    const after = [player("p1"), careerTeamOf("t1", "p1", "pending")];
    expect(resolveNav(after, onPlayer)).toEqual({ rowId: null, explicit: false });
  });

  it("still lets the operator pin a blocked player explicitly", () => {
    // Back / "Change decision" reaches a row the walk would not offer. It has
    // to stay put: its own step is where an unanswerable career team gets
    // unticked.
    const rows = [player("p1"), careerTeamOf("t1", "p1")];
    const nav = { rowId: "p1", explicit: true };
    expect(resolveNav(rows, nav)).toBe(nav);
  });
});

describe("counting", () => {
  it("counts decided rows regardless of status", () => {
    const rows = [
      row("a", "ready", { action: "create" }),
      row("b", "pending", { action: "skip" }),
      row("c", "ready"),
    ];
    expect(countDecided(rows)).toBe(2);
  });

  it("counts only pending rows that are still undecided", () => {
    // A bulk skip CAN decide a pending row, and once it has, that row is no
    // longer something the operator is waiting on.
    const rows = [
      row("a", "pending"),
      row("b", "pending", { action: "skip" }),
      row("c", "ready"),
    ];
    expect(countPendingUndecided(rows)).toBe(1);
  });

  it("splits the summary three ways", () => {
    const rows = [
      row("a", "ready", { action: "create" }),
      row("b", "ready", { action: "link", linkedPlayerId: "p1" }),
      row("c", "ready", { action: "link", linkedTeamId: "t1" }),
      row("d", "ready", { action: "skip" }),
      row("e", "ready"),
    ];
    expect(summarizeDecisions(rows)).toEqual({ created: 1, linked: 2, skipped: 1 });
  });

  it("summarizes an empty batch as all zeros", () => {
    expect(summarizeDecisions([])).toEqual({ created: 0, linked: 0, skipped: 0 });
  });
});

describe("resolveNav — walking forward", () => {
  it("picks the first settled undecided row when nothing is presented", () => {
    const rows = [row("a", "pending"), row("b")];
    expect(resolveNav(rows, { rowId: null, explicit: false })).toEqual({
      rowId: "b",
      explicit: false,
    });
  });

  it("advances off an implicitly-presented row once it is decided", () => {
    const rows = [row("a", "ready", { action: "create" }), row("b")];
    expect(resolveNav(rows, { rowId: "a", explicit: false })).toEqual({
      rowId: "b",
      explicit: false,
    });
  });

  it("goes to null when the last row is decided", () => {
    const rows = [row("a", "ready", { action: "create" })];
    expect(resolveNav(rows, { rowId: "a", explicit: false })).toEqual({
      rowId: null,
      explicit: false,
    });
  });

  it("advances when the presented row vanishes from the batch", () => {
    // A resume reconciliation (D11) drops rows whose names are no longer in the
    // incoming set, and the abandoned-batch sweep deletes them outright.
    const rows = [row("b")];
    expect(resolveNav(rows, { rowId: "gone", explicit: false })).toEqual({
      rowId: "b",
      explicit: false,
    });
  });

  it("advances even from an EXPLICIT row once that row is gone", () => {
    // Pinning cannot survive the row itself being deleted — there is nothing
    // left to present.
    const rows = [row("b")];
    expect(resolveNav(rows, { rowId: "gone", explicit: true })).toEqual({
      rowId: "b",
      explicit: false,
    });
  });
});

describe("resolveNav — holding still", () => {
  it("does not move when the presented row is undecided", () => {
    const rows = [row("a"), row("b")];
    const nav = { rowId: "a", explicit: false };
    expect(resolveNav(rows, nav)).toBe(nav);
  });

  it("does not move when a SIBLING row's lookup lands first", () => {
    // The reordering defect: `a` settling used to make it the new `find` hit
    // and swap the row out from under the operator reading `b`.
    const before = [row("a", "pending"), row("b", "ready")];
    const nav = resolveNav(before, { rowId: null, explicit: false });
    expect(nav.rowId).toBe("b");

    const after = [row("a", "ready"), row("b", "ready")];
    expect(resolveNav(after, nav)).toBe(nav);
  });

  it("holds an EXPLICIT row even after it carries a decision", () => {
    // This is Back / "Change": the operator asked to see this row, so the
    // read-only panel keeps rendering until they ask for something else.
    const rows = [row("a", "ready", { action: "create" }), row("b")];
    const nav = { rowId: "a", explicit: true };
    expect(resolveNav(rows, nav)).toBe(nav);
  });

  it("holds an EXPLICIT undecided row rather than jumping to an earlier one", () => {
    const rows = [row("a"), row("b")];
    const nav = { rowId: "b", explicit: true };
    expect(resolveNav(rows, nav)).toBe(nav);
  });

  it("is a fixed point when there is nothing left to present", () => {
    // The loop guard: null in, null out, SAME object — the effect bails.
    const nav = { rowId: null, explicit: false };
    expect(resolveNav([], nav)).toBe(nav);
    expect(resolveNav([row("a", "ready", { action: "skip" })], nav)).toBe(nav);
  });

  it("is a fixed point while every row is still pending", () => {
    const nav = { rowId: null, explicit: false };
    expect(resolveNav([row("a", "pending")], nav)).toBe(nav);
  });
});

describe("describeDecision", () => {
  it("reads each decision in the past tense", () => {
    expect(describeDecision({ action: "create" })).toBe("Added as new");
    expect(describeDecision({ action: "skip" })).toBe("Skipped");
    expect(describeDecision({ action: "link", linkedPlayerId: "p1" }, "Mike Trout")).toBe(
      "Linked to Mike Trout",
    );
  });

  it("never produces the live control's 'Link to {name}' accessible name", () => {
    // Two things sharing that string is ambiguous to a screen reader reading
    // the list, and to a Maestro `tapOn` matching by it.
    const text = describeDecision({ action: "link", linkedTeamId: "t1" }, "New York Yankees");
    expect(text).not.toContain("Link to New York Yankees");
    expect(text).toBe("Linked to New York Yankees");
  });

  it("falls back when the linked row's name has not resolved yet", () => {
    expect(describeDecision({ action: "link", linkedPlayerId: "p1" })).toBe(
      "Linked to an existing record",
    );
  });

  it("describes an undecided row", () => {
    expect(describeDecision(undefined)).toBe("Not yet decided");
    expect(describeDecision(null)).toBe("Not yet decided");
  });
});

describe("resolveNav — a blocker staged under ANOTHER player still blocks", () => {
  /**
   * Jason, 2026-09-06, on a 522-row hockey batch: the wizard presented "Guy
   * Lafleur" with three chips reading "needs a team decision" and no step
   * anywhere to answer them — "There does not appear to be anywhere that a
   * decision is needed that I can see."
   *
   * Staging dedupes a career team across the WHOLE batch, so in a set full of
   * NHL players the first player to name the Montreal Canadiens gets the step
   * and every later one gets none. The blocker rule keyed on
   * `source.playerRowId`, so it saw no blocker for Lafleur and let him through;
   * the chip keyed on the name across the batch, so it correctly reported the
   * step as unanswered. Two different keys for one question.
   *
   * The answer is the TEAM, identified by its name — whose lookup happened to
   * raise the step is not part of it.
   */
  const playerWithCareer = (id: string, teams: string[]): NavRow => ({
    _id: id,
    status: "ready",
    kind: "player",
    enrichment: { careerTeams: teams.map((name) => ({ name })) },
  });

  it("holds a player whose career team was staged for someone else", () => {
    const rows = [
      // Staged while an EARLIER player was looked up — so it points at THEM,
      // and only its name ties it to Lafleur.
      { ...careerTeamOf("t-habs", "p-earlier"), name: "Montreal Canadiens" },
      playerWithCareer("p-lafleur", ["Montreal Canadiens"]),
    ];
    expect(nextUndecided(rows)?._id).toBe("t-habs");
    expect(
      resolveNav(rows, { rowId: "p-lafleur", explicit: false }),
    ).toEqual({ rowId: "t-habs", explicit: false });
  });

  it("releases the player once that shared step is answered", () => {
    const rows = [
      {
        ...careerTeamOf("t-habs", "p-earlier", "ready", { action: "create" }),
        name: "Montreal Canadiens",
      },
      playerWithCareer("p-lafleur", ["Montreal Canadiens"]),
    ];
    expect(nextUndecided(rows)?._id).toBe("p-lafleur");
  });

  it("matches the label the way the rest of the wizard does, not byte-for-byte", () => {
    const rows = [
      { ...careerTeamOf("t-habs", "p-earlier"), name: "montreal  canadiens" },
      playerWithCareer("p-lafleur", ["Montreal Canadiens"]),
    ];
    expect(nextUndecided(rows)?._id).toBe("t-habs");
  });

  it("walks four staged clubs before their player, then the player", () => {
    // Deciding one step must land on the NEXT step, never on the player.
    const clubs = ["Quebec Remparts", "Montreal Canadiens", "New York Rangers", "Quebec Nordiques"];
    const staged = clubs.map((n, i) => ({
      ...careerTeamOf(`t-${i}`, "p-lafleur"),
      name: n,
    }));
    const player = playerWithCareer("p-lafleur", clubs);

    let rows: NavRow[] = [...staged, player];
    expect(nextUndecided(rows)?._id).toBe("t-0");

    // t-0 answered — the walk must go to t-1, not to the player.
    rows = [
      { ...staged[0], decision: { action: "create" } },
      ...staged.slice(1),
      player,
    ];
    expect(
      resolveNav(rows, { rowId: "t-0", explicit: false })?.rowId,
    ).toBe("t-1");
  });
});
