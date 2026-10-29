/**
 * NEO-386 — the scanner CLI's contract with this backend, checked here because
 * apps/scanner's own CI lane only runs when apps/scanner changes. The CLI
 * calls these functions by path string and recognises a closed run by the
 * stream's error text, so a rename or a rewording here must fail here.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import {
  BACKEND_FUNCTIONS,
  JOINED_RUN_FIELDS,
  RUN_CLOSED_ERROR,
} from "../../scanner/src/backend-contract";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "user_scannerContract01" };

describe("the scanner CLI's backend contract", () => {
  test.each(Object.values(BACKEND_FUNCTIONS))("%s is still exported", async (path) => {
    const [file, name] = path.split(":");
    const load = modules[`./${file}.ts`];
    expect(load).toBeDefined();
    const mod = (await load()) as Record<string, unknown>;
    expect(mod[name]).toBeDefined();
  });

  test("a joined run carries the fields the CLI reads, and a closed run refuses uploads in words it recognises", async () => {
    const t = convexTest(schema, modules);
    const me = t.withIdentity(ME);
    const homeId = await t.run(async (ctx) =>
      ctx.db.insert("collectionContainers", { ownerId: ME.subject, kind: "box", name: "Dimes", lastUpdated: 0 }),
    );
    const session = await me.mutation(api.placeholderStream.startPlaceholderStream, { source: "scanner" });
    expect(session.started).toBe(true);
    const jobId = session.jobId!;
    const runId = await me.mutation(api.intakeRuns.createIntakeRun, { jobId, homeId });
    const code = await me.mutation(api.intakeScanner.scannerCodeForIntakeRun, { runId });

    const joined = await me.query(api.intakeScanner.joinIntakeRunByScannerCode, { code });
    expect(Object.keys(joined!).sort()).toEqual(
      [...JOINED_RUN_FIELDS].filter((f) => f !== "variantName").sort(),
    );
    expect(joined).toMatchObject({ runId, jobId, collecting: true });

    await me.mutation(api.placeholderStream.closePlaceholderStream, { jobId });
    let refusal: unknown;
    try {
      await me.mutation(api.placeholderStream.confirmPlaceholderImageUpload, { jobId, entryIndex: 0 });
    } catch (error) {
      refusal = error;
    }
    expect(String(refusal)).toMatch(RUN_CLOSED_ERROR);
    expect((await me.query(api.intakeScanner.joinIntakeRunByScannerCode, { code }))?.collecting).toBe(false);
  });
});
