/**
 * The sync banner's line while names wait in the review wizard.
 *
 * NEO-335 Phase 2 (Jason, 2026-10-10): one count, no per-type counts. It
 * replaced NEO-332's "N new players + N new teams need confirmation · N to
 * pick from the roster": new players, new teams and same-name picks are all
 * names that need a look, so they are one number. `entityConfirmationMessage`
 * is pure.
 */

import { describe, expect, it } from "vitest";
import { entityConfirmationMessage } from "./CardChecklist";

describe("entityConfirmationMessage", () => {
  it("counts players and teams as one number of names", () => {
    expect(entityConfirmationMessage(["A", "B"], ["T"])).toBe(
      "3 names need a look before this saves.",
    );
    expect(entityConfirmationMessage([], ["T", "U"])).toBe(
      "2 names need a look before this saves.",
    );
  });

  it("is singular for one name, player or team", () => {
    expect(entityConfirmationMessage(["A"], [])).toBe("1 name needs a look before this saves.");
    expect(entityConfirmationMessage([], ["T"])).toBe("1 name needs a look before this saves.");
  });

  it("counts a same-name pick (NEO-332) as a name like any other — no tail of its own", () => {
    // An ambiguous player is in `unknownPlayers` too; it is not counted twice
    // and it gets no separate "to pick from the roster" clause.
    const line = entityConfirmationMessage(["Bob Allen", "New Guy"], ["T"]);
    expect(line).toBe("3 names need a look before this saves.");
    expect(line).not.toMatch(/roster|new players|new teams|confirmation/);
  });

  it("says zero plainly rather than in per-type zeros", () => {
    expect(entityConfirmationMessage([], [])).toBe("0 names need a look before this saves.");
  });
});
