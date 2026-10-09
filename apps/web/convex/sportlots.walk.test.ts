/**
 * NEO-325: tests for `walkSlListcards` (convex/adapters/sportlots.ts), the
 * `listcards.tpl` page loop lifted out of `fetchSportLotsChecklist` so the
 * Base match probe can read a set's first page, or count it, with the same
 * parse and the same end-of-set rules.
 *
 * The walk is called directly (it takes a cookie string and a set id and
 * needs no Convex ctx); `fetchSportLotsChecklist` is called through
 * convex-test only for the parity check against it.
 */

import fs from "node:fs";
import path from "node:path";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { walkSlListcards } from "./adapters/sportlots";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_user_walk_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_walk_001",
  name: "Admin User",
  role: "admin",
};

const COOKIE = "PHPSESSID=walk-test-cookie";

const tokenReads = vi.hoisted(() => ({ count: 0 }));
vi.mock("./credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./credentials")>();
  const { internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    getSiteToken: internalAction({
      args: { site: v.string() },
      returns: v.any(),
      handler: async () => {
        tokenReads.count++;
        return { token: "sl-session-cookie" };
      },
    }),
  };
});

beforeEach(() => {
  tokenReads.count = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A card row as `listcards.tpl` serves it; `variation` swaps the number cell's class. */
function row(num: string, desc: string, variation = false): string {
  return `<td class="${variation ? "smallcolorleft" : "smallleft"}">${num}</td>\n<td class="smallleft">${desc}</td>`;
}

type Call = { start: number; selset: string; cookie: string };

/** Stub fetch with a page-by-start responder; records every POST. */
function stubPages(
  pageFor: (start: number, n: number) => string | Response | Error,
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = new URLSearchParams(String(init.body));
      const start = Number(body.get("start"));
      calls.push({
        start,
        selset: body.get("selset") ?? "",
        cookie: String((init.headers as Record<string, string>).Cookie),
      });
      const out = pageFor(start, calls.length);
      if (out instanceof Error) throw out;
      return out instanceof Response ? out : new Response(out, { status: 200 });
    }),
  );
  return calls;
}

/** A page whose first row is unique to `start`, so no two pages share a fingerprint. */
const distinctPage = (start: number) => row(String(start), `Player ${start}`);

