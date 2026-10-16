import { describe, expect, test } from "vitest";
import { ResolveError } from "../service";
import { fakeClient } from "../runner/fake-client";
import {
  DECISION_PLACEHOLDER,
  LEVEL_PLACEHOLDER,
  matchReview,
  pickPlayerByBirthYear,
  PLAYER_LINK_SCAN_LIMIT,
  reviewTemplate,
  runReview,
  SAME_NAME_PLAYER_PLACEHOLDER,
  type ReviewRow,
} from "./review";

const SPORT = "sport1" as ReviewRow["sportId"];
const SET = "set1" as ReviewRow["selectorOptionId"];

let seq = 0;
function row(kind: ReviewRow["kind"], name: string, extra: Partial<ReviewRow> = {}): ReviewRow {
  seq++;
  return {
    _id: `row${seq}` as ReviewRow["_id"],
    _creationTime: seq,
    selectorOptionId: SET,
    batchId: "b1",
    kind,
    name,
    sportId: SPORT,
    sportValue: "Baseball",
    setSportId: SPORT,
    setSportValue: "Baseball",
    status: "ready",
    ...extra,
  } as ReviewRow;
}

const CTX = { selectorOptionId: SET, batchId: "b1", at: "steps[1].base.checklist.review", row: null };

/** A server stand-in: getBatch reads `rows`, recordDecision writes onto them. */
function batchServer(rows: ReviewRow[]) {
  const client = fakeClient();
  client
    .on("entityReviewQueue:getBatch", () => structuredClone(rows))
    .on("entityReviewQueue:recordDecision", (args) => {
      const r = rows.find((x) => x._id === args.reviewRowId)!;
      const { reviewRowId: _id, ...decision } = args;
      void _id;
      r.decision = decision as ReviewRow["decision"];
      return null;
    })
    .on("entityReviewQueue:stageCareerTeamRows", () => 0)
    .on("players:nearMatches", [])
    .on("teams:nearMatches", [])
    .on("leagues:nearMatches", [])
    .on("leagues:list", []);
  return client;
}

const decisions = (client: ReturnType<typeof fakeClient>) =>
  client.callsTo("entityReviewQueue:recordDecision").map((c) => c.args);

describe("matchReview — exactly one entry per row, exactly one row per entry", () => {
  const rows = [row("player", "Shohei Ohtani"), row("team", "Seattle Mariners")];

  test("one entry for one row matches", () => {
    const m = matchReview(rows, { players: [{ name: "Shohei Ohtani", decision: "create" }], teams: [{ name: "Seattle  Mariners ", decision: "create" }], leagues: [] }, CTX);
    expect(m.answers.size).toBe(2);
    expect(m.open).toEqual({ players: [], teams: [], leagues: [] });
  });

  test("a row with no entry is unanswered", () => {
    const m = matchReview(rows, { players: [{ name: "Shohei Ohtani", decision: "create" }], teams: [], leagues: [] }, CTX);
    expect(m.open.teams).toMatchObject([{ name: "Seattle Mariners", reason: "unanswered" }]);
  });

  test("two entries for one row are ambiguous, never first-wins", () => {
    const m = matchReview(
      rows,
      {
        players: [
          { name: "Shohei Ohtani", decision: "create" },
          { name: "Shohei Ohtani", decision: "skip" },
        ],
        teams: [{ name: "Seattle Mariners", decision: "create" }],
        leagues: [],
      },
      CTX,
    );
    expect(m.answers.has(rows[0]._id)).toBe(false);
    expect(m.open.players[0]).toMatchObject({ reason: "ambiguous", name: "Shohei Ohtani" });
  });

  test("an entry that matches no row is unmatched", () => {
    const m = matchReview(
      rows,
      { players: [{ name: "Shohei Ohtani", decision: "create" }, { name: "Harmon Killebrew", decision: "create" }], teams: [{ name: "Seattle Mariners", decision: "create" }], leagues: [] },
      CTX,
    );
    expect(m.open.players).toMatchObject([{ reason: "unmatched", name: "Harmon Killebrew" }]);
  });

  test("names match exactly (case is not folded) — no fuzzy guessing", () => {
    const m = matchReview(rows, { players: [{ name: "shohei ohtani", decision: "create" }], teams: [{ name: "Seattle Mariners", decision: "create" }], leagues: [] }, CTX);
    expect(m.open.players.map((o) => o.reason).sort()).toEqual(["unanswered", "unmatched"]);
  });

  test("an already-decided row needs no entry", () => {
    const decided = [row("player", "J.T. Realmuto", { decision: { action: "create" } })];
    const m = matchReview(decided, { players: [], teams: [], leagues: [] }, CTX);
    expect(m.open.players).toEqual([]);
  });
});

