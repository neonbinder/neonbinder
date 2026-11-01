import { getFunctionName } from "convex/server";
import { describe, expect, test } from "vitest";
import crons from "./crons";
import { internal } from "./_generated/api";

// NEO-370: the sales poll is what turns a BuySportsCards order into a removed
// box copy. A rename or a dropped registration would stop it silently.
describe("crons", () => {
  test("polls BuySportsCards sales every 15 minutes through listingSales.pollAll", () => {
    const job = crons.crons["poll BuySportsCards sales"];
    expect(job).toBeDefined();
    expect(job.schedule).toEqual({ type: "interval", minutes: 15 });
    expect(getFunctionName(job.name)).toBe(
      getFunctionName(internal.listingSales.pollAll),
    );
    expect(job.args).toEqual([{}]);
  });
});
