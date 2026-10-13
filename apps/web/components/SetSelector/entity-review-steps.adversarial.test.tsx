/**
 * NEO-335 Phase 2 — adversarial pass over the step counter: y never shrinks,
 * freezes on Save, thaws with its growth counted, and announces what grew.
 * `.test.tsx` because `.test.ts` is not collected under components/.
 */
import { describe, expect, it } from "vitest";
import {
  advanceStepCount,
  growthLine,
  growthReasons,
  initialStepCount,
  nextPostReviewStep,
  previousPostReviewStep,
  resolvePostReviewStep,
  stepNumber,
  trackSteps,
  type StepRow,
  type StepTracker,
} from "./entity-review-steps";

const rowOf = (id: string, name = id, source?: StepRow["source"]): StepRow =>
  ({ _id: id, kind: "team", name, source }) as StepRow;
const input = (rows: StepRow[], teamsStep = false, titlesStep = false, onSave = false) => ({
  rows,
  teamsStep,
  titlesStep,
  onSave,
});

describe("y never shrinks", () => {
  it("whatever sequence of inputs, total is non-decreasing", () => {
    let count = initialStepCount({ reviewRows: 3, teamsStep: true, titlesStep: false });
    let last = count.total;
    const seq = [
      { reviewRows: 0, teamsStep: false, titlesStep: false },
      { reviewRows: 5, teamsStep: false, titlesStep: true },
      { reviewRows: 1, teamsStep: false, titlesStep: false },
      { reviewRows: 5, teamsStep: true, titlesStep: true },
      { reviewRows: 2, teamsStep: false, titlesStep: false },
    ];
    for (const s of seq) {
      count = advanceStepCount(count, s, false).count;
      expect(count.total).toBeGreaterThanOrEqual(last);
      last = count.total;
    }
    expect(count.total).toBe(5 + 1 + 1 + 1);
  });

  it("a negative or zero review-row count cannot push y below 1", () => {
    expect(initialStepCount({ reviewRows: -4, teamsStep: false, titlesStep: false }).total).toBe(1);
  });

  it("trackSteps with every row removed keeps y and announces nothing", () => {
    const t0 = trackSteps(null, input([rowOf("a"), rowOf("b")]));
    const t1 = trackSteps(t0, input([]));
    expect(t1.count.total).toBe(t0.count.total);
    expect(t1.growth).toBeNull();
  });

  it("x for Save is always y, however the flags climbed", () => {
    let count = initialStepCount({ reviewRows: 1, teamsStep: false, titlesStep: false });
    count = advanceStepCount(count, { reviewRows: 4, teamsStep: true, titlesStep: true }, false).count;
    expect(stepNumber(count, { kind: "save" })).toBe(count.total);
    expect(stepNumber(count, { kind: "titles" })).toBe(count.total - 1);
    expect(stepNumber(count, { kind: "teams" })).toBe(count.total - 2);
  });
});

describe("frozen on Save", () => {
  it("opening straight on Save counts everything present and then ignores growth", () => {
    const t0 = trackSteps(null, input([rowOf("a")], true, false, true));
    expect(t0.count.frozen).toBe(true);
    expect(t0.count.total).toBe(3);
    const t1 = trackSteps(t0, input([rowOf("a"), rowOf("b"), rowOf("c")], true, true, true));
    expect(t1).toBe(t0);
  });

  it("growth during Save is announced once, on thaw, with the right count", () => {
    const t0 = trackSteps(null, input([rowOf("a")], false, false, false));
    const onSave = trackSteps(t0, input([rowOf("a")], false, false, true));
    const during = trackSteps(onSave, input([rowOf("a"), rowOf("b", "Jim Thome")], true, true, true));
    expect(during.count.total).toBe(onSave.count.total);
    expect(during.growth).toBeNull();
    const thawed = trackSteps(during, input([rowOf("a"), rowOf("b", "Jim Thome")], true, true, false));
    expect(thawed.count.total).toBe(5);
    expect(thawed.growth?.text).toMatch(/^3 more steps: /);
    expect(thawed.growth?.seq).toBe(1);
    // and then it is quiet again
    expect(trackSteps(thawed, input([rowOf("a"), rowOf("b")], true, true, false))).toBe(thawed);
  });

  it("thawing with nothing new announces nothing and does not bump seq", () => {
    const t0 = trackSteps(null, input([rowOf("a")]));
    const frozen = trackSteps(t0, input([rowOf("a")], false, false, true));
    const thawed = trackSteps(frozen, input([rowOf("a")], false, false, false));
    expect(thawed.growth).toBeNull();
    expect(thawed.count.frozen).toBe(false);
  });

  it("the move onto Save with growth arriving the same instant adds nothing", () => {
    const prev = initialStepCount({ reviewRows: 1, teamsStep: false, titlesStep: false });
    const { count, added } = advanceStepCount(prev, { reviewRows: 9, teamsStep: true, titlesStep: true }, true);
    expect(added).toBe(0);
    expect(count.total).toBe(prev.total);
    expect(count.frozen).toBe(true);
  });
});

