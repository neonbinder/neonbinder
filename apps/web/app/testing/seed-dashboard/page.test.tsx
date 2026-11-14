import { describe, expect, it } from "vitest";
import { listingProblemReasonValidator } from "@/convex/schema";
import { SYNC_HELD_REASONS, seedRedirect, seedsAsked, syncReadout } from "./page";

const ask = (query: string) => seedsAsked(new URLSearchParams(query));

describe("seedsAsked: what /testing/seed-dashboard seeds", () => {
  it("no ask at all is a sale", () => {
    expect(ask("")).toEqual({ clear: false, sale: true, syncPending: false, syncError: false, syncRecovered: false });
    expect(ask("redirect=/dashboard")).toEqual({ clear: false, sale: true, syncPending: false, syncError: false, syncRecovered: false });
  });

  it("asks combine, and a sync ask alone is no sale", () => {
    expect(ask("syncPending=1")).toEqual({ clear: false, sale: false, syncPending: true, syncError: false, syncRecovered: false });
    expect(ask("sale=1&syncError=1&syncPending=1")).toEqual({ clear: false, sale: true, syncPending: true, syncError: true, syncRecovered: false });
  });

  it("clear seeds nothing, whatever else is asked", () => {
    expect(ask("clear=1&sale=1&syncError=1")).toEqual({ clear: true, sale: false, syncPending: false, syncError: false, syncRecovered: false });
  });

  it("a recovered set is its own ask, no sale, and a failed ask wins over it", () => {
    expect(ask("syncRecovered=1")).toEqual({ clear: false, sale: false, syncPending: false, syncError: false, syncRecovered: true });
    expect(ask("syncError=1&syncRecovered=1")).toEqual({ clear: false, sale: false, syncPending: false, syncError: true, syncRecovered: false });
    expect(ask("clear=1&syncRecovered=1")).toEqual({ clear: true, sale: false, syncPending: false, syncError: false, syncRecovered: false });
  });

  it("only 1 means yes", () => {
    expect(ask("syncError=true")).toEqual({ clear: false, sale: true, syncPending: false, syncError: false, syncRecovered: false });
  });
});

describe("syncReadout: what the sync seed says it did, per marketplace", () => {
  it("names each marketplace, what it got, and why a seed was skipped", () => {
    expect(
      syncReadout([
        { platform: "bsc", pending: true, error: true },
        { platform: "ebay", pending: false, error: true, note: "no queued card: NB lists this account here" },
      ]),
    ).toEqual([
      "sync on bsc: waiting card + failed set",
      "sync on ebay: failed set (no queued card: NB lists this account here)",
    ]);
  });

  it("names a recovered set", () => {
    expect(syncReadout([{ platform: "ebay", pending: false, error: false, recovered: true }])).toEqual(["sync on ebay: recovered set"]);
  });

  it("says nothing was written when a marketplace got nothing", () => {
    expect(syncReadout([{ platform: "ebay", pending: false, error: false, note: "x" }])).toEqual(["sync on ebay: nothing (x)"]);
  });
});

describe("seedRedirect: where the page forwards once done", () => {
  const to = (query: string) => seedRedirect(new URLSearchParams(query));

  it("a path on this site is honoured, query and all", () => {
    expect(to("redirect=/inventory")).toBe("/inventory");
    expect(to(`redirect=${encodeURIComponent("/inventory?tab=boxes")}`)).toBe("/inventory?tab=boxes");
  });

  it("no redirect, or an empty one, is the dashboard", () => {
    expect(to("")).toBe("/dashboard");
    expect(to("redirect=")).toBe("/dashboard");
  });

  it("anything that could leave the site is the dashboard", () => {
    for (const raw of ["//evil.example", "/\\evil.example", "https://evil.example/", "evil.example", "javascript:alert(1)"]) {
      expect(to(`redirect=${encodeURIComponent(raw)}`)).toBe("/dashboard");
    }
  });
});

describe("NEO-536: syncHeld asks for a held set", () => {
  it("a known reason is a held-set ask, no sale; an unknown one is no ask", () => {
    expect(ask("syncHeld=noLink")).toEqual({
      clear: false,
      sale: false,
      syncPending: false,
      syncError: false,
      syncRecovered: false,
      syncHeld: "noLink",
    });
    expect(ask("syncHeld=bogus")).toEqual({ clear: false, sale: true, syncPending: false, syncError: false, syncRecovered: false });
  });

  it("a failed or recovered ask wins over it, and clear drops it", () => {
    expect(ask("syncError=1&syncHeld=noLink").syncHeld).toBeUndefined();
    expect(ask("syncRecovered=1&syncHeld=noLink").syncHeld).toBeUndefined();
    expect(ask("clear=1&syncHeld=noLink").syncHeld).toBeUndefined();
  });

  it("knows every reason a sync records", () => {
    expect([...SYNC_HELD_REASONS].sort()).toEqual(listingProblemReasonValidator.members.map((m) => m.value).sort());
  });

  it("the readout names a held set", () => {
    expect(syncReadout([{ platform: "bsc", pending: false, error: false, held: true }])).toEqual(["sync on bsc: held set"]);
  });
});
