/**
 * NEO-424 — the review queue's side of set history: the decided rows
 * `startBatch` writes from the gate's facts, `recordDecision`'s cross-sport
 * accept (D7), `clearDecision`'s Change on an auto-link (D6), what
 * `applyLookupResult` keeps, and the bulk create.
 *
 * Rows come from the REAL `startBatch` wherever the test is about what it
 * writes; other tests insert a row by hand in the exact shape `startBatch`
 * leaves, so the operator-side mutations are exercised alone. The scheduled
 * Wikidata enqueue is asserted off `_scheduled_functions` and never run (the
 * workpool is not mounted under convex-test); every instance is cancelled at
 * the end.
 *
 * Fixtures follow entityReviewQueue.sameNameLookup.test.ts.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { ENTITY_REVIEW_START_OPS } from "./entityReviewQueue";
import { normalizePlayerName } from "./players";
import { normalizeTeamName } from "./teams";
import { cancelScheduled } from "../lib/testing/drain-scheduled";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

type T = ReturnType<typeof convexTest>;
type Sel = Id<"selectorOptions">;

const ADMIN_IDENTITY = {
  subject: "user_autolink_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_autolink_001",
  role: "admin",
};
const ENQUEUE_FN = "wikidataPool:enqueueEntityReviewLookups";
const START_BATCH_FN = "entityReviewQueue:startBatch";

const live: T[] = [];
function newT(): T {
  const t = convexTest(schema, modules);
  live.push(t);
  return t;
}
afterEach(async () => {
  for (const t of live.splice(0)) await cancelScheduled(t);
});

async function node(t: T, level: string, value: string, parentId?: Sel): Promise<Sel> {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      level,
      value,
      ...(parentId ? { parentId } : {}),
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    });
    if (parentId) {
      const parent = await ctx.db.get(parentId);
      await ctx.db.patch(parentId, { children: [...(parent?.children ?? []), id] });
    }
    return id;
  });
}

async function player(
  t: T,
  sportId: Sel,
  name: string,
  extra: Partial<Doc<"players">> = {},
): Promise<Id<"players">> {
  return t.run((ctx) =>
    ctx.db.insert("players", {
      name,
      nameNormalized: normalizePlayerName(name),
      sportId,
      lastUpdated: Date.now(),
      ...extra,
    }),
  );
}

/** Baseball › 2024 › Topps › Series 1 › Base, a Football sport, and two Bo Jacksons. */
async function seed(t: T) {
  const baseball = await node(t, "sport", "Baseball");
  const football = await node(t, "sport", "Football");
  const year = await node(t, "year", "2024", baseball);
  const brand = await node(t, "manufacturer", "Topps", year);
  const set = await node(t, "setName", "Series 1", brand);
  const base = await node(t, "variantType", "Base", set);
  const bo = await player(t, football, "Bo Jackson");
  const otherBo = await player(t, baseball, "Bo Jackson");
  return { baseball, football, base, bo, otherBo };
}
type World = Awaited<ReturnType<typeof seed>>;

function startBatch(t: T, w: World, extra: Record<string, unknown> = {}) {
  return t.mutation(internal.entityReviewQueue.startBatch, {
    selectorOptionId: w.base,
    createdByUserId: ADMIN_IDENTITY.subject,
    sportId: w.baseball,
    playerNames: [],
    teamNames: [],
    ...extra,
  } as never);
}

async function rows(t: T, batchId: string) {
  return (await t.run((ctx) => ctx.db.query("entityReviewQueue").collect())).filter(
    (r) => r.batchId === batchId,
  );
}
const byName = (list: Doc<"entityReviewQueue">[], name: string) =>
  list.find((r) => r.name === name)!;
const getRow = (t: T, id: Id<"entityReviewQueue">) => t.run((ctx) => ctx.db.get(id));

async function scheduled(t: T) {
  return t.run(async (ctx) =>
    (
      await (ctx as unknown as {
        db: {
          system: {
            query: (n: string) => {
              collect: () => Promise<Array<{ name: string; args: unknown[] }>>;
            };
          };
        };
      }).db.system.query("_scheduled_functions").collect()
    ),
  );
}
async function enqueuedIds(t: T): Promise<string[]> {
  return (await scheduled(t))
    .filter((r) => r.name === ENQUEUE_FN)
    .flatMap((r) => (r.args[0] as { rowIds: string[] }).rowIds);
}

