import { describe, expect, it } from "vitest";
import { comparePlayerNames, playerNameParts } from "./playerName";

describe("playerNameParts", () => {
  it.each([
    ["Shohei Ohtani", { last: "Ohtani", first: "Shohei", suffix: "" }],
    ["Ken Griffey Jr.", { last: "Griffey", first: "Ken", suffix: "Jr." }],
    ["Ken Griffey Sr", { last: "Griffey", first: "Ken", suffix: "Sr" }],
    ["Cal Ripken III", { last: "Ripken", first: "Cal", suffix: "III" }],
    ["Ken Griffey, Jr.", { last: "Griffey", first: "Ken", suffix: "Jr." }],
    ["Griffey Jr., Ken", { last: "Griffey", first: "Ken", suffix: "Jr." }],
    ["Griffey, Ken", { last: "Griffey", first: "Ken", suffix: "" }],
    ["Ichiro", { last: "Ichiro", first: "", suffix: "" }],
    ["Elly De La Cruz", { last: "De La Cruz", first: "Elly", suffix: "" }],
    ["Michael A. Taylor", { last: "Taylor", first: "Michael A.", suffix: "" }],
    ["  Paul   Skenes ", { last: "Skenes", first: "Paul", suffix: "" }],
    ["", { last: "", first: "", suffix: "" }],
  ])("%s", (name, parts) => {
    expect(playerNameParts(name)).toEqual(parts);
  });

  it("a one-word name that happens to be a suffix or particle stays the name", () => {
    expect(playerNameParts("V").last).toBe("V");
    expect(playerNameParts("Van Gogh").last).toBe("Gogh");
  });
});

describe("comparePlayerNames", () => {
  const sorted = (names: string[]) => [...names].sort(comparePlayerNames);

  it("sorts by last name, then first", () => {
    expect(sorted(["Paul Skenes", "Steve Yzerman", "Jim Kelly", "Aaron Judge", "Jim Abbott"])).toEqual([
      "Jim Abbott",
      "Aaron Judge",
      "Jim Kelly",
      "Paul Skenes",
      "Steve Yzerman",
    ]);
    expect(sorted(["Ken Griffey", "Alex Griffey"])).toEqual(["Alex Griffey", "Ken Griffey"]);
  });

  it("files a suffixed name under the surname, not the suffix", () => {
    expect(sorted(["Ken Griffey Jr.", "Derek Jeter", "Tony Gwynn"])).toEqual(["Ken Griffey Jr.", "Tony Gwynn", "Derek Jeter"]);
    expect(sorted(["Ken Griffey Jr.", "Ken Griffey Sr."])).toEqual(["Ken Griffey Jr.", "Ken Griffey Sr."]);
    expect(sorted(["Cal Ripken III", "Cal Ripken II"])).toEqual(["Cal Ripken II", "Cal Ripken III"]);
  });

  it("files a one-name player under that name", () => {
    expect(sorted(["Shohei Ohtani", "Ichiro", "Derek Jeter"])).toEqual(["Ichiro", "Derek Jeter", "Shohei Ohtani"]);
  });

  it("ignores case and accents", () => {
    expect(sorted(["Ronald Acuña Jr.", "Jose Abreu", "jacob deGrom"])).toEqual(["Jose Abreu", "Ronald Acuña Jr.", "jacob deGrom"]);
  });

  it("puts a missing name after every named one", () => {
    expect(sorted(["", "Steve Yzerman", "Jim Abbott"])).toEqual(["Jim Abbott", "Steve Yzerman", ""]);
    expect(comparePlayerNames(undefined, null)).toBe(0);
    expect(comparePlayerNames(undefined, "Jim Abbott")).toBe(1);
  });
});