describe("walkSlListcards paging", () => {
  test("advances start by a fixed 100 per request, whatever the row count", async () => {
    const calls = stubPages((start) =>
      start <= 201 ? row(String(start), `Player ${start}`) : "",
    );

    const walked = await walkSlListcards(COOKIE, "555", { maxPages: 200 });

    expect(calls.map((c) => c.start)).toEqual([1, 101, 201, 301]);
    expect("cards" in walked && walked.cards.map((c) => c.cardNumber)).toEqual([
      "1",
      "101",
      "201",
    ]);
  });

  test("stops on an empty page, counting it in neither cards nor pagesOk", async () => {
    stubPages((start) => (start === 1 ? row("1", "Aaron Judge") : ""));

    const walked = await walkSlListcards(COOKIE, "555", { maxPages: 200 });

    expect(walked).toMatchObject({ pagesOk: 2 });
    expect("cards" in walked && walked.cards).toHaveLength(1);
  });

  test("a short page mid-set does not end the walk", async () => {
    const calls = stubPages((start) =>
      start === 1 ? row("1", "A One") : start === 101 ? row("2", "B Two") : "",
    );

    const walked = await walkSlListcards(COOKIE, "555", { maxPages: 200 });

    expect(calls).toHaveLength(3);
    expect("cards" in walked && walked.cards).toHaveLength(2);
  });

  test("a repeated page stops the walk and is not appended twice", async () => {
    const calls = stubPages(() => row("7", "Same Player"));

    const walked = await walkSlListcards(COOKIE, "555", { maxPages: 200 });

    expect(calls).toHaveLength(2);
    expect("cards" in walked && walked.cards).toHaveLength(1);
  });

  test.each([
    ["1", 1],
    ["0", 0],
    ["NaN", Number.NaN],
    ["negative", -5],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("maxPages %s reads exactly one page", async (_label, maxPages) => {
    const calls = stubPages((start) => distinctPage(start));

    const walked = await walkSlListcards(COOKIE, "555", { maxPages });

    expect(calls).toHaveLength(1);
    expect(walked).toMatchObject({ pagesOk: 1 });
  });

  test("maxPages 3 reads three pages", async () => {
    const calls = stubPages((start) => distinctPage(start));

    await walkSlListcards(COOKIE, "555", { maxPages: 3 });

    expect(calls.map((c) => c.start)).toEqual([1, 101, 201]);
  });

  test("maxPages 500 is clamped to 200 requests", async () => {
    const calls = stubPages((start) => distinctPage(start));

    const walked = await walkSlListcards(COOKIE, "555", { maxPages: 500 });

    expect(calls).toHaveLength(200);
    expect(walked).toMatchObject({ pagesOk: 200 });
    expect("cards" in walked && walked.cards).toHaveLength(200);
  });

  test("posts the set id as selset and the caller's cookie, verbatim", async () => {
    const calls = stubPages(() => "");

    await walkSlListcards(COOKIE, "set-77", { maxPages: 1 });

    expect(calls).toEqual([{ start: 1, selset: "set-77", cookie: COOKIE }]);
  });

  test("never reads the session token itself", async () => {
    stubPages(() => "");

    await walkSlListcards(COOKIE, "555", { maxPages: 200 });

    expect(tokenReads.count).toBe(0);
  });
});

describe("walkSlListcards failures", () => {
  test("an http error on page two carries where it landed and returns no partial cards", async () => {
    stubPages((start) =>
      start === 1 ? row("1", "A One") : new Response("nope", { status: 503 }),
    );

    const walked = await walkSlListcards(COOKIE, "555", { maxPages: 200 });

    expect(walked).toEqual({
      message: "SportLots HTTP error: 503",
      failure: {
        kind: "http_error",
        httpStatus: 503,
        timedOut: false,
        pageStart: 101,
        pagesOk: 1,
      },
    });
  });

  test("a login redirect page is signed_out, with the page it hit", async () => {
    stubPages((start) =>
      start === 1
        ? row("1", "A One")
        : start === 101
          ? row("2", "B Two")
          : '<form action="login.tpl">',
    );

    const walked = await walkSlListcards(COOKIE, "555", { maxPages: 200 });

    expect(walked).toMatchObject({
      failure: { kind: "signed_out", pageStart: 201, pagesOk: 2 },
    });
    expect("cards" in walked).toBe(false);
  });

  test("a timeout is classified timeout and flagged timedOut", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    stubPages(() => timeout);

    const walked = await walkSlListcards(COOKIE, "555", { maxPages: 200 });

    expect(walked).toMatchObject({
      failure: { kind: "timeout", timedOut: true, pageStart: 1, pagesOk: 0 },
    });
  });

  test("any other thrown fetch is a network failure", async () => {
    stubPages(() => new Error("socket hang up"));

    const walked = await walkSlListcards(COOKIE, "555", { maxPages: 200 });

    expect(walked).toMatchObject({
      failure: { kind: "network", timedOut: false, pageStart: 1, pagesOk: 0 },
    });
  });
});

describe("walkSlListcards row parse", () => {
  test("a variation row keeps its parent's number, is flagged, and loses the marker", async () => {
    stubPages((start) =>
      start === 1
        ? [
            row("11", "2021 Topps Heritage #11 Alec Bohm"),
            row("11", "2021 Topps Heritage #11 Alec Bohm [ VAR Action Image ]", true),
          ].join("\n")
        : "",
    );

    const walked = await walkSlListcards(COOKIE, "555", { maxPages: 200 });

    if (!("cards" in walked)) throw new Error("expected a successful walk");
    const [plain, variation] = walked.cards;
    expect(plain.isVariation).toBeUndefined();
    expect(plain.cardVariation).toBeUndefined();
    expect(variation).toMatchObject({
      cardNumber: "11",
      isVariation: true,
      cardVariation: "Action Image",
      players: ["Alec Bohm"],
    });
    expect(variation.cardName).not.toContain("VAR");
  });
});

describe("walkSlListcards parity with fetchSportLotsChecklist", () => {
  test("the sample listcards fixture parses to the same cards through both", async () => {
    const html = fs.readFileSync(
      path.join(__dirname, "adapters", "__fixtures__", "sl-listcards-sample.html"),
      "utf-8",
    );
    stubPages((start) => (start === 1 ? html : ""));

    const walked = await walkSlListcards(COOKIE, "189991", { maxPages: 200 });
    if (!("cards" in walked)) throw new Error("expected a successful walk");
    expect(walked.cards.length).toBeGreaterThan(5);
    expect(walked.cards.some((c) => c.isVariation)).toBe(true);

    const t = convexTest(schema, modules);
    const viaAction = await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.adapters.sportlots.fetchSportLotsChecklist, {
        parentFilters: {},
        platformFilters: { variantType: "189991" },
      });

    expect(viaAction.success).toBe(true);
    expect(viaAction.cards).toEqual(walked.cards);
    expect(viaAction.pages).toBe(walked.pagesOk);
    // The action reads the cookie itself; the walk never does.
    expect(tokenReads.count).toBe(1);
  });
});

