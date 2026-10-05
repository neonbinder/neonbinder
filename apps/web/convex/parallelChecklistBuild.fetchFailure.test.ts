/**
 * NEO-321 follow-up — when a side of `buildParallelChecklist` fails, the log
 * says exactly why (`parallel_fetch_failed`) and the operator reads which
 * kind of failure it was; when it answers, its timing is logged
 * (`parallel_fetch_ok`). Logging and copy only: no retry, no pacing.
 *
 * Both adapters are replaced wholesale (the `parallelChecklistBuild.test.ts`
 * pattern) and return each failure class the real adapters report — the
 * real adapters' own reporting is pinned in
 * `marketplaceFetchFailure.adapters.test.ts`.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { blockedSideFailed } from "./parallelChecklistBuild";
import type { FetchFailure } from "./lib/marketplaceFetchFailure";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_neo321_fetch",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo321_fetch",
  role: "admin",
};

const SENTINEL = 1_700_000_000_000;

type Outcome =
  | {
      success: true;
      cards: Array<{ cardNumber: string; cardName: string; platformRef: string }>;
      pages?: number;
      slowestPageMs?: number;
    }
  | { success: false; message?: string; failure?: FetchFailure }
  | { throws: string };

const bscState = vi.hoisted(() => ({
  outcome: { success: true, cards: [] } as unknown,
}));
vi.mock("./adapters/buysportscards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/buysportscards")>();
  const { action } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    fetchBscChecklist: action({
      args: {
        parentFilters: v.record(v.string(), v.string()),
        platformFilters: v.optional(v.record(v.string(), v.array(v.string()))),
        facetFilters: v.optional(v.record(v.string(), v.array(v.string()))),
        sourceFacet: v.optional(v.string()),
      },
      returns: v.any(),
      handler: async () => {
        const o = bscState.outcome as Outcome;
        if ("throws" in o) throw new Error(o.throws);
        return { cards: [], ...o };
      },
    }),
  };
});

const slState = vi.hoisted(() => ({
  bySlId: {} as Record<string, unknown>,
}));
vi.mock("./adapters/sportlots", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/sportlots")>();
  const { action } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    fetchSportLotsChecklist: action({
      args: {
        parentFilters: v.record(v.string(), v.string()),
        platformFilters: v.optional(v.record(v.string(), v.string())),
      },
      returns: v.any(),
      handler: async (_ctx, args) => {
        const slId = args.platformFilters?.parallel ?? "";
        const o = (slState.bySlId[slId] ?? { success: true, cards: [] }) as Outcome;
        if ("throws" in o) throw new Error(o.throws);
        return { cards: [], ...o };
      },
    }),
  };
});

type LogLine = Record<string, unknown> & { msg: string };
let lines: LogLine[] = [];
let raw: string[] = [];

beforeEach(() => {
  bscState.outcome = {
    success: true,
    cards: [{ cardNumber: "1", cardName: "Someone", platformRef: "bsc-1" }],
    pages: 1,
    slowestPageMs: 12,
  };
  slState.bySlId = {};
  lines = [];
  raw = [];
  const capture = (...args: unknown[]) => {
    const text = args.map(String).join(" ");
    raw.push(text);
    try {
      const parsed = JSON.parse(text) as LogLine;
      if (parsed && typeof parsed.msg === "string") lines.push(parsed);
    } catch {
      // not a JSON line
    }
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});

afterEach(() => {
  vi.restoreAllMocks();
});

type T = ReturnType<typeof convexTest>;

/** sport → year → setName → variantType(Insert) → insert(Anime) → parallel. */
async function seed(t: T, slIds: string[] = ["SL-P-1"]) {
  return t.run(async (ctx) => {
    const sport = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: { bsc: { b0: "baseball" }, sportlots: { s0: "BB" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    const year = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2024",
      parentId: sport,
      platformData: { bsc: { b0: "2024" }, sportlots: { s0: "2024" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    const setName = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Bowman",
      parentId: year,
      platformData: { bsc: { b0: "bowman" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    const variantType = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Insert",
      parentId: setName,
      platformData: { bsc: { b0: "insert" } },
      platformFacets: { bsc: { b0: "variant" } },
      metadata: { variantRole: "insert" },
      children: [],
      lastUpdated: SENTINEL,
    });
    const insert = await ctx.db.insert("selectorOptions", {
      level: "insert",
      value: "Anime",
      parentId: variantType,
      platformData: { bsc: { b0: "anime" }, sportlots: { s0: "SL-INSERT-1" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    const sl: Record<string, string> = {};
    slIds.forEach((id, i) => {
      sl[`s${i}`] = id;
    });
    const parallel = await ctx.db.insert("selectorOptions", {
      level: "parallel",
      value: "Anime Kanji",
      parentId: insert,
      platformData: { bsc: { b0: "anime-kanji" }, sportlots: sl },
      platformFacets: { bsc: { b0: "variantName" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    await ctx.db.patch(variantType, { children: [insert] });
    await ctx.db.patch(insert, { children: [parallel] });
    await ctx.db.insert("cardChecklist", {
      selectorOptionId: insert,
      cardNumber: "1",
      cardName: "Someone",
      platformData: {},
      sortOrder: 0,
      lastUpdated: SENTINEL,
    });
    return { insert, parallel };
  });
}

async function build(t: T, parallelId: Id<"selectorOptions">) {
  return t
    .withIdentity(ADMIN)
    .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });
}

const failedLines = () => lines.filter((l) => l.msg === "parallel_fetch_failed");
const okLines = () => lines.filter((l) => l.msg === "parallel_fetch_ok");

describe("blockedSideFailed — the operator's sentence per failure kind (DRAFT copy)", () => {
  test.each([
    ["timeout", "BSC took too long to answer, so nothing changed — try again in a bit"],
    ["network", "BSC couldn't be reached, so nothing changed — try again in a bit"],
    ["http_error", "BSC answered with an error, so nothing changed — try again in a bit"],
    ["bad_response", "BSC answered with an error, so nothing changed — try again in a bit"],
    ["signed_out", "BSC signed us out, so nothing changed — try again in a bit"],
    ["no_sign_in", "we couldn't sign in to BSC, so nothing changed — try again in a bit"],
    ["refused", "BSC didn't answer, so nothing changed — try again in a bit"],
    ["unknown", "BSC didn't answer, so nothing changed — try again in a bit"],
  ] as const)("%s", (kind, sentence) => {
    expect(blockedSideFailed("bsc", kind)).toBe(sentence);
  });

  test("SportLots is named as SportLots; no kind keeps the old sentence", () => {
    expect(blockedSideFailed("sportlots", "signed_out")).toBe(
      "SportLots signed us out, so nothing changed — try again in a bit",
    );
    expect(blockedSideFailed("sportlots")).toBe(
      "SportLots didn't answer, so nothing changed — try again in a bit",
    );
  });

  test("no sentence carries a status code, URL or marketplace message", () => {
    for (const kind of ["timeout", "http_error", "signed_out", "no_sign_in"] as const) {
      const s = blockedSideFailed("bsc", kind);
      expect(s).not.toMatch(/\d{3}|https?:|api|token|cookie|session/i);
    }
  });
});

describe("buildParallelChecklist — a failed side says why, in the log and to the operator", () => {
  test("BSC timeout: reason, timer, elapsed, and the operator hears 'took too long'", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seed(t);
    bscState.outcome = {
      success: false,
      message: "BSC error: variantName=anime-kanji: BSC API request timed out after 30s",
      failure: {
        kind: "timeout",
        timedOut: true,
        timeoutMs: 30_000,
        requests: 1,
        requestsOk: 0,
      },
    };
    slState.bySlId["SL-P-1"] = {
      success: true,
      cards: [{ cardNumber: "1", cardName: "Someone", platformRef: "sl-1" }],
      pages: 2,
      slowestPageMs: 40,
    };

    const result = await build(t, parallel);

    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe(
      "BSC took too long to answer, so nothing changed — try again in a bit",
    );
    const failed = failedLines();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      parallelId: parallel,
      sourceKind: "insert",
      side: "bsc",
      reason: "timeout",
      errorClass: "timeout",
      timedOut: true,
      timeoutMs: 30_000,
      threw: false,
      requests: 1,
      requestsOk: 0,
    });
    expect(typeof failed[0].elapsedMs).toBe("number");
    expect(failed[0].message).toContain("timed out after 30s");
    // The side that answered logs its timing — one line, its numbers.
    const ok = okLines();
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({
      side: "sportlots",
      pages: 2,
      slowestPageMs: 40,
      cards: 1,
      sets: 1,
    });
  });

  test("BSC non-2xx: the status is logged, the operator hears 'answered with an error'", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seed(t);
    bscState.outcome = {
      success: false,
      message: "BSC error: variantName=anime-kanji: BSC API error: 503",
      failure: { kind: "http_error", httpStatus: 503, timedOut: false },
    };

    const result = await build(t, parallel);

    expect(result.blockedReason).toBe(
      "BSC answered with an error, so nothing changed — try again in a bit",
    );
    expect(failedLines()[0]).toMatchObject({
      side: "bsc",
      reason: "http_error",
      httpStatus: 503,
      timedOut: false,
    });
  });

  test("BSC 401 and a failed re-auth: signed out, re-auth attempted", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seed(t);
    bscState.outcome = {
      success: false,
      message: "BSC error: variantName=anime-kanji: BSC API 401 and re-auth failed",
      failure: { kind: "signed_out", httpStatus: 401, timedOut: false, reauthAttempted: true },
    };

    const result = await build(t, parallel);

    expect(result.blockedReason).toBe(
      "BSC signed us out, so nothing changed — try again in a bit",
    );
    expect(failedLines()[0]).toMatchObject({
      reason: "signed_out",
      errorClass: "auth",
      httpStatus: 401,
      reauthAttempted: true,
    });
  });

  test("BSC no token: we couldn't sign in", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seed(t);
    bscState.outcome = {
      success: false,
      message: "No BSC token available. Connect your BSC account first.",
      failure: { kind: "no_sign_in", timedOut: false },
    };

    const result = await build(t, parallel);

    expect(result.blockedReason).toBe(
      "we couldn't sign in to BSC, so nothing changed — try again in a bit",
    );
    expect(failedLines()[0]).toMatchObject({ reason: "no_sign_in", errorClass: "no_credentials" });
  });

  test("SportLots page timeout on the second set: which page, which set, how many before", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seed(t, ["SL-P-1", "SL-P-2"]);
    slState.bySlId["SL-P-1"] = {
      success: true,
      cards: [{ cardNumber: "1", cardName: "Someone", platformRef: "sl-1" }],
      pages: 3,
      slowestPageMs: 900,
    };
    slState.bySlId["SL-P-2"] = {
      success: false,
      message:
        "SportLots error: SportLots request timed out after 30s: https://www.sportlots.com/inven/dealbin/listcards.tpl",
      failure: {
        kind: "timeout",
        timedOut: true,
        timeoutMs: 30_000,
        pageStart: 201,
        pagesOk: 2,
      },
    };

    const result = await build(t, parallel);

    expect(result.blockedReason).toBe(
      "SportLots took too long to answer, so nothing changed — try again in a bit",
    );
    const failed = failedLines().find((l) => l.side === "sportlots")!;
    expect(failed).toMatchObject({
      reason: "timeout",
      timedOut: true,
      failedPageStart: 201,
      pagesOk: 2,
      sets: 2,
      setsOk: 1,
      pagesBefore: 3,
    });
    // The URL in the adapter's message never reaches the log.
    expect(failed.message).toBe("SportLots error: SportLots request timed out after 30s: <url>");
  });

  test("SportLots signed us out (session expired)", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seed(t);
    slState.bySlId["SL-P-1"] = {
      success: false,
      message: "SportLots session expired. Re-authenticate from Profile.",
      failure: { kind: "signed_out", httpStatus: 200, timedOut: false, pageStart: 1, pagesOk: 0 },
    };

    const result = await build(t, parallel);

    expect(result.blockedReason).toBe(
      "SportLots signed us out, so nothing changed — try again in a bit",
    );
    expect(failedLines()[0]).toMatchObject({
      side: "sportlots",
      reason: "signed_out",
      errorClass: "session_expired",
      failedPageStart: 1,
      pagesOk: 0,
    });
  });

  test("a failure with no structured reason is read off the message (older adapter)", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seed(t);
    slState.bySlId["SL-P-1"] = { success: false, message: "SportLots HTTP error: 502" };

    const result = await build(t, parallel);

    expect(result.blockedReason).toBe(
      "SportLots answered with an error, so nothing changed — try again in a bit",
    );
    expect(failedLines()[0]).toMatchObject({ reason: "http_error", httpStatus: 502 });
  });

  test("a thrown adapter call is logged with its name and message, threw: true", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seed(t);
    bscState.outcome = { throws: "fetch failed" };

    const result = await build(t, parallel);

    expect(result.blockedReason).toBe(
      "BSC couldn't be reached, so nothing changed — try again in a bit",
    );
    const failed = failedLines()[0];
    expect(failed).toMatchObject({ side: "bsc", reason: "network", threw: true });
    expect(String(failed.message)).toContain("fetch failed");
  });

  test("both sides answer: one ok line each, no failure line", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seed(t);
    slState.bySlId["SL-P-1"] = {
      success: true,
      cards: [{ cardNumber: "1", cardName: "Someone", platformRef: "sl-1" }],
      pages: 2,
      slowestPageMs: 33,
    };

    const result = await build(t, parallel);

    expect(result.status).toBe("built");
    expect(failedLines()).toHaveLength(0);
    const ok = okLines();
    expect(ok.map((l) => l.side).sort()).toEqual(["bsc", "sportlots"]);
    expect(ok.find((l) => l.side === "bsc")).toMatchObject({
      pages: 1,
      slowestPageMs: 12,
      cards: 1,
    });
    for (const line of ok) expect(typeof line.elapsedMs).toBe("number");
  });
});

