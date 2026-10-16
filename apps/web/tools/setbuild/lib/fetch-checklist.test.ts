import { describe, expect, test } from "vitest";
import { fakeClient } from "../runner/fake-client";
import {
  CHOOSE_PLACEHOLDER,
  ChecklistStepError,
  UNLINK_HINT,
  fetchCandidates,
  pairCandidates,
  teamLookupsSettled,
  type ReadyCandidate,
  type ReadyCandidates,
} from "./fetch-checklist";

let seq = 0;
function cand(bucket: ReadyCandidate["bucket"], cardNumber: string, extra: Partial<ReadyCandidate> = {}): ReadyCandidate {
  seq++;
  const bsc = bucket !== "slOnly" ? { ref: `b${cardNumber}` } : undefined;
  const sportlots = bucket !== "bscOnly" ? { ref: `s${cardNumber}` } : undefined;
  return {
    _id: `c${seq}` as ReadyCandidate["_id"],
    cardNumber,
    cardName: `Player ${cardNumber}`,
    platformData: { ...(bsc ? { bsc } : {}), ...(sportlots ? { sportlots } : {}) },
    bucket,
    stem: cardNumber,
    teamResolved: true,
    ...extra,
  } as ReadyCandidate;
}

function batch(cards: ReadyCandidate[], batchId = "cb2"): ReadyCandidates {
  return { batchId, total: cards.length, ready: cards.length, cards };
}

const CTX = { servedSides: ["bsc", "sportlots"] as const, attachedSides: ["bsc", "sportlots"], at: "steps[1].base.checklist", row: null };

