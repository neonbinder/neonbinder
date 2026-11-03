/**
 * NEO-415 — the client and the server must read "a plain line" the same way.
 * `isPlainLine` in targetBox.ts decides what the quick-count field shows and
 * `isPlainLine` in convex/collectionInventory.ts decides what a quick count
 * may change. They drifted once (photos, NEO-377); this table feeds one
 * line, in each side's own shape, through both and asserts they agree.
 */

import { describe, expect, it } from "vitest";
import { isPlainLine as serverIsPlainLine } from "../../../../convex/collectionInventory";
import { isPlainLine as clientIsPlainLine } from "./targetBox";
import { DEFAULT_CONDITION, type Condition, type Copy } from "../data/types";

type Server = Parameters<typeof serverIsPlainLine>[0];

/** One flag, in both shapes: the client Copy fields and the server row fields. */
interface Flag {
  name: string;
  client: Partial<Copy>;
  server: Partial<Server>;
  plain: boolean;
  /** The collector's default condition, when the case changes it. */
  defaultCondition?: Condition;
}

const FLAGS: Flag[] = [
  { name: "an all-plain row", client: {}, server: {}, plain: true },
  { name: "the default condition set explicitly", client: { condition: DEFAULT_CONDITION }, server: { condition: DEFAULT_CONDITION }, plain: true },
  { name: "no condition at all (stored before NEO-380)", client: { condition: undefined }, server: { condition: undefined }, plain: true },
  { name: "a photo", client: { hasPhotos: true }, server: { hasPhotos: true }, plain: false },
  { name: "hasPhotos explicitly false", client: { hasPhotos: false }, server: { hasPhotos: false }, plain: true },
  { name: "a non-default condition", client: { condition: "Mint" }, server: { condition: "Mint" }, plain: false },
  {
    name: "a condition that is the collector's own default",
    client: { condition: "Mint" },
    server: { condition: "Mint" },
    defaultCondition: "Mint",
    plain: true,
  },
  {
    name: "grading",
    client: { graded: { grader: "PSA", grade: "9" } },
    server: { grading: { grader: "PSA", grade: "9" } as Server["grading"] },
    plain: false,
  },
  { name: "a serial number", client: { serialNumber: "23/50" }, server: { serialNumber: "23/50" }, plain: false },
  { name: "a cost", client: { costBasis: 1.5 }, server: { costCents: 150 }, plain: false },
  { name: "a zero cost", client: { costBasis: 0 }, server: { costCents: 0 }, plain: false },
  { name: "an own floor price", client: { minPrice: 2 }, server: { minPriceCents: 200 }, plain: false },
  { name: "a location", client: { location: "Top shelf" }, server: { location: "Top shelf" }, plain: false },
  { name: "notes", client: { notes: "creased" }, server: { notes: "creased" }, plain: false },
  { name: "up for trade", client: { upForTrade: true }, server: { upForTrade: true }, plain: false },
  { name: "up for trade explicitly false", client: { upForTrade: false }, server: { upForTrade: false }, plain: true },
  // Slot and acquired date are documented as not mattering.
  { name: "a slot and an acquired date only", client: { slot: 3, acquiredAt: "2026-01-02" }, server: { slot: 3, acquiredOn: "2026-01-02" } as Partial<Server>, plain: true },
];

/** A plain client line; notes is "" when blank, as the store writes it. */
function clientCopy(over: Partial<Copy>): Copy {
  return {
    id: "copy_1",
    cardId: "card_1",
    quantity: 1,
    acquiredAt: "2026-01-01",
    notes: "",
    homeId: "box_1",
    homeKind: "box",
    upForTrade: false,
    ...over,
  } as unknown as Copy;
}

describe("plain-line rule: client and server agree (NEO-415)", () => {
  it.each(FLAGS)("$name", ({ client, server, plain, defaultCondition }) => {
    const dc = defaultCondition ?? DEFAULT_CONDITION;
    const c = clientIsPlainLine(clientCopy(client), dc);
    const s = serverIsPlainLine(server as Server, dc);
    expect({ client: c, server: s }).toEqual({ client: plain, server: plain });
  });

  it("covers every field the server rule reads", () => {
    const covered = new Set(FLAGS.flatMap((f) => Object.keys(f.server)));
    for (const field of ["condition", "grading", "serialNumber", "costCents", "minPriceCents", "location", "notes", "upForTrade", "hasPhotos"]) {
      expect(covered.has(field)).toBe(true);
    }
  });
});
