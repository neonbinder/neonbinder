import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { Theme } from "@radix-ui/themes";
import PublicCollectionDemo from "./PublicCollectionDemo";

/**
 * NEO-358 accessibility pass, on the public demo (fixture data, no server):
 *
 * - the card drawer rides on the URL (`detail=<id>`): opening it is a Back
 *   step, ↑ ↓ replace it, Back closes it and leaves the view under it as it
 *   was, a shared link reopens it, and Close takes it off;
 * - the keyboard is parked, never dropped, when the control in use goes
 *   away (a run added, a copy saved, cancelled or removed);
 * - mutually exclusive chips are radio groups, and a wall tile's name never
 *   carries its state.
 */
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false }) }));
vi.mock("convex/react", () => ({}));

const DEMO = "/binder-tracking?demo=on";
const CHROME = "2024-topps-chrome-baseball";
const BASE_CHECKLIST = `${DEMO}&tab=checklists&set=${CHROME}&type=Base`;

function LocationProbe() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="Page URL">{pathname + search}</output>
      <button type="button" onClick={() => void navigate(-1)}>
        Browser Back
      </button>
    </>
  );
}

function renderDemo(entries: string[]) {
  render(
    <Theme>
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <Routes>
          <Route
            path="/binder-tracking"
            element={
              <>
                <PublicCollectionDemo onExit={vi.fn()} keepParams={{ demo: "on" }} />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </Theme>,
  );
}

const pageUrl = () => screen.getByRole("status", { name: "Page URL" }).textContent ?? "";
const back = () => fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
const checklist = () => screen.getByRole("region", { name: "2024 Topps Chrome Base" });
const detailsButtons = () => within(checklist()).getAllByRole("button", { name: /^Details for / });
/** Lets the requestAnimationFrame focus moves run. */
const frames = () => act(() => new Promise<void>((r) => setTimeout(r, 40)));

beforeEach(() => {
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("the card drawer on the URL", () => {
  it("opening pushes detail=<id>, ↑ ↓ replace it, and Back closes it without touching the view", () => {
    renderDemo([BASE_CHECKLIST]);
    // An in-view tweak that must survive the drawer: show Needs only.
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Show" })).getByRole("radio", { name: "Needs" }));
    const opener = detailsButtons()[0];
    fireEvent.click(opener);
    const opened = pageUrl();
    expect(opened).toMatch(new RegExp(`^${BASE_CHECKLIST.replace(/[?+]/g, "\\$&")}&detail=[^&]+$`));
    const drawer = screen.getByRole("dialog");

    // ↑ at the top of the list stays focusable and says it is unavailable.
    const prev = within(drawer).getByRole("button", { name: "Previous card" });
    expect(prev.hasAttribute("disabled")).toBe(false);
    expect(prev.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(prev);
    expect(pageUrl()).toBe(opened);

    // ↓ swaps the card in place and says where you are, focus left on the arrow.
    const next = within(drawer).getByRole("button", { name: "Next card" });
    next.focus();
    fireEvent.click(next);
    expect(pageUrl()).not.toBe(opened);
    expect(pageUrl()).toMatch(/&detail=[^&]+$/);
    expect(document.activeElement).toBe(next);
    expect(within(drawer).getAllByRole("status").some((s) => /^Card 2 of \d+, /.test(s.textContent ?? ""))).toBe(true);

    // One Back closes the drawer (not a step per card), back to the view as it was.
    back();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pageUrl()).toBe(BASE_CHECKLIST);
    expect(checklist()).toBeTruthy();
    expect(within(screen.getByRole("radiogroup", { name: "Show" })).getByRole("radio", { name: "Needs" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("Close steps Back off the entry the drawer pushed", () => {
    renderDemo([BASE_CHECKLIST]);
    fireEvent.click(detailsButtons()[0]);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close card detail" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pageUrl()).toBe(BASE_CHECKLIST);
  });

  it("a shared link reopens the drawer, its arrows quiet; Close takes it off the URL in place", () => {
    renderDemo([BASE_CHECKLIST]);
    fireEvent.click(detailsButtons()[1]);
    const shared = pageUrl();
    cleanup();

    renderDemo([shared]);
    const drawer = screen.getByRole("dialog");
    // No list came with the link: just this card, both arrows unavailable.
    expect(within(drawer).getByRole("button", { name: "Previous card" }).getAttribute("aria-disabled")).toBe("true");
    expect(within(drawer).getByRole("button", { name: "Next card" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(within(drawer).getByRole("button", { name: "Close card detail" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pageUrl()).toBe(BASE_CHECKLIST);
  });
});

describe("the keyboard is parked, never dropped", () => {
  it("Edit puts it in the copy's form; Cancel and Save copy bring it back to that copy's Edit", async () => {
    renderDemo([BASE_CHECKLIST]);
    fireEvent.click(detailsButtons()[0]);
    const drawer = screen.getByRole("dialog");
    // The demo's first card is already in hand.
    const edit = within(drawer).getAllByRole("button", { name: /^Edit / })[0];
    const editName = edit.getAttribute("aria-label")!;

    fireEvent.click(edit);
    const form = within(drawer).getByRole("form", { name: /^Edit / });
    await waitFor(() => expect(form.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe(editName));

    fireEvent.click(within(drawer).getByRole("button", { name: editName }));
    fireEvent.click(within(drawer).getByRole("button", { name: "Save copy" }));
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe(editName));
  });

  it("the add form waits behind Add once there is a copy: Add opens it, Cancel and an add fold it, the keyboard back on Add", async () => {
    renderDemo([BASE_CHECKLIST]);
    fireEvent.click(detailsButtons()[0]);
    const drawer = screen.getByRole("dialog");
    // The demo's first card is already in hand: the list, then Add, no form.
    expect(within(drawer).queryByRole("form", { name: /^Add (a|another) copy$/ })).toBeNull();
    const add = within(drawer).getByRole("button", { name: /^Add another copy of / });

    fireEvent.click(add);
    const form = within(drawer).getByRole("form", { name: "Add another copy" });
    await waitFor(() => expect(form.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(within(drawer).queryByRole("form", { name: "Add another copy" })).toBeNull();
    // Cancel folds the form; the drawer stays open.
    expect(screen.getByRole("dialog")).toBe(drawer);
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe(add.getAttribute("aria-label")));

    const edits = within(drawer).getAllByRole("button", { name: /^Edit / }).length;
    fireEvent.click(within(drawer).getByRole("button", { name: /^Add another copy of / }));
    const again = within(drawer).getByRole("form", { name: "Add another copy" });
    fireEvent.change(within(again).getByRole("textbox", { name: "Notes" }), { target: { value: "From the show" } });
    fireEvent.click(within(again).getByRole("button", { name: "Add to collection" }));
    await waitFor(() => expect(within(drawer).getAllByRole("button", { name: /^Edit / })).toHaveLength(edits + 1));
    expect(within(drawer).queryByRole("form", { name: "Add another copy" })).toBeNull();
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label") ?? "").toMatch(/^Add another copy of /));
  });

  it("Remove moves it to the next copy's Edit, and to the 'Your copies' heading after the last", async () => {
    renderDemo([BASE_CHECKLIST]);
    fireEvent.click(detailsButtons()[0]);
    const drawer = screen.getByRole("dialog");
    const removes = () => within(drawer).queryAllByRole("button", { name: /^Remove / });
    // Make sure there are two line items (a note keeps the new one from stacking).
    fireEvent.click(within(drawer).getByRole("button", { name: /^Add another copy of / }));
    const addForm = within(drawer).getByRole("form", { name: "Add another copy" });
    fireEvent.change(within(addForm).getByRole("textbox", { name: "Notes" }), { target: { value: "From the show" } });
    const before = removes().length;
    fireEvent.click(within(addForm).getByRole("button", { name: "Add to collection" }));
    await waitFor(() => expect(removes()).toHaveLength(before + 1));
    // The add folds away, the keyboard on Add.
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label") ?? "").toMatch(/^Add another copy of /));

    // Remove the first: the keyboard lands on the next copy's Edit.
    const nextEdit = within(drawer).getAllByRole("button", { name: /^Edit / })[1];
    removes()[0].focus();
    fireEvent.click(removes()[0]);
    await waitFor(() => expect(document.activeElement).toBe(nextEdit));

    // Remove the rest: after the last, the heading holds it.
    while (removes().length > 0) {
      const count = removes().length;
      removes()[0].focus();
      fireEvent.click(removes()[0]);
      await waitFor(() => expect(removes()).toHaveLength(count - 1));
      await frames();
    }
    await waitFor(() => expect(document.activeElement?.textContent).toMatch(/^Your copies/));
  });

  it("adding a run puts the caret back in the run box", async () => {
    renderDemo([`${DEMO}&tab=cards&set=${CHROME}`]);
    const box = screen.getByRole("textbox", { name: "Add a run of numbers" });
    // A number two cards share holds the run: leave each one out until it can go in.
    let text = "1-50";
    fireEvent.change(box, { target: { value: text } });
    for (let held = screen.queryByRole("button", { name: /^Pick your #/ }); held; held = screen.queryByRole("button", { name: /^Pick your #/ })) {
      text += `, -${/#(\S+) first/.exec(held.textContent ?? "")![1]}`;
      fireEvent.change(box, { target: { value: text } });
    }
    // The preview is one live region, named by the box.
    const preview = document.getElementById(box.getAttribute("aria-describedby")!.split(" ")[1])!;
    expect(preview.getAttribute("role")).toBe("status");
    expect(preview.textContent).toMatch(/^Adds \d+ cards? /);
    fireEvent.click(screen.getByRole("button", { name: /^Add \d+ cards?$/ }));
    expect(document.activeElement).toBe(box);
    expect((box as HTMLInputElement).value).toBe("");
  });

  it("text the run box cannot read is an alert, and the box says it is invalid", () => {
    renderDemo([`${DEMO}&tab=cards&set=${CHROME}`]);
    const box = screen.getByRole("textbox", { name: "Add a run of numbers" });
    fireEvent.change(box, { target: { value: "zzz" } });
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toMatch(/^Can't read that\./);
  });
});

describe("chips and tiles say state once", () => {
  it("the wall's chips are radio groups, and a tile's name never carries have or need", () => {
    renderDemo([`${DEMO}&tab=cards&set=${CHROME}`]);
    const show = screen.getByRole("radiogroup", { name: "Show on the wall" });
    const everything = within(show).getByRole("radio", { name: "Everything" });
    expect(everything.getAttribute("aria-checked")).toBe("true");
    expect(within(show).getAllByRole("radio").filter((r) => r.tabIndex === 0)).toEqual([everything]);

    const wall = screen.getByRole("group", { name: "2024 Topps Chrome checklist wall" });
    const tile = within(wall).getAllByRole("button", { pressed: false })[0];
    expect(tile.getAttribute("aria-label")).not.toMatch(/, (have|need)\b/);

    // "Open details": the tile is no longer a toggle, so its name says have or need.
    const clicking = screen.getByRole("radiogroup", { name: "Clicking a tile" });
    fireEvent.click(within(clicking).getByRole("radio", { name: "Open details" }));
    expect(tile.hasAttribute("aria-pressed")).toBe(false);
    expect(tile.getAttribute("aria-label")).toMatch(/, (have|need)\b/);
    expect(screen.getByText(/A click or Enter opens a card's details\./)).toBeTruthy();
  });

  it("a wall strip is a disclosure whose name does not change", () => {
    renderDemo([`${DEMO}&tab=cards&set=${CHROME}`]);
    const wall = screen.getByRole("group", { name: "2024 Topps Chrome checklist wall" });
    const strip = within(wall).getAllByRole("button", { expanded: true })[0];
    const name = strip.textContent;
    expect(name).toMatch(/ tiles$/);
    fireEvent.click(strip);
    expect(strip.getAttribute("aria-expanded")).toBe("false");
    expect(strip.textContent).toBe(name);
  });
});

describe("more of the pass", () => {
  it("a board's strip is a disclosure that stays put, its bulbs counted for a reader", () => {
    renderDemo([`${DEMO}&tab=cards`]);
    const hide = screen.getAllByRole("button", { name: /^Hide the cards, .+ of .+$/ })[0];
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    const strip = hide.closest("li")!;
    expect(within(strip).getByText(/^\d+ of \d+ lit up/)).toBeTruthy();
    fireEvent.click(hide);
    expect(hide.isConnected).toBe(true);
    expect(hide.getAttribute("aria-expanded")).toBe("false");
    expect(hide.getAttribute("aria-label")).toMatch(/^Show the cards, /);
  });

  it("Show more counts the whole shelf and hands the keyboard to the first card it adds", async () => {
    renderDemo([`${DEMO}&tab=cards`]);
    const rail = screen.getByRole("navigation", { name: "Shelves and binders" });
    fireEvent.click(within(rail).getByRole("button", { name: /^Every card I own/ }));
    expect(within(rail).getByRole("button", { name: /^Every card I own/ }).getAttribute("aria-current")).toBe("true");
    const more = screen.queryByRole("button", { name: /^Show \d+ more of \d+$/ });
    expect(more).toBeTruthy();
    if (!more) return;
    const grid = screen.getByRole("list", { name: /^Every card I own/ });
    const shownBefore = within(grid).getAllByRole("button").length;
    const total = Number(/of (\d+)$/.exec(more.textContent ?? "")![1]);
    expect(total).toBeGreaterThan(shownBefore);
    fireEvent.click(more);
    await waitFor(() => expect(document.activeElement).toBe(within(grid).getAllByRole("button")[shownBefore]));
  });

  it("the status line holds its Undo while the keyboard is on it", async () => {
    vi.useFakeTimers();
    try {
      renderDemo([`${BASE_CHECKLIST}&scope=binder-main`]);
      const have = within(checklist()).getAllByRole("button", { name: /^Have /, pressed: false })[0];
      fireEvent.click(have);
      await act(async () => {});
      const undo = screen.getByRole("button", { name: "Undo" });
      act(() => undo.focus());
      act(() => vi.advanceTimersByTime(15_000));
      expect(screen.getByRole("button", { name: "Undo" })).toBe(undo);
      // The keyboard moves on: the line counts down again.
      act(() => screen.getByRole("searchbox", { name: "Search every card" }).focus());
      act(() => vi.advanceTimersByTime(10_500));
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
