import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { Theme } from "@radix-ui/themes";
import FinalCollectionPage from "../FinalCollectionPage";
import { comparePlayerNames } from "../playerName";

/**
 * NEO-364 (D8-D12) — the inventory's Checklists on the demo store: the
 * "Adding to" box, a quantity field per card, the chips, the sort and "Add a
 * range to <box>". Box copies only; no Have / Want / Trade here.
 */
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" }) }));

const CHECKLIST = "/inventory?tab=checklists&set=2024-topps-chrome-baseball&type=Base";

function Probe() {
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

function renderChecklist(start = CHECKLIST) {
  render(
    <Theme>
      <MemoryRouter initialEntries={[start]}>
        <Routes>
          <Route
            path="/inventory"
            element={
              <>
                <FinalCollectionPage surface="inventory" />
                <Probe />
              </>
            }
          />
          <Route path="/collection" element={<FinalCollectionPage />} />
        </Routes>
      </MemoryRouter>
    </Theme>,
  );
}

const url = () => screen.getByRole("status", { name: "Page URL" }).textContent ?? "";
const adding = () => screen.getByRole("combobox", { name: "Adding to" }) as HTMLSelectElement;
const qty = () => screen.getAllByRole("textbox", { name: /^Quantity of / }) as HTMLInputElement[];
const says = (re: RegExp) => screen.getAllByRole("status").some((s) => re.test(s.textContent ?? ""));
const flush = () => act(async () => {});

/** The numbers on the rows, in the order the list shows them. */
const numbers = () => qty().map((el) => /Quantity of #(\S+) /.exec(el.getAttribute("aria-label") ?? "")![1]);

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(cleanup);

describe("the inventory's checklist", () => {
  it("counts plain copies in the target box, which starts as Unsorted", () => {
    renderChecklist();
    expect(adding().value).toBe("box-unsorted");
    expect(within(adding()).getAllByRole("option").map((o) => o.textContent)).toEqual(["Unsorted", "Show box"]);
    expect(qty().length).toBeGreaterThan(3);
    expect(qty().every((el) => el.value === "0" || Number(el.value) > 0)).toBe(true);
    expect(screen.getByRole("list", { name: "Quantities in Unsorted" })).toBeTruthy();
  });

  it("has no Have, Want or Trade controls: a field and Details only", () => {
    renderChecklist();
    expect(screen.queryByRole("button", { name: /^Have #/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Want #/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Trade #/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Details for / }).length).toBe(qty().length);
  });

  it("typing a number and leaving the field boxes that many, and the 'in your boxes' line follows", async () => {
    renderChecklist();
    const before = /^(\d+) of (\d+) in your boxes/;
    const line = () => screen.getByText((_, el) => el?.tagName === "P" && before.test(el.textContent ?? ""));
    const owned0 = Number(before.exec(line().textContent!)![1]);
    const first = qty()[0];
    fireEvent.change(first, { target: { value: "3" } });
    fireEvent.blur(first);
    await flush();
    await waitFor(() => expect(says(/^Boxed 3 more of #\S+ .+\. 3 in Unsorted\.$/)).toBe(true));
    expect(qty()[0].value).toBe("3");
    expect(Number(before.exec(line().textContent!)![1])).toBe(owned0 + 1);
  });

  it("a blank field does not replace a live Undo: the count stays on the status line and Undo still works", async () => {
    renderChecklist();
    const [a, b] = qty();
    fireEvent.change(a, { target: { value: "3" } });
    fireEvent.blur(a);
    await flush();
    await waitFor(() => expect(says(/^Boxed 3 more of /)).toBe(true));
    fireEvent.change(b, { target: { value: "" } });
    fireEvent.blur(b);
    await flush();
    expect(says(/^Boxed 3 more of /)).toBe(true);
    expect(says(/Nothing changed/)).toBe(false);
    expect(b.value).toBe("0");
    fireEvent.click(screen.getAllByRole("button", { name: "Undo" })[0]);
    await waitFor(() => expect(says(/^Undone\./)).toBe(true));
    expect(qty()[0].value).toBe("0");
  });

  it("with no notice up, a blank field says Nothing changed", async () => {
    renderChecklist();
    const [a] = qty();
    fireEvent.change(a, { target: { value: "" } });
    fireEvent.blur(a);
    await flush();
    expect(says(/^Nothing changed\. Type 0 to clear it\.$/)).toBe(true);
  });

  it("after Dismiss, the same blank blur is allowed to speak", async () => {
    renderChecklist();
    const [a, b] = qty();
    fireEvent.change(a, { target: { value: "3" } });
    fireEvent.blur(a);
    await flush();
    await waitFor(() => expect(says(/^Boxed 3 more of /)).toBe(true));
    fireEvent.click(screen.getAllByRole("button", { name: /^Dismiss/ })[0]);
    fireEvent.change(b, { target: { value: "" } });
    fireEvent.blur(b);
    await flush();
    expect(says(/^Nothing changed\. Type 0 to clear it\.$/)).toBe(true);
  });

  it("a collection copy never counts: nothing held in a binder lights a field", () => {
    renderChecklist();
    // The demo holds 2024 Topps Chrome Base in binders; no field reads it.
    expect(qty().every((el) => el.value === "0")).toBe(true);
  });

  it("the chips narrow to cards in the box, or not in it", async () => {
    renderChecklist();
    const all = numbers();
    const first = qty()[1];
    fireEvent.change(first, { target: { value: "2" } });
    fireEvent.blur(first);
    await flush();
    const show = screen.getByRole("radiogroup", { name: "Show" });
    fireEvent.click(within(show).getByRole("radio", { name: "In Unsorted" }));
    expect(numbers()).toEqual([all[1]]);
    fireEvent.click(within(show).getByRole("radio", { name: "Not in Unsorted" }));
    expect(numbers()).toEqual(all.filter((n) => n !== all[1]));
    fireEvent.click(within(show).getByRole("radio", { name: "All" }));
    expect(numbers()).toEqual(all);
  });

  it("says what an empty chip means, instead of an empty list", () => {
    renderChecklist();
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Show" })).getByRole("radio", { name: "In Unsorted" }));
    expect(screen.getByText(/Nothing from this checklist in Unsorted yet/)).toBeTruthy();
  });

  it("sorts by number, player and team without losing a card", () => {
    renderChecklist();
    const all = numbers();
    const sort = screen.getByRole("combobox", { name: "Sort by" });
    fireEvent.change(sort, { target: { value: "number" } });
    const byNumber = numbers();
    expect([...byNumber].sort()).toEqual([...all].sort());
    fireEvent.change(sort, { target: { value: "player" } });
    expect(numbers()).toHaveLength(all.length);
    // Filed by last name, then first, as a collector sorts a box.
    const firstPlayers = qty().map((el) => /Quantity of #\S+ (.+) in /.exec(el.getAttribute("aria-label") ?? "")![1].split(/ \/ |, /)[0]);
    expect(new Set(firstPlayers).size).toBeGreaterThan(1);
    expect(firstPlayers).toEqual([...firstPlayers].sort(comparePlayerNames));
    fireEvent.change(sort, { target: { value: "team" } });
    expect(numbers()).toHaveLength(all.length);
    fireEvent.change(sort, { target: { value: "checklist" } });
    expect(numbers()).toEqual(all);
  });

  it("searches the checklist by number", () => {
    renderChecklist();
    const target = numbers()[2];
    fireEvent.change(screen.getByRole("searchbox", { name: "Search this checklist" }), { target: { value: `#${target}` } });
    expect(numbers()).toContain(target);
        fireEvent.change(screen.getByRole("searchbox", { name: "Search this checklist" }), { target: { value: "zzzzzz" } });
    expect(screen.getByText("No cards match.")).toBeTruthy();
  });

  it("Add a range files one of each card into the box, and says how many", async () => {
    renderChecklist();
    const range = screen.getByRole("textbox", { name: "Add a range to Unsorted" });
    fireEvent.change(range, { target: { value: "1-3" } });
    const add = screen.getByRole("button", { name: /^Add 3 to Unsorted$/ });
    fireEvent.click(add);
    await flush();
    await waitFor(() => expect(says(/^Added 3 cards to Unsorted, one each\.$/)).toBe(true));
    expect((range as HTMLInputElement).value).toBe("");
    expect(qty().slice(0, 3).map((el) => el.value)).toEqual(["1", "1", "1"]);
  });

  it("Add a range reads Enter as Add, and a range it cannot read says so and adds nothing", () => {
    renderChecklist();
    const range = screen.getByRole("textbox", { name: "Add a range to Unsorted" });
    fireEvent.change(range, { target: { value: "banana" } });
    expect(screen.getByRole("alert").textContent).toMatch(/Can't read that/);
    expect(range.getAttribute("aria-invalid")).toBe("true");
    expect((screen.getByRole("button", { name: /^Add to Unsorted$/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a range that names an unknown card says which, and Escape clears the range", () => {
    renderChecklist();
    const range = screen.getByRole("textbox", { name: "Add a range to Unsorted" });
    fireEvent.change(range, { target: { value: "1, 99999" } });
    expect(screen.getByText(/Not on this checklist: 99999/)).toBeTruthy();
    fireEvent.keyDown(range, { key: "Escape" });
    expect((range as HTMLInputElement).value).toBe("");
  });

  it("Add a range reads \"skip 12\" as taking a number back out, and says so in the placeholder", () => {
    renderChecklist();
    const range = screen.getByRole("textbox", { name: "Add a range to Unsorted" }) as HTMLInputElement;
    expect(range.placeholder).toBe("1-20, skip 12");
    fireEvent.change(range, { target: { value: "1-3, skip 2" } });
    expect(screen.getByRole("button", { name: /^Add 2 to Unsorted$/ })).toBeTruthy();
    fireEvent.change(range, { target: { value: "1-3, -2" } });
    expect(screen.getByRole("button", { name: /^Add 2 to Unsorted$/ })).toBeTruthy();
    fireEvent.change(range, { target: { value: "1, skip 99999" } });
    expect(screen.getByText(/Not on this checklist: skip 99999/)).toBeTruthy();
  });

  it("names the target box under the checklist's heading, and follows a new pick", () => {
    renderChecklist();
    const heading = screen.getByRole("heading", { level: 3 });
    const section = heading.closest("section")!;
    expect(within(section).getByText("Adding to", { exact: false }).textContent).toBe("Adding to Unsorted");
    fireEvent.change(adding(), { target: { value: "box-show" } });
    expect(within(section).getByText("Adding to", { exact: false }).textContent).toBe("Adding to Show box");
  });

  it("a range into a box already holding some says how many get one more", async () => {
    renderChecklist();
    const first = qty()[0];
    fireEvent.change(first, { target: { value: "2" } });
    fireEvent.blur(first);
    await flush();
    fireEvent.change(screen.getByRole("textbox", { name: "Add a range to Unsorted" }), { target: { value: "1-2" } });
    expect(screen.getByText(/1 already in there get one more/)).toBeTruthy();
  });

  describe("the target box", () => {
    it("picking another box replaces box= on the URL (no Back step), counts that box, and is kept for next time", async () => {
      renderChecklist();
      const entries = url();
      fireEvent.change(adding(), { target: { value: "box-show" } });
      expect(url()).toBe(`${entries}&box=box-show`);
      expect(screen.getByRole("list", { name: "Quantities in Show box" })).toBeTruthy();
      expect(window.localStorage.getItem("nb.demo.targetBox")).toBe("box-show");
      // Not a Back step: Back leaves the page for the entry before it (none here).
      fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
      expect(url()).toBe(`${entries}&box=box-show`);
    });

    it("a box on the URL wins over the kept one; an unknown id reads as Unsorted", () => {
      window.localStorage.setItem("nb.demo.targetBox", "box-show");
      renderChecklist(`${CHECKLIST}&box=box-unsorted`);
      expect(adding().value).toBe("box-unsorted");
      cleanup();
      renderChecklist(`${CHECKLIST}&box=gone`);
      expect(adding().value).toBe("box-show");
    });

    it("with no box on the URL the last pick on this device is the target", () => {
      window.localStorage.setItem("nb.demo.targetBox", "box-show");
      renderChecklist();
      expect(adding().value).toBe("box-show");
    });

    it("counts the picked box: the Show box's cards read their quantities there", () => {
      renderChecklist("/inventory?tab=checklists&set=2024-score-football&type=Base&box=box-show");
      // Unsorted is empty; the Show box holds copies, and the fields now read that box.
      expect(screen.getByRole("list", { name: "Quantities in Show box" })).toBeTruthy();
    });

    it("a storage that throws still lets a pick through", () => {
      const original = Object.getOwnPropertyDescriptor(window, "localStorage");
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get: () => {
          throw new DOMException("denied", "SecurityError");
        },
      });
      try {
        renderChecklist();
        fireEvent.change(adding(), { target: { value: "box-show" } });
        expect(url()).toMatch(/&box=box-show$/);
      } finally {
        if (original) Object.defineProperty(window, "localStorage", original);
      }
    });
  });
});
