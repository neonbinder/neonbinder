/**
 * NEO-464 — the dashboard's own reads and its visit stamp
 * (`convex/dashboard.ts`): the pure rules first, then each function on the
 * small collection catalog (`lib/testing/collection-fixture.ts`), then the
 * slice-4 reads (could fit, intake, sales):
 *
 *   Topps Chrome  Base #1 Gooden, #2 Strawberry, #1 Gooden "Sliding" (variation)
 *                 Parallels › Gold Refractor #1 Gooden /50
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  COULD_FIT_CARDS,
  FILED_ONLY_ERA_END,
  FRESH_PULL_LINES,
  STAMP_SLACK_MS,
  SYNC_ALERTS_SHOWN,
  SYNC_CARDS_NAMED,
  INTAKE_PREVIEW_CARDS,
  INTAKE_RECENT_MS,
  INTAKE_RUNS,
  NEW_SETS_SHOWN,
  SALE_LINES,
  SET_LOAD_MS,
  SALES_SHOWN,
  STAMP_MIN_MS,
  VISIT_GAP_MS,
  arrivalOf,
  baseCompletion,
  checklistLoads,
  intakeRunSorted,
  intakeRunTally,
  legacyStampOf,
  mergeStamped,
  newSetsSettled,
  nextVisit,
  ruleNamesChecklist,
  saleLinesOf,
  smartChecklistCount,
  syncOutcome,
} from "./dashboard";
import { awaitingShipment } from "./listingSales";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "collector_me_001" };
const THEM = { subject: "collector_them_002" };
const DAY = 86_400_000;

// ───────────────────────────────────────────────────────────────────────────
// Pure rules
// ───────────────────────────────────────────────────────────────────────────

describe("arrivalOf", () => {
  test("the acquired day, at noon UTC, keeps the day itself", () => {
    expect(arrivalOf({ acquiredOn: "2026-11-05", _creationTime: 1 })).toEqual({
      ms: Date.UTC(2026, 10, 5, 12),
      day: "2026-11-05",
    });
  });

  test("no acquired day (or a malformed one): when the line was first written", () => {
    expect(arrivalOf({ _creationTime: 1234 })).toEqual({ ms: 1234, day: null });
    expect(arrivalOf({ acquiredOn: "last week", _creationTime: 99 })).toEqual({ ms: 99, day: null });
  });
});

describe("baseCompletion", () => {
  const at = (cardId: string, day: string) => ({ cardId, acquiredOn: day, _creationTime: 0 });

  test("finished when the last card was FIRST held; a later second copy finishes nothing", () => {
    const done = baseCompletion(
      ["a", "b", "c"],
      [at("a", "2026-11-01"), at("c", "2026-11-03"), at("b", "2026-11-02"), at("a", "2026-11-08")],
    );
    expect(done).toEqual({
      whenMs: Date.UTC(2026, 10, 3, 12),
      whenDay: "2026-11-03",
      lastCardId: "c",
      byArrival: ["c", "b", "a"],
    });
  });

  test("a card with no copy: not finished", () => {
    expect(baseCompletion(["a", "b"], [at("a", "2026-11-01")])).toBeNull();
  });

  test("a parallel or variation copy (a card outside the checklist) counts for nothing", () => {
    expect(baseCompletion(["a", "b"], [at("a", "2026-11-01"), at("b-gold", "2026-11-02")])).toBeNull();
  });

  test("an empty checklist is never finished", () => {
    expect(baseCompletion([], [at("a", "2026-11-01")])).toBeNull();
  });

  test("a tie on the finishing moment goes to the card later in the checklist", () => {
    expect(baseCompletion(["a", "b"], [at("a", "2026-11-02"), at("b", "2026-11-02")])?.lastCardId).toBe("b");
  });
});

describe("nextVisit", () => {
  const T = 1_800_000_000_000;

  test("the first open ever: nothing to compare, stamped", () => {
    expect(nextVisit(undefined, T)).toEqual({ visit: { seenAt: T }, since: null, write: true });
  });

  test("a later open starts a new visit whose news starts at the last open", () => {
    const later = T + VISIT_GAP_MS + 1;
    expect(nextVisit({ seenAt: T, sinceAt: T - DAY }, later)).toEqual({
      visit: { seenAt: later, sinceAt: T },
      since: T,
      write: true,
    });
  });

  test("Back within the visit keeps its news and slides the visit along", () => {
    const back = T + 5 * 60_000;
    expect(nextVisit({ seenAt: T, sinceAt: T - DAY }, back)).toEqual({
      visit: { seenAt: back, sinceAt: T - DAY },
      since: T - DAY,
      write: true,
    });
  });

  test("a reopen within STAMP_MIN_MS (a double mount) writes nothing", () => {
    expect(nextVisit({ seenAt: T, sinceAt: T - DAY }, T + STAMP_MIN_MS - 1)).toEqual({
      visit: { seenAt: T, sinceAt: T - DAY },
      since: T - DAY,
      write: false,
    });
    // A clock that ran backwards is the same visit, unwritten.
    expect(nextVisit({ seenAt: T }, T - 10_000).write).toBe(false);
  });
});

describe("checklistLoads (New on NeonBinder's grouping)", () => {
  const T = 1_800_000_000_000;
  const hop = (setId: string, name: string, at: number, isBase = false) => ({ variantId: `${setId}/${name}`, setId, name, at, isBase });
  const read = (hops: ReturnType<typeof hop>[]) => checklistLoads(hops).map((e) => [e.kind, e.opens.name, e.at]);

  test("a set loaded with its Base, inserts and parallels is one entry, the set, opening on its Base", () => {
    expect(read([hop("s", "Gold", T), hop("s", "Base", T - 10, true), hop("s", "Future Stars", T - 20)])).toEqual([
      ["set", "Base", T],
    ]);
  });

  test("a lone variant is its own entry; several without the Base are one entry each, newest first", () => {
    expect(read([hop("s", "Gold", T)])).toEqual([["variant", "Gold", T]]);
    expect(read([hop("s", "Gold", T), hop("t", "Base", T - 5, true), hop("s", "Red", T - 10)])).toEqual([
      ["variant", "Gold", T],
      ["set", "Base", T - 5],
      ["variant", "Red", T - 10],
    ]);
  });

  test("a variant uploaded long after its set's load is news of its own; the set's old load stays a set entry", () => {
    const later = T + SET_LOAD_MS + 1;
    expect(read([hop("s", "Gold", later), hop("s", "Base", T, true), hop("s", "Red", T - 1)])).toEqual([
      ["variant", "Gold", later],
      ["set", "Base", T],
    ]);
  });

  test("a checklist opens once: an older load of the same Base is dropped, and a repeat inside a load counts once", () => {
    const later = T + SET_LOAD_MS + 1;
    expect(read([hop("s", "Base", later, true), hop("s", "Gold", T), hop("s", "Base", T - 1, true)])).toEqual([["set", "Base", later]]);
    expect(read([hop("s", "Gold", T), hop("s", "Gold", T - 5)])).toEqual([["variant", "Gold", T]]);
  });

  test("settled only once the walk is below every shown entry's load window", () => {
    const entries = checklistLoads([hop("s", "Gold", T), hop("t", "Base", T - 5, true)]);
    expect(newSetsSettled(entries, T - 100, 3)).toBe(false); // too few
    expect(newSetsSettled(entries, T - 100, 2)).toBe(false); // a Base could still fold Gold into its set
    expect(newSetsSettled(entries, T - SET_LOAD_MS, 2)).toBe(false); // t's load is still open
    expect(newSetsSettled(entries, T - 5 - SET_LOAD_MS, 2)).toBe(true);
  });
});

describe("ruleNamesChecklist", () => {
  const set = { test: { kind: "set" as const, setIds: ["s"] } };
  const player = { test: { kind: "player" as const, playerIds: ["p"] } };

  test("all-of with a set term names a checklist; a player or team rule does not", () => {
    expect(ruleNamesChecklist({ match: "all", terms: [set, player] })).toBe(true);
    expect(ruleNamesChecklist({ match: "all", terms: [player] })).toBe(false);
    expect(ruleNamesChecklist({ match: "all", terms: [{ ...set, negate: true }] })).toBe(false);
  });

  test("any-of names a checklist only when every term is a set", () => {
    expect(ruleNamesChecklist({ match: "any", terms: [set, set] })).toBe(true);
    expect(ruleNamesChecklist({ match: "any", terms: [set, player] })).toBe(false);
    expect(ruleNamesChecklist({ match: "any", terms: [] })).toBe(false);
  });
});

describe("smartChecklistCount", () => {
  test("counts the fits as the empty slots draw them: a parallel only once the binder holds a card of it", () => {
    const fits = [
      { cardId: "b1", variantId: "base" },
      { cardId: "b2", variantId: "base" },
      { cardId: "g1", variantId: "gold" },
      { cardId: "g2", variantId: "gold" },
      { cardId: "r1", variantId: "red" },
    ];
    const parallels = new Set(["gold", "red"]);
    expect(smartChecklistCount(fits, new Set(["b1"]), parallels)).toEqual({ have: 1, total: 2 });
    expect(smartChecklistCount(fits, new Set(["b1", "g2"]), parallels)).toEqual({ have: 2, total: 4 });
  });
});

describe("intakeRunTally", () => {
  const row = (id: string, frontIndex: number, extra: { cardId?: string; savedAt?: number; setAside?: boolean } = {}) => ({
    _id: id,
    frontIndex,
    ...extra,
  });

  test("saved or set aside is out; open with a card waits on a yes; open with none is unidentified", () => {
    const tally = intakeRunTally([
      row("m3", 3, { cardId: "c3" }),
      row("m1", 1, { cardId: "c1", savedAt: 5 }),
      row("m2", 2, { setAside: true }),
      row("m4", 4),
      row("m0", 0, { cardId: "c0" }),
    ]);
    expect(tally).toEqual({
      scans: 5,
      done: 2,
      needsYou: 2,
      unidentified: 1,
      guesses: [
        { id: "m0", cardId: "c0" },
        { id: "m3", cardId: "c3" },
      ],
    });
  });

  test("the preview is capped; the counts are not", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`g${i}`, i, { cardId: `c${i}` }));
    const tally = intakeRunTally(rows);
    expect(tally.needsYou).toBe(10);
    expect(tally.guesses.map((g) => g.id)).toEqual(["g0", "g1", "g2"]);
  });

  test("an empty run counts nothing", () => {
    expect(intakeRunTally([])).toEqual({ scans: 0, done: 0, needsYou: 0, unidentified: 0, guesses: [] });
  });
});

describe("intakeRunSorted", () => {
  test("every scan saved or set aside is sorted; one open scan is not; an empty run never is", () => {
    expect(intakeRunSorted({ scans: 4, done: 4 })).toBe(true);
    expect(intakeRunSorted({ scans: 4, done: 3 })).toBe(false);
    expect(intakeRunSorted({ scans: 0, done: 0 })).toBe(false);
  });
});

describe("awaitingShipment", () => {
  test("a sold order the platform has not reported shipped", () => {
    expect(awaitingShipment("bsc", "READY_TO_SHIP")).toBe(true);
    expect(awaitingShipment("bsc", "PARTIALLY_REFUNDED_READY_TO_SHIP")).toBe(true);
    expect(awaitingShipment("ebay", "PAID")).toBe(true);
    expect(awaitingShipment("ebay", "NOT_STARTED")).toBe(true);
    expect(awaitingShipment("ebay", "IN_PROGRESS")).toBe(true);
  });

  test("shipped, cancelled, or a status NB does not know: nothing to ship", () => {
    expect(awaitingShipment("bsc", "SHIPPED")).toBe(false);
    expect(awaitingShipment("bsc", "PARTIALLY_REFUNDED_SHIPPED")).toBe(false);
    expect(awaitingShipment("bsc", "CANCELLED")).toBe(false);
    expect(awaitingShipment("bsc", "SOMETHING_NEW")).toBe(false);
    expect(awaitingShipment("ebay", "FULFILLED")).toBe(false);
    expect(awaitingShipment("ebay", "CANCELED")).toBe(false);
    expect(awaitingShipment("ebay", "FULLY_REFUNDED")).toBe(false);
    expect(awaitingShipment("ebay", "PENDING")).toBe(false);
    expect(awaitingShipment("ebay", "FAILED")).toBe(false);
    expect(awaitingShipment("ebay", "SOMETHING_NEW")).toBe(false);
  });
});

describe("saleLinesOf", () => {
  const card = "card_1" as Id<"cardChecklist">;

  test("a line NB could not tie to a card carries none and reads unmatched; a tied line keeps its card", () => {
    const out = saleLinesOf([
      { cardId: card, quantity: 1 },
      { quantity: 2 },
      { cardId: card, quantity: 1, problem: "linkMismatch" },
      { cardId: card, quantity: 3, problem: "oversold", shortBy: 1 },
    ]);
    expect(out.lines).toEqual([
      { cardId: card, quantity: 1 },
      { quantity: 2, problem: "unmatched" },
      { quantity: 1, problem: "linkMismatch" },
      { cardId: card, quantity: 3, problem: "oversold", shortBy: 1 },
    ]);
    expect(out.cardCount).toBe(7);
    expect(out.problemPastCut).toBe(false);
  });

  test("past SALE_LINES the lines are cut, still counted, and a problem there is reported", () => {
    const items = Array.from({ length: SALE_LINES + 3 }, () => ({ cardId: card, quantity: 1 }));
    expect(saleLinesOf(items)).toMatchObject({ cardCount: SALE_LINES + 3, problemPastCut: false });
    expect(saleLinesOf(items).lines).toHaveLength(SALE_LINES);
    const withProblem = [...items, { quantity: 1 }];
    expect(saleLinesOf(withProblem).problemPastCut).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The functions, on the fixture catalog
// ───────────────────────────────────────────────────────────────────────────

async function setup() {
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  const homes = await t.run(async (ctx) => {
    const home = (ownerId: string, kind: "binder" | "box", name: string, system?: "main" | "unsorted") =>
      ctx.db.insert("collectionContainers", {
        ownerId,
        kind,
        ...(system ? { system } : {}),
        name,
        lastUpdated: 0,
      });
    return {
      main: await home(ME.subject, "binder", "Main", "main"),
      box: await home(ME.subject, "box", "Unsorted", "unsorted"),
      theirMain: await home(THEM.subject, "binder", "Main", "main"),
    };
  });
  return { t, fx, homes, me: t.withIdentity(ME), them: t.withIdentity(THEM) };
}
type S = Awaited<ReturnType<typeof setup>>;

/** A line of `cardId` in `homeId`, as the copy writes store it (variant and set denormalised). */
function line(
  s: S,
  cardId: Id<"cardChecklist">,
  variantId: Id<"selectorOptions">,
  opts: { homeId?: Id<"collectionContainers">; ownerId?: string; acquiredOn?: string; lastUpdated: number; filedAt?: number },
) {
  return s.t.run((ctx) =>
    ctx.db.insert("collectionCopies", {
      ownerId: opts.ownerId ?? ME.subject,
      cardId,
      variantId,
      setId: s.fx.setId,
      homeId: opts.homeId ?? s.homes.main,
      quantity: 1,
      ...(opts.acquiredOn ? { acquiredOn: opts.acquiredOn } : {}),
      lastUpdated: opts.lastUpdated,
      ...(opts.filedAt !== undefined ? { filedAt: opts.filedAt } : {}),
    }),
  );
}

