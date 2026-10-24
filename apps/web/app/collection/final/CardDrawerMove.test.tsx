import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Theme } from "@radix-ui/themes";
import PublicCollectionDemo from "./PublicCollectionDemo";
import { initialCollectionState, MAIN_BINDER_ID, PUBLIC_STORAGE_KEY } from "./store";

/**
 * NEO-359 — a line item's Move, Sell and Take off sale panels in the drawer,
 * on the public demo (fixture data; the Convex client module is mocked
 * EMPTY, so reaching for it would throw). The collection and Inventory never
 * mix in one pick: Move goes binder to binder (or box to box), Sell picks a
 * box, Take off sale picks the binder it goes back into. All of a line or
 * part of a stack, the keyboard coming back to the button that opened the
 * panel (or to the twin's, once a move folds the line away).
 */
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false }) }));
vi.mock("convex/react", () => ({}));

const DEMO = "/binder-tracking?demo=on";
/** The seed's one stack of three: raw copies in the Show box (for sale). */
const STACK = initialCollectionState().copies.find((c) => c.quantity === 3)!;
/** How many line items the drawer shows for that card to start with. */
const LINES = initialCollectionState().copies.filter((c) => c.cardId === STACK.cardId).length;

function renderDrawer() {
  render(
    <Theme>
      <MemoryRouter initialEntries={[`${DEMO}&tab=cards&detail=${STACK.cardId}`]}>
        <Routes>
          <Route path="/binder-tracking" element={<PublicCollectionDemo onExit={vi.fn()} keepParams={{ demo: "on" }} />} />
        </Routes>
      </MemoryRouter>
    </Theme>,
  );
  return screen.getByRole("dialog");
}

