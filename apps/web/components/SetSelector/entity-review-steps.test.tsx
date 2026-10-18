/**
 * NEO-335 Phase 2 — the pure step model behind "Step x of y".
 *
 * (`.test.tsx` although it renders nothing: the components project only
 * collects `.test.tsx` under components/.)
 */
import { describe, expect, it } from "vitest";
import {
  advanceStepCount,
  asAutographFormat,
  AUTOGRAPH_GROWTH_REASON,
  autographCardIndexes,
  carriesAutograph,
  cardsForTeamsStep,
  growthLine,
  growthReasons,
  initialStepCount,
  nextPostReviewStep,
  plannedTotal,
  previousPostReviewStep,
  resolvePostReviewStep,
  reviewStepIndex,
  reviewStepKind,
  STEP_SUBTITLE,
  stepNumber,
  trackSteps,
  upcomingReviewStepKind,
  type StepRow,
} from "./entity-review-steps";
import type { NavRow } from "./entity-review-nav";
import { storedPeople, type TeamsReviewRow } from "./teams-on-cards";

const plan = (reviewRows: number, teamsStep = false, titlesStep = false) => ({
  reviewRows,
  teamsStep,
  titlesStep,
});

describe("plannedTotal — y = review rows + teams? + titles? + save", () => {
  it("counts each part", () => {
    expect(plannedTotal(plan(0))).toBe(1);
    expect(plannedTotal(plan(5))).toBe(6);
    expect(plannedTotal(plan(5, true))).toBe(7);
    expect(plannedTotal(plan(5, true, true))).toBe(8);
    expect(plannedTotal(plan(5, false, true))).toBe(7);
  });

  it("teams-only is two steps: teams, then Save", () => {
    expect(plannedTotal(plan(0, true))).toBe(2);
    const count = initialStepCount(plan(0, true));
    expect(stepNumber(count, { kind: "teams" })).toBe(1);
    expect(stepNumber(count, { kind: "save" })).toBe(2);
  });

  it("counts a NEO-332 pick step as a review row like any other", () => {
    // A same-name player is ONE row whatever screen it opens on.
    const rows: NavRow[] = [
      { _id: "a", status: "ready", kind: "player", enrichment: { existingCandidates: [1, 2] } },
      { _id: "b", status: "ready", kind: "player" },
    ];
    expect(plannedTotal(plan(rows.length))).toBe(3);
    expect(reviewStepKind(rows[0], { pick: true })).toBe("pick");
    expect(STEP_SUBTITLE[reviewStepKind(rows[0], { pick: true })]).toBe("Which player is this?");
  });
});

describe("advanceStepCount — grows, never shrinks, freezes on Save", () => {
  it("grows when staged rows arrive and reports how many", () => {
    const start = initialStepCount(plan(3));
    const { count, added } = advanceStepCount(start, plan(5), false);
    expect(count.total).toBe(6);
    expect(added).toBe(2);
  });

  it("never shrinks: fewer rows, a teams step gone, a titles step gone", () => {
    const start = initialStepCount(plan(4, true, true)); // 7
    const shrunk = advanceStepCount(start, plan(2, false, false), false);
    expect(shrunk.count).toBe(start); // same object: nothing moved
    expect(shrunk.added).toBe(0);
    expect(shrunk.count.total).toBe(7);
  });

  it("returns the same object when nothing changed", () => {
    const start = initialStepCount(plan(3, true));
    expect(advanceStepCount(start, plan(3, true), false).count).toBe(start);
  });

  it("adds the teams step once, and keeps it", () => {
    const start = initialStepCount(plan(3));
    const grown = advanceStepCount(start, plan(3, true), false);
    expect(grown.added).toBe(1);
    expect(grown.count.teamsStep).toBe(true);
    const later = advanceStepCount(grown.count, plan(3, false), false);
    expect(later.count.teamsStep).toBe(true);
    expect(later.count.total).toBe(5);
  });

  it("adds nothing once on Save, and nothing on the move onto Save", () => {
    const start = initialStepCount(plan(3)); // 4
    const onSave = advanceStepCount(start, plan(5, true, true), true);
    expect(onSave.added).toBe(0);
    expect(onSave.count.total).toBe(4);
    expect(onSave.count.frozen).toBe(true);
    // Still on Save: still nothing.
    const still = advanceStepCount(onSave.count, plan(9, true, true), true);
    expect(still.count).toBe(onSave.count);
  });

  it("thaws when the operator leaves Save, and only then counts what turned up", () => {
    const frozen = advanceStepCount(initialStepCount(plan(3)), plan(3), true).count;
    const left = advanceStepCount(frozen, plan(3, false, true), false);
    expect(left.count.frozen).toBe(false);
    expect(left.added).toBe(1);
    expect(left.count.titlesStep).toBe(true);
  });
});

