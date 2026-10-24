import { describe, expect, it } from "vitest";
import { finishForVariant } from "./finish";

/**
 * NEO-358 — the presentational finish read from a variant's title. Best
 * effort by design (Jason, 2026-10-23): these pin the words it knows and the
 * fallbacks for the titles it does not.
 */

const parallel = (name: string, insertName: string | null = null) =>
  finishForVariant({ kind: "parallel", name, insertName });

describe("finishForVariant", () => {
  it("draws Base plain, whatever it is called", () => {
    expect(finishForVariant({ kind: "base", name: null })).toEqual({ kind: "standard" });
    expect(finishForVariant({ kind: "base", name: "Gold" })).toEqual({ kind: "standard" });
  });

  it("knows a superfractor however it is spelled", () => {
    expect(parallel("SuperFractor")).toEqual({ kind: "superfractor" });
    expect(parallel("Super Fractor")).toEqual({ kind: "superfractor" });
    expect(parallel("Superfractor Auto")).toEqual({ kind: "superfractor" });
  });

  it("draws anything gold as gold, before any colour or refractor word", () => {
    expect(parallel("Gold Refractor")).toEqual({ kind: "gold" });
    expect(parallel("Gold Zone")).toEqual({ kind: "gold" });
    expect(parallel("Rose Gold")).toEqual({ kind: "gold" });
    expect(parallel("Golden Mirror")).toEqual({ kind: "gold" });
  });

  it("tints a coloured refractor with its colour", () => {
    expect(parallel("Aqua Refractor")).toEqual({ kind: "refractor", tint: "#00E5C0" });
    expect(parallel("Red Refractor")).toEqual({ kind: "refractor", tint: "#E0242B" });
    expect(parallel("Blue Prizm")).toEqual({ kind: "refractor", tint: "#1E6BFF" });
    expect(parallel("Orange Wave")).toEqual({ kind: "refractor", tint: "#FF9E00" });
  });

  it("keeps a plain refractor untinted", () => {
    expect(parallel("Refractor")).toEqual({ kind: "refractor" });
    expect(parallel("X-Fractor")).toEqual({ kind: "refractor" });
  });

  it("draws a coloured parallel with no refractor word as a tinted foil", () => {
    expect(parallel("Red")).toEqual({ kind: "foil", tint: "#E0242B" });
    expect(parallel("Black Foil")).toEqual({ kind: "foil", tint: "#1A1A1A" });
    expect(parallel("Lava")).toEqual({ kind: "foil", tint: "#FF6A13" });
  });

  it("uses the first colour named", () => {
    expect(parallel("Red White and Blue")).toEqual({ kind: "foil", tint: "#E0242B" });
  });

  it("matches whole words only", () => {
    // "Redemption" is not red, "Bluegrass" is not blue.
    expect(parallel("Redemption")).toEqual({ kind: "foil" });
    expect(parallel("Bluegrass Heroes")).toEqual({ kind: "foil" });
  });

  it("gives an unknown insert or parallel the generic sheen", () => {
    expect(parallel("Artist's Proof")).toEqual({ kind: "foil" });
    expect(finishForVariant({ kind: "insert", name: "Pennant Flyers" })).toEqual({ kind: "foil" });
  });

  it("reads a sub-parallel's insert too", () => {
    expect(parallel("Parallel", "Gold Label")).toEqual({ kind: "gold" });
    expect(parallel("Refractor", "Future Stars")).toEqual({ kind: "refractor" });
  });
});
