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

import { ConvexPickListProvider, listedTitle, listedYear, toListedCard } from "./convexPickStore";
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

  it("a failed put-back puts the tick back on and rejects", async () => {
    await mount();
    mutate.mockResolvedValue(undefined);
    await act(async () => {
      await store!.setPulled([LINE], true);
    });
    expect(store!.pulled.has(LINE)).toBe(true);
    mutate.mockRejectedValue(new Error("offline"));
    let failed = false;
    await act(async () => {
      await (store!.setPulled([LINE], false) as Promise<void>).catch(() => (failed = true));
    });
    expect(failed).toBe(true);
    expect(mutate).toHaveBeenLastCalledWith({ ids: [LINE], pulled: false });
    expect(store!.pulled.has(LINE)).toBe(true);
  });

  it("two saves in flight: the guard holds until both have settled, even when one fails", async () => {
    await mount();
    const calls: { resolve: () => void; reject: (e: Error) => void }[] = [];
    mutate.mockImplementation(
      () => new Promise<void>((resolve, reject) => calls.push({ resolve, reject })),
    );
    await act(async () => {
      void store!.setPulled([LINE], true);
    });
    await act(async () => {
      void (store!.setPulled([LINE], false) as Promise<void>).catch(() => {});
    });
    expect(calls).toHaveLength(2);
    expect(leaving()).toBe(true);
    await act(async () => calls[1].reject(new Error("offline")));
    expect(leaving()).toBe(true);
    await act(async () => calls[0].resolve());
    expect(leaving()).toBe(false);
  });

  it("leaving the page mid-save removes the guard with the store", async () => {
    await mount();
    mutate.mockReturnValue(new Promise<void>(() => {}));
    await act(async () => {
      void store!.setPulled([LINE], true);
    });
    expect(leaving()).toBe(true);
    cleanup();
    expect(leaving()).toBe(false);
  });

  it("a request sets no guard before it is made and none for an empty mark", async () => {
    await mount();
    expect(leaving()).toBe(false);
    await act(async () => {
      await store!.setPulled([], true);
    });
    expect(mutate).not.toHaveBeenCalled();
    expect(leaving()).toBe(false);
  });
});

describe("NEO-509: a sale's own words for its card", () => {
  it("titles the line set, variant, number, then players; a Base variant unwritten", () => {
    const listed = toListedCard(
      { sport: "football", year: "2021", setName: "Score", players: "Justin Fields", cardNo: "TB2", variant: "Insert", variantName: "1991 Throwback" },
      undefined,
    );
    expect(listedTitle(listed!)).toBe("2021 Score 1991 Throwback #TB2 · Justin Fields");
    expect(listed).toMatchObject({ sportName: "football", year: 2021, role: "insert", cardNumber: "TB2" });
    expect(listedTitle(toListedCard({ year: "2024", setName: "2024 Topps Chrome", cardNo: "7", variant: "Base" }, undefined)!)).toBe(
      "2024 Topps Chrome #7",
    );
    // A Base line whose name is "Base" never reads "Base" twice, nor at all.
    expect(listedTitle(toListedCard({ year: "2024", setName: "Score", cardNo: "7", variant: "Base", variantName: "Base" }, undefined)!)).toBe(
      "2024 Score #7",
    );
  });

  it("takes NB's sport when the sale names one NB has, the listing's word otherwise", () => {
    const raw = { sport: "football", sportId: "sp1" as never, year: "2021" };
    expect(toListedCard(raw, { name: "Football", code: "FB" })).toMatchObject({ sportId: "sp1", sportName: "Football", sportCode: "FB" });
    const unresolved = toListedCard(raw, null)!;
    expect(unresolved.sportId).toBeUndefined();
    expect(unresolved.sportName).toBe("football");
  });

  it("keeps an unknown variant word as written and never guesses a role from it", () => {
    // "Promo", "Variation", "SP": the word is what keeps the seller off the base copy.
    expect(toListedCard({ variant: "Promo" }, undefined)).toEqual({ variantWord: "Promo" });
    expect(toListedCard({ variant: "Short Print", variantName: "Gold" }, undefined)).toEqual({ variantWord: "Short Print", variantName: "Gold" });
    expect(listedTitle(toListedCard({ year: "2021", setName: "Score", cardNo: "5", variant: "Variation" }, undefined)!)).toBe("2021 Score Variation #5");
    // A word that IS a kind is the role; the name stays whatever the role.
    expect(toListedCard({ variant: "Parallels", variantName: "Gold" }, undefined)).toEqual({ role: "parallel", variantName: "Gold" });
    expect(toListedCard({ variant: "Base", variantName: "Photo Variation" }, undefined)).toEqual({ role: "base", variantName: "Photo Variation" });
    // A name with no word: kept, no role.
    expect(toListedCard({ variantName: "1991 Throwback" }, undefined)).toEqual({ variantName: "1991 Throwback" });
  });

  it("files a season under its start year and refuses a year that is no year", () => {
    expect(["2021", "2023-24", "2023/2024", "1799", "2101", "21", "2021a"].map(listedYear)).toEqual([
      2021, 2023, 2023, undefined, undefined, undefined, undefined,
    ]);
    expect(toListedCard({ sport: " ", players: "" }, undefined)).toBeUndefined();
  });
});