const NOW = Date.UTC(2026, 10, 9, 15);
const WINDOW = NOW - 11 * DAY;

describe("justCompleted", () => {
  test("refuses a signed-out caller", async () => {
    const s = await setup();
    await expect(s.t.query(api.dashboard.justCompleted, { sinceMs: WINDOW })).rejects.toThrow(/Not authenticated/);
  });

  test("a base checklist held whole, its last card in the window: the set, its count and its finishing card", async () => {
    const s = await setup();
    await line(s, s.fx.gooden1, s.fx.baseId, { acquiredOn: "2026-10-01", lastUpdated: NOW - 2 * DAY });
    await line(s, s.fx.strawberry2, s.fx.baseId, { acquiredOn: "2026-11-07", lastUpdated: NOW - 2 * DAY });
    const done = await s.me.query(api.dashboard.justCompleted, { sinceMs: WINDOW });
    expect(done).toEqual([
      {
        setId: s.fx.setId,
        setLabel: "2024 Topps Chrome",
        checklistName: null,
        total: 2,
        whenMs: Date.UTC(2026, 10, 7, 12),
        whenDay: "2026-11-07",
        lastCardId: s.fx.strawberry2,
        cardIds: [s.fx.strawberry2, s.fx.gooden1],
      },
    ]);
  });

  test("names the set with its brand, as its cards' listing titles do (NEO-464)", async () => {
    const s = await setup();
    // A set filed under Topps whose own name does not lead with it.
    await s.t.run((ctx) => ctx.db.patch(s.fx.setId, { value: "Chrome" }));
    await line(s, s.fx.gooden1, s.fx.baseId, { acquiredOn: "2026-10-01", lastUpdated: NOW - 2 * DAY });
    await line(s, s.fx.strawberry2, s.fx.baseId, { acquiredOn: "2026-11-07", lastUpdated: NOW - 2 * DAY });
    const done = await s.me.query(api.dashboard.justCompleted, { sinceMs: WINDOW });
    expect(done.map((d) => d.setLabel)).toEqual(["2024 Topps Chrome"]);
  });

  test("finished before the window: left out, even though a line was touched in it", async () => {
    const s = await setup();
    await line(s, s.fx.gooden1, s.fx.baseId, { acquiredOn: "2026-09-01", lastUpdated: NOW - DAY });
    await line(s, s.fx.strawberry2, s.fx.baseId, { acquiredOn: "2026-09-02", lastUpdated: NOW - DAY });
    expect(await s.me.query(api.dashboard.justCompleted, { sinceMs: WINDOW })).toEqual([]);
  });

  test("a set not complete is left out", async () => {
    const s = await setup();
    await line(s, s.fx.gooden1, s.fx.baseId, { acquiredOn: "2026-11-07", lastUpdated: NOW - DAY });
    expect(await s.me.query(api.dashboard.justCompleted, { sinceMs: WINDOW })).toEqual([]);
  });

  test("a parallel never stands in for its base card", async () => {
    const s = await setup();
    await line(s, s.fx.gold1, s.fx.goldId, { acquiredOn: "2026-11-07", lastUpdated: NOW - DAY });
    await line(s, s.fx.strawberry2, s.fx.baseId, { acquiredOn: "2026-11-07", lastUpdated: NOW - DAY });
    expect(await s.me.query(api.dashboard.justCompleted, { sinceMs: WINDOW })).toEqual([]);
  });

  test("an image variation never stands in for the regular card", async () => {
    const s = await setup();
    await line(s, s.fx.gooden1Sliding, s.fx.baseId, { acquiredOn: "2026-11-07", lastUpdated: NOW - DAY });
    await line(s, s.fx.strawberry2, s.fx.baseId, { acquiredOn: "2026-11-07", lastUpdated: NOW - DAY });
    expect(await s.me.query(api.dashboard.justCompleted, { sinceMs: WINDOW })).toEqual([]);
  });

  test("a box's copy is for sale, not in the collection: it does not complete the set", async () => {
    const s = await setup();
    await line(s, s.fx.gooden1, s.fx.baseId, { homeId: s.homes.box, acquiredOn: "2026-11-07", lastUpdated: NOW - DAY });
    await line(s, s.fx.strawberry2, s.fx.baseId, { acquiredOn: "2026-11-07", lastUpdated: NOW - DAY });
    expect(await s.me.query(api.dashboard.justCompleted, { sinceMs: WINDOW })).toEqual([]);
  });

  test("another collector's copies are theirs, and an empty collection finishes nothing", async () => {
    const s = await setup();
    await line(s, s.fx.gooden1, s.fx.baseId, { homeId: s.homes.theirMain, ownerId: THEM.subject, acquiredOn: "2026-11-07", lastUpdated: NOW - DAY });
    await line(s, s.fx.strawberry2, s.fx.baseId, { acquiredOn: "2026-11-07", lastUpdated: NOW - DAY });
    expect(await s.me.query(api.dashboard.justCompleted, { sinceMs: WINDOW })).toEqual([]);
    const fresh = await setup();
    expect(await fresh.me.query(api.dashboard.justCompleted, { sinceMs: WINDOW })).toEqual([]);
  });
});

describe("setBoard", () => {
  test("the set's regular base cards in order, lit where held in the collection; a parallel lights nothing", async () => {
    const s = await setup();
    await line(s, s.fx.strawberry2, s.fx.baseId, { lastUpdated: NOW });
    await line(s, s.fx.gold1, s.fx.goldId, { lastUpdated: NOW });
    expect(await s.me.query(api.dashboard.setBoard, { setId: s.fx.setId })).toEqual({
      cards: [
        { cardId: s.fx.gooden1, cardNumber: "1", owned: false },
        { cardId: s.fx.strawberry2, cardNumber: "2", owned: true },
      ],
      truncated: false,
    });
  });

  test("another collector's copy lights nothing on mine, and mine nothing on theirs", async () => {
    const s = await setup();
    await line(s, s.fx.gooden1, s.fx.baseId, { homeId: s.homes.theirMain, ownerId: THEM.subject, lastUpdated: NOW });
    await line(s, s.fx.strawberry2, s.fx.baseId, { lastUpdated: NOW });
    const lit = async (who: S["me"]) =>
      (await who.query(api.dashboard.setBoard, { setId: s.fx.setId }))!.cards.filter((c) => c.owned).map((c) => c.cardId);
    expect(await lit(s.me)).toEqual([s.fx.strawberry2]);
    expect(await lit(s.them)).toEqual([s.fx.gooden1]);
  });

  test("null for an id that is not a set", async () => {
    const s = await setup();
    expect(await s.me.query(api.dashboard.setBoard, { setId: s.fx.baseId })).toBeNull();
    expect(await s.me.query(api.dashboard.setBoard, { setId: "not-an-id" })).toBeNull();
  });
});

