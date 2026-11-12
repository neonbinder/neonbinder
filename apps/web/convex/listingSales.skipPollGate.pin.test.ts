/**
 * NEO-500 — `skipPollGate` lets a caller run the order poll's two steps
 * (`recordOrderCore`, `applySaleLinesCore`) without the poll gate (whether the
 * owner's listing state polls sales). Only the poll itself (`listingSales.ts`,
 * where the option is defined) and the Pick List test seed (`testing.ts`,
 * double-gated, the caller's own rows) may name it. A new caller anywhere
 * else would apply sales the gate exists to hold back, so it fails here.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const CONVEX_DIR = __dirname;
const ALLOWED = ["listingSales.ts", "testing.ts"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "_generated" || entry.name === "node_modules" || entry.name === "__fixtures__") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("NEO-500: skipPollGate has exactly two callers", () => {
  test("only listingSales.ts and testing.ts name skipPollGate", () => {
    const naming = sourceFiles(CONVEX_DIR)
      .filter((file) => readFileSync(file, "utf8").includes("skipPollGate"))
      .map((file) => relative(CONVEX_DIR, file))
      .sort();
    expect(naming).toEqual(ALLOWED);
  });

  test("control: the scan reaches both allowed files and reads their sources", () => {
    for (const name of ALLOWED) {
      expect(readFileSync(join(CONVEX_DIR, name), "utf8")).toContain("skipPollGate");
    }
    expect(sourceFiles(CONVEX_DIR).length).toBeGreaterThan(50);
  });
});
