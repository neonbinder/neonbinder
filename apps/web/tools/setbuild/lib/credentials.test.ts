import { describe, expect, test } from "vitest";
import { CredentialsError, ensureCredentials, SeedingNotEnabled } from "./credentials";
import { fakeNbClient } from "./fake-nb-client";
import { NOTHING_PAUSED, parseDeclaredPaused } from "./sync-column";

const SEED = "testing:seedMyTestCredentials";
const TEST = "credentials:testSiteCredentials";

describe("ensureCredentials", () => {
  test("seeds the named sites, then warms each one the seed stored", async () => {
    const client = fakeNbClient({
      [SEED]: (a) => ({ seeded: (a.sites as string[]).map((site) => ({ site, stored: true })) }),
      [TEST]: () => ({ success: true, message: "Connected." }),
    });
    const out = await ensureCredentials(client, { seed: ["buysportscards", "sportlots"], warm: true }, NOTHING_PAUSED);
    expect(client.callsTo(SEED)[0].args).toEqual({ sites: ["buysportscards", "sportlots"] });
    expect(client.callsTo(TEST).map((c) => c.args.site)).toEqual(["buysportscards", "sportlots"]);
    expect(out.pausedSkipped).toEqual([]);
  });

  test("a declared-paused site is neither seeded nor warmed", async () => {
    const client = fakeNbClient({
      [SEED]: (a) => ({ seeded: (a.sites as string[]).map((site) => ({ site, stored: true })) }),
      [TEST]: () => ({ success: true, message: "Connected." }),
    });
    const out = await ensureCredentials(
      client,
      { seed: ["buysportscards", "sportlots"], warm: true },
      parseDeclaredPaused("sportlots"),
    );
    expect(client.callsTo(SEED)[0].args).toEqual({ sites: ["buysportscards"] });
    expect(client.callsTo(TEST).map((c) => c.args.site)).toEqual(["buysportscards"]);
    expect(out.pausedSkipped).toEqual(["sportlots"]);
  });

  test("a failed store stops with the server's reason, before any warm", async () => {
    const client = fakeNbClient({
      [SEED]: () => ({ seeded: [{ site: "sportlots", stored: false, reason: "SportLots refused the sign-in." }] }),
      [TEST]: () => ({ success: true, message: "" }),
    });
    await expect(ensureCredentials(client, { seed: ["sportlots"], warm: true }, NOTHING_PAUSED)).rejects.toThrow(
      /SportLots refused the sign-in/,
    );
    expect(client.callsTo(TEST)).toHaveLength(0);
  });

  test("a server skip the run did not declare paused is a failure, not a pass", async () => {
    const client = fakeNbClient({
      [SEED]: () => ({ seeded: [{ site: "sportlots", stored: false, skipped: true }] }),
    });
    await expect(ensureCredentials(client, { seed: ["sportlots"], warm: false }, NOTHING_PAUSED)).rejects.toBeInstanceOf(
      CredentialsError,
    );
  });

  test("a deployment that refuses seeding (production) says so", async () => {
    const client = fakeNbClient({
      [SEED]: () => {
        throw new Error("Uncaught Error: Test credential seeding is not enabled on this deployment");
      },
    });
    await expect(ensureCredentials(client, { seed: ["buysportscards"], warm: false }, NOTHING_PAUSED)).rejects.toBeInstanceOf(
      SeedingNotEnabled,
    );
  });

  test("a warm that fails stops the run", async () => {
    const client = fakeNbClient({
      [SEED]: () => ({ seeded: [{ site: "buysportscards", stored: true }] }),
      [TEST]: () => ({ success: false, message: "Couldn't sign in to BuySportsCards." }),
    });
    await expect(ensureCredentials(client, { seed: ["buysportscards"], warm: true }, NOTHING_PAUSED)).rejects.toThrow(
      /Couldn't sign in/,
    );
  });
});
