/**
 * NEO-536 — a collector's report of a held-back set (`syncReports.ts`) and
 * the dashboard's "with the crew" reads (`crewDesk.ts`), on the collection
 * fixture catalog.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import { listedCleanlySince } from "./syncReports";
import { CREW_DESK_SHOWN } from "./crewDesk";
import {
  MAX_OPEN_SYNC_REPORTS,
  MAX_SYNC_REPORT_CARDS,
  MAX_SYNC_REPORT_DETAIL,
  SYNC_REPORT_GROUP_COUNT_CAP,
} from "../lib/collection/sync-report";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "collector_me_001" };
const THEM = { subject: "collector_them_002" };
const ADMIN = { subject: "admin_003", role: "admin" };

type Reason =
  | "noLink"
  | "sharedLink"
  | "numberMismatch"
  | "noPrice"
  | "priceTooHigh"
  | "noCondition"
  | "graded"
  | "notOnSheet"
  | "rejected"
  | "missingAspect"
  | "noPhoto"
  | "setupIncomplete";

async function setup() {
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  return { t, fx, me: t.withIdentity(ME), them: t.withIdentity(THEM), admin: t.withIdentity(ADMIN) };
}
type S = Awaited<ReturnType<typeof setup>>;

function record(
  s: S,
  o: {
    ownerId?: string;
    platform?: "bsc" | "ebay";
    variantId?: Id<"selectorOptions">;
    status?: "idle" | "running" | "error";
    lastRunAt?: number;
    problems?: Array<{ cardId?: Id<"cardChecklist">; reason: Reason; detail?: string }>;
    problemsTotal?: number;
  } = {},
) {
  return s.t.run((ctx) =>
    ctx.db.insert("marketplaceListingSyncs", {
      ownerId: o.ownerId ?? ME.subject,
      variantId: o.variantId ?? s.fx.baseId,
      platform: o.platform ?? "bsc",
      status: o.status ?? "idle",
      lastRunAt: o.lastRunAt ?? 1000,
      problems: o.problems ?? [],
      ...(o.problemsTotal !== undefined ? { problemsTotal: o.problemsTotal } : {}),
      conditionsPushed: [],
      lastUpdated: 0,
    }),
  );
}

const allReports = (s: S) => s.t.run((ctx) => ctx.db.query("syncReports").collect());

describe("report", () => {
  test("copies only the reportable reasons from the caller's own record; the detail only for rejected and missingAspect, cut to 200", async () => {
    const s = await setup();
    const long = "x".repeat(MAX_SYNC_REPORT_DETAIL + 50);
    await record(s, {
      problems: [
        { cardId: s.fx.gooden1, reason: "noPrice", detail: "No price set." },
        { cardId: s.fx.strawberry2, reason: "noLink", detail: "should not be kept" },
        { cardId: s.fx.gooden1, reason: "rejected", detail: `  ${long}  ` },
        { cardId: s.fx.gooden1Sliding, reason: "missingAspect", detail: "Year Manufactured" },
        { reason: "notOnSheet" },
        { cardId: s.fx.strawberry2, reason: "noPhoto" },
      ],
    });
    // Theirs, on the same set: never read for my report.
    await record(s, { ownerId: THEM.subject, problems: [{ cardId: s.fx.gooden1, reason: "sharedLink" }] });

    const out = await s.me.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "bsc", note: "  look please  " });
    expect(out.already).toBe(false);
    const [row] = await allReports(s);
    expect(row).toMatchObject({
      ownerId: ME.subject,
      platform: "bsc",
      variantId: s.fx.baseId,
      label: "2024 Topps Chrome",
      heldBack: 3,
      note: "look please",
      status: "open",
    });
    expect(row.cards).toEqual([
      { cardId: s.fx.strawberry2, reason: "noLink" },
      { cardId: s.fx.gooden1, reason: "rejected", detail: long.slice(0, MAX_SYNC_REPORT_DETAIL) },
      { cardId: s.fx.gooden1Sliding, reason: "missingAspect", detail: "Year Manufactured" },
    ]);
  });

  test(`keeps at most ${MAX_SYNC_REPORT_CARDS} cards, and heldBack counts them all`, async () => {
    const s = await setup();
    await record(s, {
      problems: Array.from({ length: MAX_SYNC_REPORT_CARDS + 7 }, () => ({ cardId: s.fx.gooden1, reason: "noLink" as const })),
    });
    await s.me.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "bsc" });
    const [row] = await allReports(s);
    expect(row.cards).toHaveLength(MAX_SYNC_REPORT_CARDS);
    expect(row.heldBack).toBe(MAX_SYNC_REPORT_CARDS + 7);
  });

  test("refuses with no record (another collector's record is not mine), a failed sync, or nothing reportable", async () => {
    const s = await setup();
    await record(s, { ownerId: THEM.subject, problems: [{ cardId: s.fx.gooden1, reason: "noLink" }] });
    await expect(s.me.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "bsc" })).rejects.toThrow(
      /hasn't synced there yet/,
    );

    await record(s, { status: "error", problems: [{ cardId: s.fx.gooden1, reason: "noLink" }] });
    await expect(s.me.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "bsc" })).rejects.toThrow(
      /didn't finish/,
    );

    await record(s, {
      platform: "ebay",
      problems: [
        { cardId: s.fx.gooden1, reason: "noPrice" },
        { cardId: s.fx.gooden1, reason: "setupIncomplete" },
        // A reportable reason with no NB card names nothing to report.
        { reason: "noLink" },
      ],
    });
    await expect(s.me.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "ebay" })).rejects.toThrow(
      /needs the crew/,
    );
    expect(await allReports(s)).toEqual([]);
  });

  test("refuses signed out, and a note over 500 characters", async () => {
    const s = await setup();
    await record(s, { problems: [{ cardId: s.fx.gooden1, reason: "noLink" }] });
    await expect(s.t.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "bsc" })).rejects.toThrow(
      /Not authenticated/,
    );
    await expect(
      s.me.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "bsc", note: "y".repeat(501) }),
    ).rejects.toThrow(/too long/);
    expect(await allReports(s)).toEqual([]);
  });

  test("a second report of the same open set refreshes it; a left-out note keeps the note, a blank one clears it", async () => {
    const s = await setup();
    const rec = await record(s, { problems: [{ cardId: s.fx.gooden1, reason: "noLink" }] });
    const first = await s.me.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "bsc", note: "first" });
    await s.t.run((ctx) =>
      ctx.db.patch(rec, {
        problems: [
          { cardId: s.fx.gooden1, reason: "noLink" },
          { cardId: s.fx.strawberry2, reason: "sharedLink" },
        ],
      }),
    );
    const again = await s.me.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "bsc" });
    expect(again).toEqual({ id: first.id, already: true });
    let [row] = await allReports(s);
    expect(row).toMatchObject({ heldBack: 2, note: "first" });
    expect(row.cards.map((c) => c.cardId)).toEqual([s.fx.gooden1, s.fx.strawberry2]);

    await s.me.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "bsc", note: "  " });
    [row] = await allReports(s);
    expect(row.note).toBeUndefined();
    expect(await allReports(s)).toHaveLength(1);
  });

  test("a closed report does not stop a new one", async () => {
    const s = await setup();
    await record(s, { problems: [{ cardId: s.fx.gooden1, reason: "noLink" }] });
    const first = await s.me.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "bsc" });
    await s.admin.mutation(api.syncReports.close, { id: first.id, outcome: "fixed" });
    const second = await s.me.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "bsc" });
    expect(second.already).toBe(false);
    expect(second.id).not.toBe(first.id);
  });

  test(`caps open reports at ${MAX_OPEN_SYNC_REPORTS} per collector`, async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      for (let i = 0; i < MAX_OPEN_SYNC_REPORTS; i++) {
        await ctx.db.insert("syncReports", {
          ownerId: ME.subject,
          platform: "bsc",
          variantId: s.fx.goldId,
          label: `Set ${i}`,
          cards: [],
          heldBack: 1,
          status: "open",
          lastUpdated: 0,
        });
      }
    });
    await record(s, { platform: "ebay", problems: [{ cardId: s.fx.gooden1, reason: "noLink" }] });
    await expect(s.me.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "ebay" })).rejects.toThrow(
      new RegExp(`${MAX_OPEN_SYNC_REPORTS} reports open`),
    );
    // Someone else is not capped by mine.
    await record(s, { ownerId: THEM.subject, platform: "ebay", problems: [{ cardId: s.fx.gooden1, reason: "noLink" }] });
    await expect(s.them.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "ebay" })).resolves.toMatchObject({
      already: false,
    });
  });
});

describe("withdraw", () => {
  test("deletes the caller's own open report; another collector's reads as not found; a closed one stays", async () => {
    const s = await setup();
    await record(s, { problems: [{ cardId: s.fx.gooden1, reason: "noLink" }] });
    await record(s, { platform: "ebay", problems: [{ cardId: s.fx.gooden1, reason: "noLink" }] });
    const mine = await s.me.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "bsc" });
    const closed = await s.me.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "ebay" });
    await s.admin.mutation(api.syncReports.close, { id: closed.id, outcome: "fixed" });

    await expect(s.them.mutation(api.syncReports.withdraw, { id: mine.id })).rejects.toThrow(/isn't one of yours/);
    await expect(s.t.mutation(api.syncReports.withdraw, { id: mine.id })).rejects.toThrow(/Not authenticated/);
    await expect(s.me.mutation(api.syncReports.withdraw, { id: closed.id })).rejects.toThrow(/closed that report already/);
    expect(await allReports(s)).toHaveLength(2);

    await s.me.mutation(api.syncReports.withdraw, { id: mine.id });
    expect((await allReports(s)).map((r) => r._id)).toEqual([closed.id]);
  });
});

describe("close", () => {
  async function twoReports(s: S) {
    await record(s, { problems: [{ cardId: s.fx.gooden1, reason: "noLink" }] });
    await record(s, { ownerId: THEM.subject, problems: [{ cardId: s.fx.gooden1, reason: "noLink" }] });
    // Mine on the other platform: a different group.
    await record(s, { platform: "ebay", problems: [{ cardId: s.fx.gooden1, reason: "noLink" }] });
    const mine = await s.me.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "bsc" });
    const theirs = await s.them.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "bsc" });
    const other = await s.me.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "ebay" });
    return { mine: mine.id, theirs: theirs.id, other: other.id };
  }

  test("is admin-only and writes nothing for anyone else", async () => {
    const s = await setup();
    const ids = await twoReports(s);
    await expect(s.t.mutation(api.syncReports.close, { id: ids.mine, outcome: "fixed" })).rejects.toThrow(/Not authenticated/);
    await expect(s.me.mutation(api.syncReports.close, { id: ids.mine, outcome: "fixed" })).rejects.toThrow(
      /Admin access required/,
    );
    expect((await allReports(s)).map((r) => r.status)).toEqual(["open", "open", "open"]);
  });

  test("closes every open report on the set and platform, whoever sent it, and nothing else", async () => {
    const s = await setup();
    const ids = await twoReports(s);
    expect(await s.admin.mutation(api.syncReports.close, { id: ids.theirs, outcome: "fixed" })).toEqual({ closed: 2 });
    const rows = await allReports(s);
    const by = new Map(rows.map((r) => [r._id, r]));
    for (const id of [ids.mine, ids.theirs]) {
      expect(by.get(id)).toMatchObject({ status: "fixed", closedBy: ADMIN.subject });
      expect(by.get(id)!.closedAt).toBeTypeOf("number");
      expect(by.get(id)!.closeNote).toBeUndefined();
    }
    expect(by.get(ids.other)!.status).toBe("open");
    await expect(s.admin.mutation(api.syncReports.close, { id: ids.mine, outcome: "fixed" })).rejects.toThrow(/closed already/);
  });

  test("Not a bug needs a note, and the collector reads it (never who closed it)", async () => {
    const s = await setup();
    const ids = await twoReports(s);
    await expect(s.admin.mutation(api.syncReports.close, { id: ids.mine, outcome: "notABug" })).rejects.toThrow(/Add a note/);
    await expect(s.admin.mutation(api.syncReports.close, { id: ids.mine, outcome: "notABug", note: "   " })).rejects.toThrow(
      /Add a note/,
    );
    await expect(
      s.admin.mutation(api.syncReports.close, { id: ids.mine, outcome: "notABug", note: "z".repeat(501) }),
    ).rejects.toThrow(/too long/);
    expect((await allReports(s)).every((r) => r.status === "open")).toBe(true);

    await s.admin.mutation(api.syncReports.close, { id: ids.mine, outcome: "notABug", note: " That card isn't on their sheet. " });
    const mine = await s.me.query(api.syncReports.mine, {});
    const closed = mine.find((r) => r._id === ids.mine)!;
    expect(closed).toMatchObject({ status: "notABug", closeNote: "That card isn't on their sheet." });
    expect(closed).not.toHaveProperty("closedBy");
    expect((await s.them.query(api.syncReports.mine, {}))[0]).toMatchObject({ status: "notABug" });
  });
});

describe("mine", () => {
  test("the caller's reports of every status, newest first; nobody else's", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      const base = { platform: "bsc" as const, variantId: s.fx.baseId, cards: [], heldBack: 1, lastUpdated: 0 };
      await ctx.db.insert("syncReports", { ...base, ownerId: ME.subject, label: "closed late", status: "fixed", closedAt: Date.now() + 10_000 });
      await ctx.db.insert("syncReports", { ...base, ownerId: ME.subject, label: "open", status: "open" });
      await ctx.db.insert("syncReports", { ...base, ownerId: ME.subject, label: "closed early", status: "notABug", closedAt: 1, closeNote: "why" });
      await ctx.db.insert("syncReports", { ...base, ownerId: THEM.subject, label: "theirs", status: "open" });
    });
    expect((await s.me.query(api.syncReports.mine, {})).map((r) => r.label)).toEqual(["closed late", "open", "closed early"]);
    await expect(s.t.query(api.syncReports.mine, {})).rejects.toThrow(/Not authenticated/);
  });
});

describe("queue and review", () => {
  test("admin-only; one row per set and platform, oldest first, with how many others reported it; no collector ids", async () => {
    const s = await setup();
    await record(s, { problems: [{ cardId: s.fx.gooden1, reason: "noLink" }] });
    await record(s, { ownerId: THEM.subject, problems: [{ cardId: s.fx.gooden1, reason: "noLink" }] });
    await record(s, { variantId: s.fx.goldId, platform: "ebay", problems: [{ cardId: s.fx.gold1, reason: "rejected", detail: "Blurry" }] });
    const first = await s.me.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "bsc", note: "help" });
    await s.them.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "bsc" });
    const gold = await s.me.mutation(api.syncReports.report, { variantId: s.fx.goldId, platform: "ebay" });

    await expect(s.t.query(api.syncReports.queue, {})).rejects.toThrow(/Not authenticated/);
    await expect(s.me.query(api.syncReports.queue, {})).rejects.toThrow(/Admin access required/);
    const out = await s.admin.query(api.syncReports.queue, {});
    expect(out.more).toBe(false);
    expect(out.reports.map((r) => [r._id, r.platform, r.alsoReportedBy, r.note])).toEqual([
      [first.id, "bsc", 1, "help"],
      [gold.id, "ebay", 0, undefined],
    ]);
    expect(JSON.stringify(out)).not.toContain(ME.subject);
    expect(JSON.stringify(out)).not.toContain(THEM.subject);
  });

  test("review: the held cards by NB number and name (gone ones counted), the owner, the group, and null for a bad id", async () => {
    const s = await setup();
    await record(s, {
      problems: [
        { cardId: s.fx.strawberry2, reason: "noLink" },
        { cardId: s.fx.gooden1, reason: "rejected", detail: "Too blurry" },
      ],
    });
    const r = await s.me.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "bsc" });
    await s.t.run((ctx) => ctx.db.delete(s.fx.strawberry2));

    await expect(s.me.query(api.syncReports.review, { id: r.id })).rejects.toThrow(/Admin access required/);
    const out = await s.admin.query(api.syncReports.review, { id: r.id });
    expect(out).toMatchObject({
      _id: r.id,
      status: "open",
      label: "2024 Topps Chrome",
      ownerId: ME.subject,
      heldBack: 2,
      cardsGone: 1,
      alsoReportedBy: 0,
    });
    expect(out!.cards).toEqual([
      { cardId: s.fx.gooden1, reason: "rejected", detail: "Too blurry", cardNumber: "1", cardLabel: "Dwight Gooden" },
    ]);
    // Still held back on the owner's record: not listed cleanly.
    expect(out!.listedCleanlySince).toBeUndefined();
    expect(await s.admin.query(api.syncReports.review, { id: "not-an-id" })).toBeNull();
  });

  test("review: listedCleanlySince is the owner's last run once it no longer holds a reported card back", async () => {
    const s = await setup();
    const rec = await record(s, { problems: [{ cardId: s.fx.gooden1, reason: "noLink" }] });
    const r = await s.me.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "bsc" });
    // A later run that holds back only a card nobody reported.
    await s.t.run((ctx) =>
      ctx.db.patch(rec, { lastRunAt: 5000, problems: [{ cardId: s.fx.strawberry2, reason: "noPrice" }], problemsTotal: 1 }),
    );
    expect((await s.admin.query(api.syncReports.review, { id: r.id }))!.listedCleanlySince).toBe(5000);
    // It stays open: nothing closes on its own.
    expect((await allReports(s))[0].status).toBe("open");
  });
});

describe("listedCleanlySince (pure)", () => {
  const reported = [{ cardId: "c1" }];
  test("only a finished run whose whole held-back list names none of the reported cards", () => {
    expect(listedCleanlySince(null, reported)).toBeUndefined();
    expect(listedCleanlySince({ status: "idle", lastRunAt: 9, problems: [] }, reported)).toBe(9);
    expect(listedCleanlySince({ status: "running", lastRunAt: 9, problems: [] }, reported)).toBeUndefined();
    expect(listedCleanlySince({ status: "error", lastRunAt: 9, problems: [] }, reported)).toBeUndefined();
    expect(listedCleanlySince({ status: "idle", problems: [] }, reported)).toBeUndefined();
    expect(
      listedCleanlySince({ status: "idle", lastRunAt: 9, problems: [{ cardId: "c1" as never, reason: "noPrice" }] }, reported),
    ).toBeUndefined();
    // Cut at the writer's cap: a reported card could hide past it.
    expect(listedCleanlySince({ status: "idle", lastRunAt: 9, problems: [], problemsTotal: 3 }, reported)).toBeUndefined();
  });
});

describe("crewDesk", () => {
  async function requests(s: S, ownerId: string, n: number, status: "waiting" | "added" | "declined" = "waiting") {
    await s.t.run(async (ctx) => {
      for (let i = 0; i < n; i++) {
        await ctx.db.insert("cardRequests", {
          ownerId,
          kind: i % 2 === 0 ? "card" : "set",
          status,
          label: `${ownerId} ${status} ${i}`,
          lastUpdated: i,
        });
      }
    });
  }

  test("mine: only the caller's waiting requests and open reports, newest first, capped with totals", async () => {
    const s = await setup();
    await requests(s, ME.subject, CREW_DESK_SHOWN + 2);
    await requests(s, ME.subject, 2, "declined");
    await requests(s, ME.subject, 1, "added");
    await requests(s, THEM.subject, 3);
    await record(s, { problems: [{ cardId: s.fx.gooden1, reason: "noLink" }] });
    await record(s, { platform: "ebay", problems: [{ cardId: s.fx.gooden1, reason: "noLink" }] });
    await record(s, { ownerId: THEM.subject, problems: [{ cardId: s.fx.gooden1, reason: "noLink" }] });
    await s.me.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "bsc" });
    const ebay = await s.me.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "ebay" });
    await s.them.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "bsc" });
    // Closed: not on the dashboard.
    await s.admin.mutation(api.syncReports.close, { id: ebay.id, outcome: "fixed" });

    await expect(s.t.query(api.crewDesk.mine, {})).rejects.toThrow(/Not authenticated/);
    const out = await s.me.query(api.crewDesk.mine, {});
    expect(out.requestsTotal).toBe(CREW_DESK_SHOWN + 2);
    expect(out.requests).toHaveLength(CREW_DESK_SHOWN);
    expect(out.requests[0].label).toBe(`${ME.subject} waiting ${CREW_DESK_SHOWN + 1}`);
    expect(out.requests.every((r) => r.label.startsWith(`${ME.subject} waiting`))).toBe(true);
    expect(out.reportsTotal).toBe(1);
    expect(out.reports.map((r) => [r.platform, r.label, r.heldBack])).toEqual([["bsc", "2024 Topps Chrome", 1]]);
    // Only the open one is a reported set; never theirs, never a closed one.
    expect(out.reportedKeys).toEqual([{ variantId: s.fx.baseId, platform: "bsc" }]);
  });

  /** An open report of `ownerId`'s on one set and platform, written straight in. */
  function openReport(s: S, ownerId: string, variantId: Id<"selectorOptions">, platform: "bsc" | "ebay") {
    return s.t.run((ctx) =>
      ctx.db.insert("syncReports", {
        ownerId,
        platform,
        variantId,
        label: `${variantId} ${platform}`,
        cards: [],
        heldBack: 1,
        status: "open",
        lastUpdated: 0,
      }),
    );
  }

  test(`mine: reportedKeys names every open report, past the ${CREW_DESK_SHOWN} rows shown`, async () => {
    const s = await setup();
    const sets = [s.fx.baseId, s.fx.futureStarsId, s.fx.goldId, s.fx.setId];
    for (const variantId of sets) {
      for (const platform of ["bsc", "ebay"] as const) await openReport(s, ME.subject, variantId, platform);
    }
    await openReport(s, THEM.subject, s.fx.year1986Id, "bsc");
    const out = await s.me.query(api.crewDesk.mine, {});
    expect(sets.length * 2).toBeGreaterThan(CREW_DESK_SHOWN);
    expect(out.reports).toHaveLength(CREW_DESK_SHOWN);
    expect(out.reportsTotal).toBe(sets.length * 2);
    const keys = new Set(out.reportedKeys.map((k) => `${k.platform}|${k.variantId}`));
    expect(keys.size).toBe(sets.length * 2);
    for (const variantId of sets) {
      expect(keys.has(`bsc|${variantId}`)).toBe(true);
      expect(keys.has(`ebay|${variantId}`)).toBe(true);
    }
    expect(keys.has(`bsc|${s.fx.year1986Id}`)).toBe(false);
  });

  test(`waiting: each report row counts the other collectors with that set open, to ${SYNC_REPORT_GROUP_COUNT_CAP}`, async () => {
    const s = await setup();
    // The oldest of the group stands for it; the others are counted.
    const first = await openReport(s, ME.subject, s.fx.baseId, "bsc");
    for (let i = 0; i < SYNC_REPORT_GROUP_COUNT_CAP + 3; i++) await openReport(s, `collector_${i}`, s.fx.baseId, "bsc");
    // The same set on the other platform is its own group.
    const ebay = await openReport(s, THEM.subject, s.fx.baseId, "ebay");
    const alone = await openReport(s, THEM.subject, s.fx.goldId, "bsc");
    const out = await s.admin.query(api.crewDesk.waiting, {});
    const queue = await s.admin.query(api.syncReports.queue, {});
    expect(out.reports.map((r) => [r._id, r.alsoReportedBy])).toEqual([
      [first, SYNC_REPORT_GROUP_COUNT_CAP],
      [ebay, 0],
      [alone, 0],
    ]);
    // The same count the admin queue gives.
    expect(out.reports.map((r) => r.alsoReportedBy)).toEqual(queue.reports.map((r) => r.alsoReportedBy));
  });

  test("waiting: admin-only; everyone's open asks oldest first, one report per set and platform, no collector ids", async () => {
    const s = await setup();
    await requests(s, ME.subject, 2);
    await requests(s, THEM.subject, 1);
    await requests(s, THEM.subject, 1, "declined");
    await record(s, { problems: [{ cardId: s.fx.gooden1, reason: "noLink" }] });
    await record(s, { ownerId: THEM.subject, problems: [{ cardId: s.fx.gooden1, reason: "noLink" }] });
    const first = await s.me.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "bsc" });
    await s.them.mutation(api.syncReports.report, { variantId: s.fx.baseId, platform: "bsc" });

    await expect(s.t.query(api.crewDesk.waiting, {})).rejects.toThrow(/Not authenticated/);
    await expect(s.me.query(api.crewDesk.waiting, {})).rejects.toThrow(/Admin access required/);
    const out = await s.admin.query(api.crewDesk.waiting, {});
    expect(out.requests.map((r) => r.label)).toEqual([
      `${ME.subject} waiting 0`,
      `${THEM.subject} waiting 0`,
      `${ME.subject} waiting 1`,
    ]);
    expect(out.reports.map((r) => [r._id, r.alsoReportedBy])).toEqual([[first.id, 1]]);
    expect(out.requestsMore).toBe(false);
    expect(out.reportsMore).toBe(false);
    for (const item of [...out.requests, ...out.reports]) expect(item).not.toHaveProperty("ownerId");
  });
});