/** An auto-link row exactly as `startBatch` writes one. */
async function insertAutoLinkRow(
  t: T,
  w: World,
  opts: {
    linked?: Id<"players">;
    candidates?: Array<Id<"players">>;
    origin?: "setHistory" | "hallOfFame";
  } = {},
) {
  const linked = opts.linked ?? w.bo;
  const candidates =
    opts.candidates === undefined
      ? undefined
      : await Promise.all(
          opts.candidates.map(async (playerId) => {
            const p = (await t.run((ctx) => ctx.db.get(playerId)))!;
            const s = (await t.run((ctx) => ctx.db.get(p.sportId)))!;
            return {
              playerId,
              name: p.name,
              careerSummary: "",
              sportValue: s.value,
            };
          }),
        );
  const homeSport = linked === w.bo ? w.football : w.baseball;
  return t.run((ctx) =>
    ctx.db.insert("entityReviewQueue", {
      selectorOptionId: w.base,
      batchId: "batch-al",
      createdByUserId: ADMIN_IDENTITY.subject,
      kind: "player",
      name: "Bo Jackson",
      nameNormalized: normalizePlayerName("Bo Jackson"),
      sportId: homeSport,
      status: "ready",
      ...(candidates ? { enrichment: { existingCandidates: candidates } } : {}),
      decision: {
        action: "link",
        linkedPlayerId: linked,
        autoLinked: opts.origin ?? "setHistory",
      },
    }),
  );
}

// ===========================================================================
// startBatch: the facts become rows
// ===========================================================================