describe("growth announcements", () => {
  const player = rowOf("p1", "Jim Thome");
  const career = (id: string, of: string) =>
    ({ _id: id, kind: "team", name: id, source: { kind: "careerTeamOf", playerRowId: of } }) as StepRow;

  it("two staged career teams for one player: '2 more steps: teams for Jim Thome'", () => {
    const t0 = trackSteps(null, input([player]));
    const t1 = trackSteps(t0, input([player, career("t1", "p1"), career("t2", "p1")]));
    expect(t1.growth?.text).toBe("2 more steps: teams for Jim Thome");
  });

  it("one staged step is singular", () => {
    const t0 = trackSteps(null, input([player]));
    const t1 = trackSteps(t0, input([player, career("t1", "p1")]));
    expect(t1.growth?.text).toBe("1 more step: teams for Jim Thome");
  });

  it("a staged career team whose player row is missing falls back to 'more names', never 'undefined'", () => {
    const text = growthReasons({
      addedRows: [career("t1", "ghost")],
      allRows: [career("t1", "ghost")],
      teamsStepAdded: false,
      titlesStepAdded: false,
    });
    expect(text).toEqual(["more names"]);
  });

  it("a player with an empty name does not produce 'teams for '", () => {
    const blank = rowOf("p2", "");
    const reasons = growthReasons({
      addedRows: [career("t1", "p2")],
      allRows: [blank, career("t1", "p2")],
      teamsStepAdded: false,
      titlesStepAdded: false,
    });
    expect(reasons.join()).not.toMatch(/teams for\s*$/);
  });

  it("the same player twice is named once; three players read 'A, B and C'", () => {
    const rows = [rowOf("a", "A"), rowOf("b", "B"), rowOf("c", "C")];
    const reasons = growthReasons({
      addedRows: [career("t1", "a"), career("t2", "a"), career("t3", "b"), career("t4", "c")],
      allRows: [...rows],
      teamsStepAdded: true,
      titlesStepAdded: true,
    });
    expect(reasons).toEqual(["teams for A, B and C", "cards with no team", "card titles"]);
  });

  it("growthLine with no reasons is just the count", () => {
    expect(growthLine(1, [])).toBe("1 more step");
    expect(growthLine(0, [])).toBe("0 more steps");
  });

  it("the teams step and the titles step appearing together are two steps with both reasons", () => {
    const t0: StepTracker = trackSteps(null, input([player]));
    const t1 = trackSteps(t0, input([player], true, true));
    expect(t1.growth?.text).toBe("2 more steps: cards with no team, card titles");
  });

  it("each growth bumps seq so two identical lines are distinguishable", () => {
    const t0 = trackSteps(null, input([player]));
    const t1 = trackSteps(t0, input([player, career("t1", "p1")]));
    const t2 = trackSteps(t1, input([player, career("t1", "p1"), career("t2", "p1")]));
    expect(t1.growth?.text).toBe(t2.growth?.text);
    expect(t2.growth!.seq).toBe(t1.growth!.seq + 1);
  });
});

describe("walking past empty steps", () => {
  it("nothing live: every request lands on Save, and Back from Save leaves for the names", () => {
    const live = { teams: false, titles: false };
    expect(resolvePostReviewStep("teams", live)).toBe("save");
    expect(resolvePostReviewStep("titles", live)).toBe("save");
    expect(previousPostReviewStep("save", live)).toBeNull();
    expect(nextPostReviewStep("save", live)).toBeNull();
  });

  it("titles live but teams not: Back from Save stops on titles, and from titles leaves", () => {
    const live = { teams: false, titles: true };
    expect(previousPostReviewStep("save", live)).toBe("titles");
    expect(previousPostReviewStep("titles", live)).toBeNull();
  });
});