describe("runReview", () => {
  test("an unanswered row stops the review before a single decision is recorded, with a fill-in template", async () => {
    const rows = [row("player", "Shohei Ohtani"), row("team", "Seattle Mariners", { enrichment: { league: "American League" } })];
    const client = batchServer(rows);
    const answers = { players: [{ name: "Shohei Ohtani", decision: "create" as const }], teams: [], leagues: [] };
    const out = await runReview(client, CTX, answers);
    expect(out.status).toBe("open");
    if (out.status !== "open") return;
    expect(out.open.teams).toMatchObject([{ name: "Seattle Mariners", reason: "unanswered" }]);
    expect(decisions(client)).toEqual([]);
    expect(client.writes().filter((c) => c.fn !== "entityReviewQueue:stageCareerTeamRows")).toEqual([]);

    const t = reviewTemplate(rows, answers);
    expect(t.players).toEqual([{ name: "Shohei Ohtani", decision: "create" }]);
    expect(t.teams).toEqual([{ name: "Seattle Mariners", decision: `${DECISION_PLACEHOLDER} — league "American League"` }]);
  });

  test('"none-expected" makes any row an open decision', async () => {
    const client = batchServer([row("player", "Shohei Ohtani")]);
    const out = await runReview(client, CTX, "none-expected");
    expect(out.status).toBe("open");
    expect(decisions(client)).toEqual([]);
  });

  test("waits for lookups to settle before reading the batch", async () => {
    const rows = [row("player", "Shohei Ohtani", { status: "pending" })];
    const client = batchServer(rows);
    client.on("entityReviewQueue:getBatch", (_a, n) => {
      if (n >= 2) rows[0].status = "ready";
      return structuredClone(rows);
    });
    const out = await runReview(client, CTX, { players: [{ name: "Shohei Ohtani", decision: "create" }], teams: [], leagues: [] });
    expect(out.status).toBe("done");
    expect(client.callsTo("entityReviewQueue:getBatch").length).toBeGreaterThanOrEqual(3);
  });

  test("stages career teams the way the wizard does, then answers the staged step before its player", async () => {
    const player = row("player", "Julio Rodriguez", {
      enrichment: { careerTeams: [{ name: "Seattle Mariners", fromYear: 2022 }] },
    });
    const rows: ReviewRow[] = [player];
    const client = batchServer(rows);
    client.on("entityReviewQueue:stageCareerTeamRows", (args) => {
      expect(args).toEqual({ reviewRowId: player._id });
      if (rows.length === 1) {
        rows.unshift(
          row("team", "Seattle Mariners", {
            source: { kind: "careerTeamOf", playerRowId: player._id },
            enrichment: { location: "Seattle", league: "American League" },
          }),
        );
        return 1;
      }
      return 0;
    });
    const out = await runReview(client, CTX, {
      players: [{ name: "Julio Rodriguez", decision: "create" }],
      teams: [{ name: "Seattle Mariners", decision: "create" }],
      leagues: [],
    });
    expect(out).toMatchObject({ status: "done", applied: { players: 1, teams: 1, leagues: 0 }, staged: 1 });
    // planStaging: once per player row per session.
    expect(client.callsTo("entityReviewQueue:stageCareerTeamRows")).toHaveLength(1);
    // The New Team step untouched: teamCreatePrefill's split, league left to the server.
    expect(decisions(client)).toEqual([
      { reviewRowId: rows[0]._id, action: "create", create: { name: "Mariners", location: "Seattle" } },
      { reviewRowId: player._id, action: "create" },
    ]);
  });

  test("walks leagues, then teams, then players, with the untouched step's payloads", async () => {
    const team = row("team", "Atlanta Braves", { enrichment: { league: "National League" } });
    const rows = [
      row("player", "Ronald Acuna Jr."),
      team,
      row("league", "National League", {
        source: { kind: "leagueOf", teamRowId: team._id },
        enrichment: { abbreviation: "NL", yearsActive: { from: 1876 }, wikidataId: "Q1" },
      }),
    ];
    const client = batchServer(rows);
    await runReview(client, CTX, {
      players: [{ name: "Ronald Acuna Jr.", decision: "create" }],
      teams: [{ name: "Atlanta Braves", decision: "create", location: "Atlanta" }],
      leagues: [{ name: "National League", decision: "create", level: "major" }],
    });
    expect(decisions(client).map((d) => d.reviewRowId)).toEqual([rows[2]._id, rows[1]._id, rows[0]._id]);
    // NEO-331: the step's prefill plus the level the spec pressed.
    expect(decisions(client)[0]).toMatchObject({
      createLeague: { name: "National League", level: "major", abbreviation: "NL", yearsActive: { from: 1876 }, wikidataId: "Q1" },
    });
    expect(decisions(client)[1]).toMatchObject({ create: { location: "Atlanta", name: "Braves" } });
  });

  test("a link names exactly one existing row; a team link keeps the alias (the checkbox default)", async () => {
    const rows = [row("team", "SEA Mariners")];
    const client = batchServer(rows);
    client.on("teams:nearMatches", [{ _id: "teamM", name: "Seattle Mariners", confidence: "exact" }]);
    await runReview(client, CTX, { players: [], teams: [{ name: "SEA Mariners", decision: { link: "Seattle Mariners" } }], leagues: [] });
    expect(decisions(client)).toEqual([{ reviewRowId: rows[0]._id, action: "link", linkedTeamId: "teamM", saveAsAlias: true }]);
  });

  test("a link that matches two rows is refused, never the first", async () => {
    const rows = [row("player", "Will Smith")];
    const client = batchServer(rows);
    client.on("players:nearMatches", [
      { _id: "p1", name: "Will Smith", confidence: "exact", birthYear: 1995 },
      { _id: "p2", name: "Will Smith", confidence: "exact", birthYear: 1989 },
    ]);
    await expect(
      runReview(client, CTX, { players: [{ name: "Will Smith", decision: { link: "Will Smith" } }], teams: [], leagues: [] }),
    ).rejects.toBeInstanceOf(ResolveError);
    expect(decisions(client)).toEqual([]);
  });

  test("NEO-331: a league create with no level is refused before anything is recorded for it", async () => {
    const rows = [row("league", "Northwest League")];
    const client = batchServer(rows);
    // A caller that bypassed the spec schema (which refuses this shape itself).
    const answers = { players: [], teams: [], leagues: [{ name: "Northwest League", decision: "create" as const }] };
    await expect(runReview(client, CTX, answers)).rejects.toThrow(/answered "create" with no level/);
    expect(decisions(client)).toEqual([]);
  });

  test("NEO-331: an unanswered league's template leaves its level as a fill-in", () => {
    const rows = [row("league", "Northwest League"), row("team", "Eugene Emeralds")];
    const t = reviewTemplate(rows, { players: [], teams: [], leagues: [] });
    expect(t.leagues).toEqual([{ name: "Northwest League", decision: DECISION_PLACEHOLDER, level: LEVEL_PLACEHOLDER }]);
    expect(LEVEL_PLACEHOLDER).toContain('"minor"');
    // A team's template never carries a level.
    expect(t.teams[0]).not.toHaveProperty("level");
    // An answered league is copied as given.
    const answered = reviewTemplate(rows, {
      players: [],
      teams: [],
      leagues: [{ name: "Northwest League", decision: "create", level: "minor" }],
    });
    expect(answered.leagues).toEqual([{ name: "Northwest League", decision: "create", level: "minor" }]);
  });

  test("a team's league resolves to the one existing league", async () => {
    const rows = [row("team", "Seattle Mariners")];
    const client = batchServer(rows);
    client.on("leagues:list", [{ _id: "lgAL", name: "American League", aliases: ["AL"] }]);
    await runReview(client, CTX, { players: [], teams: [{ name: "Seattle Mariners", decision: "create", league: "AL" }], leagues: [] });
    expect(decisions(client)[0]).toMatchObject({ create: { name: "Seattle Mariners", leagueId: "lgAL" } });
  });

  test("partial mode (decide) records only what it was given", async () => {
    const rows = [row("player", "Shohei Ohtani"), row("player", "J.T. Realmuto")];
    const client = batchServer(rows);
    const out = await runReview(client, CTX, { players: [{ name: "J.T. Realmuto", decision: "create" }], teams: [], leagues: [] }, { partial: true });
    expect(decisions(client)).toEqual([{ reviewRowId: rows[1]._id, action: "create" }]);
    expect(out.status).toBe("open");
    if (out.status === "open") expect(out.open.players.map((p) => p.name)).toEqual(["Shohei Ohtani"]);
  });
});

