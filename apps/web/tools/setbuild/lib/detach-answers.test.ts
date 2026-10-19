/**
 * NEO-339 — `nb_fix`'s `detach`: the Sources panel's × as an answer. The row
 * resolves like every fix answer, the id resolves to its slot by id, the card
 * count read at fix time rides as `acknowledgedCards`, the primary is
 * confirmed as the panel's confirm does, and nothing else is written.
 */
import { describe, expect, test } from "vitest";
import { contentDigest } from "../client/target";
import { fixConfirmPhrase } from "../service";
import { FAKE_TARGET, convexCodeError, fakeNbClient, row } from "./fake-nb-client";
import { BASE, FUTURE, INSERTS, SET } from "./attention.fixture";
import { CardAnswerError } from "./attention-answers";
import { DetachFixAborted, MAX_FIX_DETACH, applyDetachAnswers, resolveDetachAnswers, type DetachFixAnswer } from "./detach-answers";
import { parseFixAnswers } from "./fix-answers";

const DETACH = "selectorOptions:detachPlatformId";
const COUNTS = "selectorOptions:getSlotCardCounts";

/** Topps Chrome: Base, and Inserts › Future Stars carrying two SportLots sets (its own, then the flagship's 269998). */
function world(o: { counts?: number; detach?: (a: Record<string, unknown>) => unknown } = {}) {
  const future = row(FUTURE, "insert", "Future Stars", {
    platformData: { bsc: { s0: "future-stars" }, sportlots: { s0: "9001", s1: "269998" } },
    primaryPlatformId: { sportlots: "s0" },
  });
  return fakeNbClient({
    "selectorOptions:getSelectorOptions": (a) => {
      if (a.level === "variantType" && a.parentId === SET.setId) return [row(BASE, "variantType", "Base"), row(INSERTS, "variantType", "Inserts")];
      if (a.level === "insert" && a.parentId === INSERTS) return [future];
      return [];
    },
    "selectorOptions:getSelectorOptionById": (a) => (a.id === FUTURE ? future : null),
    [COUNTS]: () => ({ bsc: { s0: 4 }, sportlots: { s0: 4, s1: o.counts ?? 3 }, total: 7 }),
    [DETACH]: o.detach ?? ((a) => ({ success: true, message: "ok", orphanedCards: a.slot === "s1" ? (o.counts ?? 3) : 4 })),
  });
}

const futureStars = { type: "Inserts", name: "Future Stars" };

async function detach(client: ReturnType<typeof world>, answers: DetachFixAnswer[]) {
  return applyDetachAnswers(client, await resolveDetachAnswers(client, SET, answers));
}

describe("detach answers", () => {
  test("the id resolves to its slot by id, and the panel's call goes with the count read now", async () => {
    const client = world();
    const [r] = await detach(client, [{ row: futureStars, side: "sportlots", id: "269998" }]);
    expect(client.callsTo(DETACH).map((c) => c.args)).toEqual([
      { selectorOptionId: FUTURE, side: "sportlots", slot: "s1", acknowledgedCards: 3 },
    ]);
    expect(r).toEqual({
      at: "detach[0]",
      row: futureStars,
      rowLabel: "Inserts › Future Stars",
      rowId: FUTURE,
      side: "sportlots",
      id: "269998",
      outcome: "applied",
      orphanedCards: 3,
      detail:
        "Detached SportLots 269998 from Inserts › Future Stars. 3 cards were fetched from it and stay on the row; " +
        "delete any that do not belong in the Set Builder.",
    });
  });

  test("the reconciler's primary is detached with confirmPrimary, as the panel's confirm sends it, and says a sync could re-add it", async () => {
    const client = world();
    const [r] = await detach(client, [{ row: futureStars, side: "sportlots", id: "9001" }]);
    expect(client.callsTo(DETACH)[0].args).toMatchObject({ slot: "s0", confirmPrimary: true, acknowledgedCards: 4 });
    expect(r).toMatchObject({ outcome: "applied", primary: true });
    expect(r.detail.endsWith("A later sync of this row could re-add it.")).toBe(true);
  });

  test("an id the row does not carry is moot: nothing is read or written for it", async () => {
    const client = world();
    const [r] = await detach(client, [{ row: futureStars, side: "bsc", id: "269998" }]);
    expect(r).toMatchObject({ outcome: "moot", detail: "Inserts › Future Stars does not carry BSC 269998; nothing to detach." });
    expect(client.callsTo(DETACH)).toEqual([]);
    expect(client.callsTo(COUNTS)).toEqual([]);
  });

  test("a count that changed between the read and the write is refused by the server; the answer says so", async () => {
    const client = world({
      detach: () => {
        const err = convexCodeError("DETACH_COUNT_CHANGED") as Error & { data: Record<string, unknown> };
        err.data.cards = 5;
        throw err;
      },
    });
    const [r] = await detach(client, [{ row: futureStars, side: "sportlots", id: "269998" }]);
    expect(r).toMatchObject({
      outcome: "refused",
      detail: "Not detached: 5 card(s) now come from SportLots 269998, not the 3 read a moment ago. Check the row and answer again.",
    });
  });

  test("the same link twice is refused while resolving, before any write", async () => {
    const client = world();
    const answer = { row: futureStars, side: "sportlots" as const, id: "269998" };
    await expect(resolveDetachAnswers(client, SET, [answer, answer])).rejects.toBeInstanceOf(CardAnswerError);
    expect(client.callsTo(DETACH)).toEqual([]);
  });

  test("a failure that is not a refusal keeps the links already detached", async () => {
    let n = 0;
    const client = world({
      detach: () => {
        if (n++ === 0) return { success: true, message: "ok", orphanedCards: 3 };
        throw new Error("network");
      },
    });
    const err = await detach(client, [
      { row: futureStars, side: "sportlots", id: "269998" },
      { row: futureStars, side: "sportlots", id: "9001" },
    ]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DetachFixAborted);
    expect((err as DetachFixAborted).results.map((r) => [r.id, r.outcome])).toEqual([["269998", "applied"]]);
  });

  test("the schema caps a call, and the confirm phrase binds detach only when given", () => {
    const one = { detach: [{ row: futureStars, side: "sportlots" as const, id: "269998" }] };
    expect(parseFixAnswers(one)).toEqual(one);
    expect(() => parseFixAnswers({ detach: Array.from({ length: MAX_FIX_DETACH + 1 }, () => one.detach[0]) })).toThrow(
      `At most ${MAX_FIX_DETACH} detach answers per call; split the batch and confirm each part.`,
    );
    expect(() => parseFixAnswers({ detach: [{ side: "ebay", id: "x" }] })).toThrow(/detach\.0\.side/);
    const path = { sport: "Baseball", year: "2014", manufacturer: "Topps", set: "Topps Chrome" };
    const phrase = fixConfirmPhrase(FAKE_TARGET, path, one);
    expect(phrase).not.toBe(fixConfirmPhrase(FAKE_TARGET, path, { detach: [{ ...one.detach[0], id: "9001" }] }));
    // Every earlier phrase holds: no detach, or an empty list, is the phrase it always was.
    expect(fixConfirmPhrase(FAKE_TARGET, path, { detach: [] })).toBe(fixConfirmPhrase(FAKE_TARGET, path, {}));
    expect(phrase.endsWith(contentDigest({ write: "fix", path: "Baseball/2014/Topps/Topps Chrome", cards: [], names: [], detach: one.detach }))).toBe(true);
  });
});
