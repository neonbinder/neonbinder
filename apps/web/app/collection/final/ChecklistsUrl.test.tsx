import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { Theme } from "@radix-ui/themes";
import FinalCollectionPage from "./FinalCollectionPage";
import PublicCollectionDemo from "./PublicCollectionDemo";

/**
 * NEO-350 — the Checklists drill lives on the page URL: each cascade pick is
 * one Back step, a refresh or a shared link reopens the same checklist, an
 * unknown id falls back quietly, the search box writes `q` without a Back
 * step per letter, and the tab title names the view.
 */
// NEO-356: the demo bar's theme switch asks Clerk who is looking.
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false }) }));
vi.mock("convex/react", () => ({}));

const DEMO = "/binder-tracking?demo=on";
const CHROME = "2024-topps-chrome-baseball";

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

function renderDemo(entries: string[] = [DEMO]) {
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

function renderApp(start: string) {
  render(
    <Theme>
      <MemoryRouter initialEntries={[start]}>
        <Routes>
          <Route path="/collection" element={<FinalCollectionPage />} />
        </Routes>
      </MemoryRouter>
    </Theme>,
  );
}

const pageUrl = () => screen.getByRole("status", { name: "Page URL" }).textContent;
const back = () => fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
const openTab = (name: string) =>
  fireEvent.click(within(screen.getByRole("navigation", { name: "Collection sections" })).getByRole("link", { name }));
const pick = (column: string, option: RegExp) =>
  fireEvent.click(within(screen.getByRole("listbox", { name: column })).getByRole("option", { name: option }));
const checklistHeading = (name: string) => screen.queryByRole("heading", { level: 3, name });
/** Any checklist on screen: each one has its Show chips. */
const anyChecklist = () => screen.queryByRole("group", { name: "Show" });

beforeEach(() => {
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("the Checklists drill on the URL", () => {
  it("pushes one entry per pick, and Back steps up one level at a time", () => {
    renderDemo();
    openTab("Checklists");
    expect(pageUrl()).toBe(`${DEMO}&tab=checklists`);

    pick("Sports", /^Baseball/);
    expect(pageUrl()).toBe(`${DEMO}&tab=checklists&sport=baseball`);
    pick("Years", /^2024/);
    pick("Brands", /^Topps/);
    expect(pageUrl()).toBe(`${DEMO}&tab=checklists&sport=baseball&year=2024&brand=brand-topps`);
    pick("Sets", /^Topps Chrome/);
    expect(pageUrl()).toBe(`${DEMO}&tab=checklists&set=${CHROME}`);
    pick("Variant Types", /^Base/);
    expect(pageUrl()).toBe(`${DEMO}&tab=checklists&set=${CHROME}&type=Base`);
    expect(checklistHeading("2024 Topps Chrome Base")).toBeTruthy();
    expect(document.title).toBe("Checklists · 2024 Topps Chrome Base · Collection demo");

    // Back: up to the set, its variant types open again, no checklist.
    back();
    expect(pageUrl()).toBe(`${DEMO}&tab=checklists&set=${CHROME}`);
    expect(checklistHeading("2024 Topps Chrome Base")).toBeNull();
    expect(screen.getByRole("listbox", { name: "Variant Types" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sets: Topps Chrome, change" })).toBeTruthy();
    expect(document.title).toBe("Checklists · 2024 Topps Chrome · Collection demo");

    // Back: up to the brand, the sets open again.
    back();
    expect(pageUrl()).toBe(`${DEMO}&tab=checklists&sport=baseball&year=2024&brand=brand-topps`);
    expect(screen.getByRole("listbox", { name: "Sets" })).toBeTruthy();
    expect(screen.queryByRole("listbox", { name: "Variant Types" })).toBeNull();

    // Still inside the demo: three more steps up and we are on the tab's top.
    back();
    back();
    back();
    expect(pageUrl()).toBe(`${DEMO}&tab=checklists`);
    expect(screen.getByRole("listbox", { name: "Sports" })).toBeTruthy();
  });

  it("restores a deep link's drill, down to an insert or parallel", () => {
    renderDemo([`${DEMO}&tab=checklists&set=${CHROME}&type=Parallels&variant=Gold+Refractor`]);
    expect(checklistHeading("2024 Topps Chrome Gold Refractor")).toBeTruthy();
    // The picks read as a trail of summary cards.
    expect(screen.getByRole("button", { name: "Sports: Baseball, change" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sets: Topps Chrome, change" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Variant Types: Parallels, change" })).toBeTruthy();
    expect(document.title).toBe("Checklists · 2024 Topps Chrome Gold Refractor · Collection demo");
  });

  it("falls back quietly from an unknown id to the deepest level that makes sense", () => {
    // An unknown set: the top of the cascade.
    renderDemo([`${DEMO}&tab=checklists&set=1888-topps-nope&type=Base`]);
    expect(screen.getByRole("listbox", { name: "Sports" })).toBeTruthy();
    expect(anyChecklist()).toBeNull();
    expect(document.title).toBe("Checklists · Collection demo");
    cleanup();

    // A known set with an unknown variant type: the set, its types open.
    renderDemo([`${DEMO}&tab=checklists&set=${CHROME}&type=Shiny`]);
    expect(screen.getByRole("button", { name: "Sets: Topps Chrome, change" })).toBeTruthy();
    expect(screen.getByRole("listbox", { name: "Variant Types" })).toBeTruthy();
    cleanup();

    // An unknown parallel: its variant type, the parallels open.
    renderDemo([`${DEMO}&tab=checklists&set=${CHROME}&type=Parallels&variant=Plaid+Refractor`]);
    expect(screen.getByRole("listbox", { name: "Parallels" })).toBeTruthy();
    expect(anyChecklist()).toBeNull();
    cleanup();

    // A year the sport has no sets in: the sport, its years open.
    renderDemo([`${DEMO}&tab=checklists&sport=baseball&year=1888&brand=brand-topps`]);
    expect(screen.getByRole("button", { name: "Sports: Baseball, change" })).toBeTruthy();
    expect(screen.getByRole("listbox", { name: "Years" })).toBeTruthy();
    cleanup();

    // An unknown card to ring: the checklist opens, nothing is ringed.
    renderDemo([`${DEMO}&tab=checklists&set=${CHROME}&type=Base&card=card-nope`]);
    expect(checklistHeading("2024 Topps Chrome Base")).toBeTruthy();
    expect(anyChecklist()).toBeTruthy();
  });

  it("keeps your place when you leave the tab and come back", () => {
    renderDemo([`${DEMO}&tab=checklists&set=${CHROME}&type=Base`]);
    openTab("My Cards");
    expect(document.title).toBe("My Cards · Collection demo");
    openTab("Checklists");
    expect(pageUrl()).toBe(`${DEMO}&tab=checklists&set=${CHROME}&type=Base`);
    expect(checklistHeading("2024 Topps Chrome Base")).toBeTruthy();
  });

  it("writes the search to q without a Back step per letter", async () => {
    renderDemo();
    openTab("Checklists");
    const box = screen.getByRole("searchbox", { name: "Search every card" });
    fireEvent.change(box, { target: { value: "o" } });
    fireEvent.change(box, { target: { value: "oh" } });
    fireEvent.change(box, { target: { value: "ohtani" } });
    await waitFor(() => expect(pageUrl()).toBe(`${DEMO}&tab=checklists&q=ohtani`));

    // One Back leaves the search and the tab together.
    back();
    expect(pageUrl()).toBe(DEMO);
    expect(screen.queryByRole("searchbox", { name: "Search every card" })).toBeNull();
  });

  it("a search hit opens its checklist as a Back step, and Back brings the search back", () => {
    renderDemo();
    openTab("Checklists");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search every card" }), {
      target: { value: "ohtani gold refractor" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: /^Open the checklist for 2024 Topps Chrome/ })[0]);
    expect(pageUrl()).toMatch(new RegExp(`tab=checklists&set=${CHROME}&type=Parallels&variant=Gold\\+Refractor&card=`));
    expect(checklistHeading("2024 Topps Chrome Gold Refractor")).toBeTruthy();
    expect((screen.getByRole("searchbox", { name: "Search every card" }) as HTMLInputElement).value).toBe("");

    back();
    expect(pageUrl()).toBe(`${DEMO}&tab=checklists&q=ohtani+gold+refractor`);
    expect((screen.getByRole("searchbox", { name: "Search every card" }) as HTMLInputElement).value).toBe(
      "ohtani gold refractor",
    );
  });
});

describe("the tab title names the view", () => {
  it("in the public demo", () => {
    renderDemo([`${DEMO}&tab=binders&b=binder-main`]);
    expect(document.title).toBe("My Binders · Main · Collection demo");
  });

  it("in the app, on its own base title", () => {
    renderApp("/collection?tab=binders&b=binder-main");
    expect(document.title).toBe("My Binders · Main · Collection");
    cleanup();
    renderApp(`/collection?tab=checklists&set=${CHROME}&type=Base`);
    expect(document.title).toBe("Checklists · 2024 Topps Chrome Base · Collection");
    cleanup();
    renderApp("/collection");
    expect(document.title).toBe("My Cards · Collection");
  });
});
