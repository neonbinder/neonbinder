import { describe, expect, it } from "vitest";
import { initialCollectionState, MAIN_BINDER_ID } from "@/app/collection/final/store";
import { bindersOf, getDashboard } from "./fake-data";

// The demo dashboard opens each card's panel on the demo's collection store,
// so every card the dashboard names must sit where the store keeps it.
const store = initialCollectionState();
const containers = new Map(store.containers.map((c) => [c.id, c]));
const data = getDashboard();

function copiesOf(cardId: string) {
  return store.copies.filter((c) => c.cardId === cardId);
}

function inBoxes(cardId: string): number {
  return copiesOf(cardId)
    .filter((c) => containers.get(c.homeId)?.kind === "box")
    .reduce((n, c) => n + c.quantity, 0);
}

describe("the demo dashboard agrees with the demo store", () => {
  it("files every Fresh Pull in the binder it names", () => {
    const pulls = data.additions.flatMap((b) => b.cards);
    expect(pulls.length).toBeGreaterThan(0);
    for (const pull of pulls) {
      const homes = copiesOf(pull.id).map((c) => containers.get(c.homeId));
      expect(homes.some((h) => h?.kind === "binder" && h.name === pull.binderName), `${pull.title} in ${pull.binderName}`).toBe(true);
    }
    for (const b of data.additions) {
      expect(b.binders.reduce((n, x) => n + x.count, 0)).toBe(b.cards.length);
    }
  });

  it("lists every New Listing as the store's own box line: the box, the quantity, the price", () => {
    expect(data.newListings.length).toBeGreaterThan(0);
    for (const l of data.newListings) {
      const line = store.copies.find((c) => c.id === l.lineId);
      expect(line?.cardId).toBe(l.id);
      expect(line?.homeId).toBe(l.boxId);
      expect(containers.get(l.boxId)?.kind).toBe("box");
      expect(containers.get(l.boxId)?.name).toBe(l.boxName);
      expect(line?.quantity).toBe(l.quantity);
      expect(l.priceCents).toBe(line?.minPrice === undefined ? null : Math.round(line.minPrice * 100));
    }
  });

  it("sells only cards the boxes hold, and an oversold line counts what they really hold", () => {
    const lines = data.sales?.unshipped.flatMap((s) => s.lines) ?? [];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      if (!line.card) continue;
      expect(inBoxes(line.card.id), line.card.title).toBeGreaterThan(0);
      if (line.problem?.kind === "oversold") {
        expect(line.problem.inBoxes).toBe(inBoxes(line.card.id));
        expect(line.problem.sold).toBeGreaterThan(line.problem.inBoxes);
      }
    }
  });

  it("holds back only cards in a box", () => {
    const held = data.syncStatus?.problems.flatMap((p) => p.cards) ?? [];
    expect(held.length).toBeGreaterThan(0);
    for (const { card } of held) expect(inBoxes(card.id), card.title).toBeGreaterThan(0);
  });

  it("chases exactly the store's Want List, for the binder each want names", () => {
    expect(data.wantList.map((w) => w.id)).toEqual(store.wants.map((w) => w.cardId));
    data.wantList.forEach((w, i) => {
      const binderId = store.wants[i].binderId;
      expect(w.forBinder).toBe(binderId ? (containers.get(binderId)?.name ?? null) : null);
    });
  });

  it("cheers no finished checklist, since the store owns none whole", () => {
    expect(data.justCompleted).toBeNull();
  });

  it("stands the store's boxes in use on the shelf, each with what it holds", () => {
    const boxes = data.shelfBoxes ?? [];
    expect(boxes.length).toBeGreaterThan(0);
    expect(data.totals.boxes).toBe(boxes.length);
    for (const box of boxes) {
      expect(containers.get(box.id)?.kind).toBe("box");
      const held = store.copies.filter((c) => c.homeId === box.id).reduce((n, c) => n + c.quantity, 0);
      expect(box.cardCount).toBe(held);
      expect(box.cardCount).toBeGreaterThan(0);
    }
  });

  it("piles up for trade exactly the store's flagged copies", () => {
    const flagged = store.copies.filter((c) => c.upForTrade);
    expect(data.tradePile.count).toBe(flagged.reduce((n, c) => n + c.quantity, 0));
    expect(new Set(data.tradePile.cards.map((c) => c.id))).toEqual(new Set(flagged.map((c) => c.cardId)));
  });

  it("counts Main as the store files it, up-for-trade copies included", () => {
    const main = bindersOf(data).find((b) => b.id === "main");
    const held = store.copies.filter((c) => c.homeId === MAIN_BINDER_ID).reduce((n, c) => n + c.quantity, 0);
    expect(main?.cardCount).toBe(held);
  });

  it("guesses in the hopper only at cards the collector does not own yet", () => {
    for (const scan of data.intake.preview) {
      if (scan.guess) expect(copiesOf(scan.guess.id), scan.guess.title).toHaveLength(0);
    }
  });
});