describe("smartChecklist", () => {
  async function smartBinder(s: S, rule: unknown, opts: { state?: boolean } = {}) {
    return s.t.run(async (ctx) => {
      const binderId = await ctx.db.insert("collectionContainers", {
        ownerId: ME.subject,
        kind: "binder",
        name: "Chrome, every card",
        rule: rule as never,
        lastUpdated: 0,
      });
      const fits: Array<[Id<"cardChecklist">, Id<"selectorOptions">]> = [
        [s.fx.gooden1, s.fx.baseId],
        [s.fx.strawberry2, s.fx.baseId],
        [s.fx.gold1, s.fx.goldId],
      ];
      for (const [i, [cardId, variantId]] of fits.entries()) {
        await ctx.db.insert("collectionBinderFits", { ownerId: ME.subject, binderId, cardId, variantId, order: i, generation: 1 });
      }
      if (opts.state !== false) {
        await ctx.db.insert("collectionBinderFitsState", {
          ownerId: ME.subject,
          binderId,
          computedAt: 0,
          supported: true,
          complete: true,
          count: fits.length,
          generation: 1,
        });
      }
      return binderId;
    });
  }
  const setRule = (setId: string) => ({ version: 1, match: "all", terms: [{ test: { kind: "set", setIds: [setId] } }] });

  test("counts the filed fits against the checklist, the Gold parallel left out until one is filed", async () => {
    const s = await setup();
    const binderId = await smartBinder(s, setRule(s.fx.setId));
    await line(s, s.fx.gooden1, s.fx.baseId, { homeId: binderId, lastUpdated: NOW });
    expect(await s.me.query(api.dashboard.smartChecklist, { containerId: binderId })).toEqual({ have: 1, total: 2 });
    await line(s, s.fx.gold1, s.fx.goldId, { homeId: binderId, lastUpdated: NOW });
    expect(await s.me.query(api.dashboard.smartChecklist, { containerId: binderId })).toEqual({ have: 2, total: 3 });
  });

  test("no honest number: a player rule, fits not computed yet, or another collector asking", async () => {
    const s = await setup();
    const player = await smartBinder(s, { version: 1, match: "all", terms: [{ test: { kind: "player", playerIds: [s.fx.goodenId] } }] });
    expect(await s.me.query(api.dashboard.smartChecklist, { containerId: player })).toBeNull();
    const pending = await smartBinder(s, setRule(s.fx.setId), { state: false });
    expect(await s.me.query(api.dashboard.smartChecklist, { containerId: pending })).toBeNull();
    const mine = await smartBinder(s, setRule(s.fx.setId));
    expect(await s.them.query(api.dashboard.smartChecklist, { containerId: mine })).toBeNull();
  });
});

describe("newSince", () => {
  /** Let the wall clock pass a millisecond, so a later write's stamp is strictly later. */
  const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

  test("the collection lines filed after the stamp, newest first; never a box's, never another collector's", async () => {
    const s = await setup();
    await line(s, s.fx.gooden1, s.fx.baseId, { lastUpdated: NOW - 3 * DAY, filedAt: NOW - 3 * DAY });
    await line(s, s.fx.strawberry2, s.fx.baseId, { lastUpdated: NOW - DAY, filedAt: NOW - DAY });
    await line(s, s.fx.gold1, s.fx.goldId, { lastUpdated: NOW, filedAt: NOW });
    await line(s, s.fx.gooden1, s.fx.baseId, { homeId: s.homes.box, lastUpdated: NOW, filedAt: NOW });
    await line(s, s.fx.gooden1, s.fx.baseId, { homeId: s.homes.theirMain, ownerId: THEM.subject, lastUpdated: NOW, filedAt: NOW });
    const result = await s.me.query(api.dashboard.newSince, { sinceMs: NOW - 2 * DAY });
    expect(result).toEqual({
      lines: [
        { homeId: s.homes.main, cardId: s.fx.gold1, filedAt: NOW },
        { homeId: s.homes.main, cardId: s.fx.strawberry2, filedAt: NOW - DAY },
      ],
      truncated: false,
    });
  });

  test("a line written after the stamp but not filed since (an edit, a sale) is not news", async () => {
    const s = await setup();
    await line(s, s.fx.gooden1, s.fx.baseId, { lastUpdated: NOW });
    await line(s, s.fx.strawberry2, s.fx.baseId, { lastUpdated: NOW, filedAt: NOW - 3 * DAY });
    expect(await s.me.query(api.dashboard.newSince, { sinceMs: NOW - 2 * DAY })).toEqual({ lines: [], truncated: false });
  });

  test("through the real writes: any add into a binder is filed, Main included; an edit, a trade flag or a pocket shuffle is not", async () => {
    const s = await setup();
    const mets = await s.t.run((ctx) =>
      ctx.db.insert("collectionContainers", { ownerId: ME.subject, kind: "binder", name: "Mets", lastUpdated: 0 }),
    );
    const since = Date.now() - 1;
    const news = async (sinceMs = since) =>
      (await s.me.query(api.dashboard.newSince, { sinceMs })).lines.map((l) => `${l.homeId}|${l.cardId}`).sort();
    const filedAtOf = async (id: Id<"collectionCopies">) => (await s.t.run((ctx) => ctx.db.get(id)))?.filedAt;

    // Adds (Jason, 2026-11-10: "adding cards to a binder in any way is filed"):
    // one into Main, one straight into a binder. Both are news, each in its own home.
    const gooden = await s.me.mutation(api.collection.addHave, { cardId: s.fx.gooden1 });
    const straw = await s.me.mutation(api.collection.addHave, { cardId: s.fx.strawberry2, homeId: mets });
    expect(await news()).toEqual([`${mets}|${s.fx.strawberry2}`, `${s.homes.main}|${s.fx.gooden1}`].sort());
    const stamped = await filedAtOf(straw.copyId);
    expect(stamped).toBeGreaterThan(since);

    // An edit, a pocket shuffle inside the same binder and a trade flag keep the stamp as it was.
    await tick();
    await s.me.mutation(api.collection.updateCopy, { copyId: straw.copyId, details: { quantity: 1, notes: "corner ding" } });
    await s.me.mutation(api.collection.placeCopy, { copyId: straw.copyId, slot: 5 });
    await s.me.mutation(api.collection.setTrade, { copyId: straw.copyId, on: true });
    expect(await filedAtOf(straw.copyId)).toBe(stamped);
    expect(await news(stamped!)).toEqual([]);

    // A second add that folds into the line files it again.
    await tick();
    const again = await s.me.mutation(api.collection.addHave, { cardId: s.fx.gooden1 });
    expect(again).toMatchObject({ copyId: gooden.copyId, merged: true });
    expect(await news(stamped!)).toEqual([`${s.homes.main}|${s.fx.gooden1}`]);

    // Filing Gooden out of Main into the Mets binder is news in the binder it went to.
    await tick();
    const afterFold = (await filedAtOf(gooden.copyId))!;
    await s.me.mutation(api.collection.moveCopy, { copyId: gooden.copyId, toHomeId: mets });
    expect(await news(afterFold)).toEqual([`${mets}|${s.fx.gooden1}`]);
  });

  test("a part split off inside the same binder keeps its source's stamp; split into another home, it is filed now", async () => {
    const s = await setup();
    const mets = await s.t.run((ctx) =>
      ctx.db.insert("collectionContainers", { ownerId: ME.subject, kind: "binder", name: "Mets", lastUpdated: 0 }),
    );
    const added = await s.me.mutation(api.collection.addHaves, { cardIds: [s.fx.gooden1, s.fx.gooden1], homeId: mets });
    const copyId = added[0].copyId;
    const stamp = (await s.t.run((ctx) => ctx.db.get(copyId)))!.filedAt!;
    await tick();
    const shuffled = await s.me.mutation(api.collection.moveCopy, { copyId, toHomeId: mets, quantity: 1, slot: 7 });
    expect(shuffled.split).toBe(true);
    expect((await s.t.run((ctx) => ctx.db.get(shuffled.copyId)))!.filedAt).toBe(stamp);
    await tick();
    const toMain = await s.me.mutation(api.collection.moveCopy, { copyId: shuffled.copyId, toHomeId: s.homes.main });
    expect((await s.t.run((ctx) => ctx.db.get(toMain.copyId)))!.filedAt).toBeGreaterThan(stamp);
  });

  test("a box raise files cards into the box; taking it back with Undo does not stamp again", async () => {
    const s = await setup();
    const raised = await s.me.mutation(api.collectionInventory.setBoxQuantity, {
      cardId: s.fx.gooden1,
      boxId: s.homes.box,
      quantity: 2,
    });
    const rows = await s.t.run((ctx) =>
      ctx.db
        .query("collectionCopies")
        .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ME.subject).eq("cardId", s.fx.gooden1))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    const stamp = rows[0].filedAt!;
    expect(typeof stamp).toBe("number");
    // A box is never on the dashboard's binder shelf.
    expect((await s.me.query(api.dashboard.newSince, { sinceMs: stamp - 1 })).lines).toEqual([]);
    await tick();
    const lowered = await s.me.mutation(api.collectionInventory.setBoxQuantity, {
      cardId: s.fx.gooden1,
      boxId: s.homes.box,
      quantity: 1,
    });
    expect((await s.t.run((ctx) => ctx.db.get(rows[0]._id)))!.filedAt).toBe(stamp);
    await s.me.mutation(api.collectionInventory.undoBoxQuantity, { inverse: lowered.inverse });
    expect((await s.t.run((ctx) => ctx.db.get(rows[0]._id)))!.filedAt).toBe(stamp);
    expect(raised.after).toBe(2);
  });

  test("emptying a binder back to Main moves its cards, so they are news in Main", async () => {
    const s = await setup();
    const mets = await s.t.run((ctx) =>
      ctx.db.insert("collectionContainers", { ownerId: ME.subject, kind: "binder", name: "Mets", lastUpdated: 0 }),
    );
    const straw = await s.me.mutation(api.collection.addHave, { cardId: s.fx.strawberry2, homeId: mets });
    await tick();
    const since = Date.now();
    expect((await s.me.query(api.dashboard.newSince, { sinceMs: since })).lines).toEqual([]);
    await s.me.mutation(api.collectionContainers.empty, { containerId: mets });
    const lines = (await s.me.query(api.dashboard.newSince, { sinceMs: since })).lines;
    expect(lines.map((l) => [l.homeId, l.cardId])).toEqual([[s.homes.main, s.fx.strawberry2]]);
    expect(straw.copyId).toBeDefined();
  });
});