describe("stepNumber — x", () => {
  it("review steps are 1-based by index, capped at the last review step", () => {
    const count = initialStepCount(plan(3, true));
    expect(stepNumber(count, { kind: "review", index: 0 })).toBe(1);
    expect(stepNumber(count, { kind: "review", index: 2 })).toBe(3);
    expect(stepNumber(count, { kind: "review", index: 9 })).toBe(3);
  });

  it("post-review steps count back from y, so Save is always y of y", () => {
    const count = initialStepCount(plan(3, true, true)); // 6
    expect(stepNumber(count, { kind: "teams" })).toBe(4);
    expect(stepNumber(count, { kind: "titles" })).toBe(5);
    expect(stepNumber(count, { kind: "save" })).toBe(6);
  });

  it("titles without teams sits right before Save", () => {
    const count = initialStepCount(plan(2, false, true)); // 4
    expect(stepNumber(count, { kind: "titles" })).toBe(3);
    expect(stepNumber(count, { kind: "save" })).toBe(4);
  });
});

describe("reviewStepIndex", () => {
  const rows = [
    { _id: "a", decision: { action: "create" as const } },
    { _id: "b", decision: null },
    { _id: "c", decision: { action: "skip" as const } },
    { _id: "d", decision: null },
  ];

  it("an undecided row is next after every decided one", () => {
    expect(reviewStepIndex(rows, "b")).toBe(2);
    expect(reviewStepIndex(rows, "d")).toBe(2);
  });

  it("a decided row read back sits at its place among the decided", () => {
    expect(reviewStepIndex(rows, "a")).toBe(0);
    expect(reviewStepIndex(rows, "c")).toBe(1);
  });

  it("with nothing on screen, the next step to come", () => {
    expect(reviewStepIndex(rows, null)).toBe(2);
    expect(reviewStepIndex([], null)).toBe(0);
  });
});

describe("subtitles", () => {
  it("are the approved copy per screen type", () => {
    expect(STEP_SUBTITLE).toEqual({
      league: "New league",
      team: "New team",
      player: "New player",
      pick: "Which player is this?",
      teams: "Cards with no team",
      // NEO-345 — placeholder, awaiting Jason's wording.
      autograph: "Autographed cards",
      titles: "Card titles",
      save: "Ready to save",
    });
  });

  it("follow the row's kind", () => {
    expect(reviewStepKind({ kind: "league" })).toBe("league");
    expect(reviewStepKind({ kind: "team" })).toBe("team");
    expect(reviewStepKind({ kind: "player" })).toBe("player");
    expect(reviewStepKind({ kind: "player" }, { pick: true })).toBe("pick");
    // `pick` means nothing on a team.
    expect(reviewStepKind({ kind: "team" }, { pick: true })).toBe("team");
  });

  it("while nothing is on screen, name the step the walk reaches next", () => {
    expect(
      upcomingReviewStepKind([
        { _id: "p", status: "pending", kind: "player" },
        { _id: "t", status: "pending", kind: "team" },
      ]),
    ).toBe("team");
    expect(
      upcomingReviewStepKind([
        { _id: "p", status: "pending", kind: "player", enrichment: { existingCandidates: [1, 2] } },
      ]),
    ).toBe("pick");
    expect(upcomingReviewStepKind([{ _id: "x", status: "ready", decision: { action: "skip" } }])).toBe(
      null,
    );
  });
});

