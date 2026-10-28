import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Theme } from "@radix-ui/themes";
import { useState } from "react";
import QuantityRow, { BLANK_MESSAGE, quantityMessage } from "./QuantityRow";
import { QuickEntryProvider } from "./QuickEntry";
import { CollectionModeProvider } from "../mode";
import { PageApiContext, type PageApi } from "../pageApi";
import { CollectionStoreContext, type CollectionActions, type CollectionData, type CollectionStoreValue } from "../data/store";
import { REAL_CAPABILITIES, type Card, type Container, type Copy } from "../data/types";

/**
 * NEO-364 (D9-D11) — one inventory Checklists row: the quantity field, its
 * save marks, and its keyboard. The store is a stub (a shelf and a spy for
 * `setBoxQuantity`), the page API a set of spies: these tests pin what the
 * row asks for and says, not how a store answers.
 */
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" }) }));

const SET = {
  id: "set1",
  name: "Topps Chrome",
  season: "2024",
  year: 2024,
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
  cardCount: 3,
  baseCardCount: 3,
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
const ELLY = card("k1", "12", "Elly De La Cruz");
const CHASE = card("k2", "13", "Chase Burns");

const SHELF: Container[] = [
  { id: "main", kind: "binder", system: "main", name: "Main", count: null },
  { id: "unsorted", kind: "box", system: "unsorted", name: "Unsorted", count: null },
  { id: "show", kind: "box", name: "Show box", count: null },
];

const line = (over: Partial<Copy> = {}): Copy => ({
  id: "line1",
  cardId: ELLY.id,
  variantId: VARIANT.id,
  setId: SET.id,
  homeId: "unsorted",
  homeKind: "box",
  homeName: "Unsorted",
  upForTrade: false,
  quantity: 2,
  acquiredAt: "2026-10-01",
  notes: "",
  ...over,
});

interface Rig {
  setBoxQuantity: ReturnType<typeof vi.fn>;
  api: { notify: ReturnType<typeof vi.fn>; inform: ReturnType<typeof vi.fn>; undoLast: ReturnType<typeof vi.fn>; openCard: ReturnType<typeof vi.fn> };
  onOpen: ReturnType<typeof vi.fn>;
  onOpenChecklist: ReturnType<typeof vi.fn>;
}

function setup(
  rows: { card: Card; copies: Copy[] | undefined }[] = [{ card: ELLY, copies: [line()] }],
  {
    shelf: shelfIn = SHELF,
    write,
    checklist = false,
  }: { shelf?: Container[] | null; write?: (card: Card, box: Container, quantity: number) => Promise<unknown>; checklist?: boolean } = {},
): Rig {
  const undo = vi.fn(async () => {});
  const setBoxQuantity = vi.fn(
    write ?? (async (_c: Card, _b: Container, quantity: number) => ({ before: 2, after: quantity, undo })),
  );
  const api = { notify: vi.fn(), inform: vi.fn(), undoLast: vi.fn(), openCard: vi.fn() };
  const onOpen = vi.fn();
  const onOpenChecklist = vi.fn();
  const pageApi: PageApi = {
    openCard: api.openCard,
    goToChecklists: vi.fn(),
    openSuggestion: vi.fn(),
    notify: api.notify,
    inform: api.inform,
    undoLast: api.undoLast,
    run: vi.fn(),
  };
  const shelf = shelfIn ?? undefined;
  const data = { useContainers: () => shelf, useDemoExtension: () => undefined, useDefaultCondition: () => "Excellent" } as unknown as CollectionData;
  const value = {
    kind: "convex",
    capabilities: REAL_CAPABILITIES,
    data,
    actions: { setBoxQuantity } as unknown as CollectionActions,
  } as CollectionStoreValue;
  render(
    <Theme>
      <MemoryRouter initialEntries={["/inventory?tab=checklists"]}>
        <CollectionStoreContext.Provider value={value}>
          <CollectionModeProvider mode="app" surface="inventory">
            <PageApiContext.Provider value={pageApi}>
              <QuickEntryProvider>
                <ul data-qty-list="">
                  {rows.map((r) => (
                    <QuantityRow
                      key={r.card.id}
                      card={r.card}
                      copies={r.copies}
                      onOpen={onOpen}
                      onOpenChecklist={checklist ? onOpenChecklist : undefined}
                    />
                  ))}
                </ul>
              </QuickEntryProvider>
            </PageApiContext.Provider>
          </CollectionModeProvider>
        </CollectionStoreContext.Provider>
      </MemoryRouter>
    </Theme>,
  );
  return { setBoxQuantity, api, onOpen, onOpenChecklist };
}

const field = (name = /^Quantity of /) => screen.getByRole("textbox", { name }) as HTMLInputElement;
const fields = () => screen.getAllByRole("textbox", { name: /^Quantity of / }) as HTMLInputElement[];
const type = (el: HTMLInputElement, text: string) => fireEvent.change(el, { target: { value: text } });
const flush = () => act(async () => {});

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe("the field's number", () => {
  it("is how many plain copies of the card sit in the target box, named for the card and the box", () => {
    setup([{ card: ELLY, copies: [line({ quantity: 2 }), line({ id: "l2", quantity: 3, slot: 1 })] }]);
    expect(field().value).toBe("5");
    expect(field().getAttribute("aria-label")).toBe("Quantity of #12 Elly De La Cruz in Unsorted");
  });

  it("counts a card in no line as 0, and never counts another box's copies", () => {
    setup([{ card: ELLY, copies: [line({ homeId: "show", quantity: 4 })] }]);
    expect(field().value).toBe("0");
  });

  it("shows the card's other lines after it, read-only, and never counts them", () => {
    setup([{ card: ELLY, copies: [line({ quantity: 1 }), line({ id: "slab", quantity: 1, graded: { grader: "PSA", grade: "9" } })] }]);
    expect(field().value).toBe("1");
    const others = screen.getByText("also here: PSA 9");
    // After the number in reading order, so "0 · also here: PSA 9" never reads as a contradiction.
    expect(field().compareDocumentPosition(others) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(field().getAttribute("aria-describedby")?.split(" ")).toContain(others.id);
  });

  it("a card with only a graded or noted copy in the box reads 0, with that copy named after it", () => {
    setup([{ card: ELLY, copies: [line({ id: "slab", quantity: 1, graded: { grader: "PSA", grade: "9" } }), line({ id: "nm", condition: "Near Mint" })] }]);
    expect(field().value).toBe("0");
    expect(screen.getByText("also here: PSA 9, Raw Near Mint ×2")).toBeTruthy();
  });

  it("with every copy plain, says nothing after the field and describes it by nothing", () => {
    setup();
    expect(screen.queryByText(/also here/)).toBeNull();
    expect(field().getAttribute("aria-describedby")).toBeNull();
  });

  it("waits, read-only and empty, until the shelf and the copies are in", () => {
    setup([{ card: ELLY, copies: undefined }]);
    expect(field().value).toBe("");
    expect(field().readOnly).toBe(true);
  });

  it("waits for the shelf too", () => {
    setup([{ card: ELLY, copies: [line()] }], { shelf: null });
    expect(field().readOnly).toBe(true);
  });

  it("takes digits only, four at most (one past the cap, so 1000 is never cut to 100)", () => {
    setup();
    type(field(), "1a2b3c4d5");
    expect(field().value).toBe("1234");
  });

  it("is a numeric field with a Next key on a phone", () => {
    setup();
    expect(field().getAttribute("inputmode")).toBe("numeric");
    expect(field().getAttribute("enterkeyhint")).toBe("next");
  });
});

describe("committing", () => {
  it("leaving the field writes the new number once, into the target box", async () => {
    const rig = setup();
    type(field(), "5");
    fireEvent.blur(field());
    await flush();
    expect(rig.setBoxQuantity).toHaveBeenCalledTimes(1);
    expect(rig.setBoxQuantity).toHaveBeenCalledWith(ELLY, expect.objectContaining({ id: "unsorted", name: "Unsorted" }), 5);
  });

  it("says what changed on the status line with the write's Undo, and shows the check", async () => {
    const undo = vi.fn(async () => {});
    const rig = setup(undefined, { write: async (_c, _b, q) => ({ before: 2, after: q, undo }) });
    type(field(), "5");
    fireEvent.blur(field());
    await flush();
    expect(rig.api.notify).toHaveBeenCalledWith("Boxed 3 more of #12 Elly De La Cruz. 5 in Unsorted.", undo);
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("says a lowering as pulled copies", async () => {
    const rig = setup(undefined, { write: async (_c, _b, q) => ({ before: 2, after: q, undo: async () => {} }) });
    type(field(), "0");
    fireEvent.blur(field());
    await flush();
    expect(rig.api.notify).toHaveBeenCalledWith("Pulled 2 of #12 Elly De La Cruz from Unsorted. 0 left.", expect.any(Function));
  });

  it("the same number writes nothing and says nothing", async () => {
    const rig = setup();
    type(field(), "2");
    fireEvent.blur(field());
    await flush();
    expect(rig.setBoxQuantity).not.toHaveBeenCalled();
    expect(rig.api.notify).not.toHaveBeenCalled();
    expect(field().value).toBe("2");
  });

  it("clicking in and out of the field untouched writes nothing", async () => {
    const rig = setup();
    field().focus();
    fireEvent.blur(field());
    await flush();
    expect(rig.setBoxQuantity).not.toHaveBeenCalled();
  });

  it("a blank field puts its number back, writes nothing, and says so once on the status line", async () => {
    const rig = setup();
    type(field(), "");
    fireEvent.blur(field());
    await flush();
    expect(rig.setBoxQuantity).not.toHaveBeenCalled();
    expect(field().value).toBe("2");
    // An aside, never a notice: it must not replace a live Undo.
    expect(rig.api.notify).not.toHaveBeenCalled();
    expect(rig.api.inform).toHaveBeenCalledTimes(1);
    expect(rig.api.inform).toHaveBeenCalledWith(BLANK_MESSAGE);
  });

  it("a number past the cap is refused in the server's words: nothing written, the number put back", async () => {
    const rig = setup();
    type(field(), "1000");
    expect(field().value).toBe("1000");
    fireEvent.blur(field());
    await flush();
    expect(rig.setBoxQuantity).not.toHaveBeenCalled();
    expect(field().value).toBe("2");
    expect(screen.getByText("Didn't save: Quantity is a whole number from 0 to 999. Back to 2.")).toBeTruthy();
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(rig.api.notify).toHaveBeenCalledTimes(1);
    expect(rig.api.notify).toHaveBeenCalledWith("#12 Elly De La Cruz didn't change. Quantity is a whole number from 0 to 999.");
    // The cap itself still writes.
    type(field(), "999");
    expect(field().getAttribute("aria-invalid")).toBeNull();
    fireEvent.blur(field());
    await flush();
    expect(rig.setBoxQuantity).toHaveBeenCalledTimes(1);
    expect(rig.setBoxQuantity.mock.calls[0][2]).toBe(999);
  });

  it("shows a dot while the write is on its way, and holds the typed number until it lands", async () => {
    let land!: () => void;
    const rig = setup(undefined, {
      write: (_c, _b, q) => new Promise((resolve) => (land = () => resolve({ before: 2, after: q, undo: async () => {} }))),
    });
    type(field(), "4");
    fireEvent.blur(field());
    await flush();
    expect(screen.getByText("Saving")).toBeTruthy();
    expect(field().value).toBe("4");
    await act(async () => land());
    expect(screen.queryByText("Saving")).toBeNull();
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(rig.api.notify).toHaveBeenCalled();
  });

  it("a refusal shows the reason on the row, puts the old number back, and says it on the status line", async () => {
    const rig = setup(undefined, { write: async () => Promise.reject(new Error("That box is gone.")) });
    type(field(), "7");
    fireEvent.blur(field());
    await flush();
    expect(field().value).toBe("2");
    expect(screen.getByText(/Didn't save:.*That box is gone\..*Back to 2\./)).toBeTruthy();
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(rig.api.notify).toHaveBeenCalledWith(expect.stringContaining("didn't change"));
    // Typing again clears the complaint.
    type(field(), "3");
    expect(field().getAttribute("aria-invalid")).toBeNull();
  });

  it("two quick commits go out in the order they were made, the second never passing the first", async () => {
    const order: number[] = [];
    let first!: () => void;
    const rig = setup(undefined, {
      write: (_c, _b, q) => {
        order.push(q);
        if (order.length === 1) return new Promise((resolve) => (first = () => resolve({ before: 2, after: q, undo: async () => {} })));
        return Promise.resolve({ before: order[0], after: q, undo: async () => {} });
      },
    });
    type(field(), "5");
    fireEvent.blur(field());
    type(field(), "8");
    fireEvent.blur(field());
    await flush();
    // The queue holds the second behind the first.
    expect(rig.setBoxQuantity).toHaveBeenCalledTimes(1);
    await act(async () => first());
    await flush();
    expect(order).toEqual([5, 8]);
    expect(rig.setBoxQuantity).toHaveBeenCalledTimes(2);
  });

  it("a failed write does not stall the one queued behind it", async () => {
    let n = 0;
    const rig = setup(
      [
        { card: ELLY, copies: [line()] },
        { card: CHASE, copies: [line({ id: "c2", cardId: CHASE.id })] },
      ],
      {
        write: async (_c, _b, q) => {
          n += 1;
          if (n === 1) throw new Error("nope");
          return { before: 2, after: q, undo: async () => {} };
        },
      },
    );
    const [a, b] = fields();
    type(a, "5");
    fireEvent.blur(a);
    type(b, "6");
    fireEvent.blur(b);
    await flush();
    await flush();
    expect(rig.setBoxQuantity).toHaveBeenCalledTimes(2);
    expect(rig.setBoxQuantity.mock.calls[1].slice(0, 1)).toEqual([CHASE]);
    expect(rig.setBoxQuantity.mock.calls[1][2]).toBe(6);
  });
});

describe("the keyboard", () => {
  const rows = () => [
    { card: ELLY, copies: [line()] },
    { card: CHASE, copies: [line({ id: "c2", cardId: CHASE.id, quantity: 4 })] },
  ];

  it("Enter commits the field and moves to the next row's field", async () => {
    const rig = setup(rows());
    const [a, b] = fields();
    a.focus();
    type(a, "9");
    fireEvent.keyDown(a, { key: "Enter" });
    expect(document.activeElement).toBe(b);
    // Moving the focus is what blurs it in a browser.
    fireEvent.blur(a);
    await flush();
    expect(rig.setBoxQuantity).toHaveBeenCalledWith(ELLY, expect.anything(), 9);
  });

  it("Shift+Enter moves to the row above", () => {
    setup(rows());
    const [a, b] = fields();
    b.focus();
    fireEvent.keyDown(b, { key: "Enter", shiftKey: true });
    expect(document.activeElement).toBe(a);
  });

  it("Enter on the last row commits in place, with nowhere to go", async () => {
    const rig = setup(rows());
    const [, b] = fields();
    b.focus();
    type(b, "6");
    fireEvent.keyDown(b, { key: "Enter" });
    await flush();
    expect(rig.setBoxQuantity).toHaveBeenCalledWith(CHASE, expect.anything(), 6);
  });

  it("Escape puts back what was there, in place, and writes nothing", async () => {
    const rig = setup();
    field().focus();
    type(field(), "9");
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(field().value).toBe("2");
    fireEvent.blur(field());
    await flush();
    expect(rig.setBoxQuantity).not.toHaveBeenCalled();
  });

  it("Ctrl/Cmd+Z with nothing typed takes back the last count; with something typed it stays the field's own undo", () => {
    const rig = setup();
    field().focus();
    fireEvent.keyDown(field(), { key: "z", ctrlKey: true });
    expect(rig.api.undoLast).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(field(), { key: "z", metaKey: true });
    expect(rig.api.undoLast).toHaveBeenCalledTimes(2);
    type(field(), "9");
    fireEvent.keyDown(field(), { key: "z", ctrlKey: true });
    expect(rig.api.undoLast).toHaveBeenCalledTimes(2);
  });

  it("Ctrl+Shift+Z is not an undo", () => {
    const rig = setup();
    fireEvent.keyDown(field(), { key: "z", ctrlKey: true, shiftKey: true });
    expect(rig.api.undoLast).not.toHaveBeenCalled();
  });

  it("the field is the row's only Tab stop: Details and Checklist are reached with the arrows", () => {
    setup(undefined, { checklist: true });
    expect(field().tabIndex).toBe(0);
    expect(screen.getByRole("button", { name: /^Details for / }).tabIndex).toBe(-1);
    expect(screen.getByRole("button", { name: /^Open the checklist for / }).tabIndex).toBe(-1);
  });

  it("→ at the end of the field moves to Details, and ← comes back", () => {
    setup();
    const details = screen.getByRole("button", { name: /^Details for / });
    field().focus();
    field().setSelectionRange(1, 1);
    fireEvent.keyDown(field(), { key: "ArrowRight" });
    expect(document.activeElement).toBe(details);
    fireEvent.keyDown(details, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(field());
  });

  it("→ in the middle of a typed number moves the caret, not the focus", () => {
    setup();
    type(field(), "12");
    field().focus();
    field().setSelectionRange(0, 0);
    fireEvent.keyDown(field(), { key: "ArrowRight" });
    expect(document.activeElement).toBe(field());
  });

  it("→ walks field, then Checklist, then Details; ← walks back, and the ends stay put", () => {
    setup(undefined, { checklist: true });
    const checklist = screen.getByRole("button", { name: /^Open the checklist for / });
    const details = screen.getByRole("button", { name: /^Details for / });
    field().focus();
    field().setSelectionRange(1, 1);
    fireEvent.keyDown(field(), { key: "ArrowRight" });
    expect(document.activeElement).toBe(checklist);
    fireEvent.keyDown(checklist, { key: "ArrowRight" });
    expect(document.activeElement).toBe(details);
    fireEvent.keyDown(details, { key: "ArrowRight" });
    expect(document.activeElement).toBe(details);
    fireEvent.keyDown(details, { key: "ArrowLeft" });
    fireEvent.keyDown(checklist, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(field());
    fireEvent.keyDown(field(), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(field());
  });
});

describe("the + beside the field", () => {
  const plus = (name: string | RegExp = /^Add one /) => screen.getByRole("button", { name }) as HTMLButtonElement;
  /** What Tab walks, in document order: what a browser's sequential focus visits. */
  const tabbable = () =>
    [...document.querySelectorAll<HTMLElement>("input, button, select, textarea, a[href], [tabindex]")].filter(
      (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled,
    );

  it("is named for the card and the box, as the field is", () => {
    setup();
    expect(plus().getAttribute("aria-label")).toBe("Add one #12 Elly De La Cruz to Unsorted");
    // No title: it would be read again as the button's description.
    expect(plus().hasAttribute("title")).toBe(false);
    // Right after the field, before what else the box holds and Details.
    const details = screen.getByRole("button", { name: /^Details for / });
    expect(field().compareDocumentPosition(plus()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(plus().compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("boxes one more through the field's own write, shows the new number, and says it on the status line with Undo", async () => {
    let land!: () => void;
    const undo = vi.fn(async () => {});
    const rig = setup(undefined, {
      write: (_c, _b, q) => new Promise((resolve) => (land = () => resolve({ before: 2, after: q, undo }))),
    });
    fireEvent.click(plus());
    await flush();
    expect(rig.setBoxQuantity).toHaveBeenCalledTimes(1);
    expect(rig.setBoxQuantity).toHaveBeenCalledWith(ELLY, expect.objectContaining({ id: "unsorted" }), 3);
    expect(field().value).toBe("3");
    expect(screen.getByText("Saving")).toBeTruthy();
    await act(async () => land());
    expect(rig.api.notify).toHaveBeenCalledWith("Boxed 1 more of #12 Elly De La Cruz. 3 in Unsorted.", undo);
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("two quick clicks make two more: the second builds on the first while it is still on its way", async () => {
    const lands: (() => void)[] = [];
    const rig = setup(undefined, {
      write: (_c, _b, q) => new Promise((resolve) => lands.push(() => resolve({ before: q - 1, after: q, undo: async () => {} }))),
    });
    fireEvent.click(plus());
    fireEvent.click(plus());
    await flush();
    expect(field().value).toBe("4");
    // The queue holds the second behind the first.
    expect(rig.setBoxQuantity).toHaveBeenCalledTimes(1);
    await act(async () => lands[0]());
    await flush();
    expect(rig.setBoxQuantity).toHaveBeenCalledTimes(2);
    expect(rig.setBoxQuantity.mock.calls.map((c) => c[2])).toEqual([3, 4]);
    await act(async () => lands[1]());
    expect(rig.api.notify).toHaveBeenLastCalledWith("Boxed 1 more of #12 Elly De La Cruz. 4 in Unsorted.", expect.any(Function));
  });

  it("writes a typed number first, then one more on top of it", async () => {
    const rig = setup();
    type(field(), "5");
    fireEvent.click(plus());
    await flush();
    expect(rig.setBoxQuantity.mock.calls.map((c) => c[2])).toEqual([5, 6]);
  });

  it("at 999 refuses in the cap's words and writes nothing", async () => {
    const rig = setup([{ card: ELLY, copies: [line({ quantity: 999 })] }]);
    fireEvent.click(plus());
    await flush();
    expect(rig.setBoxQuantity).not.toHaveBeenCalled();
    expect(field().value).toBe("999");
    expect(screen.getByText("Didn't save: Quantity is a whole number from 0 to 999. Back to 999.")).toBeTruthy();
    expect(rig.api.notify).toHaveBeenCalledWith("#12 Elly De La Cruz didn't change. Quantity is a whole number from 0 to 999.");
  });

  it("adds nothing to a typed number the cap refused", async () => {
    const rig = setup();
    type(field(), "1000");
    fireEvent.click(plus());
    await flush();
    expect(rig.setBoxQuantity).not.toHaveBeenCalled();
    expect(field().value).toBe("2");
    expect(rig.api.notify).toHaveBeenCalledTimes(1);
  });

  it("is never a Tab stop: Tab from one field lands on the next row's field", () => {
    setup([
      { card: ELLY, copies: [line()] },
      { card: CHASE, copies: [line({ id: "c2", cardId: CHASE.id })] },
    ]);
    const [a, b] = fields();
    expect(plus(/^Add one #12 /).tabIndex).toBe(-1);
    expect(tabbable()).toEqual([a, b]);
  });

  it("is not on the row's arrows: → from the field still reaches Details", () => {
    setup();
    field().focus();
    field().setSelectionRange(1, 1);
    fireEvent.keyDown(field(), { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Details for / }));
  });

  it("keeps the focus where it was: pressing it never pulls the focus off a field", () => {
    setup();
    field().focus();
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    plus().dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it("waits, like the field, until the shelf and the copies are in", () => {
    setup([{ card: ELLY, copies: undefined }]);
    expect(plus().disabled).toBe(true);
  });
});

describe("the row's other controls", () => {
  it("Details opens the card on the row's first line in the box", () => {
    const rig = setup([{ card: ELLY, copies: [line({ id: "first" }), line({ id: "second", slot: 2 })] }]);
    fireEvent.click(screen.getByRole("button", { name: "Details for #12 Elly De La Cruz" }));
    expect(rig.onOpen).toHaveBeenCalledWith("first");
  });

  it("Details with no line in the box opens the card on no line", () => {
    const rig = setup([{ card: ELLY, copies: [] }]);
    fireEvent.click(screen.getByRole("button", { name: /^Details for / }));
    expect(rig.onOpen).toHaveBeenCalledWith(undefined);
  });

  it("clicking the row puts the caret in its field", () => {
    setup();
    const row = field().closest("li")!;
    // The number shows twice in the DOM: its own column from sm up, and on
    // the player's line on a phone (CSS hides one). Either is the row's body.
    fireEvent.click(within(row).getAllByText("#12")[0]);
    expect(document.activeElement).toBe(field());
  });

  it("Checklist (a search hit) opens the card's checklist without touching the field", () => {
    const rig = setup(undefined, { checklist: true });
    fireEvent.click(screen.getByRole("button", { name: /^Open the checklist for / }));
    expect(rig.onOpenChecklist).toHaveBeenCalledTimes(1);
    expect(rig.setBoxQuantity).not.toHaveBeenCalled();
  });
});

describe("the status line's words", () => {
  const unsorted = { name: "Unsorted" };
  it("says a raise, a lowering and no change", () => {
    expect(quantityMessage("#1 A", unsorted, { before: 0, after: 3 })).toBe("Boxed 3 more of #1 A. 3 in Unsorted.");
    expect(quantityMessage("#1 A", unsorted, { before: 5, after: 2 })).toBe("Pulled 3 of #1 A from Unsorted. 2 left.");
    expect(quantityMessage("#1 A", unsorted, { before: 2, after: 2 })).toBe("#1 A stays at 2 in Unsorted.");
  });
});

describe("a row that outlives its own commit", () => {
  it("keeps the typed number for the box it was typed for when the target box changes", () => {
    function Harness() {
      const [copies] = useState([line({ quantity: 2 })]);
      return <QuantityRow card={ELLY} copies={copies} onOpen={() => {}} />;
    }
    const undo = vi.fn();
    void undo;
    // The target is the URL's box: a row mounted for `show` reads that box's copies, not Unsorted's.
    render(
      <Theme>
        <MemoryRouter initialEntries={["/inventory?tab=checklists&box=show"]}>
          <CollectionStoreContext.Provider
            value={
              {
                kind: "convex",
                capabilities: REAL_CAPABILITIES,
                data: { useContainers: () => SHELF, useDemoExtension: () => undefined, useDefaultCondition: () => "Excellent" },
                actions: { setBoxQuantity: vi.fn() },
              } as unknown as CollectionStoreValue
            }
          >
            <CollectionModeProvider mode="app" surface="inventory">
              <PageApiContext.Provider
                value={{ openCard: vi.fn(), goToChecklists: vi.fn(), openSuggestion: vi.fn(), notify: vi.fn(), inform: vi.fn(), undoLast: vi.fn(), run: vi.fn() }}
              >
                <QuickEntryProvider>
                  <ul>
                    <Harness />
                  </ul>
                </QuickEntryProvider>
              </PageApiContext.Provider>
            </CollectionModeProvider>
          </CollectionStoreContext.Provider>
        </MemoryRouter>
      </Theme>,
    );
    // The card's 2 copies are in Unsorted; the target is the Show box, so the field reads 0.
    expect(field().value).toBe("0");
    expect(field().getAttribute("aria-label")).toBe("Quantity of #12 Elly De La Cruz in Show box");
  });
});
