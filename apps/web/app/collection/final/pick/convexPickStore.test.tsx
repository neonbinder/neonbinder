/**
 * NEO-500 — the signed-in Pick List store (`./convexPickStore`): a mark is
 * shown at once, the promise resolves only when the server has it, a failed
 * save puts the tick back and rejects, and leaving the page asks first while
 * a mark is still on its way.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useContext, useEffect } from "react";

const mutate = vi.fn();
const query = vi.fn();
let openAnswer: unknown;

vi.mock("convex/react", () => ({
  useQuery: () => openAnswer,
  useConvex: () => ({ query }),
  useMutation: () => mutate,
}));

import { ConvexPickListProvider } from "./convexPickStore";
import { PickListStoreContext } from "./store";
import type { PickListStore } from "./types";

const SALE = "sale1";
const LINE = `${SALE}~abc`;
const CARD = "card1";

const RAW_CARD = {
  _id: CARD,
  cardNumber: "7",
  cardName: "Card 7",
  sortOrder: 7,
  variantId: "v1",
  features: [],
  listingTitle: "2024 Topps Chrome #7",
  players: [{ _id: "p1", name: "Paul Skenes" }],
  teams: [],
  set: {
    _id: "s1",
    name: "Topps Chrome",
    season: "2024",
    sport: { _id: "sp1", name: "Baseball" },
    year: { _id: "y1", name: "2024" },
    manufacturer: { _id: "m1", name: "Topps" },
  },
  variant: {
    _id: "v1",
    level: "variantType",
    name: "Base",
    kind: "base",
    variantType: { _id: "v1", name: "Base" },
    insert: null,
    parallel: null,
    cardCount: 1,
    baseCardCount: 1,
  },
};

openAnswer = {
  truncated: false,
  boxes: [{ id: "box1", name: "Box 2" }],
  lines: [
    {
      id: LINE,
      saleId: SALE,
      platform: "bsc",
      orderNo: "12-3456",
      orderDate: 1,
      firstSeenAt: 1,
      cardId: CARD,
      quantity: 1,
      condition: "near_mint",
      from: [{ copyId: "copy1", boxId: "box1", slot: 2, quantity: 1, condition: "Near Mint" }],
    },
  ],
};

query.mockImplementation((_fn: unknown, args: { cardIds?: string[]; copyIds?: string[] }) =>
  Promise.resolve(args.cardIds ? args.cardIds.map(() => ({ card: RAW_CARD, sportCode: "BB" })) : []),
);

let store: PickListStore | null = null;
function Probe() {
  const current = useContext(PickListStoreContext);
  useEffect(() => {
    store = current;
  });
  return null;
}

async function mount() {
  render(
    <ConvexPickListProvider>
      <Probe />
    </ConvexPickListProvider>,
  );
  // The card hydration lands.
  await act(async () => {});
  expect(store?.data?.lines.map((l) => l.id)).toEqual([LINE]);
}

function leaving(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

afterEach(() => {
  cleanup();
  mutate.mockReset();
  store = null;
});

describe("the signed-in Pick List store", () => {
  it("ticks at once, resolves only once the server has the mark, and guards a reload until then", async () => {
    await mount();
    let land!: () => void;
    mutate.mockReturnValue(new Promise<void>((resolve) => (land = resolve)));
    let saved = false;
    await act(async () => {
      void (store!.setPulled([LINE], true) as Promise<void>).then(() => (saved = true));
    });
    expect(store!.pulled.has(LINE)).toBe(true);
    expect(mutate).toHaveBeenCalledWith({ ids: [LINE], pulled: true });
    expect(saved).toBe(false);
    expect(leaving()).toBe(true);

    await act(async () => land());
    expect(saved).toBe(true);
    expect(leaving()).toBe(false);
    // Still on screen, checked: the page keeps what it pulled this session.
    expect(store!.data?.lines.map((l) => l.id)).toEqual([LINE]);
  });

  it("a failed save puts the tick back, rejects, and lifts the guard", async () => {
    await mount();
    mutate.mockRejectedValue(new Error("offline"));
    let failed = false;
    await act(async () => {
      await (store!.setPulled([LINE], true) as Promise<void>).catch(() => (failed = true));
    });
    expect(failed).toBe(true);
    expect(store!.pulled.has(LINE)).toBe(false);
    expect(leaving()).toBe(false);
  });
});
