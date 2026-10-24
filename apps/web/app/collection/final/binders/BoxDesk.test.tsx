import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { MemoryRouter, Route, Routes } from "react-router";
import { Theme } from "@radix-ui/themes";
import { cards as fixtureCards } from "../../prototypes/_shared/data";
import FinalCollectionPage from "../FinalCollectionPage";
import { demoCard, DemoCollectionProvider } from "../data/demoStore";
import { compareCards } from "../data/labels";
import { useCollectionActions, useContainers } from "../data/store";
import type { Card, Container, Copy } from "../data/types";
import BoxDesk from "./BoxDesk";
import ForSaleView from "./ForSaleView";

vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true }) }));

/**
 * NEO-359 — an open box: five rows and the "Not sorted into a row yet" strip,
 * every move done three ways (drag, the row picker, Alt+ArrowUp / Alt+ArrowDown)
 * through one `onPlace`; and the for-sale view over every box.
 */

const BOX: Container = { id: "box1", kind: "box", name: "Show box", count: null };
const checklist: Card[] = fixtureCards
  .filter((c) => c.setId === "1996-playoff-contenders" && c.variantPath.type === "Base" && c.variation === null)
  .map((c) => demoCard(c.id)!)
  .sort(compareCards);
const byId = new Map(checklist.map((c) => [c.id, c]));
const [c0, c1, c2] = checklist;

const line = (id: string, card: Card, slot?: number, over: Partial<Copy> = {}): Copy => ({
  id,
  cardId: card.id,
  variantId: card.variant.id,
  setId: card.set.id,
  homeId: BOX.id,
  homeKind: "box",
  homeName: BOX.name,
  upForTrade: false,
  quantity: 1,
  acquiredAt: "2026-01-01",
  notes: "",
  ...(slot === undefined ? {} : { slot }),
  ...over,
});

afterEach(cleanup);

function renderBox(
  copies: Copy[],
  onPlace: Parameters<typeof BoxDesk>[0]["onPlace"] = vi.fn(async (c: Copy) => c.id),
  extra: Partial<Parameters<typeof BoxDesk>[0]> = {}) {
  const props = { onOpen: vi.fn(), onMore: vi.fn() };
  render(
    <Theme>
      <DndContext>
        <BoxDesk
          box={BOX}
          copies={copies}
          cards={byId}
          truncated={false}
          found={null}
          draggingId={null}
          onPlace={onPlace}
          {...props}
          {...extra}
        />
      </DndContext>
    </Theme>,
  );
  return { onPlace, ...props };
}

const cardButton = (re: RegExp) => screen.getByRole("button", { name: re });

describe("an open box", () => {
  it("draws five rows, each counting its cards, and the strip for cards in no row", () => {
    renderBox([line("a", c0, 0), line("b", c1, 0, { quantity: 3 }), line("c", c2, 4), line("d", c2)]);
    const region = screen.getByRole("region", { name: "Show box, open" });
    const rows = within(region).getAllByRole("group");
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual([
      "Row 1, 4 cards",
      "Row 2, 0 cards",
      "Row 3, 0 cards",
      "Row 4, 0 cards",
      "Row 5, 1 card",
    ]);
    const strip = screen.getByRole("group", { name: "Not sorted into a row yet" });
    expect(within(strip).getAllByRole("button", { name: /Playoff Contenders/ })).toHaveLength(1);
  });

  it("says an empty box is empty, and a sorted one is all sorted", () => {
    renderBox([]);
    expect(screen.getByText(/This box is empty/)).toBeTruthy();
    cleanup();
    renderBox([line("a", c0, 1)]);
    expect(screen.getByText(/All sorted/)).toBeTruthy();
  });

  it("names an empty row for what to do", () => {
    renderBox([line("a", c0, 1)]);
    expect(screen.getAllByText(/^Empty\. Drag a card in, or pick Row \d under one\.$/)).toHaveLength(4);
  });

  it("opens the card drawer on a card's line when pressed", () => {
    const { onOpen } = renderBox([line("a", c0, 1)]);
    fireEvent.click(cardButton(/Playoff Contenders/));
    expect(onOpen).toHaveBeenCalledWith(c0, expect.objectContaining({ id: "a" }));
  });

  it("offers Dig deeper only when the box holds more than is loaded", () => {
    const { onMore } = renderBox([line("a", c0, 1)], undefined, { truncated: true });
    fireEvent.click(screen.getByRole("button", { name: "Dig deeper into Show box" }));
    expect(onMore).toHaveBeenCalled();
    cleanup();
    renderBox([line("a", c0, 1)]);
    expect(screen.queryByRole("button", { name: /Dig deeper/ })).toBeNull();
  });
});

