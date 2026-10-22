/**
 * NEO-339 live: nb_fix's row {type:"Insert", name:"Future Stars Autographs
 * Red"} answered "No row named …" while the row sat grouped under "Future
 * Stars Autographs". Every name-addressed row lookup in the tool shares one
 * resolution (`resolveTypeRow` in spec/resolve.ts): top-level first, then a
 * grouped row by its own name, ties named with their parents. Here: the
 * fixture's "Gold", grouped under "Future Stars", reached by its own name
 * through nb_attention's row, nb_fix's card and autograph answers, detach,
 * and the names answers.
 */
import { describe, expect, test } from "vitest";
import { ResolveError } from "../service";
import { row } from "./fake-nb-client";
import { FUTURE, GOLD, INSERTS, SET, attentionClient, card } from "./attention.fixture";
import { listCardAttention, resolveAttentionRow } from "./attention";
import { applyAutographAnswers, applyCardAnswers } from "./attention-answers";
import { applyDetachAnswers, resolveDetachAnswers } from "./detach-answers";
import { resolveNameAnswers } from "./name-suggestions";

const BY_OWN_NAME = { type: "Inserts", name: "Gold" };
const BY_PARENT = { type: "Inserts", name: "Future Stars", parallel: "Gold" };
const goldCard = () => card("c-gold", "FS-1", "Future One Gold", { playerIds: ["p"], teamOnCardIds: ["t"], listingTitleTruncated: true, listingTitle: "Cut" });

describe("a grouped row resolves by its own name everywhere", () => {
  test("resolveAttentionRow: by its own name, the same node as by its parent, addressed and linked through the parent", async () => {
    const client = attentionClient({ store: { rows: {} } });
    const own = await resolveAttentionRow(client, SET, BY_OWN_NAME, "cards[0]");
    expect(own).toEqual(await resolveAttentionRow(client, SET, BY_PARENT, "cards[0]"));
    expect(own).toMatchObject({ rowId: GOLD, ref: BY_PARENT, label: "Inserts › Future Stars › Gold" });
    expect(own.drillIds.slice(-3)).toEqual([INSERTS, FUTURE, GOLD]);
    // A parallel holds no parallels.
    await expect(resolveAttentionRow(client, SET, { ...BY_OWN_NAME, parallel: "Gold" }, "cards[0]")).rejects.toThrow(
      '"Gold" is a parallel of "Future Stars", so nothing sits under it',
    );
    // A name nothing carries lists the grouped rows too, each with its parent.
    const miss = await resolveAttentionRow(client, SET, { type: "Inserts", name: "Golden" }, "cards[0]").then(
      () => null,
      (e: unknown) => e as ResolveError,
    );
    expect(miss).toBeInstanceOf(ResolveError);
    expect(miss!.candidates).toEqual([{ id: GOLD, name: "Gold", detail: "parallel of Future Stars" }]);
  });

  test("nb_attention lists the grouped row's card by its parent; nb_fix answers it by the row's own name", async () => {
    const client = attentionClient({ store: { rows: { [GOLD]: [goldCard()] } } });
    const listed = (await listCardAttention(client, SET)).cards.find((c) => c.cardNumber === "FS-1")!;
    expect(listed.row).toEqual(BY_PARENT);
    const [r] = await applyCardAnswers(client, SET, [{ row: BY_OWN_NAME, cardNumber: "FS-1", answer: { title: "2014 Topps Chrome Future Stars Gold Future One #FS-1" } }]);
    expect(r.outcome).toBe("applied");
    expect(client.callsTo("selectorOptions:updateCard").map((c) => c.args.id)).toEqual(["c-gold"]);
  });

  test("nb_fix autographs: the grouped row by its own name", async () => {
    const au = card("g1", "FS-1", "Auto", { teamOnCardIds: ["t"], listingTitle: "T", attributes: ["AU"] });
    const client = attentionClient({ store: { rows: { [GOLD]: [au] } } });
    const [r] = await applyAutographAnswers(client, SET, [{ row: BY_OWN_NAME, format: "On Card" }], { waitMs: 5_000, pollMs: 1_000, sleep: async () => {} });
    expect(r).toMatchObject({ rowId: GOLD, outcome: "applied" });
    expect(client.callsTo("autographFormat:setAutographFormat").map((c) => c.args)).toEqual([{ selectorOptionId: GOLD, value: "On Card" }]);
  });

  test("nb_fix detach: the grouped row by its own name", async () => {
    const client = attentionClient({
      store: { rows: {} },
      handlers: {
        "selectorOptions:getSelectorOptionById": (a) => (a.id === GOLD ? row(GOLD, "parallel", "Gold", { platformData: { sportlots: { s0: "269998" } } }) : null),
        "selectorOptions:getSlotCardCounts": () => ({ bsc: {}, sportlots: { s0: 0 }, total: 0 }),
        "selectorOptions:detachPlatformId": () => ({ success: true, message: "ok", orphanedCards: 0 }),
      },
    });
    const [r] = await applyDetachAnswers(client, await resolveDetachAnswers(client, SET, [{ row: BY_OWN_NAME, side: "sportlots", id: "269998" }]));
    expect(r).toMatchObject({ rowId: GOLD, rowLabel: "Inserts › Future Stars › Gold", outcome: "applied" });
    expect(client.callsTo("selectorOptions:detachPlatformId")[0].args).toMatchObject({ selectorOptionId: GOLD, side: "sportlots", slot: "s0" });
  });

  test("nb_fix names: the grouped row by its own name is the parallel's column", async () => {
    const client = attentionClient({ store: { rows: {} } });
    const [r] = await resolveNameAnswers(client, { sport: "Baseball", year: "2014", manufacturer: "Topps", set: "Topps Chrome" }, SET, [
      { row: BY_OWN_NAME, side: "bsc", action: "decline", label: "Gold Refractor" },
    ]);
    expect(r).toMatchObject({ level: "parallel", parentId: FUTURE, rowId: GOLD });
  });
});
