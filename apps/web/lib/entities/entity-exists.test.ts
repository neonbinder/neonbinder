import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import {
  entityExistsRefusal,
  existingPlayerLabel,
  existingTeamLabel,
  playerCreateRefusal,
  playerExistsText,
  teamExistsText,
} from "./entity-exists";

describe("playerCreateRefusal — the create-only rule (NEO-339)", () => {
  const LIMIT = 10;
  test("nothing on file creates", () => {
    expect(playerCreateRefusal([], undefined, LIMIT)).toBeNull();
    expect(playerCreateRefusal([], 1990, LIMIT)).toBeNull();
  });
  test("one same-name player always refuses, whatever the year", () => {
    expect(playerCreateRefusal([{ birthYear: 1991 }], undefined, LIMIT)).toBe("sameName");
    expect(playerCreateRefusal([{ birthYear: 1991 }], 1991, LIMIT)).toBe("sameName");
    expect(playerCreateRefusal([{ birthYear: 1991 }], 1975, LIMIT)).toBe("sameName");
    expect(playerCreateRefusal([{}], 1975, LIMIT)).toBe("sameName");
  });
  test("several and no year refuses", () => {
    expect(playerCreateRefusal([{ birthYear: 1867 }, { birthYear: 1937 }], undefined, LIMIT)).toBe("noBirthYear");
  });
  test("several at the scan limit refuses: rows past it were never read", () => {
    const rows = Array.from({ length: LIMIT }, (_, i) => ({ birthYear: 1900 + i }));
    expect(playerCreateRefusal(rows, 2001, LIMIT)).toBe("tooMany");
  });
  test("a colliding year refuses", () => {
    expect(playerCreateRefusal([{ birthYear: 1867 }, { birthYear: 1937 }], 1937, LIMIT)).toBe("sameBirthYear");
  });
  test("an undated rival refuses", () => {
    expect(playerCreateRefusal([{ birthYear: 1867 }, {}], 2001, LIMIT)).toBe("undatedRival");
  });
  test("several, all dated, none that year: a new player may be created", () => {
    expect(playerCreateRefusal([{ birthYear: 1867 }, { birthYear: 1937 }], 2001, LIMIT)).toBeNull();
  });
});

describe("entityExistsRefusal — reading the structured refusal", () => {
  test("a PLAYER_EXISTS ConvexError", () => {
    const err = new ConvexError({
      code: "PLAYER_EXISTS",
      reason: "sameName",
      name: "Mike Trout",
      count: 1,
      players: [{ id: "p1", name: "Mike Trout", birthYear: 1991 }],
    });
    expect(entityExistsRefusal(err)).toEqual({
      code: "PLAYER_EXISTS",
      reason: "sameName",
      name: "Mike Trout",
      count: 1,
      players: [{ id: "p1", name: "Mike Trout", birthYear: 1991 }],
    });
  });

  test("a TEAM_EXISTS ConvexError", () => {
    const err = new ConvexError({
      code: "TEAM_EXISTS",
      name: "San Diego Padres",
      teams: [{ id: "t1", name: "San Diego Padres", years: "" }],
    });
    expect(entityExistsRefusal(err)).toEqual({
      code: "TEAM_EXISTS",
      name: "San Diego Padres",
      teams: [{ id: "t1", name: "San Diego Padres", years: "" }],
    });
  });

  test("a plain object carrying `data` (the tool's transport) reads the same", () => {
    expect(
      entityExistsRefusal({ data: { code: "TEAM_EXISTS", name: "X", teams: [{ id: "t", name: "X", years: "1990–present" }] } }),
    ).toMatchObject({ code: "TEAM_EXISTS", teams: [{ years: "1990–present" }] });
  });

  test("anything else is not this refusal — other codes, strings, malformed rows dropped", () => {
    expect(entityExistsRefusal(new ConvexError("A player name is required."))).toBeNull();
    expect(entityExistsRefusal(new ConvexError({ code: "TEAM_ERA_EXISTS", eras: [] }))).toBeNull();
    expect(entityExistsRefusal(new Error("boom"))).toBeNull();
    expect(entityExistsRefusal(null)).toBeNull();
    const partial = entityExistsRefusal(
      new ConvexError({ code: "PLAYER_EXISTS", reason: "sameName", name: "A", players: [{ id: 1 }, { id: "p2", name: "A" }] }),
    );
    expect(partial).toMatchObject({ players: [{ id: "p2", name: "A" }], count: 1 });
  });
});

describe("the copy", () => {
  test("labels name the row the way the pickers do", () => {
    expect(existingPlayerLabel({ id: "p", name: "Mike Trout", birthYear: 1991 })).toBe("Mike Trout (born 1991)");
    expect(existingPlayerLabel({ id: "p", name: "Mike Trout" })).toBe("Mike Trout");
    expect(existingTeamLabel({ id: "t", name: "Kansas City Monarchs", years: "1920–1965" })).toBe(
      "Kansas City Monarchs · 1920–1965",
    );
    expect(existingTeamLabel({ id: "t", name: "Athletics", years: "" })).toBe("Athletics");
  });

  test("every refusal reason has its own sentence, naming the player", () => {
    const base = { code: "PLAYER_EXISTS" as const, name: "Bob Allen", count: 2, players: [] };
    const texts = (["sameName", "noBirthYear", "sameBirthYear", "undatedRival", "tooMany"] as const).map((reason) =>
      playerExistsText({ ...base, reason, birthYear: 1937 }),
    );
    expect(new Set(texts).size).toBe(5);
    for (const t of texts) expect(t).toContain("Bob Allen");
    expect(texts[2]).toContain("born 1937");
  });

  test("a team sentence says one or several", () => {
    const one = { code: "TEAM_EXISTS" as const, name: "Winnipeg Jets", teams: [{ id: "a", name: "Winnipeg Jets", years: "2011–present" }] };
    expect(teamExistsText(one)).toBe("Winnipeg Jets is already a team in this sport. Use it instead of adding a second one.");
    expect(teamExistsText({ ...one, teams: [...one.teams, { id: "b", name: "Winnipeg Jets", years: "" }] })).toBe(
      "Winnipeg Jets already names 2 teams in this sport. Use the one on this card.",
    );
  });
});
