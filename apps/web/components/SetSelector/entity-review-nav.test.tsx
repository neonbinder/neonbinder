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