describe("no secret or URL lands in a fetch log line", () => {
  test("a message carrying a URL with a query, a bearer token, a cookie and a credential key is scrubbed", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seed(t);
    const SECRET_TOKEN = "fake-secret-abcdefghijklmnopqrstuvwxyz0123456789";
    const COOKIE = "PHPSESSID=zz9plural9alpha";
    bscState.outcome = {
      success: false,
      message:
        `BSC API request failed: request to https://api-prod.buysportscards.com/search/bulk-upload/results?token=${SECRET_TOKEN} ` +
        `with Bearer ${SECRET_TOKEN} and cookie=${COOKIE} via /credentials/buysportscards-credentials-user_123/token`,
      failure: { kind: "network", timedOut: false },
    };

    await build(t, parallel);

    const failed = failedLines();
    expect(failed).toHaveLength(1);
    const text = JSON.stringify(failed[0]);
    expect(text).not.toContain(SECRET_TOKEN);
    expect(text).not.toContain("zz9plural9alpha");
    expect(text).not.toContain("buysportscards.com");
    expect(text).not.toContain("?token");
    expect(text).not.toContain("user_123");
    // And nothing else this build logged carries them either.
    for (const line of raw) {
      expect(line).not.toContain(SECRET_TOKEN);
      expect(line).not.toContain("zz9plural9alpha");
    }
  });
});