describe("cardsForTeamsStep — optimistic while names are open", () => {
  const cards = [
    { cardNumber: "1", cardName: "A", players: ["Pete Rose"], teams: ["Reds"] },
    { cardNumber: "2", cardName: "B", players: ["Johnny Bench"] },
  ];
  const teamRow = (decision: TeamsReviewRow["decision"]): TeamsReviewRow => ({
    _id: "t",
    kind: "team",
    name: "Reds",
    decision,
  });

  it("assumes an undecided team name resolves", () => {
    expect(cardsForTeamsStep(cards, [teamRow(null)])).toEqual([1]);
  });

  it("counts the card once the operator skips the team name", () => {
    expect(cardsForTeamsStep(cards, [teamRow({ action: "skip" })])).toEqual([0, 1]);
  });

  it("leaves out settled positions", () => {
    expect(cardsForTeamsStep(cards, [teamRow({ action: "skip" })], [1])).toEqual([0]);
  });

  it("counts a card from the start when an earlier save skipped its only team name", () => {
    // NEO-335: a re-sync has no row for a name the set's skip records rule
    // out (the gate drops it), so the record is what says it is no team.
    const people = storedPeople(undefined, undefined, ["Reds"]);
    expect(cardsForTeamsStep(cards, [], undefined, people)).toEqual([0, 1]);
    // An undecided row in this sitting outranks the record, and is still
    // assumed to resolve.
    expect(cardsForTeamsStep(cards, [teamRow(null)], undefined, people)).toEqual([1]);
  });
});

describe("post-review navigation", () => {
  const all = { teams: true, titles: true };
  const none = { teams: false, titles: false };

  it("starts at the first step with something in it", () => {
    expect(resolvePostReviewStep(null, all)).toBe("teams");
    expect(resolvePostReviewStep(null, { teams: false, titles: true })).toBe("titles");
    expect(resolvePostReviewStep(null, none)).toBe("save");
  });

  it("passes over an empty step forwards", () => {
    expect(resolvePostReviewStep("teams", { teams: false, titles: true })).toBe("titles");
    expect(resolvePostReviewStep("titles", none)).toBe("save");
  });

  it("Next walks teams → titles → save", () => {
    expect(nextPostReviewStep("teams", all)).toBe("titles");
    expect(nextPostReviewStep("teams", { teams: true, titles: false })).toBe("save");
    expect(nextPostReviewStep("titles", all)).toBe("save");
    expect(nextPostReviewStep("save", all)).toBeNull();
  });

  it("Back walks save → titles → teams → out to the names", () => {
    expect(previousPostReviewStep("save", all)).toBe("titles");
    expect(previousPostReviewStep("save", { teams: true, titles: false })).toBe("teams");
    expect(previousPostReviewStep("titles", all)).toBe("teams");
    expect(previousPostReviewStep("teams", all)).toBeNull();
    expect(previousPostReviewStep("save", none)).toBeNull();
  });
});

describe("growth line", () => {
  it("is the approved copy, singular and plural", () => {
    expect(growthLine(2, ["teams for Jim Thome"])).toBe("2 more steps: teams for Jim Thome");
    expect(growthLine(1, ["teams for Jim Thome"])).toBe("1 more step: teams for Jim Thome");
  });

  it("names the player whose career teams were staged", () => {
    const player: StepRow = { _id: "p", kind: "player", name: "Jim Thome" };
    const staged: StepRow[] = [
      { _id: "t1", kind: "team", name: "Cleveland Indians", source: { kind: "careerTeamOf", playerRowId: "p" } },
      { _id: "t2", kind: "team", name: "Philadelphia Phillies", source: { kind: "careerTeamOf", playerRowId: "p" } },
    ];
    expect(
      growthReasons({
        addedRows: staged,
        allRows: [...staged, player],
        teamsStepAdded: false,
        titlesStepAdded: false,
      }),
    ).toEqual(["teams for Jim Thome"]);
  });

  it("joins several players, and names the other kinds of growth", () => {
    const rows: StepRow[] = [
      { _id: "p1", kind: "player", name: "A" },
      { _id: "p2", kind: "player", name: "B" },
      { _id: "tm", kind: "team", name: "Sydney Blue Sox" },
      { _id: "t1", kind: "team", name: "X", source: { kind: "careerTeamOf", playerRowId: "p1" } },
      { _id: "t2", kind: "team", name: "Y", source: { kind: "careerTeamOf", playerRowId: "p2" } },
      { _id: "l1", kind: "league", name: "ABL", source: { kind: "leagueOf", teamRowId: "tm" } },
    ];
    expect(
      growthReasons({
        addedRows: rows.slice(3),
        allRows: rows,
        teamsStepAdded: true,
        titlesStepAdded: true,
      }),
    ).toEqual([
      "teams for A and B",
      "league for Sydney Blue Sox",
      "cards with no team",
      "card titles",
    ]);
  });
});