describe("startBatch: auto-links are born decided, ready and never looked up", () => {
  test("a set-history player link is one decided row in the linked player's home sport", async () => {
    const t = newT();
    const w = await seed(t);

    const batchId = await startBatch(t, w, {
      autoLinks: [
        {
          kind: "player",
          name: "Bo Jackson",
          playerId: w.bo,
          rowSportId: w.football,
          origin: "setHistory",
        },
      ],
    });

    const [row] = await rows(t, batchId);
    expect(row).toMatchObject({
      kind: "player",
      name: "Bo Jackson",
      sportId: w.football,
      status: "ready",
      decision: { action: "link", linkedPlayerId: w.bo, autoLinked: "setHistory" },
    });
    // A guest link: nothing for the commit to add to the player's sports.
    expect(row.decision).not.toHaveProperty("addSetSport");
    // One candidate is not a choice, so none is stored.
    expect(row.enrichment).toBeUndefined();
    expect(await enqueuedIds(t)).toEqual([]);
  });

  test("with rivals it stores the candidates, history player first, each labelled with its sport", async () => {
    const t = newT();
    const w = await seed(t);

    const batchId = await startBatch(t, w, {
      autoLinks: [
        {
          kind: "player",
          name: "Bo Jackson",
          playerId: w.bo,
          rowSportId: w.football,
          origin: "setHistory",
          // The linked id repeated among the rivals must not appear twice.
          candidatePlayerIds: [w.bo, w.otherBo, w.bo],
        },
      ],
    });

    const [row] = await rows(t, batchId);
    expect(
      row.enrichment?.existingCandidates?.map((c) => [c.playerId, c.sportValue]),
    ).toEqual([
      [w.bo, "Football"],
      [w.otherBo, "Baseball"],
    ]);
  });

  test("a Hall of Fame link carries its origin", async () => {
    const t = newT();
    const w = await seed(t);

    const batchId = await startBatch(t, w, {
      autoLinks: [
        {
          kind: "player",
          name: "Bo Jackson",
          playerId: w.otherBo,
          rowSportId: w.baseball,
          origin: "hallOfFame",
        },
      ],
    });

    expect((await rows(t, batchId))[0].decision).toMatchObject({
      linkedPlayerId: w.otherBo,
      autoLinked: "hallOfFame",
    });
  });

  test("a team link is decided in the team's sport; only ordinary names are enqueued", async () => {
    const t = newT();
    const w = await seed(t);
    const raiders = await t.run((ctx) =>
      ctx.db.insert("teams", {
        location: "Oakland",
        name: "Raiders",
        nameNormalized: normalizeTeamName("Oakland Raiders"),
        sportId: w.football,
        lastUpdated: Date.now(),
      }),
    );

    const batchId = await startBatch(t, w, {
      playerNames: ["Travis Bazzana"],
      autoLinks: [
        {
          kind: "team",
          name: "Oakland Raiders",
          teamId: raiders,
          rowSportId: w.football,
          origin: "setHistory",
        },
      ],
    });

    const list = await rows(t, batchId);
    const teamRow = byName(list, "Oakland Raiders");
    expect(teamRow).toMatchObject({
      kind: "team",
      sportId: w.football,
      status: "ready",
      decision: { action: "link", linkedTeamId: raiders, autoLinked: "setHistory" },
    });
    expect(await enqueuedIds(t)).toEqual([byName(list, "Travis Bazzana")._id]);
  });

  test("the same name in playerNames and autoLinks, in two spellings, is ONE row", async () => {
    const t = newT();
    const w = await seed(t);

    const batchId = await startBatch(t, w, {
      playerNames: ["Jackson, Bo"],
      autoLinks: [
        {
          kind: "player",
          name: "Bo Jackson",
          playerId: w.bo,
          rowSportId: w.football,
          origin: "setHistory",
        },
      ],
    });

    const list = await rows(t, batchId);
    expect(list).toHaveLength(1);
    expect(list[0].decision?.action).toBe("link");
    expect(await enqueuedIds(t)).toEqual([]);
  });

  test("an auto-link beats a history choice and a preselect for the same name", async () => {
    const t = newT();
    const w = await seed(t);

    const batchId = await startBatch(t, w, {
      autoLinks: [
        {
          kind: "player",
          name: "Bo Jackson",
          playerId: w.bo,
          rowSportId: w.football,
          origin: "setHistory",
        },
      ],
      historyCandidates: [{ name: "Bo Jackson", playerIds: [w.bo, w.otherBo] }],
      preselects: [
        {
          name: "Bo Jackson",
          playerId: w.otherBo,
          sportId: w.baseball,
          sportValue: "Baseball",
          reason: "onlyNamesake",
        },
      ],
    });

    const list = await rows(t, batchId);
    expect(list).toHaveLength(1);
    expect(list[0].decision).toMatchObject({ linkedPlayerId: w.bo });
    expect(list[0].enrichment?.preselect).toBeUndefined();
  });

  test("a malformed fact costs its one name, never the batch, and logs counts only", async () => {
    const t = newT();
    const w = await seed(t);
    const someTeam = await t.run((ctx) =>
      ctx.db.insert("teams", {
        name: "Some Team",
        nameNormalized: normalizeTeamName("Some Team"),
        sportId: w.baseball,
        lastUpdated: Date.now(),
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const batchId = await startBatch(t, w, {
        playerNames: ["Travis Bazzana"],
        autoLinks: [
          // A player link with no player.
          { kind: "player", name: "No Player", rowSportId: w.baseball, origin: "setHistory" },
          // A Hall of Fame team link: teams only ever come from set history.
          {
            kind: "team",
            name: "Some Team",
            teamId: someTeam,
            rowSportId: w.baseball,
            origin: "hallOfFame",
          },
        ],
      });

      const list = await rows(t, batchId);
      expect(list.map((r) => r.name)).toEqual(["Travis Bazzana"]);
      const line = warn.mock.calls
        .map((c) => String(c[0]))
        .find((s) => s.includes("entity_review_start_batch_malformed_facts"))!;
      expect(JSON.parse(line)).toMatchObject({ malformedFacts: 2 });
      expect(line).not.toContain("No Player");
    } finally {
      warn.mockRestore();
    }
  });

  test("the audit log names ids and origins, never a name", async () => {
    const t = newT();
    const w = await seed(t);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await startBatch(t, w, {
        autoLinks: [
          {
            kind: "player",
            name: "Bo Jackson",
            playerId: w.bo,
            rowSportId: w.football,
            origin: "hallOfFame",
          },
        ],
      });
      const line = log.mock.calls
        .map((c) => String(c[0]))
        .find((s) => s.includes("entity_review_auto_linked"))!;
      expect(JSON.parse(line).links[0]).toMatchObject({ origin: "hallOfFame", playerId: w.bo });
      expect(line).not.toContain("Bo Jackson");
    } finally {
      log.mockRestore();
    }
  });
});

describe("startBatch: history choices and preselects wait for the operator", () => {
  test("a history choice is ready in the set's sport with cross-sport candidates, and not enqueued", async () => {
    const t = newT();
    const w = await seed(t);

    const batchId = await startBatch(t, w, {
      historyCandidates: [{ name: "Bo Jackson", playerIds: [w.bo, w.otherBo] }],
    });

    const [row] = await rows(t, batchId);
    expect(row).toMatchObject({ status: "ready", sportId: w.baseball });
    expect(row.decision).toBeUndefined();
    expect(row.enrichment?.existingCandidates?.map((c) => [c.playerId, c.sportValue])).toEqual([
      [w.bo, "Football"],
      [w.otherBo, "Baseball"],
    ]);
    expect(await enqueuedIds(t)).toEqual([]);
  });

  test("a history choice whose players are all gone falls back to an ordinary looked-up row", async () => {
    const t = newT();
    const w = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.delete(w.bo);
      await ctx.db.delete(w.otherBo);
    });

    const batchId = await startBatch(t, w, {
      historyCandidates: [{ name: "Bo Jackson", playerIds: [w.bo, w.otherBo] }],
    });

    const [row] = await rows(t, batchId);
    expect(row.status).toBe("pending");
    expect(row.enrichment).toBeUndefined();
    expect(await enqueuedIds(t)).toEqual([row._id]);
  });

  test("a preselected name is ready with the suggestion and NO lookup; its neighbours are enqueued", async () => {
    const t = newT();
    const w = await seed(t);
    await t.run((ctx) => ctx.db.delete(w.otherBo));

    const batchId = await startBatch(t, w, {
      playerNames: ["Bo Jackson", "Travis Bazzana"],
      preselects: [
        {
          name: "Bo Jackson",
          playerId: w.bo,
          sportId: w.football,
          sportValue: "Football",
          reason: "priorYearProduct",
        },
      ],
    });

    const list = await rows(t, batchId);
    const bo = byName(list, "Bo Jackson");
    expect(bo.status).toBe("ready");
    expect(bo.decision).toBeUndefined();
    expect(bo.enrichment?.preselect).toEqual({
      playerId: w.bo,
      name: "Bo Jackson",
      sportId: w.football,
      sportValue: "Football",
      reason: "priorYearProduct",
    });
    expect(bo.enrichment?.wikidataId).toBeUndefined();
    expect(await enqueuedIds(t)).toEqual([byName(list, "Travis Bazzana")._id]);
  });

  test("a batch of ONLY preselected names schedules no pool enqueue at all", async () => {
    const t = newT();
    const w = await seed(t);
    await t.run((ctx) => ctx.db.delete(w.otherBo));

    await startBatch(t, w, {
      playerNames: ["Bo Jackson"],
      preselects: [
        {
          name: "Bo Jackson",
          playerId: w.bo,
          sportId: w.football,
          sportValue: "Football",
          reason: "onlyNamesake",
        },
      ],
    });

    expect((await scheduled(t)).filter((r) => r.name === ENQUEUE_FN)).toHaveLength(0);
  });

  test("a preselect rides on a history choice's row", async () => {
    const t = newT();
    const w = await seed(t);

    const batchId = await startBatch(t, w, {
      playerNames: [],
      historyCandidates: [{ name: "Bo Jackson", playerIds: [w.bo, w.otherBo] }],
      preselects: [
        {
          name: "Bo Jackson",
          playerId: w.bo,
          sportId: w.football,
          sportValue: "Football",
          reason: "priorYearProduct",
        },
      ],
    });

    const [row] = await rows(t, batchId);
    expect(row.enrichment?.existingCandidates).toHaveLength(2);
    expect(row.enrichment?.preselect?.playerId).toBe(w.bo);
  });
});

