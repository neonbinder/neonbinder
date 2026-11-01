import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Theme } from "@radix-ui/themes";
import InventoryChecklist from "./InventoryChecklist";
import { QuickEntryProvider } from "./QuickEntry";
import { checklistGateLine } from "./listing/ListingGate";
import { stubListing } from "./listing/stubListing";
import { CollectionModeProvider } from "../mode";
import { PageApiContext, type PageApi } from "../pageApi";
import { CollectionStoreContext, type CollectionActions, type CollectionData, type CollectionStoreValue } from "../data/store";
import { REAL_CAPABILITIES, type Card, type Container, type Copy, type ListingGateView } from "../data/types";
import { expectAccessibleInBothModes } from "@/lib/testing/axe";

/**
 * NEO-370 — the listing gate on the inventory checklist. A collector set up
 * for syncing stocks a box that lists on marketplaces only with a price on
 * the cards: with no common price for the checklist, every RAISE holds (a
 * higher number, the +, "Add a range"), each control pointing at the note
 * under Common price that says why. Lowering a count always writes: taking
 * cards out is never blocked (Jason, 2026-11-01). A common price, a box that does not list, or a collector who does
 * not sync: nothing held. The store is a stub; the gate is what the server's
 * `listingGate.forHome` would answer.
 */
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" }) }));

const SET = {
  id: "set1",
  name: "Topps",
  season: "1988",
  year: 1988,
  brand: { id: "b", name: "Topps" },
  sport: { id: "s", name: "Baseball" },
};
const VARIANT = {
  id: "base1",
  kind: "base" as const,
  name: null,
  insertName: null,
  printRun: null,
  order: 0,
  path: { typeId: "base1", variantId: null, subVariantId: null },
  finish: { kind: "standard" as const },
  cardCount: 2,
  baseCardCount: 2,
};
const card = (id: string, n: string, player: string): Card => ({
  id,
  set: SET,
  variant: VARIANT,
  cardNumber: n,
  players: [{ id: `p-${id}`, name: player }],
  teams: [{ id: "t", location: "Cincinnati", name: "Reds" }],
  printRun: null,
  features: [],
  cardVariation: null,
  isVariation: false,
  sortOrder: Number(n),
  finish: { kind: "standard" },
});
const CARDS = [card("k1", "1", "Barry Larkin"), card("k2", "2", "Eric Davis")];
const SHELF: Container[] = [{ id: "unsorted", kind: "box", system: "unsorted", name: "Unsorted", count: null }];
/** Two plain copies of the first card already in the box, so its count can come down. */
const STOCK: Copy[] = [
  {
    id: "line1",
    cardId: CARDS[0].id,
    variantId: VARIANT.id,
    setId: SET.id,
    homeId: "unsorted",
    homeKind: "box",
    homeName: "Unsorted",
    upForTrade: false,
    quantity: 2,
    acquiredAt: "2026-10-01",
    notes: "",
  },
];

/** Syncing, the box lists, no common price: held. */
const HELD: ListingGateView = { syncing: true, applies: true, commonPriceCents: null };

function setup(gate: ListingGateView | undefined) {
  const setBoxQuantity = vi.fn(async (_c: Card, _b: Container, quantity: number) => ({ before: 2, after: quantity, undo: async () => {} }));
  const addMany = vi.fn(async () => ({ undo: async () => {} }));
  const notify = vi.fn();
  const pageApi = {
    openCard: vi.fn(),
    goToChecklists: vi.fn(),
    openSuggestion: vi.fn(),
    notify,
    inform: vi.fn(),
    undoLast: vi.fn(),
    run: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  } as unknown as PageApi;
  const data = {
    useContainers: () => SHELF,
    useDemoExtension: () => undefined,
    useDefaultCondition: () => "Excellent",
    useVariantCards: () => CARDS,
    useCopiesInVariant: () => STOCK,
    useVariantCompletion: () => ({ owned: 1, total: 2, percent: 50, ownedAll: 1, totalAll: 2 }),
    useCommonPrices: () => (gate?.commonPriceCents ? { base1: gate.commonPriceCents / 100 } : {}),
  } as unknown as CollectionData;
  const value = {
    kind: "convex",
    capabilities: REAL_CAPABILITIES,
    data,
    actions: { setBoxQuantity, addMany } as unknown as CollectionActions,
    listing: stubListing({ useGate: () => gate }),
  } as CollectionStoreValue;
  const tree = () => (
    <Theme>
      <MemoryRouter initialEntries={["/inventory?tab=checklists"]}>
        <CollectionStoreContext.Provider value={value}>
          <CollectionModeProvider mode="app" surface="inventory">
            <PageApiContext.Provider value={pageApi}>
              <QuickEntryProvider>
                <InventoryChecklist
                  setId="set1"
                  variantId="base1"
                  title="1988 Topps Base"
                  actions={{ open: vi.fn() } as never}
                  selectedCardId={null}
                  highlightCardId={null}
                />
              </QuickEntryProvider>
            </PageApiContext.Provider>
          </CollectionModeProvider>
        </CollectionStoreContext.Provider>
      </MemoryRouter>
    </Theme>
  );
  const view = render(tree());
  return { view, setBoxQuantity, addMany, notify, rerender: () => view.rerender(tree()) };
}

