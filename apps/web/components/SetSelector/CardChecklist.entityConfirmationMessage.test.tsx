/**
 * NEO-332 — the sync banner's count of names waiting in the review wizard.
 *
 * `entityConfirmationMessage` is pure. With nothing ambiguous it must stay
 * byte-for-byte what it has always been (zeros included), because Maestro
 * flows and CardChecklist.test.tsx match that sentence. With something
 * ambiguous the zero parts drop out and the ambiguous names get their own tail.
 */

import { describe, expect, it } from "vitest";
import { entityConfirmationMessage } from "./CardChecklist";

describe("entityConfirmationMessage", () => {
  it("keeps the old template byte-exact when nothing is ambiguous", () => {
    expect(entityConfirmationMessage(["A"], [])).toBe(
      "1 new players + 0 new teams need confirmation",
    );
    expect(entityConfirmationMessage(["A", "B"], ["T"], [])).toBe(
      "2 new players + 1 new teams need confirmation",
    );
    expect(entityConfirmationMessage([], [])).toBe(
      "0 new players + 0 new teams need confirmation",
    );
  });

  it("ignores an ambiguous name that is not among the unknown players", () => {
    expect(entityConfirmationMessage(["A"], [], ["Z"])).toBe(
      "1 new players + 0 new teams need confirmation",
    );
  });

  it("splits new players, new teams and the pick tail when all are present", () => {
    expect(entityConfirmationMessage(["A", "B", "C"], ["T"], ["C"])).toBe(
      "2 new players + 1 new teams need confirmation · 1 to pick from the roster",
    );
  });

  it("leaves out the teams part when there are none", () => {
    expect(entityConfirmationMessage(["A", "B"], [], ["B"])).toBe(
      "1 new players need confirmation · 1 to pick from the roster",
    );
  });

  it("leaves out the players part when every player is a pick", () => {
    expect(entityConfirmationMessage(["A", "B"], ["T"], ["A", "B"])).toBe(
      "1 new teams need confirmation · 2 to pick from the roster",
    );
  });

  it("reads as the tail alone when the only open names are ambiguous", () => {
    expect(entityConfirmationMessage(["A"], [], ["A"])).toBe(
      "1 to pick from the roster",
    );
  });
});