describe("startBatch: resume and continuation carry the facts", () => {
  const autoLink = (w: World) => ({
    kind: "player" as const,
    name: "Bo Jackson",
    playerId: w.bo,
    rowSportId: w.football,
    origin: "setHistory" as const,
  });

  test("a resume with the same facts writes no second row", async () => {
    const t = newT();
    const w = await seed(t);

    const first = await startBatch(t, w, { autoLinks: [autoLink(w)] });
    const second = await startBatch(t, w, { autoLinks: [autoLink(w)] });

    expect(second).toBe(first);
    expect(await rows(t, first)).toHaveLength(1);
  });

  test("a resume never re-decides a row the operator has since Changed", async () => {
    const t = newT();
    const w = await seed(t);
    const batchId = await startBatch(t, w, { autoLinks: [autoLink(w)] });
    const [row] = await rows(t, batchId);
    await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.entityReviewQueue.clearDecision, { reviewRowId: row._id });

    await startBatch(t, w, { autoLinks: [autoLink(w)] });

    const after = await rows(t, batchId);
    expect(after).toHaveLength(1);
    expect(after[0].decision).toBeUndefined();
  });

  test("a resume adds a fact that arrived with the re-Confirm and keeps the old row", async () => {
    const t = newT();
    const w = await seed(t);
    const batchId = await startBatch(t, w, { playerNames: ["Travis Bazzana"] });

    await startBatch(t, w, {
      playerNames: ["Travis Bazzana"],
      autoLinks: [autoLink(w)],
    });

    const list = await rows(t, batchId);
    expect(list.map((r) => r.name).sort()).toEqual(["Bo Jackson", "Travis Bazzana"]);
    expect(byName(list, "Bo Jackson").decision?.action).toBe("link");
  });

  test("a fact the first page cannot afford is carried by the continuation and lands once", async () => {
    const t = newT();
    const w = await seed(t);
    const names = Array.from(
      { length: Math.floor(ENTITY_REVIEW_START_OPS / 3) + 25 },
      (_, i) => `Rookie Number${i}`,
    );
    const args = { playerNames: names, autoLinks: [autoLink(w)] };

    const batchId = await startBatch(t, w, args);

    // Facts go after the plain names, so the first page ran out before it.
    expect((await rows(t, batchId)).some((r) => r.name === "Bo Jackson")).toBe(false);
    const continuation = (await scheduled(t)).find((r) => r.name === START_BATCH_FN)!;
    const sent = continuation.args[0] as {
      autoLinks?: unknown[];
      continueBatchId?: string;
    };
    expect(sent.continueBatchId).toBe(batchId);
    expect(sent.autoLinks).toHaveLength(1);

    let guard = 0;
    while ((await rows(t, batchId)).length < names.length + 1) {
      await startBatch(t, w, args);
      if (++guard > 20) throw new Error("did not converge");
    }
    const list = await rows(t, batchId);
    expect(list.filter((r) => r.name === "Bo Jackson")).toHaveLength(1);
    expect(byName(list, "Bo Jackson").decision).toMatchObject({ autoLinked: "setHistory" });
  });
});

