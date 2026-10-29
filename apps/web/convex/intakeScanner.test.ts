/**
 * NEO-386 — the scanner code: minted once per run, joined only by the run's
 * owner, and honest about a run that has stopped taking cards.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import {
  normalizeScannerCode,
  SCANNER_CODE_ALPHABET,
  SCANNER_CODE_LENGTH,
} from "./intakeScanner";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "user_scannerMe00001" };
const THEM = { subject: "user_scannerThem002" };
const JOB = "job-scanner-1";

async function world(status: "collecting" | "pairing" = "collecting") {
  const t = convexTest(schema, modules);
  const runId = await t.run(async (ctx) => {
    await ctx.db.insert("placeholderJobs", {
      jobId: JOB,
      userId: ME.subject,
      objectPath: `placeholders/${ME.subject}/${JOB}/`,
      createdAt: 0,
      mode: "stream",
      status,
    });
    const homeId = await ctx.db.insert("collectionContainers", {
      ownerId: ME.subject,
      kind: "box",
      name: "Dime box",
      lastUpdated: 0,
    });
    return await ctx.db.insert("intakeRuns", {
      userId: ME.subject,
      jobId: JOB,
      homeId,
      createdAt: 0,
      lastActivityAt: 0,
    });
  });
  return { t, runId };
}

describe("normalizeScannerCode", () => {
  test("folds case and drops spaces and dashes", () => {
    expect(normalizeScannerCode(" ab3-x7k ")).toBe("AB3X7K");
  });
});

describe("scannerCodeForIntakeRun", () => {
  test("mints a readable code once and returns the same one after", async () => {
    const { t, runId } = await world();
    const me = t.withIdentity(ME);
    const code = await me.mutation(api.intakeScanner.scannerCodeForIntakeRun, { runId });
    expect(code).toHaveLength(SCANNER_CODE_LENGTH);
    for (const ch of code) expect(SCANNER_CODE_ALPHABET).toContain(ch);
    expect(await me.mutation(api.intakeScanner.scannerCodeForIntakeRun, { runId })).toBe(code);
  });

  test("refuses another collector's run", async () => {
    const { t, runId } = await world();
    await expect(
      t.withIdentity(THEM).mutation(api.intakeScanner.scannerCodeForIntakeRun, { runId }),
    ).rejects.toThrow(/Intake run not found/);
  });
});

describe("joinIntakeRunByScannerCode", () => {
  test("the owner joins with the code, typed loosely", async () => {
    const { t, runId } = await world();
    const me = t.withIdentity(ME);
    const code = await me.mutation(api.intakeScanner.scannerCodeForIntakeRun, { runId });
    const typed = `${code.slice(0, 3).toLowerCase()}-${code.slice(3)}`;
    expect(await me.query(api.intakeScanner.joinIntakeRunByScannerCode, { code: typed })).toEqual({
      runId,
      jobId: JOB,
      homeName: "Dime box",
      homeKind: "box",
      variantName: undefined,
      collecting: true,
    });
  });

  test("another collector with the same code finds nothing", async () => {
    const { t, runId } = await world();
    const code = await t.withIdentity(ME).mutation(api.intakeScanner.scannerCodeForIntakeRun, { runId });
    expect(
      await t.withIdentity(THEM).query(api.intakeScanner.joinIntakeRunByScannerCode, { code }),
    ).toBeNull();
  });

  test("a run that stopped taking cards says so", async () => {
    const { t, runId } = await world("pairing");
    const me = t.withIdentity(ME);
    const code = await me.mutation(api.intakeScanner.scannerCodeForIntakeRun, { runId });
    const joined = await me.query(api.intakeScanner.joinIntakeRunByScannerCode, { code });
    expect(joined?.collecting).toBe(false);
  });

  test("a wrong-length code is no match", async () => {
    const { t } = await world();
    expect(
      await t.withIdentity(ME).query(api.intakeScanner.joinIntakeRunByScannerCode, { code: "AB" }),
    ).toBeNull();
  });
});