describe("NEO-509: the sports a sale names", () => {
  const original = openAnswer;
  const sportId = (n: number) => `sport${String(n).padStart(3, "0")}`;
  const lostLine = (n: number, listed: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    id: `s1~lost${n}`,
    saleId: "s1",
    platform: "bsc",
    orderNo: "12-3456",
    orderDate: 1,
    firstSeenAt: 1,
    cantFind: "unmatched",
    quantity: 1,
    condition: "near_mint",
    from: [],
    listed,
    ...over,
  });
  const open = (lines: unknown[]) => ({ truncated: false, boxes: [], lines });
  const sportCalls = () =>
    query.mock.calls.filter(([, args]) => (args as { sportIds?: string[] }).sportIds).map(([, args]) => (args as { sportIds: string[] }).sportIds);

  afterEach(() => {
    openAnswer = original;
    query.mockReset();
    query.mockImplementation((_fn: unknown, args: { cardIds?: string[]; copyIds?: string[] }) =>
      Promise.resolve(args.cardIds ? args.cardIds.map(() => ({ card: RAW_CARD, sportCode: "BB" })) : []),
    );
  });

  async function mountWith(lines: unknown[]) {
    openAnswer = open(lines);
    store = null;
    render(
      <ConvexPickListProvider>
        <Probe />
      </ConvexPickListProvider>,
    );
    await act(async () => {});
  }

  it("asks 21 sports in a call of 20 and a call of 1, and holds the list until both have answered", async () => {
    const pending: Array<(answer: unknown) => void> = [];
    query.mockImplementation(
      (_fn: unknown, args: { sportIds?: string[] }) =>
        new Promise((resolve) => pending.push((answer) => resolve(answer ?? args.sportIds?.map(() => ({ name: "Football", code: "FB" }))))),
    );
    await mountWith(Array.from({ length: 21 }, (_, n) => lostLine(n, { sportId: sportId(n), sport: "football", year: "2021" })));
    const calls = sportCalls();
    expect(calls.map((c) => c.length)).toEqual([20, 1]);
    expect(calls.flat()).toEqual(Array.from({ length: 21 }, (_, n) => sportId(n)));
    // Neither has answered: the list waits rather than show a guessed sport.
    expect(store?.data).toBeUndefined();
    await act(async () => pending[0](undefined));
    expect(store?.data).toBeUndefined();
    await act(async () => pending[1](undefined));
    expect(store?.data?.lines).toHaveLength(21);
    expect(store!.data!.lines.every((l) => l.listed?.sportName === "Football" && l.sportCode === "FB")).toBe(true);
    // Each sport is asked once, not again on the next render.
    expect(sportCalls()).toHaveLength(2);
  });

  it("asks a repeated sport once, and none for a line without one", async () => {
    await mountWith([lostLine(1, { sportId: sportId(1), year: "2021" }), lostLine(2, { sportId: sportId(1), year: "2022" }), lostLine(3, { year: "2023" })]);
    expect(sportCalls()).toEqual([[sportId(1)]]);
    expect(store?.data?.lines).toHaveLength(3);
  });

  it("a sport call that fails does not hold the list: the line keeps the listing's own sport word", async () => {
    query.mockImplementation(() => Promise.reject(new Error("offline")));
    await mountWith([lostLine(1, { sportId: sportId(1), sport: "football", year: "2021", setName: "Score", cardNo: "5" })]);
    const line = store?.data?.lines[0];
    expect(line?.listed).toMatchObject({ sportName: "football", year: 2021 });
    expect(line?.listed?.sportId).toBeUndefined();
    expect(line?.sportCode).toBeNull();
  });

  it("a sport NB no longer has (null answer) is the listing's word too", async () => {
    query.mockImplementation((_fn: unknown, args: { sportIds?: string[] }) => Promise.resolve(args.sportIds?.map(() => null) ?? []));
    await mountWith([lostLine(1, { sportId: sportId(1), sport: "football", year: "2021", setName: "Score", cardNo: "5" })]);
    expect(store?.data?.lines[0].listed?.sportName).toBe("football");
    expect(store?.data?.lines[0].listed?.sportId).toBeUndefined();
  });

  it("numbers lines of one order that read alike, so no two titles (and toggle names) are the same", async () => {
    const same = { sport: "football", year: "2021", setName: "Score", cardNo: "5", players: "Justin Fields" };
    await mountWith([
      lostLine(1, same),
      lostLine(2, same),
      // Differs only by a field the title does not write.
      lostLine(3, { ...same, sport: "hockey" }),
      lostLine(4, { cardNo: "6", year: "2021", setName: "Score" }),
      lostLine(5, {}),
      lostLine(6, {}),
      // Another order: its own count.
      lostLine(7, same, { id: "s2~lost7", saleId: "s2", orderNo: "99" }),
    ]);
    const titles = store!.data!.lines.map((l) => l.listingTitle);
    expect(titles).toEqual([
      "2021 Score #5 · Justin Fields (1 of 3)",
      "2021 Score #5 · Justin Fields (2 of 3)",
      "2021 Score #5 · Justin Fields (3 of 3)",
      "2021 Score #6",
      "Unmatched sale (1 of 2)",
      "Unmatched sale (2 of 2)",
      "2021 Score #5 · Justin Fields",
    ]);
    // Every control name is the title plus its order: unique across the list.
    const names = store!.data!.lines.map((l) => `${l.listingTitle}|${l.order.id}`);
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps the described line's listed card and its next step, and an undescribed one carries none", async () => {
    await mountWith([lostLine(1, { year: "2021", setName: "Score", cardNo: "5" }), lostLine(2, { sport: " " })]);
    const [described, bare] = store!.data!.lines;
    expect(described.listed).toMatchObject({ year: 2021, cardNumber: "5" });
    expect(described.problem).toMatch(/couldn't match/);
    expect(bare.listed).toBeUndefined();
    expect(bare.listingTitle).toBe("Unmatched sale");
  });
});