const frames = () => act(() => new Promise<void>((r) => setTimeout(r, 40)));
const lines = (drawer: HTMLElement) => within(within(drawer).getByRole("region", { name: /^Your copies of / })).getAllByRole("listitem");
/** The stack of three's Take off sale / Sell button (its line id is stable through a split). */
const stackSell = (drawer: HTMLElement) =>
  within(drawer)
    .getAllByRole("button", { name: /^(Take #.+ off sale|Sell #.+)$/ })
    .find((b) => b.getAttribute("data-copy-sell") === STACK.id)!;
const status = (re: RegExp) => screen.getAllByRole("status").some((s) => re.test(s.textContent ?? ""));
const optionsOf = (select: HTMLElement) => within(select).getAllByRole("option").map((o) => o.textContent);

beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

/** Takes `count` of the stack off sale into the slab case. */
async function takeOff(drawer: HTMLElement, count: number, source = stackSell(drawer)) {
  fireEvent.click(source);
  const panel = within(drawer).getByRole("form", { name: /^Take .+ off sale$/ });
  fireEvent.change(within(panel).getByRole("combobox", { name: "Back into" }), { target: { value: "binder-slab-case" } });
  const qty = within(panel).queryByRole("spinbutton", { name: "Quantity to take back" });
  if (qty) fireEvent.change(qty, { target: { value: String(count) } });
  fireEvent.click(within(panel).getByRole("button", { name: /^Take (\d+|it) off sale$/ }));
}

describe("the drawer's Move, Sell and Take off sale", () => {
  it("a line in a box has Take off sale, not Move, and it picks a binder only", () => {
    const drawer = renderDrawer();
    const stackMove = () =>
      within(drawer)
        .queryAllByRole("button", { name: /^Move #/ })
        .find((b) => b.getAttribute("data-copy-move") === STACK.id);
    // It is the only box, so the line has nowhere to Move to.
    expect(stackMove()).toBeUndefined();
    const button = stackSell(drawer);
    expect(button.textContent).toBe("Take off sale");
    expect(within(drawer).getAllByText(/^For sale · Show box$/).length).toBeGreaterThan(0);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const panel = within(drawer).getByRole("form", { name: /^Take .+ off sale$/ });
    const to = within(panel).getByRole("combobox", { name: "Back into" });
    expect(document.activeElement).toBe(to);
    // Binders only: never a box, the Want List or Up for Trade.
    const options = optionsOf(to);
    expect(options.join("|")).not.toMatch(/box|Want List|Up for Trade/i);
    expect(options).toContain("Main");
    expect(options).toContain("Slab case");
  });

  it("asks how many on a stack, all of them to start, and refuses a number outside 1 to the stack", () => {
    const drawer = renderDrawer();
    fireEvent.click(stackSell(drawer));
    const panel = within(drawer).getByRole("form", { name: /^Take .+ off sale$/ });
    const qty = within(panel).getByRole("spinbutton", { name: "Quantity to take back" }) as HTMLInputElement;
    expect(qty.value).toBe("3");
    const go = () => within(panel).getByRole("button", { name: /^Take (\d+|it) off sale$/ });
    expect(go().textContent).toBe("Take 3 off sale");

    // The button stays focusable (aria-disabled) and a press while invalid moves nothing.
    fireEvent.change(qty, { target: { value: "0" } });
    expect(go().getAttribute("aria-disabled")).toBe("true");
    expect(within(panel).getByText("Pick 1 to 3.")).toBeTruthy();
    fireEvent.click(go());
    expect(within(drawer).getByRole("form", { name: /^Take .+ off sale$/ })).toBeTruthy();
    expect(status(/off sale/)).toBe(false);
    fireEvent.change(qty, { target: { value: "4" } });
    expect(go().getAttribute("aria-disabled")).toBe("true");
    fireEvent.change(qty, { target: { value: "2" } });
    expect(go().getAttribute("aria-disabled")).toBeNull();
    expect(go().textContent).toBe("Take 2 off sale");
  });

  it("splits a stack: the box keeps the rest, the part lands in the binder, and the keyboard returns to Take off sale", async () => {
    const drawer = renderDrawer();
    expect(lines(drawer)).toHaveLength(LINES);
    await takeOff(drawer, 2);
    await waitFor(() => expect(lines(drawer)).toHaveLength(LINES + 1));
    await frames();

    expect(status(/^Took 2 of #.+ off sale\. They're back in Slab case\.$/)).toBe(true);
    const kept = stackSell(drawer);
    expect(kept.textContent).toBe("Take off sale");
    expect(within(drawer).getByText(/×2/)).toBeTruthy();
    expect(document.activeElement).toBe(kept);
    expect(within(drawer).queryByRole("form", { name: /off sale$/ })).toBeNull();
  });

  it("taking the rest off into the line already there folds them, and the keyboard goes to that twin's Move button", async () => {
    const drawer = renderDrawer();
    await takeOff(drawer, 1);
    await waitFor(() => expect(lines(drawer)).toHaveLength(LINES + 1));
    await frames();

    // The two left in the box now go to the same slab case: they fold into the one already there.
    await takeOff(drawer, 2);
    await waitFor(() => expect(lines(drawer)).toHaveLength(LINES));
    await frames();

    expect(status(/stacked with the ones already there/)).toBe(true);
    const stack = within(drawer).getByText(/×3/).closest("li")!;
    const twin = within(stack).getByRole("button", { name: /^Move #/ });
    expect(twin.getAttribute("data-copy-move")).not.toBe(STACK.id);
    expect(document.activeElement).toBe(twin);
  });

  it("a binder's line moves to another binder only, and Sell puts it in a box", async () => {
    const drawer = renderDrawer();
    await takeOff(drawer, 3);
    await waitFor(() => expect(stackSell(drawer).textContent).toBe("Sell"));
    await frames();

    // Move: binders only.
    const move = within(drawer)
      .getAllByRole("button", { name: /^Move #/ })
      .find((b) => b.getAttribute("data-copy-move") === STACK.id)!;
    fireEvent.click(move);
    const movePanel = within(drawer).getByRole("form", { name: /^Move / });
    const options = optionsOf(within(movePanel).getByRole("combobox", { name: "Move to" }));
    expect(options.join("|")).not.toMatch(/box|Slab case|Want List|Up for Trade/i);
    expect(options).toContain("Main");
    fireEvent.click(within(movePanel).getByRole("button", { name: "Keep it here" }));
    await frames();
    expect(document.activeElement).toBe(move);

    // Sell: boxes only, and the line reads For sale once it lands.
    const sell = stackSell(drawer);
    expect(sell.textContent).toBe("Sell");
    fireEvent.click(sell);
    const sellPanel = within(drawer).getByRole("form", { name: /^Sell / });
    expect(optionsOf(within(sellPanel).getByRole("combobox", { name: "Into which box" }))).toEqual(["Show box"]);
    expect(within(sellPanel).getByText("Everything in a box is for sale. Boxes live on Inventory.")).toBeTruthy();
    fireEvent.click(within(sellPanel).getByRole("button", { name: "Put 3 up for sale" }));
    await waitFor(() => expect(status(/^#.+ are up for sale in Show box\.$/)).toBe(true));
    await frames();
    expect(within(drawer).getAllByText(/^For sale · Show box$/).length).toBeGreaterThan(0);
  });

  it("Escape and Leave it for sale close the panel and leave the card where it is, the keyboard on the button", async () => {
    const drawer = renderDrawer();
    const button = stackSell(drawer);
    fireEvent.click(button);
    fireEvent.keyDown(within(drawer).getByRole("form", { name: /off sale$/ }), { key: "Escape" });
    await frames();
    expect(within(drawer).queryByRole("form", { name: /off sale$/ })).toBeNull();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    fireEvent.click(within(drawer).getByRole("button", { name: "Leave it for sale" }));
    await frames();
    expect(within(drawer).queryByRole("form", { name: /off sale$/ })).toBeNull();
    expect(lines(drawer)).toHaveLength(LINES);
    expect(status(/off sale/)).toBe(false);
  });

  it("Sell with no box yet says how to make one, and goes to the demo's Inventory tab", async () => {
    // The demo with its boxes gone: every copy back in Main.
    const seed = initialCollectionState();
    const boxes = new Set(seed.containers.filter((c) => c.kind === "box").map((c) => c.id));
    const state = {
      ...seed,
      containers: seed.containers.filter((c) => !boxes.has(c.id)),
      copies: seed.copies.map((c) => (boxes.has(c.homeId) ? { ...c, homeId: MAIN_BINDER_ID, row: undefined, slot: undefined } : c)),
    };
    window.sessionStorage.setItem(PUBLIC_STORAGE_KEY, JSON.stringify(state));
    const drawer = renderDrawer();
    fireEvent.click(stackSell(drawer));
    const group = within(drawer).getByRole("group", { name: /^Sell / });
    expect(within(group).getByText("No boxes yet, so there's nowhere to sell it from.")).toBeTruthy();
    expect(within(group).getByText("Make a box on Inventory, then come back and press Sell.")).toBeTruthy();
    const link = within(group).getByRole("link", { name: "Go to Inventory" });
    await frames();
    expect(document.activeElement).toBe(link);
    expect(link.getAttribute("href")).toBe("/binder-tracking?demo=on&tab=inventory");
  });
});
