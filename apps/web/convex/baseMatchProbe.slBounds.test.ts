/**
 * NEO-325 (security round): the bounds on a SportLots probe call.
 *
 *   - `probeSlCount` reads at most `SL_PROBE_COUNT_MAX_PAGES` (16) pages per
 *     set. A set still returning rows on its last allowed page is answered
 *     `failed` / `timeout`, never as a count (a count of a truncated walk is a
 *     wrong number the client would compare).
 *   - `probeSlFirstPage` reads one page by design, so its walk being
 *     "truncated" is not a failure.
 *   - The whole call has `SL_PROBE_DEADLINE_MS`. An id the budget does not
 *     reach is answered `failed` / `timeout` without a request.
 *
 * The walk itself (`walkSlListcards`, its `truncated` flag and its deadline)
 * is covered in `sportlots.walk.test.ts`; this file goes through the public
 * actions. The clock is moved by skewing `Date.now` from inside the fetch
 * stub, so nothing waits for real time.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { SL_PROBE_COUNT_MAX_PAGES, SL_PROBE_DEADLINE_MS } from "./lib/baseMatchProbe";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_slbounds_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_slbounds_001",
  name: "Admin User",
  role: "admin",
};

const st = vi.hoisted(() => ({ reads: 0 }));

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
        st.reads++;
        return { token: "PHPSESSID=slbounds" };
      },
    }),
  };
});

const clock = { skew: 0 };

beforeEach(() => {
  st.reads = 0;
  clock.skew = 0;
  const real = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => real() + clock.skew);
  for (const m of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, m).mockImplementation(() => {});
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const row = (n: string, d: string) =>
  `<td class="smallleft">${n}</td>\n<td class="smallleft">${d}</td>`;
/** One row that is unique to its page, so the walk never sees a repeat. */
const pageRow = (start: number) => row(String(start), `Player ${start}`);

type Call = { id: string; start: number };

/** Stub SL: `answer(id, start, n)` per POST; `onCall` runs first (clock moves). */
function stubSl(
  answer: (id: string, start: number, n: number) => string | Response,
  onCall?: (n: number) => void,
) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = new URLSearchParams(String(init.body));
      const id = body.get("selset") ?? "";
      const start = Number(body.get("start"));
      calls.push({ id, start });
      onCall?.(calls.length);
      await new Promise((r) => setTimeout(r, 1));
      const out = answer(id, start, calls.length);
      return out instanceof Response ? out : new Response(out, { status: 200 });
    }),
  );
  return calls;
}

const asAdmin = (t: ReturnType<typeof convexTest>) => t.withIdentity(ADMIN);
const count = (ids: string[]) =>
  asAdmin(convexTest(schema, modules)).action(api.baseMatchProbe.probeSlCount, { setIds: ids });

describe("probeSlCount: the page cap", () => {
  test("the cap is 16 pages", () => {
    expect(SL_PROBE_COUNT_MAX_PAGES).toBe(16);
  });

  test("a set that never ends is a timeout after exactly 16 requests, never a count", async () => {
    const calls = stubSl((_id, start) => pageRow(start));

    const out = await count(["328996"]);

    expect(out).toEqual([{ id: "328996", status: "failed", kind: "timeout" }]);
    expect(calls).toHaveLength(16);
    expect(calls.map((c) => c.start)).toEqual(Array.from({ length: 16 }, (_, i) => 1 + 100 * i));
  });

  test("15 pages of rows then an empty page is a count of 15 over 16 requests", async () => {
    const calls = stubSl((_id, start) => (start <= 1401 ? pageRow(start) : ""));

    const out = await count(["328996"]);

    expect(out).toEqual([{ id: "328996", status: "ok", count: 15, pages: 16 }]);
    expect(calls).toHaveLength(16);
  });

  test("16 pages of rows with the empty 17th never asked for is a timeout", async () => {
    const calls = stubSl((_id, start) => (start <= 1501 ? pageRow(start) : ""));

    const out = await count(["328996"]);

    expect(out).toEqual([{ id: "328996", status: "failed", kind: "timeout" }]);
    expect(calls).toHaveLength(16);
    expect(Math.max(...calls.map((c) => c.start))).toBe(1501);
  });

  test("each id has its own 16 pages", async () => {
    const calls = stubSl((id, start) => (id === "11" ? pageRow(start) : start === 1 ? pageRow(start) : ""));

    const out = await count(["11", "22"]);

    expect(out).toEqual([
      { id: "11", status: "failed", kind: "timeout" },
      { id: "22", status: "ok", count: 1, pages: 2 },
    ]);
    expect(calls.filter((c) => c.id === "11")).toHaveLength(16);
    expect(calls.filter((c) => c.id === "22")).toHaveLength(2);
  });

  test("probeSlFirstPage reads one page of a set that never ends and still answers ok", async () => {
    const calls = stubSl((_id, start) => pageRow(start));
    const t = convexTest(schema, modules);

    const out = await asAdmin(t).action(api.baseMatchProbe.probeSlFirstPage, { setIds: ["328996"] });

    expect(calls).toHaveLength(1);
    expect(out).toMatchObject([{ id: "328996", status: "ok", pageHadRows: true }]);
  });
});

