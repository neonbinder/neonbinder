import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  BSC_LATENCY_BUCKET_COUNT,
  BSC_LATENCY_BUCKET_EDGES_MS,
  MAX_DETAIL_LINES,
  bscInflight,
  bucketIndex,
  createBscRecorder,
  emptyLatency,
  mergeSummaries,
  percentile,
  pickBscHeaders,
  resetBscInflightForTests,
  scrubBscBody,
  truncateUtf8,
  type BscSummaryLine,
} from "./bscCallTelemetry";
import { BSC_LATENCY_BUCKET_EDGES_MS as STATS_EDGES } from "../bscCallStats";
import { EDGES_MS as SCRIPT_EDGES } from "../../scripts/bsc-health/histogram.mjs";

describe("scrubBscBody", () => {
  test.each([
    ["a JWT", "bad token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcDEFghiJKL here", "eyJhbGci"],
    ["a bearer token", "Authorization failed for Bearer abc123.def-456_xyz", "abc123.def"],
    ["an email", "no seller for jane.doe+test@example.com", "jane.doe"],
    ["a uuid", "id 123e4567-e89b-12d3-a456-426614174000 missing", "123e4567"],
    ["an opaque run", "ref ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789 end", "ABCDEFGHIJKLMNOP"],
    ["a long digit run", "account 12345678901 closed", "12345678901"],
    ["a phone number", "call 555-123-4567 now", "555-123-4567"],
    ["a token pair", "token=hunter2supersecret&x=1", "hunter2supersecret"],
    ["a password in JSON-ish text", 'password: "p4ssw0rd!"', "p4ssw0rd"],
  ])("removes %s", (_name, input, secret) => {
    const out = scrubBscBody(input, "text/plain");
    expect(out).not.toContain(secret);
    expect(out.length).toBeGreaterThan(0);
  });

  test("keeps short ordinary numbers and words", () => {
    expect(scrubBscBody("Service unavailable, retry in 30 s (code 503)", "text/plain")).toBe(
      "Service unavailable, retry in 30 s (code 503)",
    );
  });

  test("JSON keeps key names and the five named values, drops the rest", () => {
    const out = scrubBscBody(
      JSON.stringify({
        message: "Rate exceeded",
        code: 42,
        sellerName: "Jane Collector",
        seller: { id: 9988776655, address: "1 Main St", title: "oops" },
        items: [{ sku: "SECRET-SKU" }],
      }),
      "application/json",
    );
    expect(out).toContain('message="Rate exceeded"');
    expect(out).toContain("code=");
    expect(out).toContain("sellerName");
    expect(out).not.toContain("Jane");
    expect(out).not.toContain("Main St");
    expect(out).not.toContain("SECRET-SKU");
    expect(out).not.toContain("9988776655");
  });

  test("a JSON message is still scrubbed", () => {
    const out = scrubBscBody('{"message":"user a@b.co failed"}', "application/json");
    expect(out).not.toContain("a@b.co");
  });

  test("truncated JSON falls back to patterns and still drops other values", () => {
    const out = scrubBscBody('{"error":"Upstream timeout","sellerName":"Jane Collector","rows":[{"a":"xxxxxxxx', "application/json");
    expect(out).toContain("Upstream timeout");
    expect(out).not.toContain("Jane");
  });

  test("HTML keeps the title, drops tags, scripts and styles", () => {
    const out = scrubBscBody(
      "<html><head><title>503 Service Unavailable</title><style>.x{}</style></head><body><script>var s='secret';</script><h1>Oops</h1><p>try later</p></body></html>",
      "text/html",
    );
    expect(out).toContain('title="503 Service Unavailable"');
    expect(out).toContain("Oops try later");
    expect(out).not.toContain("secret");
    expect(out).not.toContain("<");
  });

  test("truncates to 500 bytes after scrubbing, never splitting a character", () => {
    const out = scrubBscBody("é".repeat(1000), "text/plain");
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(500);
    expect(out).not.toContain("�");
    expect(truncateUtf8("abc", 2)).toBe("ab");
  });

  test("a secret straddling the cut is scrubbed before it, not after", () => {
    const secret = "A".repeat(40);
    const out = scrubBscBody("x".repeat(480).replace(/x/g, "y ") + secret, "text/plain");
    expect(out).not.toContain("AAAAAAAAAA");
  });

  test("empty and garbage input do not throw", () => {
    expect(scrubBscBody("")).toBe("");
    expect(scrubBscBody("\u0000\u0001\u0002")).toBe("");
    expect(scrubBscBody("{")).toBe("");
  });
});