/**
 * NEO-339 live measurement: Mark McGwire, Derek Jeter and Sammy Sosa were
 * drafted "create", and by the apply another writer on the shared preview had
 * created them, so the review no longer asked about them. A spec run treats
 * such an answer as moot (a reported no-op); `decide` keeps it strict.
 */
describe("moot review answers (NEO-339)", () => {
  const answers = {
    players: [
      { name: "Shohei Ohtani", decision: "create" as const },
      { name: "Mark McGwire", decision: "create" as const },
    ],
    teams: [{ name: "Fort Lauderdale Yankees", decision: { link: "Fort Lauderdale Yankees" } }],
    leagues: [{ name: "Florida State League", decision: "skip" as const }],
  };

  test("matchReview: an entry no row is named like is moot with mootUnmatched, for every kind and decision", () => {
    const rows = [row("player", "Shohei Ohtani")];
    const m = matchReview(rows, answers, { ...CTX, mootUnmatched: true });
    expect(m.open).toEqual({ players: [], teams: [], leagues: [] });
    expect(m.moot).toEqual([
      { at: `${CTX.at}.players[1]`, kind: "player", name: "Mark McGwire" },
      { at: `${CTX.at}.teams[0]`, kind: "team", name: "Fort Lauderdale Yankees" },
      { at: `${CTX.at}.leagues[0]`, kind: "league", name: "Florida State League" },
    ]);
    // Without it (the default), the same entries are open.
    expect(matchReview(rows, answers, CTX).open.players).toMatchObject([{ reason: "unmatched", name: "Mark McGwire" }]);
  });

  test("runReview (spec run): the asked row is decided, the moot answers are reported and recorded nowhere", async () => {
    const rows = [row("player", "Shohei Ohtani")];
    const client = batchServer(rows);
    const out = await runReview(client, CTX, answers);
    expect(out.status).toBe("done");
    expect(out.moot.map((m) => m.name)).toEqual(["Mark McGwire", "Fort Lauderdale Yankees", "Florida State League"]);
    expect(decisions(client)).toEqual([{ reviewRowId: rows[0]._id, action: "create" }]);
  });

  test("still open: a row the review asks about with no answer, even beside moot answers", async () => {
    const rows = [row("player", "Shohei Ohtani"), row("player", "George Brett")];
    const client = batchServer(rows);
    const out = await runReview(client, CTX, answers);
    expect(out.status).toBe("open");
    if (out.status === "open") expect(out.open.players).toMatchObject([{ name: "George Brett", reason: "unanswered" }]);
    expect(decisions(client)).toEqual([]);
  });

  test("decide (partial) keeps an answer for a row that is not there strict", async () => {
    const client = batchServer([row("player", "Shohei Ohtani")]);
    const out = await runReview(client, CTX, { players: [{ name: "Mark McGwire", decision: "create" }], teams: [], leagues: [] }, { partial: true });
    expect(out.status).toBe("open");
    if (out.status === "open") expect(out.open.players).toMatchObject([{ name: "Mark McGwire", reason: "unmatched" }]);
  });
});

