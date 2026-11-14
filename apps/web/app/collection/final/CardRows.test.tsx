import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import CardRowGroup, { type RowActions } from "./CardRows";
import { CollectionStoreContext, ScopeProvider } from "./data/store";
import { REAL_CAPABILITIES, type Card, type Container, type Copy } from "./data/types";
import { OPTIMISTIC_ID_PREFIX } from "./lineKeys";

/**
 * NEO-529 — a checklist row keeps its identity across the store's
 * optimistic→real id swap. Have draws the new copy under an `optimistic:` id
 * and the server's id replaces it a moment later; a row keyed by the copy's id
 * remounted there, so a quick press on Details (or any control on the row)
 * landed on a node that had just left the page. `useLineKeys` (./lineKeys)
 * hands the drawn line's key to the server's line, as CardDetail's list does.
 */
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true }) }));
vi.mock("convex/react", () => ({}));

const CARD: Card = {
  id: "c-1",
  set: {
    id: "set-chrome",
    name: "Topps Chrome",
    season: "2024",
    year: 2024,
    brand: { id: "br-topps", name: "Topps" },
    sport: { id: "sp-baseball", name: "Baseball" },
  },
  variant: {
    id: "vt-base",
    kind: "base",
    name: null,
    insertName: null,
    printRun: null,
    order: 0,
    path: { typeId: "vt-base", variantId: null, subVariantId: null },
    finish: { kind: "standard" },
    cardCount: 1,
    baseCardCount: 1,
  },
  cardNumber: "1",
  players: [{ id: "pl-ohtani", name: "Shohei Ohtani" }],
  teams: [{ id: "tm-dodgers", location: "Los Angeles", name: "Dodgers" }],
  printRun: null,
  features: [],
  cardVariation: null,
  isVariation: false,
  sortOrder: 1,
  finish: { kind: "standard" },
};

const HOMES: Container[] = [
  { id: "main", kind: "binder", system: "main", name: "Main", count: null },
  { id: "binder-rainbow", kind: "binder", name: "Ohtani rainbow", count: null },
];

/** A copy already on the server. */
const HELD: Copy = {
  id: "copy-1",
  cardId: CARD.id,
  variantId: "vt-base",
  setId: "set-chrome",
  homeId: "main",
  homeKind: "binder",
  homeName: "Main",
  upForTrade: false,
  quantity: 1,
  acquiredAt: "2026-10-01",
  notes: "",
};
/** What Have draws ahead of the server. */
const DRAWN: Copy = { ...HELD, id: `${OPTIMISTIC_ID_PREFIX}1`, homeId: "binder-rainbow", homeName: "Ohtani rainbow" };
/** The same copy once the server answers. */
const LANDED: Copy = { ...DRAWN, id: "copy-9" };

const store = {
  kind: "convex",
  capabilities: REAL_CAPABILITIES,
  data: { useContainers: () => HOMES, useWants: () => [] },
} as never;

function actions(): RowActions {
  return {
    have: vi.fn(),
    removeLine: vi.fn(),
    addAnother: vi.fn(),
    toggleWant: vi.fn(),
    toggleTrade: vi.fn(),
    open: vi.fn(),
  };
}

function Rows({ copies, rowActions }: { copies: Copy[]; rowActions: RowActions }) {
  return (
    <CollectionStoreContext.Provider value={store}>
      <ScopeProvider value="binder-rainbow">
        <ul>
          <CardRowGroup card={CARD} copies={copies} actions={rowActions} />
        </ul>
      </ScopeProvider>
    </CollectionStoreContext.Provider>
  );
}

afterEach(cleanup);

describe("CardRowGroup through the id swap", () => {
  it("a lone row keeps its Details button, and the focus on it, when the server's id replaces the drawn one", () => {
    const rowActions = actions();
    const { rerender } = render(<Rows copies={[DRAWN]} rowActions={rowActions} />);
    const details = screen.getByRole("button", { name: "Details for #1 Shohei Ohtani" });
    const row = details.parentElement!.parentElement!;
    act(() => details.focus());
    expect(document.activeElement).toBe(details);

    act(() => rerender(<Rows copies={[LANDED]} rowActions={rowActions} />));

    const after = screen.getByRole("button", { name: "Details for #1 Shohei Ohtani" });
    expect(after).toBe(details);
    expect(details.isConnected).toBe(true);
    expect(details.parentElement!.parentElement).toBe(row);
    expect(document.activeElement).toBe(details);
    // The press aimed at the drawn row lands, on the server's line.
    fireEvent.click(details);
    expect(rowActions.open).toHaveBeenCalledWith(CARD, "copy-9");
  });

  it("in a stack, the swapped line keeps its row and the held line keeps its own", () => {
    const rowActions = actions();
    const { rerender } = render(<Rows copies={[HELD, DRAWN]} rowActions={rowActions} />);
    const drawnHave = screen.getByRole("button", { name: /^Have #1 Shohei Ohtani, .*Ohtani rainbow/ });
    const heldHave = screen.getByRole("button", { name: /^Have #1 Shohei Ohtani, .*Main/ });
    act(() => drawnHave.focus());

    // The server's answer can come back in a different order, too.
    act(() => rerender(<Rows copies={[LANDED, HELD]} rowActions={rowActions} />));

    expect(screen.getByRole("button", { name: /^Have #1 Shohei Ohtani, .*Ohtani rainbow/ })).toBe(drawnHave);
    expect(screen.getByRole("button", { name: /^Have #1 Shohei Ohtani, .*Main/ })).toBe(heldHave);
    expect(drawnHave.isConnected).toBe(true);
    expect(document.activeElement).toBe(drawnHave);
    fireEvent.click(drawnHave);
    expect(rowActions.removeLine).toHaveBeenCalledWith(CARD, LANDED);
  });
});