describe("pickBscHeaders", () => {
  test("keeps the allowlist, drops everything else", () => {
    const h = new Headers({
      Server: "CloudFront",
      Via: "1.1 abc.cloudfront.net",
      "X-Cache": "Error from cloudfront",
      "Retry-After": "5",
      "cf-ray": "abc",
      "x-amz-cf-id": "ID123",
      "x-amz-cf-pop": "DFW56",
      "x-amzn-requestid": "r1",
      "x-request-id": "q1",
      "content-type": "application/json",
      "content-length": "12",
      "set-cookie": "session=abc",
      authorization: "Bearer zzz",
      "x-user-email": "a@b.co",
    });
    const out = pickBscHeaders(h);
    expect(Object.keys(out).sort()).toEqual(
      ["cf-ray", "content-length", "content-type", "retry-after", "server", "via", "x-amz-cf-id", "x-amz-cf-pop", "x-amzn-requestid", "x-cache", "x-request-id"].sort(),
    );
  });

  test("caps each value at 200 characters, and x-amzn-* at eight", () => {
    const rec: Record<string, string> = { server: "s".repeat(500) };
    for (let i = 0; i < 20; i++) rec[`x-amzn-h${i}`] = "v";
    const out = pickBscHeaders(rec);
    expect(out.server).toHaveLength(200);
    expect(Object.keys(out).filter((k) => k.startsWith("x-amzn-"))).toHaveLength(8);
  });

  test("tolerates nothing", () => {
    expect(pickBscHeaders(undefined)).toEqual({});
  });
});

describe("histogram", () => {
  test("edges are the same in the recorder, the stats table and the scripts", () => {
    expect([...BSC_LATENCY_BUCKET_EDGES_MS]).toEqual([...STATS_EDGES]);
    expect([...BSC_LATENCY_BUCKET_EDGES_MS]).toEqual([...SCRIPT_EDGES]);
    expect(BSC_LATENCY_BUCKET_COUNT).toBe(11);
  });

  test.each([
    [0, 0],
    [100, 0],
    [101, 1],
    [30000, 8],
    [30001, 9],
    [60000, 9],
    [60001, 10],
  ])("bucketIndex(%i) = %i", (ms, idx) => expect(bucketIndex(ms)).toBe(idx));

  const lat = (values: number[]) => {
    const l = emptyLatency();
    l.min = Math.min(...values);
    l.max = Math.max(...values);
    for (const v of values) {
      l.sum += v;
      l.buckets[bucketIndex(v)] += 1;
    }
    return l;
  };

  test("percentile of an empty histogram is null", () => {
    expect(percentile(emptyLatency(), 0.5)).toBeNull();
  });

  test("a single observation is exact (clamped to min/max)", () => {
    expect(percentile(lat([420]), 0.5)).toBe(420);
    expect(percentile(lat([420]), 0.95)).toBe(420);
  });

  test("p50 and p95 land in the right buckets", () => {
    const l = lat([...new Array(90).fill(80), ...new Array(10).fill(8000)]);
    expect(percentile(l, 0.5)).toBeLessThanOrEqual(100);
    const p95 = percentile(l, 0.95) as number;
    expect(p95).toBeGreaterThan(5000);
    expect(p95).toBeLessThanOrEqual(8000);
  });

  const summary = (over: Partial<BscSummaryLine> & { values: number[] }): BscSummaryLine => {
    const { values, ...rest } = over;
    return {
      op: "x",
      startedAt: 10,
      endedAt: 20,
      calls: values.length,
      ok: values.length,
      byKind: {},
      byStatus: { "200": values.length },
      maxInflight: 1,
      suppressed: 0,
      lat: lat(values),
      ...rest,
    };
  };

  test("merge adds counts and buckets, widens the window, takes extremes", () => {
    const a = summary({ values: [50, 300], maxInflight: 2, byKind: { http: 1 } });
    const b = summary({ values: [9000], startedAt: 5, endedAt: 40, maxInflight: 5, suppressed: 3, byKind: { http: 2, timeout: 1 } });
    const m = mergeSummaries(a, b);
    expect(m.calls).toBe(3);
    expect(m.startedAt).toBe(5);
    expect(m.endedAt).toBe(40);
    expect(m.maxInflight).toBe(5);
    expect(m.suppressed).toBe(3);
    expect(m.byKind).toEqual({ http: 3, timeout: 1 });
    expect(m.lat.min).toBe(50);
    expect(m.lat.max).toBe(9000);
    expect(m.lat.sum).toBe(9350);
    expect(m.lat.buckets.reduce((x, y) => x + y, 0)).toBe(3);
  });

  test("merging with an empty summary keeps the other's min", () => {
    const m = mergeSummaries(summary({ values: [] }), summary({ values: [700] }));
    expect(m.lat.min).toBe(700);
  });
});

// ---------------------------------------------------------------------------

