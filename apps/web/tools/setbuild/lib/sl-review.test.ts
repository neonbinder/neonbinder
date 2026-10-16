import { describe, expect, test } from "vitest";
import { MAX_REVIEW_DECISIONS } from "../../../lib/set-build/sl-review";
import { fakeNbClient } from "./fake-nb-client";
import { applySlReview } from "./sl-review";
import type { SlDecision } from "../spec/schema";

const REVIEW = "slSetReview:getSlSetReview";
const APPLY = "slSetReview:applySlSetReview";
const ENSURE = "selectorOptions:ensureSelectorOptions";
const TYPES = "slSetReview:getVariantTypesOfSet";

type Entry = { slId: string; label: string; defaultName: string; suggestedOfSetId?: string };

const entry = (slId: string, label: string): Entry => ({ slId, label, defaultName: `Bowman ${label}` });

function world(entries: Entry[], opts: { types?: Array<{ _id: string; value: string; role?: string }> } = {}) {
  let live = [...entries];
  const applied: Array<Array<Record<string, unknown>>> = [];
  const client = fakeNbClient({
    [REVIEW]: () =>
      live.length === 0
        ? null
        : {
            yearId: "y1",
            manufacturerId: "m1",
            brandValue: "Bowman",
            entries: live,
            ofSets: [
              { _id: "set-bowman", value: "Bowman" },
              { _id: "set-chrome", value: "Bowman Chrome" },
            ],
            ofSetsTruncated: false,
            moreNextSync: 0,
            partial: false,
            classifiedAt: 1,
          },
    [ENSURE]: () => ({ ran: true, reason: "synced", skippedSides: [], pausedSides: [] }),
    [TYPES]: () =>
      opts.types ?? [
        { _id: "vt-ins", value: "Insert", role: "insert" },
        { _id: "vt-par", value: "Parallel", role: "parallel" },
      ],
    [APPLY]: (a) => {
      const decisions = a.decisions as Array<Record<string, unknown>>;
      applied.push(decisions);
      const sent = new Set(decisions.map((d) => d.slId));
      live = live.filter((e) => !sent.has(e.slId));
      return {
        sets: decisions.filter((d) => !d.variantTypeId).length,
        underType: { insert: 0, parallel: decisions.filter((d) => d.variantTypeId).length, none: 0 },
        skipped: 0,
        skippedByReason: { notInReview: 0, alreadyLinked: 0, nameTaken: 0, existsElsewhere: 0, invalid: 0 },
        knownBrandsAdded: 0,
        refused: [],
        remaining: live.length,
        incomplete: false,
      };
    },
  });
  return { client, applied };
}

const opts = { at: "steps[0].slReview", path: "Baseball/2026/Bowman" };

describe("applySlReview", () => {
  test("no review waiting (saved already, or SportLots paused) is a skip", async () => {
    const { client } = world([]);
    expect(await applySlReview(client, "m1" as never, [], opts)).toEqual({ outcome: "skipped", reason: "no-review" });
    expect(client.callsTo(APPLY)).toHaveLength(0);
  });

  test("files each line as the spec says: own set, or under the named set's type after syncing its types", async () => {
    const { client, applied } = world([entry("101", "Sterling"), entry("102", "Blue"), entry("103", "AA Game Autos")]);
    const decisions: SlDecision[] = [
      { slId: "101", placement: "own-set" },
      { slId: "102", set: "Bowman", variantType: "Parallel" },
      { slId: "103", set: "bowman", variantType: "insert", name: "All-America Game Autos" },
    ];
    const res = await applySlReview(client, "m1" as never, decisions, opts);
    expect(res).toMatchObject({ outcome: "applied", applied: 3, remaining: 0, calls: 1, syncedSets: ["set-bowman"] });
    // The dialog's forced Sync Variant Types, once for the one set picked.
    expect(client.callsTo(ENSURE).map((c) => c.args)).toEqual([{ level: "variantType", parentId: "set-bowman", force: true }]);
    expect(applied[0]).toEqual([
      { slId: "101" },
      { slId: "102", variantTypeId: "vt-par" },
      { slId: "103", variantTypeId: "vt-ins", name: "All-America Game Autos" },
    ]);
  });

  test("a line the spec does not answer is open, and nothing is filed by default", async () => {
    const { client } = world([entry("101", "Sterling"), entry("102", "Blue")]);
    const res = await applySlReview(client, "m1" as never, [{ slId: "101", placement: "own-set" }], opts);
    expect(res.outcome).toBe("open");
    if (res.outcome !== "open") return;
    expect(res.slReview.rows).toEqual([{ slId: "102", name: "Blue" }]);
    expect(client.callsTo(APPLY)).toHaveLength(0);
    expect(client.callsTo(ENSURE)).toHaveLength(0);
  });

  test("an unknown SportLots id is open", async () => {
    const { client } = world([entry("101", "Sterling")]);
    const res = await applySlReview(
      client,
      "m1" as never,
      [
        { slId: "101", placement: "own-set" },
        { slId: "999", placement: "own-set" },
      ],
      opts,
    );
    expect(res.outcome).toBe("open");
    if (res.outcome !== "open") return;
    expect(res.names).toEqual([{ at: "steps[0].slReview.decisions[1].slId", kind: "sl-review-id", name: "999", candidates: [] }]);
    expect(client.callsTo(APPLY)).toHaveLength(0);
  });

  test("a set or variant type that is not exactly one row is open; nothing is saved", async () => {
    const { client } = world([entry("102", "Blue")]);
    const noSet = await applySlReview(client, "m1" as never, [{ slId: "102", set: "Topps", variantType: "Parallel" }], opts);
    expect(noSet.outcome).toBe("open");

    const twoTypes = world([entry("102", "Blue")], {
      types: [
        { _id: "a", value: "Parallel" },
        { _id: "b", value: "parallel" },
      ],
    });
    const res = await applySlReview(twoTypes.client, "m1" as never, [{ slId: "102", set: "Bowman", variantType: "PARALLEL" }], opts);
    expect(res.outcome).toBe("open");
    if (res.outcome !== "open") return;
    expect(res.names[0]).toMatchObject({ kind: "variant type", candidates: [{ id: "a" }, { id: "b" }] });
    expect(twoTypes.client.callsTo(APPLY)).toHaveLength(0);
  });

  test(`more than ${MAX_REVIEW_DECISIONS} lines are saved in capped calls until the review is empty`, async () => {
    const entries = Array.from({ length: MAX_REVIEW_DECISIONS + 50 }, (_, i) => entry(String(1000 + i), `Set ${i}`));
    const { client, applied } = world(entries);
    const res = await applySlReview(
      client,
      "m1" as never,
      entries.map((e) => ({ slId: e.slId, placement: "own-set" as const })),
      opts,
    );
    expect(res).toMatchObject({ outcome: "applied", calls: 2, remaining: 0 });
    expect(applied.map((d) => d.length)).toEqual([MAX_REVIEW_DECISIONS, 50]);
  });
});