describe("the SportLots probe has a wall-clock budget", () => {
  /** Each request moves the clock 40s: the budget (90s) is gone after three. */
  const SPEND = 40_000;

  test("the ids the budget does not reach time out without a request", async () => {
    const calls = stubSl(
      () => row("1", "Some Player"),
      () => {
        clock.skew += SPEND;
      },
    );
    const t = convexTest(schema, modules);
    const ids = Array.from({ length: 32 }, (_, i) => `${1000 + i}`);

    const out = await asAdmin(t).action(api.baseMatchProbe.probeSlFirstPage, { setIds: ids });

    expect(calls).toHaveLength(3);
    expect(out.map((r) => r.status)).toEqual([
      ...Array(3).fill("ok"),
      ...Array(29).fill("failed"),
    ]);
    expect(out.slice(3).every((r) => "kind" in r && r.kind === "timeout")).toBe(true);
    expect(out.map((r) => r.id)).toEqual(ids);
    expect(st.reads).toBe(1);
  });

  test("a count walk the budget cuts short is a timeout, not a partial count", async () => {
    const calls = stubSl(
      (_id, start) => pageRow(start),
      () => {
        clock.skew += SPEND;
      },
    );
    const t = convexTest(schema, modules);

    const out = await asAdmin(t).action(api.baseMatchProbe.probeSlCount, { setIds: ["11", "22"] });

    expect(out.every((r) => r.status === "failed" && "kind" in r && r.kind === "timeout")).toBe(true);
    // 11 page 1 (40s spent), 22 page 1 (80s), 11 page 2 (120s): then nothing.
    expect(calls.map((c) => `${c.id}@${c.start}`)).toEqual(["11@1", "22@1", "11@101"]);
  });

  test("with the whole budget left every id is fetched", async () => {
    const calls = stubSl(() => row("1", "Some Player"));
    const t = convexTest(schema, modules);
    const ids = Array.from({ length: 12 }, (_, i) => `${1000 + i}`);

    const out = await asAdmin(t).action(api.baseMatchProbe.probeSlFirstPage, { setIds: ids });

    expect(out.every((r) => r.status === "ok")).toBe(true);
    expect(calls).toHaveLength(12);
  });

  test("the internal batch carries the same budget", async () => {
    const calls = stubSl(
      () => row("1", "Some Player"),
      () => {
        clock.skew += SL_PROBE_DEADLINE_MS + 1;
      },
    );
    const t = convexTest(schema, modules);

    const out = await asAdmin(t).action(internal.adapters.sportlots.probeSlListcardsBatch, {
      setIds: ["11", "22", "33", "44", "55", "66", "77", "88", "99"],
      mode: "firstPage",
    });

    // The first worker's request spends the budget; the next worker's check fails.
    expect(calls).toHaveLength(1);
    expect(out.filter((r) => r.status === "ok")).toHaveLength(1);
    expect(out.filter((r) => r.status === "failed")).toHaveLength(8);
  });
});
