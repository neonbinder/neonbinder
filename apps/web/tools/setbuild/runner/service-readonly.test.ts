/**
 * NEO-339 security audit item 2 — the service's read methods are read-only by
 * construction, not because today's read code happens not to write.
 *
 * The read helpers are replaced here with versions that TRY to write; the
 * service must hand them a client on which that throws before anything is
 * sent. (runner.test.ts drives the real helpers through the MCP read tools.)
 */

import { describe, expect, test, vi } from "vitest";

vi.mock("./inspect", () => ({
  inspectPath: async (client: { mutation: (fn: unknown, args: unknown) => Promise<unknown> }) => {
    const { api } = await import("../../../convex/_generated/api");
    await client.mutation(api.entityReviewQueue.recordDecision, { reviewRowId: "x", action: "skip" });
    return { found: true };
  },
}));

vi.mock("../spec/resolve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../spec/resolve")>()),
  resolveBrandYear: async (client: { action: (fn: unknown, args: unknown) => Promise<unknown> }) => {
    const { api } = await import("../../../convex/_generated/api");
    await client.action(api.selectorOptions.fetchCardChecklist, { selectorOptionId: "x" });
    return { manufacturerId: "mf" };
  },
}));

import { FAKE_TARGET, fakeClient } from "./fake-client";
import { ReadOnlyViolation } from "./read-only-client";
import { createSetBuildService } from "./service";

describe("createSetBuildService: read methods cannot write", () => {
  test("inspect runs on a query-only client", async () => {
    const inner = fakeClient().on("entityReviewQueue:recordDecision", null);
    const svc = createSetBuildService(inner, FAKE_TARGET, { pausedPlatforms: "" });
    await expect(svc.read.inspect({ sport: "Baseball", year: "2024", manufacturer: "Topps" })).rejects.toBeInstanceOf(
      ReadOnlyViolation,
    );
    expect(inner.writes()).toEqual([]);
  });

  test("reviewItems runs on a query-only client", async () => {
    const inner = fakeClient().on("selectorOptions:fetchCardChecklist", { success: true });
    const svc = createSetBuildService(inner, FAKE_TARGET, { pausedPlatforms: "" });
    await expect(
      svc.read.reviewItems({ sport: "Baseball", year: "2024", manufacturer: "Topps" }),
    ).rejects.toBeInstanceOf(ReadOnlyViolation);
    expect(inner.writes()).toEqual([]);
  });
});