const fields = () => screen.getAllByRole("textbox", { name: /^Quantity of / }) as HTMLInputElement[];
const plus = () => screen.getAllByRole("button", { name: /^Add one / }) as HTMLButtonElement[];
const range = () => screen.getByRole("textbox", { name: "Add a range to Unsorted" }) as HTMLInputElement;
const LINE = checklistGateLine("Unsorted", { needsPrice: true, needsCondition: false });
const describedBy = (el: Element) => (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(cleanup);

describe("the inventory checklist's listing gate (NEO-370)", () => {
  it("holds every raise and the range, each pointing at the reason; the fields stay editable", () => {
    setup(HELD);
    expect(LINE).toBe("Price tag first! Unsorted sells on your marketplaces, so set a common price above before you stock it.");
    const note = screen.getByText(LINE).closest("p")!;
    expect(note.id).toBeTruthy();
    for (const f of fields()) {
      // Editable: a lower always goes through. Described by the reason a raise waits on.
      expect(f.readOnly).toBe(false);
      expect(describedBy(f)).toContain(note.id);
    }
    // Still Tab stops, so the reason is read on arrival.
    expect(fields().every((f) => f.tabIndex !== -1)).toBe(true);
    expect(plus().every((b) => b.disabled)).toBe(true);
    expect(range().readOnly).toBe(true);
    expect(describedBy(range())).toContain(note.id);
    // The fix sits right above: the common price.
    expect(screen.getByRole("button", { name: "Set a common price for 1988 Topps Base" })).toBeTruthy();
  });

  it("a held raise writes nothing, typed or with +, says why, and puts the number back; a range adds nothing", async () => {
    const { setBoxQuantity, addMany, notify } = setup(HELD);
    const f = fields()[0];
    expect(f.value).toBe("2");
    fireEvent.change(f, { target: { value: "3" } });
    fireEvent.blur(f);
    await act(async () => {});
    expect(fields()[0].value).toBe("2");
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/didn't change\. Set a common price first to box more\.$/));
    expect(fields()[0].getAttribute("aria-invalid")).toBe("true");
    // A raise from 0 is held the same way.
    fireEvent.change(fields()[1], { target: { value: "1" } });
    fireEvent.blur(fields()[1]);
    fireEvent.click(plus()[0]);
    fireEvent.change(range(), { target: { value: "1-2" } });
    fireEvent.keyDown(range(), { key: "Enter" });
    await act(async () => {});
    expect(setBoxQuantity).not.toHaveBeenCalled();
    expect(addMany).not.toHaveBeenCalled();
  });

  it("a held field still lowers a count, and the lower is written (taking cards out is never blocked)", async () => {
    const { setBoxQuantity } = setup(HELD);
    for (const target of ["1", "0"]) {
      const f = fields()[0];
      fireEvent.change(f, { target: { value: target } });
      fireEvent.blur(f);
      await act(async () => {});
    }
    expect(setBoxQuantity).toHaveBeenCalledTimes(2);
    expect(setBoxQuantity.mock.calls.map((c) => c[2])).toEqual([1, 0]);
  });

  it("a common price, a box that does not list, or a collector who does not sync: nothing held", async () => {
    for (const gate of [
      { ...HELD, commonPriceCents: 25 },
      { syncing: true, applies: false, commonPriceCents: null },
      { syncing: false, applies: false, commonPriceCents: null },
      undefined,
    ]) {
      const { setBoxQuantity } = setup(gate);
      expect(screen.queryByText(LINE)).toBeNull();
      const f = fields()[0];
      expect(f.readOnly).toBe(false);
      expect(plus()[0].disabled).toBe(false);
      fireEvent.change(f, { target: { value: "3" } });
      fireEvent.blur(f);
      await act(async () => {});
      expect(setBoxQuantity).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });

  it("passes axe in light and dark, held and open", async () => {
    const held = setup(HELD);
    await expectAccessibleInBothModes(held.view.container, { label: "Inventory checklist, held", rerender: held.rerender });
    cleanup();
    const open = setup({ ...HELD, commonPriceCents: 25 });
    await expectAccessibleInBothModes(open.view.container, { label: "Inventory checklist, priced", rerender: open.rerender });
  });
});