describe("trackSteps — one sitting", () => {
  const player: StepRow = { _id: "p", kind: "player", name: "Jim Thome" };
  const other: StepRow = { _id: "q", kind: "player", name: "Other Guy" };

  it("starts quiet, and hands back the same object while nothing moves", () => {
    const first = trackSteps(null, { rows: [player, other], teamsStep: false, titlesStep: false, onSave: false });
    expect(first.count.total).toBe(3);
    expect(first.growth).toBeNull();
    const again = trackSteps(first, { rows: [player, other], teamsStep: false, titlesStep: false, onSave: false });
    expect(again).toBe(first);
  });

  it("announces staged career steps with the player's name", () => {
    const first = trackSteps(null, { rows: [player, other], teamsStep: false, titlesStep: false, onSave: false });
    const staged: StepRow[] = [
      { _id: "t1", kind: "team", name: "Indians", source: { kind: "careerTeamOf", playerRowId: "p" } },
      { _id: "t2", kind: "team", name: "Phillies", source: { kind: "careerTeamOf", playerRowId: "p" } },
    ];
    const grown = trackSteps(first, {
      rows: [...staged, player, other],
      teamsStep: false,
      titlesStep: false,
      onSave: false,
    });
    expect(grown.count.total).toBe(5);
    expect(grown.growth).toEqual({ seq: 1, text: "2 more steps: teams for Jim Thome" });
  });

  it("announces a teams step that appears on an operator's skip", () => {
    const first = trackSteps(null, { rows: [player], teamsStep: false, titlesStep: false, onSave: false });
    const grown = trackSteps(first, { rows: [player], teamsStep: true, titlesStep: false, onSave: false });
    expect(grown.growth?.text).toBe("1 more step: cards with no team");
    expect(grown.growth?.seq).toBe(1);
    const titles = trackSteps(grown, { rows: [player], teamsStep: true, titlesStep: true, onSave: false });
    expect(titles.growth).toEqual({ seq: 2, text: "1 more step: card titles" });
  });

  it("never shrinks and never announces a shrink", () => {
    const first = trackSteps(null, { rows: [player, other], teamsStep: true, titlesStep: false, onSave: false });
    const after = trackSteps(first, { rows: [player], teamsStep: false, titlesStep: false, onSave: false });
    expect(after).toBe(first);
    expect(after.count.total).toBe(4);
  });

  it("adds nothing on Save", () => {
    const first = trackSteps(null, { rows: [player], teamsStep: false, titlesStep: false, onSave: false });
    const onSave = trackSteps(first, { rows: [player], teamsStep: true, titlesStep: true, onSave: true });
    expect(onSave.count.total).toBe(2);
    expect(onSave.growth).toBeNull();
    const stillOnSave = trackSteps(onSave, {
      rows: [player, other],
      teamsStep: true,
      titlesStep: true,
      onSave: true,
    });
    expect(stillOnSave).toBe(onSave);
  });
});

// ---------------------------------------------------------------------------
// NEO-345 — the autograph format step
// ---------------------------------------------------------------------------

describe("autograph step — which cards it is about", () => {
  it("reads the AU attribute, case-folded and trimmed", () => {
    expect(carriesAutograph(["RC", "AU"])).toBe(true);
    expect(carriesAutograph([" au "])).toBe(true);
    expect(carriesAutograph(["AUTO"])).toBe(false);
    expect(carriesAutograph(["RC"])).toBe(false);
    expect(carriesAutograph(undefined)).toBe(false);
  });

  it("counts only cards the save will CREATE", () => {
    const cards = [
      { attributes: ["AU"] },
      { attributes: ["AU", "NUM"] },
      { attributes: ["RC"] },
      {},
      { attributes: ["au"] },
    ];
    expect(autographCardIndexes(cards)).toEqual([0, 1, 4]);
    // Position 1 re-syncs a stored row: it keeps its own features.
    expect(autographCardIndexes(cards, [1])).toEqual([0, 4]);
    expect(autographCardIndexes(cards, [0, 1, 4])).toEqual([]);
  });

  it("reads a stored value back as one of the two answers, or none", () => {
    expect(asAutographFormat("On Card")).toBe("On Card");
    expect(asAutographFormat("Sticker/Label")).toBe("Sticker/Label");
    expect(asAutographFormat("on card")).toBeUndefined();
    expect(asAutographFormat("None")).toBeUndefined();
    expect(asAutographFormat("")).toBeUndefined();
    expect(asAutographFormat(undefined)).toBeUndefined();
  });
});