describe("freshPulls", () => {
  /** Let the wall clock pass a millisecond, so a later write's stamp is strictly later. */
  const tick = () => new Promise((resolve) => setTimeout(resolve, 3));
  /** The line's `addedAt`, null when it has none (`t.run` answers a missing value as null). */
  const addedAtOf = (s: S, id: Id<"collectionCopies">) => s.t.run(async (ctx) => (await ctx.db.get(id))?.addedAt ?? null);
  const binder = (s: S, name: string) =>
    s.t.run((ctx) => ctx.db.insert("collectionContainers", { ownerId: ME.subject, kind: "binder", name, lastUpdated: 0 }));
  const pulls = async (s: S, sinceMs: number) =>
    (await s.me.query(api.dashboard.freshPulls, { sinceMs })).lines.map((l) => `${l.homeId}|${l.cardId}`);

  test("refuses a signed-out caller", async () => {
    const s = await setup();
    await expect(s.t.query(api.dashboard.freshPulls, { sinceMs: 0 })).rejects.toThrow(/Not authenticated/);
  });

  test("cards added on Collection (a full line, a pasted range) are fresh, newest first; never a box's, never another collector's", async () => {
    const s = await setup();
    const windowStart = Date.now() - 14 * DAY;
    const variations = await binder(s, "Variations");
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gooden1, details: { quantity: 1 } });
    await tick();
    await s.me.mutation(api.collection.addHaves, { cardIds: [s.fx.strawberry2, s.fx.gold1], homeId: variations });
    // An add into a box is stock, not a pull; and another collector's adds are theirs.
    await s.me.mutation(api.collection.addHave, { cardId: s.fx.futureStar, homeId: s.homes.box });
    await s.them.mutation(api.collection.addHave, { cardId: s.fx.gooden1 });
    const read = await pulls(s, windowStart);
    // The pasted range came in last, so it leads (its two lines share a moment); the Main add follows.
    expect(read.slice(0, 2).sort()).toEqual([`${variations}|${s.fx.gold1}`, `${variations}|${s.fx.strawberry2}`].sort());
    expect(read.slice(2)).toEqual([`${s.homes.main}|${s.fx.gooden1}`]);
  });

  test("an add stamps `addedAt` (folded or a new line); a move, an edit, a split, a box raise and an empty never do", async () => {
    const s = await setup();
    const mets = await binder(s, "Mets");
    const first = await s.me.mutation(api.collection.addHaves, { cardIds: [s.fx.gooden1, s.fx.gooden1, s.fx.gooden1], homeId: mets });
    const copyId = first[0].copyId;
    const stamp = (await addedAtOf(s, copyId))!;
    expect(typeof stamp).toBe("number");

    // An edit and a move into another binder keep it; the move is filed, not added.
    await tick();
    await s.me.mutation(api.collection.updateCopy, { copyId, details: { quantity: 3, notes: "sharp" } });
    expect(await addedAtOf(s, copyId)).toBe(stamp);
    const since = Date.now();
    await tick();
    const moved = await s.me.mutation(api.collection.moveCopy, { copyId, toHomeId: s.homes.main });
    expect(moved.split).toBe(false);
    expect(await addedAtOf(s, copyId)).toBe(stamp);
    expect(await pulls(s, since)).toEqual([]);
    const news = (await s.me.query(api.dashboard.newSince, { sinceMs: since })).lines.map((l) => `${l.homeId}|${l.cardId}`);
    expect(news).toEqual([`${s.homes.main}|${s.fx.gooden1}`]);

    // A part split off, in the same binder or into another, inherits its source's.
    await tick();
    const split = await s.me.mutation(api.collection.moveCopy, { copyId, toHomeId: mets, quantity: 1 });
    expect(split.split).toBe(true);
    expect(await addedAtOf(s, split.copyId)).toBe(stamp);
    const shuffled = await s.me.mutation(api.collection.moveCopy, { copyId, toHomeId: s.homes.main, quantity: 1, slot: 7 });
    expect(shuffled.split).toBe(true);
    expect(await addedAtOf(s, shuffled.copyId)).toBe(stamp);

    // Emptying the binder back to Main moves its cards: never added again.
    await tick();
    await s.me.mutation(api.collectionContainers.empty, { containerId: mets });
    const inMain = await s.t.run((ctx) =>
      ctx.db
        .query("collectionCopies")
        .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ME.subject).eq("cardId", s.fx.gooden1))
        .collect(),
    );
    expect(inMain.length).toBeGreaterThan(0);
    for (const row of inMain) expect(row.addedAt).toBe(stamp);
    expect(await pulls(s, since)).toEqual([]);

    // A box raise brings stock into a box: no `addedAt`, before or after a move into a binder.
    const raised = await s.me.mutation(api.collectionInventory.setBoxQuantity, { cardId: s.fx.strawberry2, boxId: s.homes.box, quantity: 2 });
    expect(raised.after).toBe(2);
    const boxed = await s.t.run((ctx) =>
      ctx.db
        .query("collectionCopies")
        .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ME.subject).eq("cardId", s.fx.strawberry2))
        .unique(),
    );
    expect(boxed!.addedAt).toBeUndefined();
    await s.me.mutation(api.collection.moveCopy, { copyId: boxed!._id, toHomeId: s.homes.main });
    expect(await addedAtOf(s, boxed!._id)).toBeNull();
    expect(await pulls(s, since)).toEqual([]);

    // A new add of the same card is a pull, on its own line.
    await tick();
    const again = await s.me.mutation(api.collection.addHave, { cardId: s.fx.strawberry2 });
    expect(await addedAtOf(s, again.copyId)).toBeGreaterThan(stamp);
    expect(await pulls(s, since)).toEqual([`${s.homes.main}|${s.fx.strawberry2}`]);
  });

  test("an add that folds stamps the line again; cards folding in by a move leave it the newer `addedAt` of the two", async () => {
    const s = await setup();
    const mets = await binder(s, "Mets");
    const old = await s.me.mutation(api.collection.addHave, { cardId: s.fx.gooden1 });
    const firstStamp = (await addedAtOf(s, old.copyId))!;
    await tick();
    const folded1 = await s.me.mutation(api.collection.addHave, { cardId: s.fx.gooden1 });
    expect(folded1).toMatchObject({ copyId: old.copyId, merged: true });
    const oldStamp = (await addedAtOf(s, old.copyId))!;
    expect(oldStamp).toBeGreaterThan(firstStamp);
    await tick();
    await tick();
    const fresh = await s.me.mutation(api.collection.addHave, { cardId: s.fx.gooden1, homeId: mets });
    const freshStamp = (await addedAtOf(s, fresh.copyId))!;
    expect(freshStamp).toBeGreaterThan(oldStamp);
    // The fresh card moves onto Main's older line: the line now holds a fresh card.
    const folded = await s.me.mutation(api.collection.moveCopy, { copyId: fresh.copyId, toHomeId: s.homes.main });
    expect(folded).toMatchObject({ copyId: old.copyId, folded: true });
    expect(await addedAtOf(s, old.copyId)).toBe(freshStamp);
    // A part split back off carries the line's.
    const back = await s.me.mutation(api.collection.moveCopy, { copyId: old.copyId, toHomeId: mets, quantity: 1 });
    expect(await addedAtOf(s, back.copyId)).toBe(freshStamp);
  });

  test("more fresh lines than the cap returns exactly the cap, newest first, and reports truncation; at the cap it does not", async () => {
    const s = await setup();
    const base = 1_000_000;
    const lineAt = (addedAt: number, slot: number) =>
      s.t.run((ctx) =>
        ctx.db.insert("collectionCopies", {
          ownerId: ME.subject,
          cardId: s.fx.gooden1,
          variantId: s.fx.baseId,
          setId: s.fx.setId,
          homeId: s.homes.main,
          slot,
          quantity: 1,
          lastUpdated: 0,
          addedAt,
        }),
      );
    // Exactly the cap: everything is returned and nothing is cut.
    for (let i = 0; i < FRESH_PULL_LINES; i++) await lineAt(base + i, i);
    const atCap = await s.me.query(api.dashboard.freshPulls, { sinceMs: 0 });
    expect(atCap.lines).toHaveLength(FRESH_PULL_LINES);
    expect(atCap.truncated).toBe(false);
    // One more, and the oldest falls off.
    await lineAt(base + FRESH_PULL_LINES, FRESH_PULL_LINES);
    const over = await s.me.query(api.dashboard.freshPulls, { sinceMs: 0 });
    expect(over.truncated).toBe(true);
    expect(over.lines).toHaveLength(FRESH_PULL_LINES);
    const stamps = over.lines.map((l) => l.addedAt);
    expect(stamps[0]).toBe(base + FRESH_PULL_LINES);
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
    expect(stamps[stamps.length - 1]).toBe(base + 1);
  });

  test("an undo's put-back is not a pull", async () => {
    const s = await setup();
    const added = await s.me.mutation(api.collection.addHave, { cardId: s.fx.gooden1 });
    const since = (await addedAtOf(s, added.copyId))! - 1;
    const { removed } = await s.me.mutation(api.collection.removeCopy, { copyId: added.copyId });
    const back = await s.me.mutation(api.collection.restoreCopy, { cardId: removed.cardId, details: removed.details });
    expect(await addedAtOf(s, back.copyId)).toBeNull();
    expect(await pulls(s, since)).toEqual([]);
  });
});