// ===========================================================================
// recordDecision: D7
// ===========================================================================

describe("recordDecision: a link to a player the batch offered may cross sports (D7)", () => {
  async function pickRow(
    t: T,
    w: World,
    enrichment: Record<string, unknown> | undefined,
  ): Promise<Id<"entityReviewQueue">> {
    return t.run((ctx) =>
      ctx.db.insert("entityReviewQueue", {
        selectorOptionId: w.base,
        batchId: "batch-d7",
        createdByUserId: ADMIN_IDENTITY.subject,
        kind: "player",
        name: "Bo Jackson",
        nameNormalized: normalizePlayerName("Bo Jackson"),
        sportId: w.baseball,
        status: "ready",
        ...(enrichment ? { enrichment: enrichment as never } : {}),
      }),
    );
  }
  const candidate = (playerId: Id<"players">, sportValue: string) => ({
    playerId,
    name: "Bo Jackson",
    careerSummary: "",
    sportValue,
  });
  const link = (t: T, reviewRowId: Id<"entityReviewQueue">, linkedPlayerId: Id<"players">, extra = {}) =>
    t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId,
      action: "link",
      linkedPlayerId,
      ...extra,
    });

  test("a listed candidate in another sport is accepted and re-points the row to his home sport", async () => {
    const t = newT();
    const w = await seed(t);
    const rowId = await pickRow(t, w, {
      existingCandidates: [candidate(w.bo, "Football"), candidate(w.otherBo, "Baseball")],
    });

    await link(t, rowId, w.bo);

    const row = await getRow(t, rowId);
    expect(row!.sportId).toBe(w.football);
    expect(row!.decision).toEqual({ action: "link", linkedPlayerId: w.bo });
  });

  test("the preselected player is accepted across sports too", async () => {
    const t = newT();
    const w = await seed(t);
    const rowId = await pickRow(t, w, {
      preselect: {
        playerId: w.bo,
        name: "Bo Jackson",
        sportId: w.football,
        sportValue: "Football",
        reason: "onlyNamesake",
      },
    });

    await link(t, rowId, w.bo);

    expect((await getRow(t, rowId))!.sportId).toBe(w.football);
  });

  test("an unlisted player in another sport is still refused, and nothing is written", async () => {
    const t = newT();
    const w = await seed(t);
    const stranger = await player(t, w.football, "Bo Jackson");
    const rowId = await pickRow(t, w, {
      existingCandidates: [candidate(w.bo, "Football"), candidate(w.otherBo, "Baseball")],
    });

    await expect(link(t, rowId, stranger)).rejects.toThrow(/doesn't match/);

    const row = await getRow(t, rowId);
    expect(row!.decision).toBeUndefined();
    expect(row!.sportId).toBe(w.baseball);
  });

  test("a row with no offer refuses a cross-sport link: the operator's own search stays sport-checked", async () => {
    const t = newT();
    const w = await seed(t);
    const rowId = await pickRow(t, w, undefined);

    await expect(link(t, rowId, w.bo)).rejects.toThrow(/doesn't match/);
  });

  test("a listed candidate in the row's own sport changes nothing about the row's sport", async () => {
    const t = newT();
    const w = await seed(t);
    const rowId = await pickRow(t, w, {
      existingCandidates: [candidate(w.bo, "Football"), candidate(w.otherBo, "Baseball")],
    });

    await link(t, rowId, w.otherBo);

    const row = await getRow(t, rowId);
    expect(row!.sportId).toBe(w.baseball);
    expect(row!.decision).toMatchObject({ linkedPlayerId: w.otherBo });
  });

  test("addSetSport survives a cross-sport pick, because the row ends up off the set's sport", async () => {
    const t = newT();
    const w = await seed(t);
    const rowId = await pickRow(t, w, {
      existingCandidates: [candidate(w.bo, "Football"), candidate(w.otherBo, "Baseball")],
    });

    await link(t, rowId, w.bo, { addSetSport: true });

    expect((await getRow(t, rowId))!.decision).toMatchObject({
      linkedPlayerId: w.bo,
      addSetSport: true,
    });
  });

  test("a link to the set's own sport drops addSetSport as the no-op it is", async () => {
    const t = newT();
    const w = await seed(t);
    const rowId = await pickRow(t, w, {
      existingCandidates: [candidate(w.bo, "Football"), candidate(w.otherBo, "Baseball")],
    });

    await link(t, rowId, w.otherBo, { addSetSport: true });

    expect((await getRow(t, rowId))!.decision).not.toHaveProperty("addSetSport");
  });

  test("a stale offered id (the player was deleted) is refused", async () => {
    const t = newT();
    const w = await seed(t);
    const rowId = await pickRow(t, w, {
      existingCandidates: [candidate(w.bo, "Football"), candidate(w.otherBo, "Baseball")],
    });
    await t.run((ctx) => ctx.db.delete(w.bo));

    await expect(link(t, rowId, w.bo)).rejects.toThrow();
  });

  test("a cross-sport pick releases the New Team steps a lookup staged for a preselected row", async () => {
    const t = newT();
    const w = await seed(t);
    const rowId = await pickRow(t, w, {
      wikidataId: "Q1",
      careerTeams: [{ name: "Los Angeles Raiders", fromYear: 1987 }],
      preselect: {
        playerId: w.bo,
        name: "Bo Jackson",
        sportId: w.football,
        sportValue: "Football",
        reason: "onlyNamesake",
      },
    });
    const staged = await t.run((ctx) =>
      ctx.db.insert("entityReviewQueue", {
        selectorOptionId: w.base,
        batchId: "batch-d7",
        createdByUserId: ADMIN_IDENTITY.subject,
        kind: "team",
        name: "Los Angeles Raiders",
        nameNormalized: normalizeTeamName("Los Angeles Raiders"),
        sportId: w.baseball,
        status: "ready",
        source: { kind: "careerTeamOf", playerRowId: rowId },
      }),
    );

    await link(t, rowId, w.bo);

    expect(await getRow(t, staged)).toBeNull();
  });
});

