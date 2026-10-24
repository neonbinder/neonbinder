import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Theme } from "@radix-ui/themes";
import PublicCollectionDemo from "./PublicCollectionDemo";
import { initialCollectionState } from "./store";

/**
 * NEO-359 — the drawer's Move panel on a line item, on the public demo (fixture
 * data; the Convex client module is mocked EMPTY, so reaching for it would
 * throw): move all of a line or part of a stack, the keyboard coming back to
 * the line's Move button (or to the twin's, once a move folds the line away),
 * and a box as the sale table.
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
const moveButtons = (drawer: HTMLElement) => within(drawer).getAllByRole("button", { name: /^Move #/ });
/** The Move button of the stack of three (its line id is stable through a split). */
const stackMove = (drawer: HTMLElement) =>
  moveButtons(drawer).find((b) => b.getAttribute("data-copy-move") === STACK.id)!;
const status = (re: RegExp) => screen.getAllByRole("status").some((s) => re.test(s.textContent ?? ""));

beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("the drawer's Move panel", () => {
  it("offers Move on a line when there is somewhere else to go, and opens on the destination pick", () => {
    const drawer = renderDrawer();
    const button = stackMove(drawer);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const panel = within(drawer).getByRole("form", { name: /^Move / });
    const to = within(panel).getByRole("combobox", { name: "Move to" }) as HTMLSelectElement;
    expect(document.activeElement).toBe(to);
    // Every other home, never the one it is in, the Want List or Up for Trade.
    const options = within(to).getAllByRole("option").map((o) => o.textContent);
    expect(options.join("|")).not.toMatch(/Show box|Want List|Up for Trade/);
    expect(options).toContain("Main");
    expect(options).toContain("Slab case");
  });

  it("asks how many on a stack, all of them to start, and refuses a number outside 1 to the stack", () => {
    const drawer = renderDrawer();
    fireEvent.click(stackMove(drawer));
    const panel = within(drawer).getByRole("form", { name: /^Move / });
    const qty = within(panel).getByRole("spinbutton", { name: "Quantity to move" }) as HTMLInputElement;
    expect(qty.value).toBe("3");
    const go = () => within(panel).getByRole("button", { name: /^Move( \d+|\sit)$/ });
    expect(go().textContent).toBe("Move 3");

    // The button stays focusable (aria-disabled) and a press while invalid moves nothing.
    fireEvent.change(qty, { target: { value: "0" } });
    expect(go().getAttribute("aria-disabled")).toBe("true");
    expect(within(panel).getByText("Pick 1 to 3.")).toBeTruthy();
    fireEvent.click(go());
    expect(within(drawer).getByRole("form", { name: /^Move / })).toBeTruthy();
    expect(status(/Moved/)).toBe(false);
    fireEvent.change(qty, { target: { value: "4" } });
    expect(go().getAttribute("aria-disabled")).toBe("true");
    fireEvent.change(qty, { target: { value: "2" } });
    expect(go().getAttribute("aria-disabled")).toBeNull();
    expect(go().textContent).toBe("Move 2");
  });

  it("splits a stack: the line keeps the rest, the part lands in the destination, and the keyboard returns to the line's Move button", async () => {
    const drawer = renderDrawer();
    expect(lines(drawer)).toHaveLength(LINES);
    const source = stackMove(drawer);
    const sourceId = source.getAttribute("data-copy-move");
    fireEvent.click(source);
    const panel = within(drawer).getByRole("form", { name: /^Move / });
    fireEvent.change(within(panel).getByRole("combobox", { name: "Move to" }), { target: { value: "binder-slab-case" } });
    fireEvent.change(within(panel).getByRole("spinbutton", { name: "Quantity to move" }), { target: { value: "2" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Move 2" }));
    await waitFor(() => expect(lines(drawer)).toHaveLength(LINES + 1));
    await frames();

    expect(status(/^Moved 2 of #.+ to Slab case\. Off the sale table\.$/)).toBe(true);
    const kept = moveButtons(drawer).find((b) => b.getAttribute("data-copy-move") === sourceId)!;
    expect(kept).toBeTruthy();
    expect(within(drawer).getByText(/×2/)).toBeTruthy();
    expect(document.activeElement).toBe(kept);
    // The panel is closed.
    expect(within(drawer).queryByRole("form", { name: /^Move / })).toBeNull();
  });

  it("moving the rest of a split into the line already there folds them, and the keyboard goes to that twin's Move button", async () => {
    const drawer = renderDrawer();
    const move = async (count: number, source: HTMLElement) => {
      fireEvent.click(source);
      const panel = within(drawer).getByRole("form", { name: /^Move / });
      fireEvent.change(within(panel).getByRole("combobox", { name: "Move to" }), { target: { value: "binder-slab-case" } });
      const qty = within(panel).queryByRole("spinbutton", { name: "Quantity to move" });
      if (qty) fireEvent.change(qty, { target: { value: String(count) } });
      fireEvent.click(within(panel).getByRole("button", { name: /^Move( \d+|\sit)$/ }));
    };
    const sourceId = stackMove(drawer).getAttribute("data-copy-move");
    await move(1, stackMove(drawer));
    await waitFor(() => expect(lines(drawer)).toHaveLength(LINES + 1));
    await frames();

    // The two left in Main now go to the same slab case: they fold into the one already there.
    const rest = moveButtons(drawer).find((b) => b.getAttribute("data-copy-move") === sourceId)!;
    await move(2, rest);
    await waitFor(() => expect(lines(drawer)).toHaveLength(LINES));
    await frames();

    expect(status(/stacked with the ones already there/)).toBe(true);
    const stack = within(drawer).getByText(/×3/).closest("li")!;
    const twin = within(stack).getByRole("button", { name: /^Move #/ });
    expect(twin.getAttribute("data-copy-move")).not.toBe(sourceId);
    expect(document.activeElement).toBe(twin);
  });

  it("into a box says it goes up for sale, and names the sale table before it is done", async () => {
    const drawer = renderDrawer();
    // Out of the box into Main first: off the sale table, and the badge goes.
    expect(within(drawer).getAllByText("For sale").length).toBeGreaterThan(0);
    fireEvent.click(stackMove(drawer));
    let panel = within(drawer).getByRole("form", { name: /^Move / });
    expect(within(panel).getByText("Into a binder: these come off the sale table.")).toBeTruthy();
    fireEvent.change(within(panel).getByRole("combobox", { name: "Move to" }), { target: { value: "binder-main" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Move 3" }));
    await waitFor(() => expect(within(drawer).queryByText("For sale")).toBeNull());
    await frames();

    // And back in: the box is the sale table.
    fireEvent.click(stackMove(drawer));
    panel = within(drawer).getByRole("form", { name: /^Move / });
    fireEvent.change(within(panel).getByRole("combobox", { name: "Move to" }), { target: { value: "box-show" } });
    expect(within(panel).getByText("A box is the sale table: these go up for sale.")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Move 3" }));
    await waitFor(() => expect(status(/Moved #.+ to Show box\. They're for sale now\.$/)).toBe(true));
    await frames();
    expect(within(drawer).getAllByText("For sale").length).toBeGreaterThan(0);
  });

  it("Escape and Keep it here close the panel and leave the card where it is, the keyboard on the Move button", async () => {
    const drawer = renderDrawer();
    const button = stackMove(drawer);
    fireEvent.click(button);
    fireEvent.keyDown(within(drawer).getByRole("form", { name: /^Move / }), { key: "Escape" });
    await frames();
    expect(within(drawer).queryByRole("form", { name: /^Move / })).toBeNull();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    fireEvent.click(within(drawer).getByRole("button", { name: "Keep it here" }));
    await frames();
    expect(within(drawer).queryByRole("form", { name: /^Move / })).toBeNull();
    expect(lines(drawer)).toHaveLength(LINES);
    expect(status(/Moved/)).toBe(false);
  });
});
