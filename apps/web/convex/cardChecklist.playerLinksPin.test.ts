/**
 * NEO-254 — `playerIds` and `playerLinks` are one list, written together.
 *
 *     playerIds === playerLinks.map(l => l.playerId)   — same ids, SAME ORDER
 *
 * `playerIds` is the fast index (`by_player`, the sync diff, listing titles);
 * `playerLinks` is the same list with the name the card printed attached. Two
 * copies of one list can disagree, and the failure is silent in the worst
 * direction: a card would keep linking to the right player while claiming it
 * was printed under somebody else's name.
 *
 * So every writer builds both in one breath, and this greps for one written
 * without the other. Same shape and reasoning as `teams.dedupPin.test.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const CONVEX_DIR = __dirname;
const SRC = readFileSync(join(CONVEX_DIR, "selectorOptions.ts"), "utf8");

/** Every line that writes `playerIds` into a `cardChecklist` row. */
function playerIdWriteLines(src: string): string[] {
  return src
    .split("\n")
    .map((line, i) => ({ line: line.trim(), i }))
    // A WRITE, not a read or a validator: `playerIds:` used as an object key
    // in an insert/patch/record literal.
    .filter(
      ({ line }) =>
        /^playerIds:/.test(line) &&
        !/v\.optional|v\.array/.test(line) &&
        !/^playerIds: 1,$/.test(line),
    )
    .map(({ line, i }) => `${i + 1}: ${line}`);
}

describe("NEO-254: no writer sets playerIds without playerLinks", () => {
  test("every cardChecklist playerIds write has a playerLinks write beside it", () => {
    const writes = playerIdWriteLines(SRC);
    // The three real writers: the commit chunk's built object, the chunk's
    // update `incoming`, and the chunk's insert branch. `addCustomCard` writes
    // both through one spread, so it does not appear here.
    expect(writes.length).toBeGreaterThan(0);

    const lines = SRC.split("\n");
    const offenders: string[] = [];
    for (const write of writes) {
      const lineNo = Number(write.split(":")[0]);
      /*
       * Within the same write region. Two of the three sites put them on
       * adjacent lines; the third is the re-sync's `incoming` record, whose
       * `playerLinks` rides along in the `contentPatch` block a few statements
       * later — deliberately, so it can never be accepted apart from the ids
       * (see the note there). 60 lines covers that without reaching the next
       * writer.
       */
      const window = lines.slice(lineNo - 1, lineNo + 60).join("\n");
      if (!window.includes("playerLinks")) offenders.push(write);
    }
    expect(offenders).toEqual([]);
  });

  test("the shared helper returns them as one derivation", () => {
    // `resolvePlayerIdsForWrite` builds `links` from the same `ids` array it
    // just validated, so the two cannot be assembled out of step.
    const helper = SRC.slice(
      SRC.indexOf("async function resolvePlayerIdsForWrite"),
      SRC.indexOf("export const addCustomCard"),
    );
    expect(helper).toContain("const links = ids.map(");
    expect(helper).toContain("return { ids, names, links };");
  });

  test("playerLinks is never an independently diffed content field", () => {
    /*
     * It is not an independent fact. In `NB_CONTENT_FIELDS` the NEO-203
     * re-sync diff would offer it to the operator on its own and let it be
     * accepted apart from the ids — the exact divergence the invariant
     * forbids.
     */
    const start = SRC.indexOf("const NB_CONTENT_FIELDS = [");
    const fields = SRC.slice(start, SRC.indexOf("] as const", start));
    expect(fields).toContain('"playerIds"');
    expect(fields).not.toContain('"playerLinks"');
  });
});