// ===========================================================================
// clearDecision: D6
// ===========================================================================

describe("clearDecision on an auto-link (D6)", () => {
  const clear = (t: T, reviewRowId: Id<"entityReviewQueue">) =>
    t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.clearDecision, { reviewRowId });

  test("2+ candidates: back to the set's sport as a ready pick step, the linked player as the preselect, no lookup", async () => {
    const t = newT();
    const w = await seed(t);
    const rowId = await insertAutoLinkRow(t, w, { candidates: [w.bo, w.otherBo] });

    await clear(t, rowId);

    const row = (await getRow(t, rowId))!;
    expect(row.decision).toBeUndefined();
    expect(row.sportId).toBe(w.baseball);
    expect(row.status).toBe("ready");
    expect(row.enrichment?.existingCandidates?.map((c) => c.playerId)).toEqual([w.bo, w.otherBo]);
    expect(row.enrichment?.preselect).toEqual({
      playerId: w.bo,
      name: "Bo Jackson",
      sportId: w.football,
      sportValue: "Football",
      reason: "setHistory",
    });
    expect(row.lastTouchedAt).toBeTypeOf("number");
    expect(await enqueuedIds(t)).toEqual([]);
  });

  test("one candidate: a ready New Player step with the preselect, still no lookup", async () => {
    const t = newT();
    const w = await seed(t);
    const rowId = await insertAutoLinkRow(t, w);

    await clear(t, rowId);

    const row = (await getRow(t, rowId))!;
    expect(row.status).toBe("ready");
    expect(row.enrichment?.existingCandidates).toBeUndefined();
    expect(row.enrichment?.preselect).toMatchObject({ playerId: w.bo, reason: "setHistory" });
    expect(await enqueuedIds(t)).toEqual([]);
  });

  test("a Hall of Fame link comes back with reason hallOfFame", async () => {
    const t = newT();
    const w = await seed(t);
    const rowId = await insertAutoLinkRow(t, w, { linked: w.otherBo, origin: "hallOfFame" });

    await clear(t, rowId);

    const row = (await getRow(t, rowId))!;
    expect(row.sportId).toBe(w.baseball);
    expect(row.enrichment?.preselect).toMatchObject({ playerId: w.otherBo, reason: "hallOfFame" });
  });

  test("the linked player deleted since: a pending new name, looked up", async () => {
    const t = newT();
    const w = await seed(t);
    const rowId = await insertAutoLinkRow(t, w);
    await t.run((ctx) => ctx.db.delete(w.bo));

    await clear(t, rowId);

    const row = (await getRow(t, rowId))!;
    expect(row.status).toBe("pending");
    expect(row.sportId).toBe(w.baseball);
    expect(row.enrichment).toBeUndefined();
    expect(await enqueuedIds(t)).toEqual([rowId]);
  });

  test("a team link goes back to pending in the set's sport and gets the lookup it skipped", async () => {
    const t = newT();
    const w = await seed(t);
    const raiders = await t.run((ctx) =>
      ctx.db.insert("teams", {
        location: "Oakland",
        name: "Raiders",
        nameNormalized: normalizeTeamName("Oakland Raiders"),
        sportId: w.football,
        lastUpdated: Date.now(),
      }),
    );
    const rowId = await t.run((ctx) =>
      ctx.db.insert("entityReviewQueue", {
        selectorOptionId: w.base,
        batchId: "batch-al",
        createdByUserId: ADMIN_IDENTITY.subject,
        kind: "team",
        name: "Oakland Raiders",
        nameNormalized: normalizeTeamName("Oakland Raiders"),
        sportId: w.football,
        status: "ready",
        decision: { action: "link", linkedTeamId: raiders, autoLinked: "setHistory" },
      }),
    );

    await clear(t, rowId);

    const row = (await getRow(t, rowId))!;
    expect(row.decision).toBeUndefined();
    expect(row.sportId).toBe(w.baseball);
    expect(row.status).toBe("pending");
    expect(await enqueuedIds(t)).toEqual([rowId]);
  });

  test("Change, then pick the history player again: cross-sport accepted, a plain decision (no autoLinked)", async () => {
    const t = newT();
    const w = await seed(t);
    const rowId = await insertAutoLinkRow(t, w, { candidates: [w.bo, w.otherBo] });
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    await clear(t, rowId);
    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "link",
      linkedPlayerId: w.bo,
    });

    const row = (await getRow(t, rowId))!;
    expect(row.sportId).toBe(w.football);
    expect(row.decision).toEqual({ action: "link", linkedPlayerId: w.bo });
  });

  test("Change, then Add as New Player anyway: the lookup starts then, once", async () => {
    const t = newT();
    const w = await seed(t);
    const rowId = await insertAutoLinkRow(t, w);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    await clear(t, rowId);
    await asAdmin.mutation(api.entityReviewQueue.requestPlayerLookup, { reviewRowId: rowId });
    await asAdmin.mutation(api.entityReviewQueue.requestPlayerLookup, { reviewRowId: rowId });

    expect((await getRow(t, rowId))!.status).toBe("pending");
    expect(await enqueuedIds(t)).toEqual([rowId]);
  });

  test("another operator's auto-link row cannot be cleared", async () => {
    const t = newT();
    const w = await seed(t);
    const rowId = await insertAutoLinkRow(t, w);

    await expect(
      t
        .withIdentity({ ...ADMIN_IDENTITY, subject: "someone_else", tokenIdentifier: "clerk|x" })
        .mutation(api.entityReviewQueue.clearDecision, { reviewRowId: rowId }),
    ).rejects.toThrow();
    expect((await getRow(t, rowId))!.decision).toBeDefined();
  });

  test("an operator's own link (no autoLinked) is cleared the ordinary way: sport untouched", async () => {
    const t = newT();
    const w = await seed(t);
    const rowId = await t.run((ctx) =>
      ctx.db.insert("entityReviewQueue", {
        selectorOptionId: w.base,
        batchId: "batch-al",
        createdByUserId: ADMIN_IDENTITY.subject,
        kind: "player",
        name: "Bo Jackson",
        nameNormalized: normalizePlayerName("Bo Jackson"),
        sportId: w.football,
        status: "ready",
        decision: { action: "link", linkedPlayerId: w.bo },
      }),
    );

    await clear(t, rowId);

    const row = (await getRow(t, rowId))!;
    expect(row.decision).toBeUndefined();
    expect(row.sportId).toBe(w.football);
    expect(row.enrichment).toBeUndefined();
  });
});

