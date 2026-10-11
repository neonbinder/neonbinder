import { describe, expect, test } from "vitest";
import { ResolveError } from "../service";
import { fakeClient } from "../runner/fake-client";
import { DECISION_PLACEHOLDER, matchReview, reviewTemplate, runReview, type ReviewRow } from "./review";

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
      leagues: [{ name: "National League", decision: "create" }],
    });
    expect(decisions(client).map((d) => d.reviewRowId)).toEqual([rows[2]._id, rows[1]._id, rows[0]._id]);
    expect(decisions(client)[0]).toMatchObject({
      createLeague: { name: "National League", abbreviation: "NL", yearsActive: { from: 1876 }, wikidataId: "Q1" },
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
