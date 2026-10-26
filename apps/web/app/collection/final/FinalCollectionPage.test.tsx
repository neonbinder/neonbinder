import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { Theme } from "@radix-ui/themes";
import FinalCollectionPage from "./FinalCollectionPage";

/**
 * NEO-364 — the page on its two sides: the inventory surface's tabs and
 * h1, the redirects (replace) between the sides, and `box=` (the inventory
 * Checklists' target box) riding Checklists drill steps only.
 */
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" }) }));

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

function renderAt(start: string, entries?: string[]) {
  render(
    <Theme>
      <MemoryRouter initialEntries={entries ?? [start]} initialIndex={entries ? entries.length - 1 : 0}>
        <Routes>
          <Route path="/collection" element={<><FinalCollectionPage /><Probe /></>} />
          <Route path="/inventory" element={<><FinalCollectionPage surface="inventory" /><Probe /></>} />
        </Routes>
      </MemoryRouter>
    </Theme>,
  );
}

const url = () => screen.getByRole("status", { name: "Page URL" }).textContent;
const back = () => fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
const tabs = (side: "Collection" | "Inventory") => within(screen.getByRole("navigation", { name: `${side} sections` }));
const pick = (column: string, option: RegExp) =>
  fireEvent.click(within(screen.getByRole("listbox", { name: column })).getByRole("option", { name: option }));

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(cleanup);

describe("the inventory surface", () => {
  it("is headed Inventory, with the tabs Inventory, My Boxes and Checklists and the list first", () => {
    renderAt("/inventory");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Inventory");
    expect(tabs("Inventory").getAllByRole("link").map((l) => l.textContent)).toEqual(["Inventory", "My Boxes", "Checklists"]);
    expect(tabs("Inventory").getByRole("link", { name: "Inventory" }).getAttribute("aria-current")).toBe("page");
    expect(document.title).toBe("Inventory");
  });

  it("each tab is its own ?tab=, titled for it", () => {
    renderAt("/inventory");
    fireEvent.click(tabs("Inventory").getByRole("link", { name: "My Boxes" }));
    expect(url()).toBe("/inventory?tab=boxes");
    expect(document.title).toBe("My Boxes · Inventory");
    fireEvent.click(tabs("Inventory").getByRole("link", { name: "Checklists" }));
    expect(url()).toMatch(/^\/inventory\?tab=checklists/);
    expect(document.title).toBe("Checklists · Inventory");
    fireEvent.click(tabs("Inventory").getByRole("link", { name: "Inventory" }));
    expect(url()).toBe("/inventory?tab=cards");
  });

  it("an unknown tab opens the list", () => {
    renderAt("/inventory?tab=wat");
    expect(screen.getByRole("heading", { level: 2, name: "Everything for sale" })).toBeTruthy();
  });

  it("the collection has no Inventory or My Boxes tab", () => {
    renderAt("/collection");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Collection");
    expect(tabs("Collection").queryByRole("link", { name: /Inventory|My Boxes/ })).toBeNull();
  });

  it("the Binder picker never narrows the inventory: scope= is ignored there", () => {
    renderAt("/inventory?tab=boxes&scope=binder-slab-case");
    expect(screen.queryByRole("combobox", { name: "Binder" })).toBeNull();
  });
});

describe("redirects between the sides replace their entry", () => {
  it.each([
    ["/collection?tab=inventory", "/inventory?tab=boxes"],
    ["/collection?tab=boxes", "/inventory?tab=boxes"],
    ["/collection?tab=binders&sale=1", "/inventory?tab=cards"],
    ["/collection?tab=inventory&b=box-show", "/inventory?tab=boxes&b=box-show"],
    ["/inventory?tab=inventory", "/inventory?tab=boxes"],
    ["/inventory?tab=binders", "/collection?tab=binders"],
    ["/inventory?tab=cards&sale=1", "/inventory?tab=cards"],
  ])("%s lands on %s", (from, to) => {
    renderAt(from);
    expect(url()).toBe(to);
  });

  it("a redirect drops the collection's scope", () => {
    renderAt("/collection?tab=inventory&scope=binder-slab-case");
    expect(url()).toBe("/inventory?tab=boxes");
  });

  it("Back skips the redirected entry", () => {
    renderAt("", ["/collection?tab=binders", "/collection?tab=inventory"]);
    expect(url()).toBe("/inventory?tab=boxes");
    back();
    expect(url()).toBe("/collection?tab=binders");
  });

  it("does not move the focus to the heading: only a link the collector follows does", () => {
    renderAt("/collection?tab=inventory");
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { level: 1 }));
  });
});

describe("box= on the inventory's Checklists", () => {
  const CHECKLISTS = "/inventory?tab=checklists&box=box-show";

  it("rides each drill step, so the target box survives the cascade", () => {
    renderAt(CHECKLISTS);
    pick("Sports", /^Baseball/);
    expect(url()).toMatch(/sport=/);
    expect(url()).toMatch(/box=box-show/);
    pick("Years", /^2024/);
    expect(url()).toMatch(/box=box-show/);
  });

  it("each pick is still a Back step, and Back keeps the box", () => {
    renderAt(CHECKLISTS);
    pick("Sports", /^Baseball/);
    back();
    expect(url()).toBe(CHECKLISTS);
  });

  it("is dropped on a tab change, so the list's rail and the Checklists' target never become each other's", () => {
    renderAt(CHECKLISTS);
    fireEvent.click(tabs("Inventory").getByRole("link", { name: "My Boxes" }));
    expect(url()).toBe("/inventory?tab=boxes");
    fireEvent.click(tabs("Inventory").getByRole("link", { name: "Inventory" }));
    expect(url()).toBe("/inventory?tab=cards");
    expect(url()).not.toMatch(/box=/);
  });

  it("coming to Checklists from another tab starts with no box on the URL", () => {
    renderAt("/inventory?tab=cards&box=box-show");
    fireEvent.click(tabs("Inventory").getByRole("link", { name: "Checklists" }));
    expect(url()).not.toMatch(/box=/);
  });

  it("a rail box on the list does not become the Checklists' target", () => {
    renderAt("/inventory?tab=cards&box=box-show");
    fireEvent.click(tabs("Inventory").getByRole("link", { name: "Checklists" }));
    expect(screen.getByRole("combobox", { name: "Adding to" })).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Adding to" }) as HTMLSelectElement).value).toBe("box-unsorted");
  });

  it("the collection's Checklists never carry box=", () => {
    renderAt("/collection?tab=checklists&box=box-show");
    pick("Sports", /^Baseball/);
    expect(url()).not.toMatch(/box=/);
    expect(screen.queryByRole("combobox", { name: "Adding to" })).toBeNull();
  });
});

describe("arriving on a side", () => {
  it("following a side link puts the keyboard on the new side's heading", async () => {
    renderAt("/collection");
    fireEvent.click(within(screen.getByRole("group", { name: "Collection or Inventory" })).getByRole("link", { name: "Boxes I sell" }));
    expect(url()).toBe("/inventory?tab=cards");
    const h1 = await screen.findByRole("heading", { level: 1, name: "Inventory" });
    expect(h1.getAttribute("tabindex")).toBe("-1");
    await vi.waitFor(() => expect(document.activeElement).toBe(h1));
  });
});