describe("walkSlListcards: truncated says the page budget ran out mid-set", () => {
  test("running out of pages while the last page still has rows is truncated", async () => {
    stubPages((start) => distinctPage(start));

    const walked = await walkSlListcards(COOKIE, "555", { maxPages: 3 });

    expect(walked).toMatchObject({ pagesOk: 3, truncated: true });
  });

  test("an empty page inside the budget is the end of the set, not truncated", async () => {
    stubPages((start) => (start <= 201 ? distinctPage(start) : ""));

    const walked = await walkSlListcards(COOKIE, "555", { maxPages: 4 });

    expect(walked).toMatchObject({ pagesOk: 4 });
    expect("truncated" in walked).toBe(false);
  });

  test("a repeated page on the last allowed page is the end of the set, not truncated", async () => {
    stubPages(() => row("7", "Same Player"));

    const walked = await walkSlListcards(COOKIE, "555", { maxPages: 2 });

    expect("cards" in walked && walked.cards).toHaveLength(1);
    expect("truncated" in walked).toBe(false);
  });

  test("the empty page that ends the set is not truncated even when it is the last allowed page", async () => {
    stubPages((start) => (start === 1 ? distinctPage(start) : ""));

    const walked = await walkSlListcards(COOKIE, "555", { maxPages: 2 });

    expect(walked).toMatchObject({ pagesOk: 2 });
    expect("truncated" in walked).toBe(false);
  });

  test("a failure is a failure: it carries no truncated flag", async () => {
    stubPages((start) => (start === 1 ? distinctPage(start) : new Response("x", { status: 503 })));

    const walked = await walkSlListcards(COOKIE, "555", { maxPages: 2 });

    expect(walked).toMatchObject({ failure: { kind: "http_error" } });
    expect("truncated" in walked).toBe(false);
  });

  test("a one-page walk of a longer set is truncated (the first-page probe ignores it)", async () => {
    stubPages((start) => distinctPage(start));

    const walked = await walkSlListcards(COOKIE, "555", { maxPages: 1 });

    expect(walked).toMatchObject({ pagesOk: 1, truncated: true });
  });
});

describe("walkSlListcards: the caller's deadline", () => {
  /** Move `Date.now` forward without waiting. */
  const skew = { ms: 0 };
  beforeEach(() => {
    skew.ms = 0;
    const real = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => real() + skew.ms);
  });

  test("a deadline already past sends nothing and times out", async () => {
    const calls = stubPages((start) => distinctPage(start));

    const walked = await walkSlListcards(COOKIE, "555", { maxPages: 16, deadlineAt: Date.now() - 1 });

    expect(calls).toHaveLength(0);
    expect(walked).toMatchObject({
      failure: { kind: "timeout", timedOut: true, pageStart: 1, pagesOk: 0 },
    });
    expect("cards" in walked).toBe(false);
  });

  test("a deadline exactly now is already spent", async () => {
    const calls = stubPages((start) => distinctPage(start));

    const walked = await walkSlListcards(COOKIE, "555", { maxPages: 16, deadlineAt: Date.now() });

    expect(calls).toHaveLength(0);
    expect(walked).toMatchObject({ failure: { kind: "timeout" } });
  });

  test("the budget running out between pages stops the walk where it is, with no partial cards", async () => {
    const deadlineAt = Date.now() + 10_000;
    const calls = stubPages((start) => {
      if (start === 101) skew.ms += 20_000;
      return distinctPage(start);
    });

    const walked = await walkSlListcards(COOKIE, "555", { maxPages: 16, deadlineAt });

    expect(calls.map((c) => c.start)).toEqual([1, 101]);
    expect(walked).toMatchObject({
      failure: { kind: "timeout", timedOut: true, pageStart: 201, pagesOk: 2 },
    });
    expect("cards" in walked).toBe(false);
  });

  test("no deadline means the 30s page timer alone", async () => {
    const timers: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timers.push(ms);
      return real(ms);
    });
    stubPages(() => "");

    await walkSlListcards(COOKIE, "555", { maxPages: 1 });

    expect(timers).toEqual([30_000]);
  });

  test("a page's timer is cut to the time the deadline leaves", async () => {
    const timers: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timers.push(ms);
      return real(ms);
    });
    stubPages(() => "");

    await walkSlListcards(COOKIE, "555", { maxPages: 1, deadlineAt: Date.now() + 4_000 });

    expect(timers).toHaveLength(1);
    expect(timers[0]).toBeGreaterThan(3_000);
    expect(timers[0]).toBeLessThanOrEqual(4_000);
  });

  test("a request that hangs is aborted at about the time left, and says how long it waited", async () => {
    vi.mocked(Date.now).mockRestore();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );
    const startedAt = Date.now();

    const walked = await walkSlListcards(COOKIE, "555", { maxPages: 16, deadlineAt: startedAt + 120 });

    const waitedMs = Date.now() - startedAt;
    expect(walked).toMatchObject({ failure: { kind: "timeout", timedOut: true, pageStart: 1, pagesOk: 0 } });
    expect(waitedMs).toBeGreaterThanOrEqual(100);
    expect(waitedMs).toBeLessThan(2_000);
    const failure = "failure" in walked ? walked.failure : undefined;
    expect(failure?.timeoutMs).toBeLessThanOrEqual(120);
  });
});