describe("autograph step — counting and position", () => {
  const withAutograph = (
    reviewRows: number,
    teamsStep: boolean,
    titlesStep: boolean,
  ) => ({ reviewRows, teamsStep, autographStep: true, titlesStep });

  it("is one more step, between teams and titles", () => {
    expect(plannedTotal(withAutograph(0, false, false))).toBe(2);
    const count = initialStepCount(withAutograph(2, true, true));
    expect(count.total).toBe(6);
    expect(stepNumber(count, { kind: "review", index: 0 })).toBe(1);
    expect(stepNumber(count, { kind: "review", index: 1 })).toBe(2);
    expect(stepNumber(count, { kind: "teams" })).toBe(3);
    expect(stepNumber(count, { kind: "autograph" })).toBe(4);
    expect(stepNumber(count, { kind: "titles" })).toBe(5);
    expect(stepNumber(count, { kind: "save" })).toBe(6);
  });

  it("without teams or titles: autograph, then Save", () => {
    const count = initialStepCount(withAutograph(0, false, false));
    expect(stepNumber(count, { kind: "autograph" })).toBe(1);
    expect(stepNumber(count, { kind: "save" })).toBe(2);
  });

  it("an absent flag is no step, so older callers count as before", () => {
    expect(plannedTotal(plan(3, true, true))).toBe(6);
    expect(initialStepCount(plan(3)).autographStep).toBe(false);
  });

  it("is a high-water mark like the others", () => {
    const first = initialStepCount(withAutograph(1, false, false));
    const { count, added } = advanceStepCount(first, plan(1), false);
    expect(count).toBe(first);
    expect(added).toBe(0);
    expect(count.autographStep).toBe(true);
  });

  it("is announced when it turns up mid-sitting", () => {
    const row: StepRow = { _id: "p", kind: "player", name: "Mike Trout" };
    const first = trackSteps(null, { rows: [row], teamsStep: false, titlesStep: false, onSave: false });
    const grown = trackSteps(first, {
      rows: [row],
      teamsStep: false,
      autographStep: true,
      titlesStep: false,
      onSave: false,
    });
    expect(grown.growth?.text).toBe(`1 more step: ${AUTOGRAPH_GROWTH_REASON}`);
    expect(grown.count.total).toBe(3);
  });
});

describe("autograph step — the walk", () => {
  const all = { teams: true, autograph: true, titles: true };

  it("walks teams → autograph → titles → save", () => {
    expect(resolvePostReviewStep(null, all)).toBe("teams");
    expect(nextPostReviewStep("teams", all)).toBe("autograph");
    expect(nextPostReviewStep("autograph", all)).toBe("titles");
    expect(nextPostReviewStep("titles", all)).toBe("save");
    expect(previousPostReviewStep("save", all)).toBe("titles");
    expect(previousPostReviewStep("titles", all)).toBe("autograph");
    expect(previousPostReviewStep("autograph", all)).toBe("teams");
    expect(previousPostReviewStep("teams", all)).toBeNull();
  });

  it("is passed over when it has nothing in it", () => {
    const none = { teams: true, autograph: false, titles: true };
    expect(nextPostReviewStep("teams", none)).toBe("titles");
    expect(previousPostReviewStep("titles", none)).toBe("teams");
    // A host that knows nothing of it walks exactly as before.
    expect(nextPostReviewStep("teams", { teams: true, titles: false })).toBe("save");
  });

  it("unanswered, nothing after it can be reached", () => {
    expect(resolvePostReviewStep("titles", all, "autograph")).toBe("autograph");
    expect(resolvePostReviewStep("save", all, "autograph")).toBe("autograph");
    expect(resolvePostReviewStep("save", { teams: false, autograph: true, titles: false }, "autograph")).toBe(
      "autograph",
    );
  });

  it("unanswered, the steps BEFORE it stay reachable", () => {
    expect(resolvePostReviewStep("teams", all, "autograph")).toBe("teams");
    expect(resolvePostReviewStep(null, all, "autograph")).toBe("teams");
  });

  it("an unanswered step that is not live holds nothing back", () => {
    const none = { teams: false, autograph: false, titles: true };
    expect(resolvePostReviewStep("save", none, "autograph")).toBe("save");
  });
});