describe("moving a card between rows", () => {
  const sortedCard = (re = /Playoff Contenders/) => cardButton(re);

  it("the row picker puts the card in that row, or out of every row", () => {
    const { onPlace } = renderBox([line("a", c0, 1)]);
    const pick = screen.getByRole("combobox", { name: /^Row for / }) as HTMLSelectElement;
    expect(pick.value).toBe("1");
    fireEvent.change(pick, { target: { value: "3" } });
    expect(onPlace).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }), 3);
    fireEvent.change(pick, { target: { value: "" } });
    expect(onPlace).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }), null);
  });

  it("a card in no row reads 'Not in a row' in its picker", () => {
    renderBox([line("a", c0)]);
    expect((screen.getByRole("combobox", { name: /^Row for / }) as HTMLSelectElement).value).toBe("");
  });

  it("Alt+ArrowDown hops one row toward the back", () => {
    const { onPlace } = renderBox([line("a", c0, 1)]);
    fireEvent.keyDown(sortedCard(), { key: "ArrowDown", altKey: true });
    expect(onPlace).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), 2);
  });

  it("Alt+ArrowUp hops one row toward the front", () => {
    const { onPlace } = renderBox([line("a", c0, 3)]);
    fireEvent.keyDown(sortedCard(), { key: "ArrowUp", altKey: true });
    expect(onPlace).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), 2);
  });

  it("hopping past Row 5 puts the card on the table (out of every row)", () => {
    const { onPlace } = renderBox([line("a", c0, 4)]);
    fireEvent.keyDown(sortedCard(), { key: "ArrowDown", altKey: true });
    expect(onPlace).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), null);
  });

  it("hopping up from the table lands in Row 5", () => {
    const { onPlace } = renderBox([line("a", c0)]);
    fireEvent.keyDown(sortedCard(), { key: "ArrowUp", altKey: true });
    expect(onPlace).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), 4);
  });

  it("does nothing at the front (up from Row 1) or on the table (down from it)", () => {
    const { onPlace } = renderBox([line("a", c0, 0)]);
    fireEvent.keyDown(sortedCard(), { key: "ArrowUp", altKey: true });
    expect(onPlace).not.toHaveBeenCalled();
    cleanup();
    const second = renderBox([line("a", c0)]);
    fireEvent.keyDown(sortedCard(), { key: "ArrowDown", altKey: true });
    expect(second.onPlace).not.toHaveBeenCalled();
  });

  it("plain arrows (no Alt) do not hop", () => {
    const { onPlace } = renderBox([line("a", c0, 1)]);
    fireEvent.keyDown(sortedCard(), { key: "ArrowDown" });
    expect(onPlace).not.toHaveBeenCalled();
  });

  it("a slot past the box's rows counts as the table when hopping", () => {
    const { onPlace } = renderBox([line("a", c0, 9)]);
    fireEvent.keyDown(sortedCard(), { key: "ArrowUp", altKey: true });
    expect(onPlace).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), 4);
  });

  it("puts the keyboard on the card in its new row (the line it became)", async () => {
    let copies = [line("a", c0, 1)];
    const onPlace = vi.fn(async (copy: Copy, row: number | null) => {
      copies = [{ ...copy, ...(row === null ? { slot: undefined } : { slot: row }) }];
      rerender();
      return copy.id;
    });
    const view = (cs: Copy[]) => (
      <Theme>
        <DndContext>
          <BoxDesk box={BOX} copies={cs} cards={byId} truncated={false} found={null} draggingId={null} onPlace={onPlace} onOpen={vi.fn()} onMore={vi.fn()} />
        </DndContext>
      </Theme>
    );
    const { rerender: rr } = render(view(copies));
    function rerender() {
      rr(view(copies));
    }
    const before = sortedCard();
    before.focus();
    await act(async () => {
      fireEvent.keyDown(before, { key: "ArrowDown", altKey: true });
    });
    await waitFor(() => expect(document.activeElement).toBe(sortedCard()));
    expect(within(screen.getByRole("group", { name: /^Row 3,/ })).getByRole("button", { name: /Playoff Contenders/ })).toBe(
      document.activeElement,
    );
  });

  it("does not move focus when the write is refused", async () => {
    const onPlace = vi.fn(async (_c: Copy, _row: number | null) => null);
    renderBox([line("a", c0, 1)], onPlace);
    const el = sortedCard();
    el.focus();
    await act(async () => {
      fireEvent.keyDown(el, { key: "ArrowDown", altKey: true });
    });
    expect(document.activeElement).toBe(el);
  });
});