describe("newSets", () => {
  // Driven on Date only (convex-test stamps `_creationTime` from it), from a
  // moment after the real clock, so a later upload is truly later.
  const BASE = Date.now() + 365 * DAY;
  afterEach(() => vi.useRealTimers());

  async function fakeSetup() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BASE);
    return setup();
  }

  /** A row under `parentId`. */
  function option(s: S, level: string, value: string, parentId: Id<"selectorOptions">) {
    return s.t.run((ctx) =>
      ctx.db.insert("selectorOptions", { level, value, parentId, platformData: {}, children: [], lastUpdated: 0 } as never),
    );
  }

  /** `n` cards uploaded now onto `variantId`. */
  function upload(s: S, variantId: Id<"selectorOptions">, n: number, title = "Card") {
    return s.t.run(async (ctx) => {
      const cards: Id<"cardChecklist">[] = [];
      for (let i = 0; i < n; i++) {
        cards.push(
          await ctx.db.insert("cardChecklist", {
            selectorOptionId: variantId,
            cardNumber: String(i + 1),
            cardName: `Player ${i + 1}`,
            listingTitle: `${title} #${i + 1}`,
            sportId: s.fx.sportId,
            platformData: {},
            sortOrder: i,
            lastUpdated: 0,
          } as never),
        );
      }
      return cards;
    });
  }

  /** A set under 1986 Topps with a Base of `n` cards, uploaded now. */
  async function setWithBase(s: S, name: string, n: number) {
    const setId = await option(s, "setName", name, s.fx.topps86Id);
    const baseId = await option(s, "variantType", "Base", setId);
    const cards = await upload(s, baseId, n, name);
    return { setId, baseId, cards };
  }

  test("a full set load (Base, an insert, a parallel) is one entry: the set, opening on its Base, its count and Base cover", async () => {
    const s = await fakeSetup();
    // A set row made after everything, with no card: a marketplace's list of sets. Never news.
    await option(s, "setName", "Empty Set", s.fx.toppsId);
    await s.t.run((ctx) => ctx.db.patch(s.fx.setId, { subtreeCardCount: 5 }));
    const out = await s.me.query(api.dashboard.newSets, {});
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      wholeSet: true,
      cardCount: 5,
      coverCardId: s.fx.gooden1,
      set: { _id: s.fx.setId, name: "Topps Chrome", season: "2024", sport: { name: "Baseball" } },
      opens: { _id: s.fx.baseId, level: "variantType", kind: "base" },
    });
  });

  test("a parallel found after its set's load is news of its own, named for itself and opening on itself", async () => {
    const s = await fakeSetup();
    vi.setSystemTime(BASE + SET_LOAD_MS + DAY);
    const red = await option(s, "insert", "Red Refractor", s.fx.parallelsTypeId);
    const reds = await upload(s, red, 3, "Red");
    const out = await s.me.query(api.dashboard.newSets, {});
    expect(out.map((e) => [e.wholeSet, e.opens.name])).toEqual([
      [false, "Red Refractor"],
      [true, "Base"],
    ]);
    expect(out[0]).toMatchObject({
      set: { _id: s.fx.setId },
      opens: { _id: red, level: "insert", kind: "parallel", variantType: { _id: s.fx.parallelsTypeId } },
      coverCardId: reds[0],
    });
    expect(out[0].addedAt).toBeGreaterThanOrEqual(BASE + SET_LOAD_MS + DAY);
  });

  test("several variants uploaded without the Base: one entry each, newest first", async () => {
    const s = await fakeSetup();
    vi.setSystemTime(BASE + SET_LOAD_MS + DAY);
    const red = await option(s, "insert", "Red Refractor", s.fx.parallelsTypeId);
    await upload(s, red, 2);
    vi.setSystemTime(BASE + SET_LOAD_MS + 2 * DAY);
    const blue = await option(s, "insert", "Blue Refractor", s.fx.parallelsTypeId);
    await upload(s, blue, 2);
    const out = await s.me.query(api.dashboard.newSets, {});
    expect(out.map((e) => [e.wholeSet, e.opens.name])).toEqual([
      [false, "Blue Refractor"],
      [false, "Red Refractor"],
      [true, "Base"],
    ]);
  });

  test("a card added to an old checklist never carries the walk back past newer uploads", async () => {
    const s = await fakeSetup();
    vi.setSystemTime(BASE + 30 * DAY);
    await setWithBase(s, "Topps Traded Update", 2);
    vi.setSystemTime(BASE + 40 * DAY);
    // One late card on Topps Chrome's Base: the set is news again (once), and the walk still finds the Traded load.
    await upload(s, s.fx.baseId, 1, "Late");
    const out = await s.me.query(api.dashboard.newSets, {});
    expect(out.map((e) => [e.set.name, e.wholeSet])).toEqual([
      ["Topps Chrome", true],
      ["Topps Traded Update", true],
    ]);
  });

  test("a set known to hold no cards is passed over", async () => {
    const s = await fakeSetup();
    vi.setSystemTime(BASE + DAY);
    const hidden = await setWithBase(s, "Pulled Set", 1);
    await s.t.run((ctx) => ctx.db.patch(hidden.setId, { subtreeCardCount: 0 }));
    const out = await s.me.query(api.dashboard.newSets, {});
    expect(out.map((n) => n.set.name)).toEqual(["Topps Chrome"]);
  });

  test("the same for every collector, and capped at NEW_SETS_SHOWN entries", async () => {
    const s = await fakeSetup();
    for (let i = 0; i < NEW_SETS_SHOWN + 2; i++) {
      vi.setSystemTime(BASE + (i + 1) * DAY);
      await setWithBase(s, `Set ${i}`, 2);
    }
    const mine = await s.me.query(api.dashboard.newSets, {});
    expect(mine).toHaveLength(NEW_SETS_SHOWN);
    expect(mine[0].set.name).toBe(`Set ${NEW_SETS_SHOWN + 1}`);
    expect(mine.every((e) => e.wholeSet)).toBe(true);
    expect(await s.them.query(api.dashboard.newSets, {})).toEqual(mine);
  });

  test("an empty catalog: nothing", async () => {
    const t = convexTest(schema, modules);
    expect(await t.withIdentity(ME).query(api.dashboard.newSets, {})).toEqual([]);
  });
});

