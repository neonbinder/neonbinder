import { describe, expect, it } from "vitest";
import { seedsAsked } from "./page";

const ask = (query: string) => seedsAsked(new URLSearchParams(query));

describe("seedsAsked: what /testing/seed-dashboard seeds", () => {
  it("no ask at all is a sale", () => {
    expect(ask("")).toEqual({ clear: false, sale: true, syncPending: false, syncError: false });
    expect(ask("redirect=/dashboard")).toEqual({ clear: false, sale: true, syncPending: false, syncError: false });
  });

  it("asks combine, and a sync ask alone is no sale", () => {
    expect(ask("syncPending=1")).toEqual({ clear: false, sale: false, syncPending: true, syncError: false });
    expect(ask("sale=1&syncError=1&syncPending=1")).toEqual({ clear: false, sale: true, syncPending: true, syncError: true });
  });

  it("clear seeds nothing, whatever else is asked", () => {
    expect(ask("clear=1&sale=1&syncError=1")).toEqual({ clear: true, sale: false, syncPending: false, syncError: false });
  });

  it("only 1 means yes", () => {
    expect(ask("syncError=true")).toEqual({ clear: false, sale: true, syncPending: false, syncError: false });
  });
});