describe("the box on the page (demo store)", () => {
  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => window.sessionStorage.clear());

  function renderPage(start: string) {
    return render(
      <Theme>
        <MemoryRouter initialEntries={[start]}>
          <Routes>
            <Route path="/inventory" element={<FinalCollectionPage surface="inventory" />} />
          </Routes>
        </MemoryRouter>
      </Theme>,
    );
  }

  it("opens the Show box with its unsorted strip, and Alt+ArrowUp from the table lands the card in Row 5 and keeps the keyboard on it", async () => {
    renderPage("/inventory?b=box-show");
    const region = await screen.findByRole("region", { name: "Show box, open" });
    const strip = screen.getByRole("group", { name: "Not sorted into a row yet" });
    const unsorted = [...strip.querySelectorAll<HTMLElement>("[data-box-copy]")];
    expect(unsorted.length).toBeGreaterThan(0);

    const target = unsorted[0];
    const id = target.getAttribute("data-box-copy")!;
    target.focus();
    await act(async () => {
      fireEvent.keyDown(target, { key: "ArrowUp", altKey: true });
    });
    await waitFor(() => {
      const moved = region.querySelector<HTMLElement>(`[data-box-copy="${CSS.escape(id)}"]`);
      expect(moved?.closest('[role="group"]')?.getAttribute("aria-label")).toMatch(/^Row 5,/);
    });
    await waitFor(() => expect(document.activeElement?.getAttribute("data-box-copy")).toBe(id));
  });
});

describe("the for-sale view", () => {
  function Rig({ openBox, openCard }: { openBox: (b: Container) => void; openCard: (c: Card, copy: Copy) => void }) {
    return (
      <Theme>
        <DemoCollectionProvider storageKey="nb-for-sale-test">
          <ForSaleView onOpenBox={openBox} onOpenCard={openCard} />
        </DemoCollectionProvider>
      </Theme>
    );
  }
  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => window.sessionStorage.clear());

  it("lists the cards of every box with the row each sits in, headed by the for-sale total", () => {
    render(<Rig openBox={vi.fn()} openCard={vi.fn()} />);
    expect(screen.getByText(/\d+ cards? for sale in 1 box/)).toBeTruthy();
    const section = screen.getByRole("region", { name: "Show box, for sale" });
    const buttons = within(section).getAllByRole("button", { name: /, Show box, / });
    expect(buttons.length).toBeGreaterThan(1);
    expect(buttons.some((b) => /, Row \d$/.test(b.getAttribute("aria-label")!))).toBe(true);
    expect(buttons.some((b) => /, not in a row$/.test(b.getAttribute("aria-label")!))).toBe(true);
  });

  it("opens the box, and a card's line, from here", () => {
    const openBox = vi.fn();
    const openCard = vi.fn();
    render(<Rig openBox={openBox} openCard={openCard} />);
    fireEvent.click(screen.getByRole("button", { name: "Open the box, Show box" }));
    expect(openBox).toHaveBeenCalledWith(expect.objectContaining({ id: "box-show" }));
    fireEvent.click(within(screen.getByRole("region", { name: "Show box, for sale" })).getAllByRole("button", { name: /, Show box, / })[0]);
    expect(openCard).toHaveBeenCalledWith(expect.objectContaining({ id: expect.any(String) }), expect.objectContaining({ homeId: "box-show" }));
  });

  it("with no box says nothing is for sale and how to make one", () => {
    function Rig2() {
      const actions = useCollectionActions();
      const containers = useContainers();
      const box = containers?.find((c) => c.kind === "box");
      return (
        <>
          <button type="button" onClick={() => box && void actions.deleteContainer(box)}>
            Delete the box
          </button>
          <ForSaleView onOpenBox={vi.fn()} onOpenCard={vi.fn()} />
        </>
      );
    }
    render(
      <Theme>
        <DemoCollectionProvider storageKey="nb-for-sale-test">
          <Rig2 />
        </DemoCollectionProvider>
      </Theme>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete the box" }));
    return waitFor(() => {
      expect(screen.getByText("Nothing's for sale yet.")).toBeTruthy();
      expect(screen.getByText(/Make a box \(New box\)/)).toBeTruthy();
    });
  });
});