describe("markVisit", () => {
  test("refuses a signed-out caller and writes nothing", async () => {
    const s = await setup();
    await expect(s.t.mutation(api.dashboard.markVisit, {})).rejects.toThrow(/Not authenticated/);
    expect(await s.t.run((ctx) => ctx.db.query("userProfiles").collect())).toEqual([]);
  });

  test("the first visit has nothing before it; a reopen moments later is the same visit", async () => {
    const s = await setup();
    expect(await s.me.mutation(api.dashboard.markVisit, {})).toEqual({ sinceMs: null });
    expect(await s.me.mutation(api.dashboard.markVisit, {})).toEqual({ sinceMs: null });
    const rows = await s.t.run((ctx) => ctx.db.query("userProfiles").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(ME.subject);
    expect(typeof rows[0].dashboardVisit?.seenAt).toBe("number");
  });

  test("after a long gap, the news starts at the last open, read before the stamp moves", async () => {
    const s = await setup();
    const longAgo = Date.now() - VISIT_GAP_MS - DAY;
    await s.t.run((ctx) =>
      ctx.db.insert("userProfiles", { userId: ME.subject, preferences: { theme: "dark" }, dashboardVisit: { seenAt: longAgo } }),
    );
    expect(await s.me.mutation(api.dashboard.markVisit, {})).toEqual({ sinceMs: longAgo });
    const [row] = await s.t.run((ctx) => ctx.db.query("userProfiles").collect());
    expect(row.dashboardVisit?.sinceAt).toBe(longAgo);
    expect(row.dashboardVisit!.seenAt).toBeGreaterThan(longAgo);
    // The rest of the profile is untouched.
    expect(row.preferences).toEqual({ theme: "dark" });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Slice 4: could fit, intake, sales
// ───────────────────────────────────────────────────────────────────────────

describe("couldFit", () => {
  /** A smart binder whose stored fits are `cards`, each with its `held` mark. */
  async function fitted(s: S, cards: Array<[Id<"cardChecklist">, boolean]>, state: { pending?: boolean } = {}) {
    return s.t.run(async (ctx) => {
      const binderId = await ctx.db.insert("collectionContainers", {
        ownerId: ME.subject,
        kind: "binder",
        name: "Mets",
        rule: { version: 1, match: "all", terms: [{ test: { kind: "set", setIds: [s.fx.setId] } }] } as never,
        lastUpdated: 0,
      });
      for (const [i, [cardId, held]] of cards.entries()) {
        await ctx.db.insert("collectionBinderFits", {
          ownerId: ME.subject,
          binderId,
          cardId,
          variantId: s.fx.baseId,
          order: i,
          generation: 1,
          held,
        });
      }
      await ctx.db.insert("collectionBinderFitsState", {
        ownerId: ME.subject,
        binderId,
        computedAt: 0,
        supported: true,
        complete: true,
        count: cards.length,
        generation: 1,
        ...(state.pending ? { pending: true } : {}),
      });
      return binderId;
    });
  }

  test("held elsewhere, not filed here, not declined: in the fits' order", async () => {
    const s = await setup();
    const binderId = await fitted(s, [
      [s.fx.gooden1, true],
      [s.fx.strawberry2, true],
      [s.fx.gold1, false],
      [s.fx.futureStar, true],
    ]);
    // Strawberry is filed here as well: nothing to suggest.
    await line(s, s.fx.strawberry2, s.fx.baseId, { homeId: binderId, lastUpdated: NOW });
    // The future star was declined for this binder.
    await s.t.run((ctx) =>
      ctx.db.insert("collectionBinderDeclines", { ownerId: ME.subject, binderId, cardId: s.fx.futureStar, declinedAt: NOW }),
    );
    expect(await s.me.query(api.dashboard.couldFit, { containerId: binderId })).toEqual({
      cardIds: [s.fx.gooden1],
      more: false,
    });
  });

  test(`at most COULD_FIT_CARDS (${COULD_FIT_CARDS}) cards, with more said`, async () => {
    const s = await setup();
    const many = await s.t.run(async (ctx) => {
      const ids: Id<"cardChecklist">[] = [];
      for (let i = 0; i < COULD_FIT_CARDS + 5; i++) {
        ids.push(await ctx.db.insert("cardChecklist", { selectorOptionId: s.fx.baseId, cardNumber: `X${i}`, cardName: `Extra ${i}`, listingTitle: `Extra ${i}`, platformData: {}, sportId: s.fx.sportId, isCustom: false, sortOrder: 100 + i, lastUpdated: NOW } as never));
      }
      return ids;
    });
    const binderId = await fitted(s, many.map((id) => [id, true] as [Id<"cardChecklist">, boolean]));
    const out = await s.me.query(api.dashboard.couldFit, { containerId: binderId });
    expect(out?.cardIds).toEqual(many.slice(0, COULD_FIT_CARDS));
    expect(out?.more).toBe(true);
  });

  test("no honest answer: fits being recomputed, a plain binder, another collector asking", async () => {
    const s = await setup();
    const pending = await fitted(s, [[s.fx.gooden1, true]], { pending: true });
    expect(await s.me.query(api.dashboard.couldFit, { containerId: pending })).toBeNull();
    expect(await s.me.query(api.dashboard.couldFit, { containerId: s.homes.main })).toBeNull();
    const mine = await fitted(s, [[s.fx.gooden1, true]]);
    expect(await s.them.query(api.dashboard.couldFit, { containerId: mine })).toBeNull();
  });
});

describe("intake", () => {
  /** A run into `homeId` with one match row per entry: a card (a guess), "saved", "aside" or null (no guess). */
  async function run(
    s: S,
    rows: Array<Id<"cardChecklist"> | "saved" | "aside" | null>,
    opts: { userId?: string; lastActivityAt?: number; homeId?: Id<"collectionContainers"> } = {},
  ) {
    const userId = opts.userId ?? ME.subject;
    return s.t.run(async (ctx) => {
      const jobId = `job-${Math.random()}`;
      const at = opts.lastActivityAt ?? Date.now();
      const runId = await ctx.db.insert("intakeRuns", {
        userId,
        jobId,
        homeId: opts.homeId ?? s.homes.main,
        createdAt: at,
        lastActivityAt: at,
      });
      const ids: Id<"intakeMatches">[] = [];
      for (const [i, what] of rows.entries()) {
        const pairId = await ctx.db.insert("placeholderPairs", {
          jobId,
          userId,
          frontIndex: i * 2,
          backIndex: i * 2 + 1,
          confidence: "exact",
          mechanism: "adjacency",
          score: 1,
        });
        ids.push(
          await ctx.db.insert("intakeMatches", {
            runId,
            userId,
            pairId,
            frontIndex: i * 2,
            backIndex: i * 2 + 1,
            readKey: "",
            confidence: 1,
            band: what && what !== "aside" ? "matched" : "none",
            reason: "numberAndPlayer",
            candidates: [],
            variations: [],
            ...(what && what !== "saved" && what !== "aside" ? { cardId: what } : {}),
            ...(what === "saved" ? { cardId: s.fx.gooden1, savedAt: at } : {}),
            ...(what === "aside" ? { setAside: true } : {}),
          }),
        );
      }
      return { runId, ids };
    });
  }

  test("refuses a signed-out caller", async () => {
    const s = await setup();
    await expect(s.t.query(api.dashboard.intake, {})).rejects.toThrow(/Not authenticated/);
  });

  test("open scans counted across runs and per run: a guess waits on a yes, none is unidentified; done ones are out", async () => {
    const s = await setup();
    const a = await run(s, [s.fx.gooden1, null, "saved", "aside"]);
    const b = await run(s, [s.fx.strawberry2], { homeId: s.homes.box });
    const out = await s.me.query(api.dashboard.intake, {});
    expect(out.needsYou).toBe(2);
    expect(out.unidentified).toBe(1);
    expect(out.truncated).toBe(false);
    expect(out.runs).toEqual(
      expect.arrayContaining([
        {
          runId: a.runId,
          homeName: "Main",
          side: "collection",
          needsYou: 1,
          unidentified: 1,
          lastActivityAt: expect.any(Number),
          guesses: [s.fx.gooden1],
        },
        {
          runId: b.runId,
          homeName: "Unsorted",
          side: "inventory",
          needsYou: 1,
          unidentified: 0,
          lastActivityAt: expect.any(Number),
          guesses: [s.fx.strawberry2],
        },
      ]),
    );
    expect(out.runs).toHaveLength(2);
    expect(out).toMatchObject({ sortedThisWeek: 0, sortedAllTime: 0, sortedAllTimeMore: false });
  });

  test("a sorted run is a count, never a row: this week within the week, and all-time; an open one stays however old", async () => {
    const s = await setup();
    const old = Date.now() - 30 * DAY;
    const lately = Date.now() - 2 * DAY;
    await run(s, ["saved", "aside"], { lastActivityAt: lately });
    await run(s, ["saved"], { lastActivityAt: Date.now() - INTAKE_RECENT_MS + 60_000 });
    await run(s, ["saved"], { lastActivityAt: old });
    const stale = await run(s, [null], { lastActivityAt: old });
    // No match rows yet (photos still processing): neither open nor sorted.
    await run(s, []);
    const out = await s.me.query(api.dashboard.intake, {});
    expect(out.runs.map((r) => r.runId)).toEqual([stale.runId]);
    // The open run carries its last activity, so two runs into one home read apart on the dashboard.
    expect(out.runs[0].lastActivityAt).toBe(old);
    expect(out).toMatchObject({ needsYou: 0, unidentified: 1, sortedThisWeek: 2, sortedAllTime: 3, sortedAllTimeMore: false });
  });

  test("past the runs it reads, all-time is a floor", async () => {
    const s = await setup();
    for (let i = 0; i < INTAKE_RUNS + 1; i++) await run(s, ["saved"], { lastActivityAt: Date.now() - (i + 1) * 60_000 });
    const out = await s.me.query(api.dashboard.intake, {});
    expect(out.runs).toEqual([]);
    expect(out).toMatchObject({ sortedThisWeek: INTAKE_RUNS, sortedAllTime: INTAKE_RUNS, sortedAllTimeMore: true });
  });

  test("thumbnails: a few best guesses per run, and a cap across runs", async () => {
    const s = await setup();
    const many = Array.from({ length: 5 }, () => s.fx.gooden1);
    for (let i = 0; i < 4; i++) await run(s, many, { lastActivityAt: Date.now() - (i + 1) * 60_000 });
    const out = await s.me.query(api.dashboard.intake, {});
    expect(out.runs.map((r) => r.needsYou)).toEqual([5, 5, 5, 5]);
    expect(out.runs.map((r) => r.guesses.length)).toEqual([3, 3, 3, 0]);
    expect(out.runs.reduce((n, r) => n + r.guesses.length, 0)).toBe(INTAKE_PREVIEW_CARDS);
  });

  test("a run whose home is another collector's never names that home", async () => {
    const s = await setup();
    // A run row can only point at the caller's own home through the app; pin the read anyway.
    const mine = await run(s, [null]);
    await run(s, [s.fx.gooden1], { homeId: s.homes.theirMain });
    const out = await s.me.query(api.dashboard.intake, {});
    expect(out.runs).toEqual([
      { runId: mine.runId, homeName: "Main", side: "collection", needsYou: 0, unidentified: 1, lastActivityAt: expect.any(Number), guesses: [] },
    ]);
    expect(out).toMatchObject({ needsYou: 0, unidentified: 1 });
  });

  test("nothing in intake, and another collector's runs are theirs: all zero", async () => {
    const s = await setup();
    await run(s, [s.fx.gooden1, null], { userId: THEM.subject, homeId: s.homes.theirMain });
    expect(await s.me.query(api.dashboard.intake, {})).toEqual({
      needsYou: 0,
      unidentified: 0,
      runs: [],
      sortedThisWeek: 0,
      sortedAllTime: 0,
      sortedAllTimeMore: false,
      truncated: false,
    });
  });
});

describe("sales", () => {
  type Item = { cardId?: Id<"cardChecklist">; quantity?: number; problem?: "unmatched" | "linkMismatch" | "oversold"; shortBy?: number };
  function order(s: S, o: { platform?: "bsc" | "ebay"; orderNo: string; status: string; orderDate: number; items?: Item[]; ownerId?: string }) {
    return s.t.run((ctx) =>
      ctx.db.insert("marketplaceSales", {
        ownerId: o.ownerId ?? ME.subject,
        platform: o.platform ?? "bsc",
        orderId: `id-${o.orderNo}`,
        orderNo: o.orderNo,
        orderDate: o.orderDate,
        status: o.status,
        totals: {},
        items: (o.items ?? [{ cardId: s.fx.gooden1 }]).map((item, i) => ({
          platformCardId: `p${i}`,
          ...(item.cardId ? { cardId: item.cardId } : {}),
          condition: "NM",
          quantity: item.quantity ?? 1,
          priceCents: 100,
          applied: true,
          ...(item.problem ? { problem: item.problem } : {}),
          ...(item.shortBy !== undefined ? { shortBy: item.shortBy } : {}),
        })),
        firstSeenAt: o.orderDate,
        lastUpdated: o.orderDate,
      }),
    );
  }
  function connect(s: S, site: string) {
    return s.t.run((ctx) => ctx.db.insert("userProfiles", { userId: ME.subject, siteCredentials: [{ site, hasCredentials: true }] }));
  }

  test("refuses a signed-out caller", async () => {
    const s = await setup();
    await expect(s.t.query(api.dashboard.sales, {})).rejects.toThrow(/Not authenticated/);
  });

  test("no order stored: no sales section, whatever platforms are connected", async () => {
    // Jason, 2026-11-10: a widget shows for what the collector has, never for a login configured.
    for (const site of ["sportlots", "buysportscards", "ebay"]) {
      const s = await setup();
      await connect(s, site);
      await order(s, { orderNo: "THEIRS", status: "READY_TO_SHIP", orderDate: NOW, ownerId: THEM.subject });
      expect(await s.me.query(api.dashboard.sales, {})).toEqual({ dealer: false, orders: [], more: false });
    }
  });

  test("an order stored, every one shipped: a dealer with nothing to ship", async () => {
    const s = await setup();
    await order(s, { orderNo: "B-9", status: "SHIPPED", orderDate: NOW - DAY });
    expect(await s.me.query(api.dashboard.sales, {})).toEqual({ dealer: true, orders: [], more: false });
  });

  test("an order stored makes a dealer; shipped and cancelled orders are not to ship; newest first", async () => {
    const s = await setup();
    const older = await order(s, { orderNo: "B-1", status: "READY_TO_SHIP", orderDate: NOW - 3 * DAY });
    await order(s, { orderNo: "B-2", status: "SHIPPED", orderDate: NOW - 2 * DAY });
    await order(s, { orderNo: "B-3", status: "CANCELLED", orderDate: NOW - 2 * DAY });
    await order(s, { platform: "ebay", orderNo: "E-1", status: "FULFILLED", orderDate: NOW - DAY });
    const newer = await order(s, {
      platform: "ebay",
      orderNo: "E-2",
      status: "PAID",
      orderDate: NOW,
      items: [{ cardId: s.fx.gooden1, quantity: 2, problem: "oversold", shortBy: 1 }, { problem: "unmatched" }],
    });
    const out = await s.me.query(api.dashboard.sales, {});
    expect(out.dealer).toBe(true);
    expect(out.orders.map((o) => o.id)).toEqual([newer, older]);
    expect(out.orders[0]).toMatchObject({
      platform: "ebay",
      orderNo: "E-2",
      status: "PAID",
      cardCount: 3,
      lines: [
        { cardId: s.fx.gooden1, quantity: 2, problem: "oversold", shortBy: 1 },
        { quantity: 1, problem: "unmatched" },
      ],
    });
  });

  test("an unpaid order, or one whose status NB does not know, stays hidden: never to ship", async () => {
    const s = await setup();
    await order(s, { platform: "ebay", orderNo: "E-UNPAID", status: "PENDING", orderDate: NOW - DAY });
    await order(s, { platform: "ebay", orderNo: "E-FAILED", status: "FAILED", orderDate: NOW - DAY });
    await order(s, { platform: "ebay", orderNo: "E-NEW", status: "SOMETHING_NEW", orderDate: NOW });
    await order(s, { orderNo: "B-NEW", status: "AWAITING_PAYMENT", orderDate: NOW });
    const paid = await order(s, { orderNo: "B-PAID", status: "READY_TO_SHIP", orderDate: NOW - 2 * DAY });
    const out = await s.me.query(api.dashboard.sales, {});
    expect(out.dealer).toBe(true);
    expect(out.orders.map((o) => o.id)).toEqual([paid]);
    expect(out.more).toBe(false);
  });

  test(`at most SALES_SHOWN (${SALES_SHOWN}) orders, the newest, with more said`, async () => {
    const s = await setup();
    for (let i = 0; i < SALES_SHOWN + 2; i++) {
      await order(s, { orderNo: `B-${i}`, status: "READY_TO_SHIP", orderDate: NOW - i * DAY });
    }
    const out = await s.me.query(api.dashboard.sales, {});
    expect(out.orders.map((o) => o.orderNo)).toEqual(Array.from({ length: SALES_SHOWN }, (_, i) => `B-${i}`));
    expect(out.more).toBe(true);
  });
});


// ───────────────────────────────────────────────────────────────────────────
// Review round 4: lines written before the stamps, New Listings, sync status
// ───────────────────────────────────────────────────────────────────────────

describe("legacyStampOf", () => {
  const MARK = FILED_ONLY_ERA_END + 30 * DAY;

  test("nothing reads as legacy before the dashboard has opened under the stamps, nor a line written since", () => {
    expect(legacyStampOf({ _creationTime: 100 }, undefined)).toBeNull();
    expect(legacyStampOf({ _creationTime: MARK }, MARK)).toBeNull();
    expect(legacyStampOf({ _creationTime: MARK + 1 }, MARK)).toBeNull();
  });

  test("a line never filed (production's legacy lines) counts by when it was written", () => {
    expect(legacyStampOf({ _creationTime: MARK - DAY }, MARK)).toBe(MARK - DAY);
  });

  test("filed-only era: filed in the same write counts; filed later (moved in) never", () => {
    const at = FILED_ONLY_ERA_END - DAY;
    expect(legacyStampOf({ _creationTime: at, filedAt: at + 3 }, MARK)).toBe(at);
    expect(legacyStampOf({ _creationTime: at, filedAt: at + STAMP_SLACK_MS + 1 }, MARK)).toBeNull();
  });

  test("written after that era, a filed line with no stamp was moved in, however soon: never legacy", () => {
    const at = FILED_ONLY_ERA_END + DAY;
    expect(legacyStampOf({ _creationTime: at, filedAt: at }, MARK)).toBeNull();
    expect(legacyStampOf({ _creationTime: at, filedAt: at + 1 }, MARK)).toBeNull();
  });
});

describe("mergeStamped", () => {
  test("newest first across both reads, cut at the cap, and the cut is said", () => {
    const out = mergeStamped([{ at: 5 }, { at: 1 }], [{ at: 3 }], 2, false);
    expect(out).toEqual({ lines: [{ at: 5 }, { at: 3 }], truncated: true });
    expect(mergeStamped([{ at: 1 }], [], 2, false).truncated).toBe(false);
    expect(mergeStamped([{ at: 1 }], [], 2, true).truncated).toBe(true);
  });
});

describe("syncOutcome", () => {
  const NOW = 1_800_000_000_000;
  const record = (over: Partial<Parameters<typeof syncOutcome>[0]> = {}) => ({
    status: "idle" as const,
    problems: [],
    ...over,
  });

  test("an error, then a later clean run: self-corrected, nothing to show", () => {
    // The record is the last run's summary: a clean run after a failure leaves it idle.
    expect(syncOutcome(record({ status: "idle", lastError: "old failure" }), NOW)).toEqual({ failed: false, heldBack: 0 });
  });

  test("a clean run, then a later error: shown", () => {
    expect(syncOutcome(record({ status: "error", lastError: "BuySportsCards didn't answer." }), NOW)).toEqual({
      failed: true,
      heldBack: 0,
    });
  });

  test("a run going now is not a failure; one that died holding an error is", () => {
    expect(syncOutcome(record({ status: "running", leaseExpiresAt: NOW + 1000, lastError: "x" }), NOW).failed).toBe(false);
    expect(syncOutcome(record({ status: "running", leaseExpiresAt: NOW - 1, lastError: "x" }), NOW).failed).toBe(true);
    expect(syncOutcome(record({ status: "running", leaseExpiresAt: NOW - 1 }), NOW).failed).toBe(false);
  });

  test("cards the last run held back are counted, the stored total when it was capped", () => {
    const problems = [{ cardId: undefined, reason: "noPrice" as const }];
    expect(syncOutcome(record({ problems }), NOW).heldBack).toBe(1);
    expect(syncOutcome(record({ problems, problemsTotal: 250 }), NOW).heldBack).toBe(250);
  });
});

describe("stamps before the dashboard opened, and moves into and out of a box", () => {
  // Driven on Date (convex-test stamps `_creationTime` from it), past the filed-only era.
  const BASE = Math.max(Date.now(), FILED_ONLY_ERA_END) + 365 * DAY;
  afterEach(() => vi.useRealTimers());
  async function at(ms: number) {
    vi.setSystemTime(ms);
  }
  async function fakeSetup() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BASE);
    return setup();
  }
  const pulls = async (s: S, sinceMs: number) =>
    (await s.me.query(api.dashboard.freshPulls, { sinceMs })).lines.map((l) => ({ home: l.homeId, card: l.cardId, at: l.addedAt }));
  const listings = async (s: S, sinceMs: number) => (await s.me.query(api.dashboard.newListings, { sinceMs })).lines;
  const rowOf = (s: S, id: Id<"collectionCopies">) => s.t.run((ctx) => ctx.db.get(id));
  const legacyLine = (
    s: S,
    o: { homeId: Id<"collectionContainers">; cardId?: Id<"cardChecklist">; ownerId?: string; filedAt?: number; quantity?: number },
  ) =>
    s.t.run((ctx) =>
      ctx.db.insert("collectionCopies", {
        ownerId: o.ownerId ?? ME.subject,
        cardId: o.cardId ?? s.fx.gooden1,
        variantId: s.fx.baseId,
        setId: s.fx.setId,
        homeId: o.homeId,
        quantity: o.quantity ?? 1,
        lastUpdated: 0,
        ...(o.filedAt !== undefined ? { filedAt: o.filedAt } : {}),
      }),
    );

  test("cards added before the stamps are Fresh Pulls by when they were written, once the dashboard has opened; never a box's, a moved-in line, another collector's, or a line written since", async () => {
    const s = await fakeSetup();
    const windowStart = BASE + 500;
    const variations = await s.t.run((ctx) =>
      ctx.db.insert("collectionContainers", { ownerId: ME.subject, kind: "binder", name: "Variations", lastUpdated: 0 }),
    );
    // Written before the window: too old to be fresh. (The window starts after it: convex-test keeps `_creationTime` rising.)
    await at(BASE + 100);
    await legacyLine(s, { homeId: variations, cardId: s.fx.gold1 });
    await at(BASE + 1000);
    const pull = await legacyLine(s, { homeId: variations });
    await at(BASE + 2000);
    await legacyLine(s, { homeId: s.homes.box, cardId: s.fx.strawberry2 });
    // Moved in after it was written (filed later): a move, never a pull.
    await at(BASE + 3000);
    await legacyLine(s, { homeId: s.homes.main, cardId: s.fx.futureStar, filedAt: BASE + 3000 + 10 * 60_000 });
    await legacyLine(s, { homeId: s.homes.theirMain, ownerId: THEM.subject });

    // Not until the dashboard opens under the stamps: until then nothing is read as legacy.
    await at(BASE + 4000);
    expect(await pulls(s, windowStart)).toEqual([]);
    await s.me.mutation(api.dashboard.markVisit, {});
    const written = (await rowOf(s, pull))!._creationTime;
    expect(await pulls(s, windowStart)).toEqual([{ home: variations, card: s.fx.gooden1, at: written }]);
    // A window starting after it leaves it out.
    expect(await pulls(s, written)).toEqual([]);

    // A later open does not move the moment the stamps started.
    await at(BASE + 2 * VISIT_GAP_MS);
    await s.me.mutation(api.dashboard.markVisit, {});
    // A line with no stamp written since (an undo's put-back) is never a pull.
    const added = await s.me.mutation(api.collection.addHave, { cardId: s.fx.strawberry2 });
    const { removed } = await s.me.mutation(api.collection.removeCopy, { copyId: added.copyId });
    await s.me.mutation(api.collection.restoreCopy, { cardId: removed.cardId, details: removed.details });
    expect(await pulls(s, windowStart)).toEqual([{ home: variations, card: s.fx.gooden1, at: written }]);
  });

  test("Sell drops `addedAt` and stamps `listedAt`; Take off sale drops `listedAt` and is no pull, even with the legacy read on", async () => {
    const s = await fakeSetup();
    await s.me.mutation(api.dashboard.markVisit, {});
    await at(BASE + 1000);
    const added = await s.me.mutation(api.collection.addHave, { cardId: s.fx.gooden1 });
    expect((await rowOf(s, added.copyId))!.addedAt).toBe(BASE + 1000);
    await at(BASE + 2000);
    await s.me.mutation(api.collection.moveCopy, { copyId: added.copyId, toHomeId: s.homes.box });
    const boxed = (await rowOf(s, added.copyId))!;
    expect(boxed.addedAt).toBeUndefined();
    expect(boxed.listedAt).toBe(BASE + 2000);
    expect(await pulls(s, 0)).toEqual([]);
    expect((await listings(s, 0)).map((l) => l.id)).toEqual([added.copyId]);

    await at(BASE + 3000);
    await s.me.mutation(api.collection.moveCopy, { copyId: added.copyId, toHomeId: s.homes.main });
    const back = (await rowOf(s, added.copyId))!;
    expect(back.addedAt).toBeUndefined();
    expect(back.listedAt).toBeUndefined();
    expect(await pulls(s, 0)).toEqual([]);
    expect(await listings(s, 0)).toEqual([]);
  });

  test("the same with the dashboard opened after the moves: a line written then moved in still never reads as legacy", async () => {
    const s = await fakeSetup();
    const added = await s.me.mutation(api.collection.addHave, { cardId: s.fx.gooden1 });
    await at(BASE + 1);
    await s.me.mutation(api.collection.moveCopy, { copyId: added.copyId, toHomeId: s.homes.box });
    await at(BASE + 2);
    await s.me.mutation(api.collection.moveCopy, { copyId: added.copyId, toHomeId: s.homes.main });
    await at(BASE + 3);
    await s.me.mutation(api.dashboard.markVisit, {});
    expect(await pulls(s, 0)).toEqual([]);
    expect(await listings(s, 0)).toEqual([]);
  });

  test("New Listings: an add into a box, a box raise and a Sell, newest first, each with its quantity and NB price", async () => {
    const s = await fakeSetup();
    const show = await s.t.run((ctx) =>
      ctx.db.insert("collectionContainers", { ownerId: ME.subject, kind: "box", name: "Show box", lastUpdated: 0 }),
    );
    // No price at all: null. The common price for the variant fills a line with none of its own.
    await at(BASE + 1000);
    const plain = await s.me.mutation(api.collection.addLineItem, {
      cardId: s.fx.gooden1,
      details: { quantity: 3, homeId: s.homes.box },
    });
    await at(BASE + 2000);
    await s.me.mutation(api.collectionInventory.setBoxQuantity, { cardId: s.fx.gold1, boxId: show, quantity: 2 });
    await at(BASE + 3000);
    const binderCopy = await s.me.mutation(api.collection.addLineItem, {
      cardId: s.fx.strawberry2,
      details: { quantity: 1, minPriceCents: 450 },
    });
    await at(BASE + 4000);
    await s.me.mutation(api.collection.moveCopy, { copyId: binderCopy.copyId, toHomeId: show });
    // Another collector's box lines are theirs.
    const theirBox = await s.t.run((ctx) =>
      ctx.db.insert("collectionContainers", { ownerId: THEM.subject, kind: "box", name: "Theirs", lastUpdated: 0 }),
    );
    await s.them.mutation(api.collection.addHave, { cardId: s.fx.gooden1, homeId: theirBox });

    const before = await listings(s, BASE);
    expect(before.map((l) => [l.cardId, l.quantity, l.priceCents, l.listedAt])).toEqual([
      [s.fx.strawberry2, 1, 450, BASE + 4000],
      [s.fx.gold1, 2, null, BASE + 2000],
      [s.fx.gooden1, 3, null, BASE + 1000],
    ]);
    expect(before[2].id).toBe(plain.copyId);

    await s.t.run((ctx) =>
      ctx.db.insert("variantCommonPrices", { ownerId: ME.subject, variantId: s.fx.baseId, priceCents: 125, lastUpdated: 0 }),
    );
    const priced = await listings(s, BASE);
    expect(priced.find((l) => l.cardId === s.fx.gooden1)?.priceCents).toBe(125);
    // The Gold Refractor is another variant: no common price for it.
    expect(priced.find((l) => l.cardId === s.fx.gold1)?.priceCents).toBeNull();
    // The window: only what landed after `sinceMs`.
    expect((await listings(s, BASE + 2500)).map((l) => l.cardId)).toEqual([s.fx.strawberry2]);
  });

  test("a move between boxes carries `listedAt` (a split part too); emptying a box into Unsorted keeps it", async () => {
    const s = await fakeSetup();
    const show = await s.t.run((ctx) =>
      ctx.db.insert("collectionContainers", { ownerId: ME.subject, kind: "box", name: "Show box", lastUpdated: 0 }),
    );
    await at(BASE + 1000);
    const line = await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gooden1, details: { quantity: 3, homeId: show } });
    await at(BASE + 5000);
    const part = await s.me.mutation(api.collection.moveCopy, { copyId: line.copyId, toHomeId: s.homes.box, quantity: 1 });
    expect(part.split).toBe(true);
    expect((await rowOf(s, part.copyId))!.listedAt).toBe(BASE + 1000);
    await at(BASE + 6000);
    await s.me.mutation(api.collectionContainers.empty, { containerId: show });
    const rows = await s.t.run((ctx) =>
      ctx.db
        .query("collectionCopies")
        .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ME.subject).eq("cardId", s.fx.gooden1))
        .collect(),
    );
    expect(rows.map((r) => [r.homeId, r.listedAt])).toEqual(rows.map(() => [s.homes.box, BASE + 1000]));
  });

  test("New Listings reads box lines written before the stamps by `_creationTime`, never a binder's", async () => {
    const s = await fakeSetup();
    await at(BASE + 1000);
    const boxed = await legacyLine(s, { homeId: s.homes.box, quantity: 4 });
    await legacyLine(s, { homeId: s.homes.main, cardId: s.fx.strawberry2 });
    await at(BASE + 2000);
    expect(await listings(s, BASE)).toEqual([]);
    await s.me.mutation(api.dashboard.markVisit, {});
    const out = await listings(s, BASE);
    expect(out.map((l) => [l.id, l.quantity, l.listedAt])).toEqual([[boxed, 4, (await rowOf(s, boxed))!._creationTime]]);
  });

  test("refuses a signed-out caller", async () => {
    const s = await fakeSetup();
    await expect(s.t.query(api.dashboard.newListings, { sinceMs: 0 })).rejects.toThrow(/Not authenticated/);
  });
});