describe("NEO-339: a player link by name and birth year", () => {
  // Four catalogue players share the name; the card's man is the one born 2001.
  const JOSES = [
    { _id: "p1894", name: "Jose Rodriguez", confidence: "exact" as const, birthYear: 1894 },
    { _id: "p1974", name: "Jose Rodriguez", confidence: "exact" as const, birthYear: 1974 },
    { _id: "p1995", name: "Jose Rodriguez", confidence: "exact" as const, birthYear: 1995 },
    { _id: "p2001", name: "José Rodriguez", confidence: "exact" as const, birthYear: 2001 },
    { _id: "pClose", name: "Josh Rodriguez", confidence: "close" as const, birthYear: 2001 },
  ];
  const linkJose = (birthYear?: number) => ({
    players: [{ name: "Jose Rodriguez", decision: { link: "Jose Rodriguez", ...(birthYear !== undefined ? { birthYear } : {}) } }],
    teams: [],
    leagues: [],
  });

  test("birthYear links the one same-name player born that year, and asks for every same-name row", async () => {
    const rows = [row("player", "Jose Rodriguez")];
    const client = batchServer(rows);
    client.on("players:nearMatches", JOSES);
    const out = await runReview(client, CTX, linkJose(2001));
    expect(out.status).toBe("done");
    expect(decisions(client)).toEqual([{ reviewRowId: rows[0]._id, action: "link", linkedPlayerId: "p2001" }]);
    // The default five could hide one; the link asks for the server's cap.
    expect(client.callsTo("players:nearMatches").map((c) => c.args)).toEqual([
      { name: "Jose Rodriguez", sportId: SPORT, limit: PLAYER_LINK_SCAN_LIMIT },
    ]);
  });

  test("no same-name player born that year is refused, naming the name, the year and every birth year", async () => {
    const rows = [row("player", "Jose Rodriguez")];
    const client = batchServer(rows);
    client.on("players:nearMatches", JOSES);
    const err = await runReview(client, CTX, linkJose(1999)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResolveError);
    expect((err as ResolveError).message).toBe(
      'No player named "Jose Rodriguez" was born in 1999. Same-name birth years: 1894, 1974, 1995, 2001.',
    );
    expect((err as ResolveError).at).toBe("steps[1].base.checklist.review.players");
    // Every same-name candidate, with its year; the close match is not one.
    expect((err as ResolveError).candidates.map((c) => [c.id, c.detail])).toEqual([
      ["p1894", "born 1894"],
      ["p1974", "born 1974"],
      ["p1995", "born 1995"],
      ["p2001", "born 2001"],
    ]);
    expect(decisions(client)).toEqual([]);
  });

  test("two same-name players born that year are refused, never the first", async () => {
    const rows = [row("player", "Jose Rodriguez")];
    const client = batchServer(rows);
    client.on("players:nearMatches", [...JOSES, { _id: "p2001b", name: "Jose Rodriguez", confidence: "exact", birthYear: 2001 }]);
    const err = await runReview(client, CTX, linkJose(2001)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResolveError);
    expect((err as ResolveError).message).toBe(
      '2 players named "Jose Rodriguez" were born in 2001, so birthYear cannot pick one. Same-name birth years: 1894, 1974, 1995, 2001, 2001.',
    );
    expect(decisions(client)).toEqual([]);
  });

  test("a same-name row with no birth year never matches one, and reads as unknown", () => {
    const hits = [
      { _id: "a", name: "Jose Rodriguez", confidence: "exact" as const },
      { _id: "b", name: "Jose Rodriguez", confidence: "exact" as const, birthYear: 1974 },
    ];
    expect(pickPlayerByBirthYear(hits, "Jose Rodriguez", 1974, "at")._id).toBe("b");
    expect(() => pickPlayerByBirthYear(hits, "Jose Rodriguez", 2001, "at")).toThrow(
      'No player named "Jose Rodriguez" was born in 2001. Same-name birth years: 1974, unknown.',
    );
  });

  test("a full window of same-name rows is refused: another one born that year may lie past it", () => {
    const hits = Array.from({ length: 8 }, (_, i) => ({ _id: `p${i}`, name: "John Smith", confidence: "exact" as const, birthYear: 1900 + i }));
    expect(() => pickPlayerByBirthYear(hits, "John Smith", 1903, "at")).toThrow(/matches 8 or more players/);
    // One under the window is checked as usual.
    expect(pickPlayerByBirthYear(hits.slice(0, 7), "John Smith", 1903, "at")._id).toBe("p3");
  });

  test("no same-name player at all is refused", () => {
    expect(() => pickPlayerByBirthYear([JOSES[4]], "Jose Rodriguez", 2001, "at")).toThrow(
      'No player named "Jose Rodriguez" to link (birthYear 2001).',
    );
  });

  test("without birthYear the link behaves as before: one exact match links, the default lookup is unchanged", async () => {
    const rows = [row("player", "Shohei Ohtani")];
    const client = batchServer(rows);
    client.on("players:nearMatches", [{ _id: "pOhtani", name: "Shohei Ohtani", confidence: "exact", birthYear: 1994 }]);
    await runReview(client, CTX, { players: [{ name: "Shohei Ohtani", decision: { link: "Shohei Ohtani" } }], teams: [], leagues: [] });
    expect(decisions(client)).toEqual([{ reviewRowId: rows[0]._id, action: "link", linkedPlayerId: "pOhtani" }]);
    expect(client.callsTo("players:nearMatches").map((c) => c.args)).toEqual([{ name: "Shohei Ohtani", sportId: SPORT }]);
  });

  test("without birthYear several same-name players still refuse, and the message points at birthYear", async () => {
    const rows = [row("player", "Jose Rodriguez")];
    const client = batchServer(rows);
    client.on("players:nearMatches", JOSES);
    const err = await runReview(client, CTX, linkJose()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResolveError);
    expect((err as ResolveError).message).toBe(
      '"Jose Rodriguez" matches 4 player rows; add the birthYear of the one you mean (born 1894, 1974, 1995, 2001).',
    );
    expect((err as ResolveError).candidates).toHaveLength(4);
    expect(decisions(client)).toEqual([]);
  });

  test("a same-name pick's template offers the birth-year form and lists the years", () => {
    const pick = row("player", "Jose Rodriguez", {
      enrichment: {
        existingCandidates: [
          { playerId: "p1974", name: "Jose Rodriguez", birthYear: 1974, careerSummary: "" },
          { playerId: "p2001", name: "José Rodriguez", birthYear: 2001, careerSummary: "" },
        ],
      },
    } as Partial<ReviewRow>);
    const t = reviewTemplate([pick, row("player", "Shohei Ohtani")], { players: [], teams: [], leagues: [] });
    expect(t.players[0].decision).toBe(
      `${SAME_NAME_PLAYER_PLACEHOLDER} — 2 existing NB player(s) share this name (born 1974, 2001); ` +
        'link one with {"link": "<name>", "birthYear": <year>}',
    );
    // A name no NB player has keeps the plain fill-in.
    expect(t.players[1].decision).toBe(DECISION_PLACEHOLDER);
  });
});