type Lines = { log: string[]; warn: string[] };
function sink(): { sink: { log(l: string): void; warn(l: string): void }; lines: Lines } {
  const lines: Lines = { log: [], warn: [] };
  return { sink: { log: (l) => lines.log.push(l), warn: (l) => lines.warn.push(l) }, lines };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const META = { pathTemplate: "marketplace/card/:id/card-listing", bscCardId: 4242, timeoutMs: 5000, attempt: 1 };

describe("createBscRecorder", () => {
  beforeEach(resetBscInflightForTests);
  afterEach(resetBscInflightForTests);

  test("a success is counted, never logged as a failure, and summarised once", async () => {
    const { sink: log, lines } = sink();
    const c = clock();
    const rec = createBscRecorder("fetchBscCardTeamNames", { log, now: c.now, deployment: "dep" });
    const tok = rec.start(META);
    expect(bscInflight()).toBe(1);
    c.advance(240);
    rec.respond(tok, new Response("{}", { status: 200 }));
    expect(bscInflight()).toBe(0);
    const out = await rec.flush();
    expect(lines.warn).toHaveLength(0);
    expect(lines.log).toHaveLength(1);
    const line = JSON.parse(lines.log[0]);
    expect(line).toMatchObject({ msg: "bsc_call_summary", op: "fetchBscCardTeamNames", deployment: "dep", calls: 1, ok: 1, byStatus: { "200": 1 }, maxInflight: 1, suppressed: 0 });
    expect(line.lat).toMatchObject({ min: 240, max: 240, sum: 240 });
    expect(line.lat.buckets).toHaveLength(11);
    expect(line.lat.buckets[1]).toBe(1);
    expect(out?.row.samples).toEqual([]);
  });

  test("a non-2xx logs one scrubbed detail line, and the caller can still read the body", async () => {
    const { sink: log, lines } = sink();
    const c = clock();
    const rec = createBscRecorder("op", { log, now: c.now });
    const tok = rec.start(META);
    c.advance(30_000);
    const resp = new Response("<html><title>503 Service Unavailable</title> jane@example.com</html>", {
      status: 503,
      headers: { server: "CloudFront", "set-cookie": "s=1", "content-type": "text/html" },
    });
    rec.respond(tok, resp);
    // The caller's response is untouched and fully readable.
    expect(resp.bodyUsed).toBe(false);
    expect(await resp.text()).toContain("jane@example.com");
    const out = await rec.flush();
    expect(lines.warn).toHaveLength(1);
    const d = JSON.parse(lines.warn[0]);
    expect(d).toMatchObject({ msg: "bsc_call_failed", op: "op", kind: "http", status: 503, pathTemplate: META.pathTemplate, bscCardId: "4242", durationMs: 30000, timeoutMs: 5000, attempt: 1, inflight: 1 });
    expect(d.headers).toEqual({ server: "CloudFront", "content-type": "text/html" });
    expect(d.body).toContain("503 Service Unavailable");
    expect(d.body).not.toContain("jane@");
    expect(out?.summary).toMatchObject({ calls: 1, ok: 0, byKind: { http: 1 }, byStatus: { "503": 1 } });
    expect(out?.samples).toHaveLength(1);
  });

  test("the clone is cancelled after at most 4 KB, so a huge body is not buffered", async () => {
    const { sink: log, lines } = sink();
    let cancelled = false;
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
        if (pulled > 1000) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const rec = createBscRecorder("op", { log });
    const tok = rec.start(META);
    rec.respond(tok, new Response(body, { status: 500 }));
    await rec.flush();
    expect(lines.warn).toHaveLength(1);
    expect(pulled).toBeLessThan(20);
    expect(cancelled).toBe(false); // the caller's branch keeps the stream open, by design
    expect(JSON.parse(lines.warn[0]).body.length).toBeLessThanOrEqual(500);
  });

  test("a body that never arrives is abandoned at the deadline", async () => {
    const { sink: log, lines } = sink();
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    const rec = createBscRecorder("op", { log, bodyReadDeadlineMs: 20 });
    const tok = rec.start(META);
    rec.respond(tok, new Response(body, { status: 502 }));
    await rec.flush();
    const d = JSON.parse(lines.warn[0]);
    expect(d.kind).toBe("http");
    expect(d.body).toBeUndefined();
  });

  test("a used body cannot be cloned; the failure is still recorded", async () => {
    const { sink: log, lines } = sink();
    const rec = createBscRecorder("op", { log });
    const tok = rec.start(META);
    const resp = new Response("gone", { status: 500 });
    await resp.text();
    rec.respond(tok, resp);
    await rec.flush();
    expect(JSON.parse(lines.warn[0])).toMatchObject({ kind: "http", status: 500 });
  });

  test("timeouts and network errors are classified; errCode comes from the cause", async () => {
    const { sink: log, lines } = sink();
    const rec = createBscRecorder("op", { log });
    const t1 = rec.start(META);
    rec.fail(t1, { error: Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }) });
    const t2 = rec.start(META);
    rec.fail(t2, { error: Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }) });
    const t3 = rec.start(META);
    rec.fail(t3, { error: new Error("secret@x.io"), kind: "parse" });
    const out = await rec.flush();
    const [a, b, c] = lines.warn.map((l) => JSON.parse(l));
    expect(a).toMatchObject({ kind: "timeout" });
    expect(a.errCode).toBeUndefined();
    expect(b).toMatchObject({ kind: "network", errCode: "ECONNRESET" });
    expect(c.kind).toBe("parse");
    expect(JSON.stringify(lines.warn)).not.toContain("secret@x.io"); // messages are never logged
    expect(out?.summary.byKind).toEqual({ timeout: 1, network: 1, parse: 1 });
  });

  test("a call already counted ok converts to a failure without double counting", async () => {
    const { sink: log, lines } = sink();
    const c = clock();
    const rec = createBscRecorder("op", { log, now: c.now });
    const tok = rec.start(META);
    c.advance(120);
    rec.ok(tok, new Response("{}", { headers: { server: "x" } }));
    c.advance(5000);
    rec.fail(tok, { kind: "body_timeout", error: Object.assign(new Error("t"), { name: "TimeoutError" }) });
    rec.fail(tok, { kind: "network" }); // a second failure on the same call is ignored
    const out = await rec.flush();
    expect(out?.summary).toMatchObject({ calls: 1, ok: 0, byKind: { body_timeout: 1 }, byStatus: { "200": 1 } });
    expect(out?.summary.lat.max).toBe(120); // latency is to headers
    const d = JSON.parse(lines.warn[0]);
    expect(d).toMatchObject({ kind: "body_timeout", status: 200 });
    expect(d.headers).toMatchObject({ server: "x" });
  });

  test("detail lines are capped; the rest are only counted", async () => {
    const { sink: log, lines } = sink();
    const rec = createBscRecorder("op", { log });
    for (let i = 0; i < MAX_DETAIL_LINES + 7; i++) rec.fail(rec.start(META), { kind: "network" });
    const out = await rec.flush();
    expect(lines.warn).toHaveLength(MAX_DETAIL_LINES);
    expect(out?.summary).toMatchObject({ calls: MAX_DETAIL_LINES + 7, suppressed: 7 });
    expect(out?.samples).toHaveLength(5);
  });

  test("the in-flight counter tracks concurrent calls and does not leak an abandoned one", async () => {
    const { sink: log, lines } = sink();
    const rec = createBscRecorder("op", { log });
    const a = rec.start(META);
    rec.start(META); // never settled: abandoned
    rec.start(META);
    expect(bscInflight()).toBe(3);
    rec.ok(a, new Response("{}"));
    expect(bscInflight()).toBe(2);
    const out = await rec.flush();
    expect(bscInflight()).toBe(0);
    expect(out?.summary).toMatchObject({ calls: 1, maxInflight: 3 });
    expect(JSON.parse(lines.log[0]).maxInflight).toBe(3);
  });

  test("two recorders share the counter", () => {
    const r1 = createBscRecorder("a", { log: sink().sink });
    const r2 = createBscRecorder("b", { log: sink().sink });
    r1.start(META);
    r2.start(META);
    expect(bscInflight()).toBe(2);
  });

  test("no calls means no summary; a second flush is a no-op", async () => {
    const { sink: log, lines } = sink();
    const rec = createBscRecorder("op", { log });
    expect(await rec.flush()).toBeNull();
    expect(lines.log).toHaveLength(0);
    const rec2 = createBscRecorder("op", { log });
    rec2.ok(rec2.start(META), new Response("{}"));
    expect(await rec2.flush()).not.toBeNull();
    expect(await rec2.flush()).toBeNull();
    expect(lines.log).toHaveLength(1);
  });

  test("a broken sink never throws into the caller", async () => {
    const bad = { log() { throw new Error("x"); }, warn() { throw new Error("x"); } };
    const rec = createBscRecorder("op", { log: bad });
    const tok = rec.start(META);
    expect(() => rec.respond(tok, new Response("x", { status: 500 }))).not.toThrow();
    await expect(rec.flush()).resolves.toBeDefined();
  });

  test("the row fits the bscCallSummaries validator's shape", async () => {
    const rec = createBscRecorder("op", { log: sink().sink });
    rec.fail(rec.start(META), { kind: "network" });
    const out = await rec.flush();
    expect(Object.keys(out!.row).sort()).toEqual(
      ["byKind", "byStatus", "calls", "endedAt", "lat", "maxInflight", "ok", "op", "samples", "startedAt", "suppressed"].sort(),
    );
  });
});
