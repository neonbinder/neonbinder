import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { createBscRecorder } from "./bscCallTelemetry";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("../**/*.*s");

describe("recorder output is accepted by bscCallStats.record", () => {
  test("a failure row round-trips through the table", async () => {
    const rec = createBscRecorder("fetchBscCardTeamNames", { log: { log() {}, warn() {} }, deployment: "dep" });
    rec.respond(
      rec.start({ pathTemplate: "marketplace/card/:id/card-listing", bscCardId: 7, timeoutMs: 5000, attempt: 1 }),
      new Response("nope", { status: 503, headers: { server: "CloudFront" } }),
    );
    rec.fail(rec.start({ pathTemplate: "x" }), { error: Object.assign(new TypeError("f"), { cause: { code: "ECONNRESET" } }) });
    const out = await rec.flush();
    const t = convexTest(schema, modules);
    await t.mutation(internal.bscCallStats.record, out!.row);
    const rows = await t.run((ctx) => ctx.db.query("bscCallSummaries").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].samples).toHaveLength(2);
    expect(rows[0].lat.buckets).toHaveLength(11);
  });
});