// ===========================================================================
// Preselect rows: requestPlayerLookup, staging, lookup, bulk
// ===========================================================================

describe("a preselected row waits for 'Add as New Player anyway'", () => {
  async function preselectRow(t: T, w: World) {
    return t.run((ctx) =>
      ctx.db.insert("entityReviewQueue", {
        selectorOptionId: w.base,
        batchId: "batch-pre",
        createdByUserId: ADMIN_IDENTITY.subject,
        kind: "player",
        name: "Bo Jackson",
        nameNormalized: normalizePlayerName("Bo Jackson"),
        sportId: w.baseball,
        status: "ready",
        enrichment: {
          preselect: {
            playerId: w.bo,
            name: "Bo Jackson",
            sportId: w.football,
            sportValue: "Football",
            reason: "onlyNamesake",
          },
        },
      }),
    );
  }

  test("requestPlayerLookup starts the held-back lookup once", async () => {
    const t = newT();
    const w = await seed(t);
    const rowId = await preselectRow(t, w);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    await asAdmin.mutation(api.entityReviewQueue.requestPlayerLookup, { reviewRowId: rowId });
    await asAdmin.mutation(api.entityReviewQueue.requestPlayerLookup, { reviewRowId: rowId });

    const row = (await getRow(t, rowId))!;
    expect(row.status).toBe("pending");
    expect(row.enrichment?.preselect?.playerId).toBe(w.bo);
    expect(await enqueuedIds(t)).toEqual([rowId]);
  });

  test("typed career teams are refused until the lookup is requested, then stage as usual", async () => {
    const t = newT();
    const w = await seed(t);
    const rowId = await preselectRow(t, w);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    await expect(
      asAdmin.mutation(api.entityReviewQueue.stageCareerTeamRows, {
        reviewRowId: rowId,
        careerTeams: [{ name: "Los Angeles Raiders", fromYear: 1987 }],
      }),
    ).rejects.toThrow(/Create new/);

    await asAdmin.mutation(api.entityReviewQueue.requestPlayerLookup, { reviewRowId: rowId });
    const added = await asAdmin.mutation(api.entityReviewQueue.stageCareerTeamRows, {
      reviewRowId: rowId,
      careerTeams: [{ name: "Los Angeles Raiders", fromYear: 1987 }],
    });
    expect(added).toBe(1);
  });

  test("the lookup landing keeps the preselect, and a Wikidata miss keeps it too", async () => {
    const t = newT();
    const w = await seed(t);
    const rowId = await preselectRow(t, w);
    await t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.requestPlayerLookup, {
      reviewRowId: rowId,
    });

    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: rowId,
      status: "ready",
      enrichment: { wikidataId: "Q1" },
      sportId: w.baseball,
    });
    const landed = (await getRow(t, rowId))!;
    expect(landed.enrichment?.wikidataId).toBe("Q1");
    expect(landed.enrichment?.preselect?.playerId).toBe(w.bo);

    const second = await preselectRow(t, w);
    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: second,
      status: "error",
      sportId: w.baseball,
    });
    expect((await getRow(t, second))!.enrichment?.preselect?.playerId).toBe(w.bo);
  });

  test("history candidates (any sport) survive the lookup, lead the live ones, and are not repeated", async () => {
    const t = newT();
    const w = await seed(t);
    const rowId = await t.run((ctx) =>
      ctx.db.insert("entityReviewQueue", {
        selectorOptionId: w.base,
        batchId: "batch-pre",
        createdByUserId: ADMIN_IDENTITY.subject,
        kind: "player",
        name: "Bo Jackson",
        nameNormalized: normalizePlayerName("Bo Jackson"),
        sportId: w.baseball,
        status: "pending",
        enrichment: {
          existingCandidates: [
            { playerId: w.bo, name: "Bo Jackson", careerSummary: "", sportValue: "Football" },
          ],
        },
      }),
    );
    // A second baseball Bo Jackson makes the live index see two rows, one of
    // which (otherBo) the history candidate list does not hold.
    await player(t, w.baseball, "Bo Jackson");

    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: rowId,
      status: "ready",
      enrichment: { wikidataId: "Q1" },
      sportId: w.baseball,
    });

    const ids = (await getRow(t, rowId))!.enrichment?.existingCandidates?.map((c) => c.playerId);
    expect(ids![0]).toBe(w.bo);
    expect(new Set(ids).size).toBe(ids!.length);
    expect(ids).toContain(w.otherBo);
  });

  test("bulk 'add remaining as new' still creates a preselected row", async () => {
    const t = newT();
    const w = await seed(t);
    await t.run((ctx) => ctx.db.delete(w.otherBo));
    const rowId = await preselectRow(t, w);

    const page = await t.query(internal.entityReviewQueue.listBulkCandidates, {
      selectorOptionId: w.base,
      batchId: "batch-pre",
      action: "create",
      callerId: ADMIN_IDENTITY.subject,
    });
    expect(page.ids).toEqual([rowId]);
    const decided = await t.mutation(internal.entityReviewQueue.decideRowsByIds, {
      ids: page.ids,
      selectorOptionId: w.base,
      batchId: "batch-pre",
      action: "create",
      callerId: ADMIN_IDENTITY.subject,
    });

    expect(decided).toBe(1);
    expect((await getRow(t, rowId))!.decision?.action).toBe("create");
  });

  test("bulk create leaves a history choice (2+ players the set linked) for the operator, but bulk skip takes it", async () => {
    const t = newT();
    const w = await seed(t);
    const batchId = await startBatch(t, w, {
      historyCandidates: [{ name: "Bo Jackson", playerIds: [w.bo, w.otherBo] }],
    });
    // Remove the in-sport twin so the LIVE index alone would call the name
    // unambiguous: only the row's own stored history keeps it out of the bulk.
    await t.run((ctx) => ctx.db.delete(w.otherBo));

    const create = await t.query(internal.entityReviewQueue.listBulkCandidates, {
      selectorOptionId: w.base,
      batchId,
      action: "create",
      callerId: ADMIN_IDENTITY.subject,
    });
    expect(create.ids).toEqual([]);
    const skip = await t.query(internal.entityReviewQueue.listBulkCandidates, {
      selectorOptionId: w.base,
      batchId,
      action: "skip",
      callerId: ADMIN_IDENTITY.subject,
    });
    expect(skip.ids).toHaveLength(1);
  });
});
