/**
 * NEO-220 — the number the reconciliation discard confirm shows.
 *
 * The interesting case is the first one: a restored session opens with a full
 * Ready column and has still done nothing, so a counter would be wrong here
 * where a diff is right.
 */

import { describe, expect, test } from "vitest";
import {
  countReconciliationEdits,
  type ReconciliationEditSet,
  type ReconciliationEditState,
} from "./reconciliation-edits";

const item = (platformValue: string) => ({ platformValue });

const set = (
  key: string,
  title: string,
  bsc: string[] = [],
  sl: string[] = [],
  metadata?: Record<string, unknown>,
): ReconciliationEditSet => ({
  key,
  title,
  bsc: bsc.map(item),
  sl: sl.map(item),
  ...(metadata ? { metadata } : {}),
});

const st = (...ready: ReconciliationEditSet[]): ReconciliationEditState => ({
  ready,
});

describe("countReconciliationEdits", () => {
  test("a session restored from existing rows starts clean", () => {
    const seeded = st(
      set("k1", "Refractors", ["b1"], ["s1"]),
      set("k2", "Gold", ["b2"], []),
    );
    expect(countReconciliationEdits(seeded, seeded)).toBe(0);
  });

  test("counts each newly promoted set", () => {
    const before = st(set("k1", "Refractors"));
    const after = st(set("k1", "Refractors"), set("k2", "Gold"), set("k3", "Black"));
    expect(countReconciliationEdits(before, after)).toBe(2);
  });

  test("counts a disbanded set", () => {
    const before = st(set("k1", "Refractors"), set("k2", "Gold"));
    expect(countReconciliationEdits(before, st(set("k1", "Refractors")))).toBe(1);
  });

  /**
   * Keyed on `key`, not `title`: the title is the operator's to edit, and a
   * title-keyed diff would read one rename as a disband plus a promote.
   */
  test("a rename is one edit, not a disband plus a promote", () => {
    const before = st(set("k1", "Refractors"));
    const after = st(set("k1", "Refractors 1st Edition"));
    expect(countReconciliationEdits(before, after)).toBe(1);
  });

  test("counts attached and detached marketplace ids one at a time", () => {
    const before = st(set("k1", "Refractors", ["b1"], ["s1"]));
    // b1 detached, b2 + b3 attached, sl side gains one.
    const after = st(set("k1", "Refractors", ["b2", "b3"], ["s1", "s2"]));
    expect(countReconciliationEdits(before, after)).toBe(4);
  });

  test("id order is not an edit", () => {
    const before = st(set("k1", "Refractors", ["b1", "b2"], []));
    const after = st(set("k1", "Refractors", ["b2", "b1"], []));
    expect(countReconciliationEdits(before, after)).toBe(0);
  });

  test("counts a metadata change", () => {
    const before = st(set("k1", "Refractors", [], [], { isInsert: false }));
    const after = st(set("k1", "Refractors", [], [], { isInsert: true }));
    expect(countReconciliationEdits(before, after)).toBe(1);
  });

  test("an undefined metadata field is not a change", () => {
    const before = st(set("k1", "Refractors", [], [], { isInsert: true }));
    const after = st(set("k1", "Refractors", [], [], {
      isInsert: true,
      isParallel: undefined,
    }));
    expect(countReconciliationEdits(before, after)).toBe(0);
  });

  test("promote then disband returns to zero", () => {
    const before = st(set("k1", "Refractors"));
    const after = st(set("k1", "Refractors"));
    expect(countReconciliationEdits(before, after)).toBe(0);
  });

  test("sums across kinds", () => {
    const before = st(
      set("k1", "Refractors", ["b1"], ["s1"]),
      set("k2", "Gold", [], []),
    );
    const after = st(
      set("k1", "Refractors 1st", ["b1", "b9"], ["s1"]), // rename + attach
      set("k3", "Black", ["b3"], []), // promote
    );
    // rename 1 + attach 1 + disband k2 1 + promote k3 1
    expect(countReconciliationEdits(before, after)).toBe(4);
  });
});