describe("pairCandidates", () => {
  test("keep both sides: matched pairs first, then every BSC-only and SportLots-only card", () => {
    const live = batch([cand("matched", "1"), cand("bscOnly", "301"), cand("slOnly", "302")]);
    const out = pairCandidates(live, { unmatchedBsc: "keep", unmatchedSportlots: "keep" }, { ...CTX, servedSides: [...CTX.servedSides] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.mode).toBe("dialog");
    expect(out.result.cards.map((c) => c.cardNumber)).toEqual(["1", "301", "302"]);
    expect(out.summary).toEqual({ matched: 1, keptBsc: 1, keptSportlots: 1, dropped: 0 });
  });

  test("drop discards the unmatched column, as Confirm does", () => {
    const live = batch([cand("matched", "1"), cand("bscOnly", "301"), cand("slOnly", "302")]);
    const out = pairCandidates(live, { unmatchedBsc: "keep", unmatchedSportlots: "drop" }, { ...CTX, servedSides: [...CTX.servedSides] });
    if (!out.ok) throw new Error("expected ok");
    expect(out.result.cards.map((c) => c.cardNumber)).toEqual(["1", "301"]);
    expect(out.summary.dropped).toBe(1);
  });

  test("an explicit pair links by marketplace ref, never by card number", () => {
    // #8 on SportLots is the same card as #7 on BSC (same name); #7 on SportLots is not.
    const live = batch([
      cand("bscOnly", "7", { cardName: "Julio Rodriguez" }),
      cand("slOnly", "7", { cardName: "Someone Else" }),
      cand("slOnly", "8", { cardName: "Julio Rodriguez" }),
    ]);
    const out = pairCandidates(
      live,
      { unmatchedBsc: "drop", unmatchedSportlots: "drop", pairs: [{ bsc: "b7", sportlots: "s8" }] },
      { ...CTX, servedSides: [...CTX.servedSides] },
    );
    if (!out.ok) throw new Error("expected ok");
    expect(out.result.cards).toHaveLength(1);
    expect(out.result.cards[0].platformData).toEqual({ bsc: { ref: "b7" }, sportlots: { ref: "s8" } });
  });

  test("a hand link whose two names disagree raises the dialog's conflict, which needs an answer", () => {
    const live = batch([cand("bscOnly", "7", { cardName: "Julio Rodriguez" }), cand("slOnly", "8", { cardName: "Someone Else" })]);
    const out = pairCandidates(
      live,
      { unmatchedBsc: "drop", unmatchedSportlots: "drop", pairs: [{ bsc: "b7", sportlots: "s8" }] },
      { ...CTX, servedSides: [...CTX.servedSides] },
    );
    expect(out.ok).toBe(false);
  });

  test("a pair naming a ref that is not unmatched is refused", () => {
    const live = batch([cand("bscOnly", "7")]);
    expect(() =>
      pairCandidates(live, { unmatchedBsc: "keep", unmatchedSportlots: "keep", pairs: [{ bsc: "b7", sportlots: "s99" }] }, { ...CTX, servedSides: [...CTX.servedSides] }),
    ).toThrow(ChecklistStepError);
  });

  test("an unanswered disagreement is an open decision with a fill-in, and nothing is paired", () => {
    const live = batch([cand("matched", "227", { playersConflict: { bsc: ["Mike Yastrzemski"], sportlots: ["Carl Yastrzemski"] } })]);
    const out = pairCandidates(live, { unmatchedBsc: "keep", unmatchedSportlots: "keep" }, { ...CTX, servedSides: [...CTX.servedSides] });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]).toMatchObject({ cardNumber: "227" });
    expect(out.template).toEqual([
      expect.objectContaining({ field: "players", bsc: "b227", sportlots: "s227", choose: expect.stringContaining(CHOOSE_PLACEHOLDER) }),
    ]);
  });

  test("an answered disagreement is settled through the dialog's reducer", () => {
    const live = batch([cand("matched", "227", { playersConflict: { bsc: ["Mike Yastrzemski"], sportlots: ["Carl Yastrzemski"] } })]);
    const out = pairCandidates(
      live,
      { unmatchedBsc: "keep", unmatchedSportlots: "keep", conflicts: [{ field: "players", bsc: "b227", choose: "sportlots" }] },
      { ...CTX, servedSides: [...CTX.servedSides] },
    );
    if (!out.ok) throw new Error("expected ok");
    expect(out.result.cards[0].players).toEqual(["Carl Yastrzemski"]);
    // Settled in this session: withheld from the diff's record (NEO-251).
    expect(out.result.conflictsByIndex).toEqual({});
  });

  test("an answer that names no disagreeing pair is open, not ignored", () => {
    const live = batch([cand("matched", "1")]);
    const out = pairCandidates(
      live,
      { unmatchedBsc: "keep", unmatchedSportlots: "keep", conflicts: [{ field: "name", bsc: "b9", choose: "bsc" }] },
      { ...CTX, servedSides: [...CTX.servedSides] },
    );
    expect(out.ok).toBe(false);
  });

  /** #482 on the real checklist twice: BSC lists Gwynn, SportLots Henderson, and the server matched them on the number. */
  const twoCards482 = () =>
    cand("matched", "482", {
      cardName: "Tony Gwynn",
      players: ["Tony Gwynn"],
      nameConflict: { bsc: "Tony Gwynn", sportlots: "Rickey Henderson" },
      playersConflict: { bsc: ["Tony Gwynn"], sportlots: ["Rickey Henderson"] },
    });

  test("an unanswered conflict's open decision and fill-in both offer the unlink", () => {
    const out = pairCandidates(batch([twoCards482()]), { unmatchedBsc: "keep", unmatchedSportlots: "keep" }, { ...CTX, servedSides: [...CTX.servedSides] });
    if (out.ok) throw new Error("expected open");
    expect(out.conflicts).toHaveLength(2);
    for (const c of out.conflicts) expect(c.detail).toContain(UNLINK_HINT);
    for (const f of out.template) {
      expect(f.choose).toContain(CHOOSE_PLACEHOLDER);
      expect(f.choose).toContain('add {"bsc":"b482","sportlots":"s482"} to pairing.unlink');
    }
  });

  test("unlink is the dialog's Unlink: two kept cards, each with its own name, roster and marketplace ref; nothing left open", () => {
    const live = batch([cand("matched", "1"), twoCards482()]);
    const out = pairCandidates(
      live,
      { unmatchedBsc: "keep", unmatchedSportlots: "keep", unlink: [{ bsc: "b482", sportlots: "s482" }] },
      { ...CTX, servedSides: [...CTX.servedSides] },
    );
    if (!out.ok) throw new Error(`expected ok, got ${JSON.stringify(out.conflicts)}`);
    expect(out.summary).toEqual({ matched: 1, keptBsc: 1, keptSportlots: 1, dropped: 0 });
    const by482 = out.result.cards.filter((c) => c.cardNumber === "482");
    expect(by482).toHaveLength(2);
    const bscCard = by482.find((c) => c.platformData.bsc)!;
    const slCard = by482.find((c) => c.platformData.sportlots)!;
    expect(bscCard).toMatchObject({ cardName: "Tony Gwynn", players: ["Tony Gwynn"], platformData: { bsc: { ref: "b482" } } });
    expect(bscCard.platformData.sportlots).toBeUndefined();
    expect(slCard).toMatchObject({ cardName: "Rickey Henderson", players: ["Rickey Henderson"], platformData: { sportlots: { ref: "s482" } } });
    expect(slCard.platformData.bsc).toBeUndefined();
    // Two kept singles carry no disagreement to the diff.
    expect(out.result.conflictsByIndex).toEqual({});
  });

  test("an unlinked half follows its side's Keep all: drop discards it", () => {
    const out = pairCandidates(
      batch([twoCards482()]),
      { unmatchedBsc: "keep", unmatchedSportlots: "drop", unlink: [{ bsc: "b482", sportlots: "s482" }] },
      { ...CTX, servedSides: [...CTX.servedSides] },
    );
    if (!out.ok) throw new Error("expected ok");
    expect(out.result.cards.map((c) => c.platformData)).toEqual([{ bsc: { ref: "b482" } }]);
    expect(out.summary.dropped).toBe(1);
  });

  test("an unlinked half can be paired again by ref", () => {
    const live = batch([twoCards482(), cand("slOnly", "483", { cardName: "Tony Gwynn" })]);
    const out = pairCandidates(
      live,
      {
        unmatchedBsc: "drop",
        unmatchedSportlots: "keep",
        unlink: [{ bsc: "b482", sportlots: "s482" }],
        pairs: [{ bsc: "b482", sportlots: "s483" }],
      },
      { ...CTX, servedSides: [...CTX.servedSides] },
    );
    if (!out.ok) throw new Error("expected ok");
    expect(out.result.cards.map((c) => c.platformData)).toEqual([
      { bsc: { ref: "b482" }, sportlots: { ref: "s483" } },
      { sportlots: { ref: "s482" } },
    ]);
  });

  test("an unlink naming a card the fetch does not hold is refused, never ignored", () => {
    const live = batch([twoCards482(), cand("bscOnly", "7")]);
    const cases: Array<[{ bsc: string; sportlots: string }, RegExp]> = [
      [{ bsc: "b482", sportlots: "s999" }, /the SportLots card is not in this fetch\.$/],
      [{ bsc: "b999", sportlots: "s482" }, /the BSC card is not in this fetch\.$/],
      [{ bsc: "b998", sportlots: "s999" }, /neither card is in this fetch\.$/],
    ];
    for (const [pair, message] of cases) {
      let caught: unknown;
      try {
        pairCandidates(live, { unmatchedBsc: "keep", unmatchedSportlots: "keep", unlink: [pair] }, { ...CTX, servedSides: [...CTX.servedSides] });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ChecklistStepError);
      expect((caught as Error).message).toMatch(/^steps\[1\]\.base\.checklist: pairing\.unlink\[0\]: BSC card "b\d+" and SportLots card "s\d+" cannot be unlinked: /);
      expect((caught as Error).message).toMatch(message);
    }
  });

  test("an unlink whose two cards are both fetched but not paired to each other is already apart: met, not refused", () => {
    // b7 is BSC-only; s482 is paired with b482. Neither is paired with the other.
    const live = batch([cand("matched", "1"), twoCards482(), cand("bscOnly", "7")]);
    const out = pairCandidates(
      live,
      { unmatchedBsc: "keep", unmatchedSportlots: "keep", unlink: [{ bsc: "b7", sportlots: "s482" }], conflicts: [
        { field: "name", bsc: "b482", choose: "bsc" },
        { field: "players", bsc: "b482", choose: "bsc" },
      ] },
      { ...CTX, servedSides: [...CTX.servedSides] },
    );
    if (!out.ok) throw new Error(`expected ok, got ${JSON.stringify(out.conflicts)}`);
    expect(out.alreadyApart).toEqual([0]);
    // Nothing was unlinked: #482 is still one matched card, b7 still kept on its own.
    expect(out.summary).toEqual({ matched: 2, keptBsc: 1, keptSportlots: 0, dropped: 0 });
  });

  test("a real unlink beside an already-apart one: only the real one unlinks", () => {
    const live = batch([twoCards482(), cand("bscOnly", "7")]);
    const out = pairCandidates(
      live,
      {
        unmatchedBsc: "keep",
        unmatchedSportlots: "keep",
        unlink: [{ bsc: "b482", sportlots: "s482" }, { bsc: "b7", sportlots: "s482" }],
      },
      { ...CTX, servedSides: [...CTX.servedSides] },
    );
    if (!out.ok) throw new Error("expected ok");
    expect(out.alreadyApart).toEqual([1]);
    expect(out.summary).toEqual({ matched: 0, keptBsc: 2, keptSportlots: 1, dropped: 0 });
  });

  test("one marketplace attached and every row a single: the UI keeps everything with no dialog", () => {
    const live = batch([cand("bscOnly", "1"), cand("bscOnly", "2")]);
    const out = pairCandidates(live, { unmatchedBsc: "drop", unmatchedSportlots: "drop" }, { ...CTX, servedSides: ["bsc"] });
    if (!out.ok) throw new Error("expected ok");
    expect(out.mode).toBe("solo");
    expect(out.result.cards).toHaveLength(2);
  });
});

