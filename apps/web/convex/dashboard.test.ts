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
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  COULD_FIT_CARDS,
  INTAKE_RECENT_MS,
  SALE_LINES,
  SALES_SHOWN,
  STAMP_MIN_MS,
  VISIT_GAP_MS,
  arrivalOf,
  baseCompletion,
  intakeRunShows,
  intakeRunTally,
  isDealer,
  nextVisit,
  ruleNamesChecklist,
  saleLinesOf,
  smartChecklistCount,
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
      unknown: ["m4"],
    });
  });

  test("the preview is capped; the counts are not", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`g${i}`, i, { cardId: `c${i}` }));
    const tally = intakeRunTally(rows);
    expect(tally.needsYou).toBe(10);
    expect(tally.guesses.map((g) => g.id)).toEqual(["g0", "g1", "g2"]);
  });

  test("an empty run counts nothing", () => {
    expect(intakeRunTally([])).toEqual({ scans: 0, done: 0, needsYou: 0, unidentified: 0, guesses: [], unknown: [] });
  });
});

describe("intakeRunShows", () => {
  const NOW_MS = 1_000_000_000_000;
  test("an unfinished run shows however old; a finished one only within the week; an empty one never", () => {
    expect(intakeRunShows({ scans: 4, done: 1 }, NOW_MS - 90 * DAY, NOW_MS)).toBe(true);
    expect(intakeRunShows({ scans: 4, done: 4 }, NOW_MS - INTAKE_RECENT_MS, NOW_MS)).toBe(true);
    expect(intakeRunShows({ scans: 4, done: 4 }, NOW_MS - INTAKE_RECENT_MS - 1, NOW_MS)).toBe(false);
    expect(intakeRunShows({ scans: 0, done: 0 }, NOW_MS, NOW_MS)).toBe(false);
  });
});

describe("isDealer", () => {
  test("any listing platform connected, or any order, whichever platform", () => {
    expect(isDealer([false, false], false)).toBe(false);
    expect(isDealer([], false)).toBe(false);
    expect(isDealer([false, true], false)).toBe(true);
    expect(isDealer([true, false], false)).toBe(true);
    expect(isDealer([false, false], true)).toBe(true);
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
  opts: { homeId?: Id<"collectionContainers">; ownerId?: string; acquiredOn?: string; lastUpdated: number },
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
  test("the collection lines written after the stamp, newest first; never a box's, never another collector's", async () => {
    const s = await setup();
    await line(s, s.fx.gooden1, s.fx.baseId, { lastUpdated: NOW - 3 * DAY });
    await line(s, s.fx.strawberry2, s.fx.baseId, { lastUpdated: NOW - DAY });
    await line(s, s.fx.gold1, s.fx.goldId, { lastUpdated: NOW });
    await line(s, s.fx.gooden1, s.fx.baseId, { homeId: s.homes.box, lastUpdated: NOW });
    await line(s, s.fx.gooden1, s.fx.baseId, { homeId: s.homes.theirMain, ownerId: THEM.subject, lastUpdated: NOW });
    const result = await s.me.query(api.dashboard.newSince, { sinceMs: NOW - 2 * DAY });
    expect(result).toEqual({
      lines: [
        { homeId: s.homes.main, cardId: s.fx.gold1, lastUpdated: NOW },
        { homeId: s.homes.main, cardId: s.fx.strawberry2, lastUpdated: NOW - DAY },
      ],
      truncated: false,
    });
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

  test("open scans counted across runs: a guess waits on a yes, none is unidentified; done ones are out", async () => {
    const s = await setup();
    const a = await run(s, [s.fx.gooden1, null, "saved", "aside"]);
    const b = await run(s, [s.fx.strawberry2], { homeId: s.homes.box });
    const out = await s.me.query(api.dashboard.intake, {});
    expect(out.needsYou).toBe(2);
    expect(out.unidentified).toBe(1);
    expect(out.truncated).toBe(false);
    expect(out.runs).toEqual(
      expect.arrayContaining([
        { runId: a.runId, homeName: "Main", scans: 4, done: 2 },
        { runId: b.runId, homeName: "Unsorted", scans: 1, done: 0 },
      ]),
    );
    expect(out.guesses.map((g) => g.cardId).sort()).toEqual([s.fx.gooden1, s.fx.strawberry2].sort());
    expect(out.unknown).toEqual([a.ids[1]]);
  });

  test("a finished run shows for a week, then leaves; an unfinished one stays however old", async () => {
    const s = await setup();
    const old = Date.now() - 30 * DAY;
    const finishedLately = await run(s, ["saved"], { lastActivityAt: Date.now() - 2 * DAY });
    await run(s, ["saved"], { lastActivityAt: old });
    const stale = await run(s, [null], { lastActivityAt: old });
    const out = await s.me.query(api.dashboard.intake, {});
    expect(out.runs.map((r) => r.runId).sort()).toEqual([finishedLately.runId, stale.runId].sort());
    expect(out).toMatchObject({ needsYou: 0, unidentified: 1 });
  });

  test("nothing in intake, and another collector's runs are theirs: all zero", async () => {
    const s = await setup();
    await run(s, [s.fx.gooden1, null], { userId: THEM.subject, homeId: s.homes.theirMain });
    expect(await s.me.query(api.dashboard.intake, {})).toEqual({
      needsYou: 0,
      unidentified: 0,
      runs: [],
      guesses: [],
      unknown: [],
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

  test("no listing platform connected and no order: not a dealer (the collector layout)", async () => {
    const s = await setup();
    await s.t.run((ctx) => ctx.db.insert("userProfiles", { userId: ME.subject, siteCredentials: [{ site: "sportlots", hasCredentials: true }] }));
    await order(s, { orderNo: "THEIRS", status: "READY_TO_SHIP", orderDate: NOW, ownerId: THEM.subject });
    expect(await s.me.query(api.dashboard.sales, {})).toEqual({ dealer: false, orders: [], more: false });
  });

  test("a listing platform connected and no sales: a dealer with nothing to ship", async () => {
    for (const site of ["buysportscards", "ebay"]) {
      const s = await setup();
      await connect(s, site);
      expect(await s.me.query(api.dashboard.sales, {})).toEqual({ dealer: true, orders: [], more: false });
    }
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