describe("syncAlerts", () => {
  const NOW = Date.now();
  function outbox(s: S, platform: "bsc" | "ebay", n: number, ownerId = ME.subject) {
    return s.t.run(async (ctx) => {
      for (let i = 0; i < n; i++) {
        await ctx.db.insert("listingOutbox", { ownerId, platform, cardId: s.fx.gooden1, variantId: s.fx.baseId, seq: i, changedAt: NOW - i });
      }
    });
  }
  function record(
    s: S,
    o: {
      platform?: "bsc" | "ebay";
      variantId?: Id<"selectorOptions">;
      status: "idle" | "running" | "error";
      lastRunAt: number;
      lastSuccessAt?: number;
      lastError?: string;
      problems?: Array<{ cardId?: Id<"cardChecklist">; reason: "noPrice" | "noLink" | "rejected"; detail?: string }>;
      problemsTotal?: number;
      ownerId?: string;
    },
  ) {
    return s.t.run((ctx) =>
      ctx.db.insert("marketplaceListingSyncs", {
        ownerId: o.ownerId ?? ME.subject,
        variantId: o.variantId ?? s.fx.baseId,
        platform: o.platform ?? "bsc",
        status: o.status,
        lastRunAt: o.lastRunAt,
        ...(o.lastSuccessAt !== undefined ? { lastSuccessAt: o.lastSuccessAt } : {}),
        ...(o.lastError !== undefined ? { lastError: o.lastError } : {}),
        problems: o.problems ?? [],
        ...(o.problemsTotal !== undefined ? { problemsTotal: o.problemsTotal } : {}),
        conditionsPushed: [],
        lastUpdated: o.lastRunAt,
      }),
    );
  }

  test("refuses a signed-out caller", async () => {
    const s = await setup();
    await expect(s.t.query(api.dashboard.syncAlerts, {})).rejects.toThrow(/Not authenticated/);
  });

  test("nothing pending and nothing failing: empty (the widget stays hidden)", async () => {
    const s = await setup();
    // A set whose last run was clean, after an earlier failure: it self-corrected.
    await record(s, { status: "idle", lastRunAt: NOW, lastSuccessAt: NOW, lastError: "an earlier failure" });
    expect(await s.me.query(api.dashboard.syncAlerts, {})).toEqual({ pending: [], sets: [], more: false });
  });

  test("pending: the cards waiting per platform; another collector's are theirs", async () => {
    const s = await setup();
    await outbox(s, "bsc", 3);
    await outbox(s, "ebay", 1);
    await outbox(s, "bsc", 5, THEM.subject);
    const out = await s.me.query(api.dashboard.syncAlerts, {});
    expect(out.pending).toEqual([
      { platform: "bsc", cards: 3, more: false },
      { platform: "ebay", cards: 1, more: false },
    ]);
    expect(out.sets).toEqual([]);
  });

  test("a later failure shows with NB's sentence; held-back cards show by name (up to SYNC_CARDS_NAMED) and count; sets holding cards back first", async () => {
    const s = await setup();
    await record(s, {
      platform: "bsc",
      status: "error",
      // The newer run: still after the set that holds cards back.
      lastRunAt: NOW + 1000,
      lastSuccessAt: NOW - DAY,
      lastError: "BuySportsCards didn't answer. NB tries again on the next sync.",
    });
    await record(s, {
      platform: "ebay",
      variantId: s.fx.goldId,
      status: "idle",
      lastRunAt: NOW,
      lastSuccessAt: NOW,
      problems: [
        { cardId: s.fx.gold1, reason: "noPrice" },
        { reason: "noLink" },
        { cardId: s.fx.gold1, reason: "rejected", detail: "Too blurry" },
        ...Array.from({ length: SYNC_CARDS_NAMED + 2 }, () => ({ cardId: s.fx.gold1, reason: "noPrice" as const })),
      ],
      problemsTotal: SYNC_CARDS_NAMED + 40,
    });
    await record(s, { status: "error", lastRunAt: NOW, lastError: "theirs", ownerId: THEM.subject });
    const out = await s.me.query(api.dashboard.syncAlerts, {});
    expect(out.sets.map((x) => [x.platform, x.failed, x.heldBack])).toEqual([
      ["ebay", false, SYNC_CARDS_NAMED + 40],
      ["bsc", true, 0],
    ]);
    expect(out.sets[1].message).toBe("BuySportsCards didn't answer. NB tries again on the next sync.");
    expect(out.sets[0].message).toBeUndefined();
    expect(out.sets[0].cards).toHaveLength(SYNC_CARDS_NAMED);
    expect(out.sets[0].cards[1]).toEqual({ cardId: s.fx.gold1, reason: "rejected", detail: "Too blurry" });
    expect(typeof out.sets[0].setLabel).toBe("string");
  });

  test("a held-back set is named with its brand, as its cards' listing titles do (NEO-464)", async () => {
    const s = await setup();
    await s.t.run((ctx) => ctx.db.patch(s.fx.setId, { value: "Chrome" }));
    await record(s, { platform: "ebay", variantId: s.fx.baseId, status: "idle", lastRunAt: NOW, lastSuccessAt: NOW, problems: [{ cardId: s.fx.gooden1, reason: "noPrice" }] });
    await record(s, { platform: "bsc", variantId: s.fx.goldId, status: "error", lastRunAt: NOW - 1, lastError: "theirs" });
    const out = await s.me.query(api.dashboard.syncAlerts, {});
    // Base reads as the set alone; any other variant after it.
    expect(out.sets.map((x) => x.setLabel)).toEqual(["2024 Topps Chrome", "2024 Topps Chrome Gold Refractor"]);
  });

  test(`at most SYNC_ALERTS_SHOWN (${SYNC_ALERTS_SHOWN}) sets, with more said`, async () => {
    const s = await setup();
    for (let i = 0; i < SYNC_ALERTS_SHOWN + 1; i++) {
      await record(s, { status: "error", lastRunAt: NOW - i, lastError: `fail ${i}`, variantId: i % 2 ? s.fx.goldId : s.fx.baseId, platform: i % 2 ? "ebay" : "bsc" });
    }
    const out = await s.me.query(api.dashboard.syncAlerts, {});
    expect(out.sets).toHaveLength(SYNC_ALERTS_SHOWN);
    expect(out.more).toBe(true);
  });
});