describe("teamLookupsSettled", () => {
  test("a card waits only when the server looks its team up (BSC ref, no teams)", () => {
    expect(teamLookupsSettled([cand("matched", "1", { teamResolved: false, teams: ["Mariners"] })])).toBe(true);
    expect(teamLookupsSettled([cand("slOnly", "1", { teamResolved: false })])).toBe(true);
    expect(teamLookupsSettled([cand("bscOnly", "1", { teamResolved: false })])).toBe(false);
  });
});

describe("fetchCandidates", () => {
  test("waits for the batch id to MOVE and the count to arrive; a previous batch never satisfies it", async () => {
    const stale = batch([cand("matched", "1"), cand("matched", "2")], "old");
    const fresh = batch([cand("matched", "1"), cand("matched", "2")], "new");
    const client = fakeClient()
      .on("checklistCandidates:getReadyCandidates", (_a, n) => (n < 3 ? stale : fresh))
      .on("selectorOptions:fetchCardChecklist", {
        success: true,
        message: "2 matched",
        candidateCount: 2,
        attachedSides: ["bsc", "sportlots"],
        pausedSides: ["sportlots"],
      });
    const out = await fetchCandidates(client, "row1" as never);
    expect(out.live?.batchId).toBe("new");
    expect(out.servedSides).toEqual(["bsc"]);
  });

  test("a failed fetch discards its candidates and stops the step", async () => {
    const client = fakeClient()
      .on("checklistCandidates:getReadyCandidates", batch([]))
      .on("selectorOptions:fetchCardChecklist", { success: false, message: "BSC timed out", candidateCount: 0, attachedSides: [] })
      .on("checklistCandidates:discardCandidates", { deleted: 0, hasMore: false });
    await expect(fetchCandidates(client, "row1" as never)).rejects.toThrow(/BSC timed out/);
    expect(client.callsTo("checklistCandidates:discardCandidates")).toHaveLength(1);
  });
});
