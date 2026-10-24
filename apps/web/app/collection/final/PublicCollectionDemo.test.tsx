import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { Theme } from "@radix-ui/themes";
import PublicCollectionDemo from "./PublicCollectionDemo";
import { PUBLIC_DESTINATIONS } from "./mode";
import { PUBLIC_STORAGE_KEY } from "./store";

/**
 * NEO-350 — the public collection demo on `/binder-tracking`: it renders for a
 * signed-out visitor with no Clerk provider and no Convex client, keeps its
 * own sessionStorage, puts each view on the page URL beside `demo=on` (so
 * Back steps back through the views), and points every signed-in
 * destination at the public tour.
 *
 * The auth and Convex client modules are mocked EMPTY: any hook or client the
 * demo reached for would throw "No … export is defined on the mock".
 */
// NEO-356: the demo bar's theme switch asks Clerk who is looking.
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false }) }));
vi.mock("convex/react", () => ({}));

const DEMO_URL = "/binder-tracking?demo=on";

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

function renderDemo(onExit = vi.fn(), entries: string[] = [DEMO_URL]) {
  render(
    <Theme>
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <Routes>
          <Route
            path="/binder-tracking"
            element={
              <>
                <PublicCollectionDemo onExit={onExit} keepParams={{ demo: "on" }} />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </Theme>,
  );
  return { onExit };
}

const pageUrl = () => screen.getByRole("status", { name: "Page URL" }).textContent;
const openTab = (name: string) =>
  fireEvent.click(within(screen.getByRole("navigation", { name: "Collection sections" })).getByRole("link", { name }));

beforeEach(() => {
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("the public collection demo", () => {
  it("renders signed out, says it is a demo, and offers Reset, Sign up and the way back", () => {
    const { onExit } = renderDemo();
    expect(screen.getByRole("heading", { level: 1, name: "Collection" })).toBeTruthy();
    const bar = screen.getByRole("region", { name: "About this demo" });
    expect(within(bar).getByText("Demo binder")).toBeTruthy();
    expect(document.activeElement).toBe(bar);

    // One Reset, in the bar (the app's footer Reset is not shown here).
    expect(screen.getAllByRole("button", { name: "Reset demo data" })).toHaveLength(1);
    // Sign up: the bar's copy (phones) and the right-edge tab (wide screens).
    const signUps = screen.getAllByRole("link", { name: "Sign up free" });
    expect(signUps.length).toBeGreaterThan(0);
    for (const link of signUps) expect(link.getAttribute("href")).toBe(PUBLIC_DESTINATIONS.signUp);

    fireEvent.click(screen.getAllByRole("button", { name: "Back to the tour" })[0]);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("puts each view on the URL beside demo=on, and Back steps back through them, scope and all", () => {
    renderDemo();
    const back = () => fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
    const scope = () => screen.getByRole("combobox", { name: "Binder" }) as HTMLSelectElement;

    // My Cards, scoped to the slab case: the scope rides on the URL, but a
    // pick replaces the entry rather than adding a Back step.
    openTab("My Cards");
    expect(pageUrl()).toBe("/binder-tracking?demo=on&tab=cards");
    // Only homes are offered, so the trade pile and the Want List are not here.
    expect(within(scope()).queryByRole("option", { name: "Up for Trade" })).toBeNull();
    const trade = (within(scope()).getByRole("option", { name: "Slab case" }) as HTMLOptionElement).value;
    fireEvent.change(scope(), { target: { value: trade } });
    expect(pageUrl()).toBe(`/binder-tracking?demo=on&tab=cards&scope=${trade}`);
    expect(scope().value).toBe(trade);

    // The 1996-97 Upper Deck wall: the push carries the scope on.
    fireEvent.click(screen.getByRole("link", { name: "1996-97 Upper Deck" }));
    expect(pageUrl()).toBe(`/binder-tracking?demo=on&tab=cards&set=1996-97-upper-deck-hockey&scope=${trade}`);
    expect(screen.getByRole("group", { name: "1996-97 Upper Deck checklist wall" })).toBeTruthy();

    // My Binders, then All Reggie White: a smart binder scopes to All.
    openTab("My Binders");
    expect(pageUrl()).toBe(`/binder-tracking?demo=on&tab=binders&scope=${trade}`);
    fireEvent.click(screen.getByRole("button", { name: /^All Reggie White,/ }));
    expect(pageUrl()).toBe("/binder-tracking?demo=on&tab=binders&b=smart-reggie-white");
    expect(screen.getByRole("heading", { level: 2, name: "All Reggie White" })).toBeTruthy();

    back();
    expect(pageUrl()).toBe(`/binder-tracking?demo=on&tab=binders&scope=${trade}`);
    expect(screen.getByText("Slab case", { selector: "strong" })).toBeTruthy();
    back();
    expect(pageUrl()).toBe(`/binder-tracking?demo=on&tab=cards&set=1996-97-upper-deck-hockey&scope=${trade}`);
    expect(screen.getByRole("group", { name: "1996-97 Upper Deck checklist wall" })).toBeTruthy();
    back();
    expect(pageUrl()).toBe(`/binder-tracking?demo=on&tab=cards&scope=${trade}`);
    expect(scope().value).toBe(trade);
    expect((within(scope()).getByRole("option", { selected: true }) as HTMLOptionElement).text).toBe("Slab case");
    back();
    expect(pageUrl()).toBe(DEMO_URL);
    expect(scope().value).toBe("all");
  });

  it("a scope pick is not a Back step: Back goes to the view before, not the unscoped one", () => {
    renderDemo();
    openTab("My Cards");
    openTab("Checklists");
    openTab("My Cards");
    const scope = () => screen.getByRole("combobox", { name: "Binder" }) as HTMLSelectElement;
    const main = (within(scope()).getByRole("option", { name: "Main" }) as HTMLOptionElement).value;
    fireEvent.change(scope(), { target: { value: main } });
    expect(pageUrl()).toBe(`/binder-tracking?demo=on&tab=cards&scope=${main}`);
    fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
    expect(pageUrl()).toBe("/binder-tracking?demo=on&tab=checklists");
  });

  it("a deep link with a scope opens scoped; an unknown binder id reads as All", () => {
    renderDemo(vi.fn(), ["/binder-tracking?demo=on&tab=cards&scope=binder-ohtani-rainbow"]);
    expect((screen.getByRole("combobox", { name: "Binder" }) as HTMLSelectElement).value).toBe("binder-ohtani-rainbow");
    cleanup();
    renderDemo(vi.fn(), ["/binder-tracking?demo=on&tab=cards&scope=binder-gone"]);
    expect((screen.getByRole("combobox", { name: "Binder" }) as HTMLSelectElement).value).toBe("all");
  });

  it("opens a shared deep link straight into that view", () => {
    renderDemo(vi.fn(), ["/binder-tracking?demo=on&tab=cards&set=1996-97-upper-deck-hockey"]);
    expect(screen.getByRole("group", { name: "1996-97 Upper Deck checklist wall" })).toBeTruthy();
  });

  it("opening a binder from the shelf keeps demo=on on the URL", () => {
    renderDemo();
    openTab("My Binders");
    fireEvent.click(screen.getByRole("button", { name: /^Ohtani rainbow,/ }));
    expect(screen.getByRole("heading", { level: 2, name: "Ohtani rainbow" })).toBeTruthy();
    expect(pageUrl()).toMatch(/^\/binder-tracking\?demo=on&tab=binders&b=/);
  });

  it("sends the Inventory long box to the public Inventory tour", () => {
    renderDemo();
    openTab("My Binders");
    const special = screen.getByRole("list", { name: "Special places" });
    const box = within(special).getByRole("link", { name: /^Inventory, \d+ cards? for sale$/ });
    expect(box.getAttribute("href")).toBe(PUBLIC_DESTINATIONS.inventory);
  });

  it("sends Print label, on the cover and in the label editor, to the public Print Shop page", () => {
    renderDemo();
    openTab("My Binders");
    fireEvent.click(screen.getByRole("button", { name: /^'96 Contenders,/ }));
    for (const link of screen.getAllByRole("link", { name: "Print label for '96 Contenders" })) {
      expect(link.getAttribute("href")).toBe(PUBLIC_DESTINATIONS.printShop);
      // The tour page opens in place, like every other tour link.
      expect(link.getAttribute("target")).toBeNull();
    }

    fireEvent.click(screen.getByRole("button", { name: "Edit label for '96 Contenders" }));
    const dialog = screen.getByRole("dialog");
    const printThis = within(dialog).getByRole("link", { name: "Print this label" });
    expect(printThis.getAttribute("href")).toBe(PUBLIC_DESTINATIONS.printShop);
    expect(printThis.getAttribute("target")).toBeNull();
    expect(within(dialog).getByText(/in the Print Shop once you've signed up\./)).toBeTruthy();
  });

  it("shares with a neutral @you handle and says the link is an example", () => {
    renderDemo();
    openTab("My Binders");
    fireEvent.click(screen.getByRole("button", { name: /^Ohtani rainbow,/ }));
    fireEvent.click(screen.getByRole("button", { name: "Share Ohtani rainbow" }));
    expect(screen.getByText("neonbinder.io/@you/binders/ohtani-rainbow")).toBeTruthy();
    expect(screen.getByText("Just an example: demo binders don't get a real page.")).toBeTruthy();
    expect(screen.queryByText(/@jason/)).toBeNull();
  });

  it("shares a browsed set at @you too", () => {
    renderDemo();
    openTab("My Binders");
    fireEvent.click(screen.getByRole("button", { name: /^Browse 2000 Topps,/ }));
    fireEvent.click(screen.getByRole("button", { name: "Share 2000 Topps" }));
    expect(screen.getByText("neonbinder.io/@you/sets/2000-topps")).toBeTruthy();
  });

  it("keeps its state under its own storage key, never the signed-in page's", () => {
    renderDemo();
    expect(window.sessionStorage.getItem(PUBLIC_STORAGE_KEY)).not.toBeNull();
    expect(window.sessionStorage.getItem("nb-collection-final")).toBeNull();
  });
});

describe("the public demo never touches Convex", () => {
  // `convex/react` is mocked EMPTY above: any hook the demo reached for throws "No export is defined".
  it("makes a box and moves a card into it on fixture data alone", async () => {
    renderDemo();
    openTab("My Binders");
    fireEvent.click(screen.getByRole("button", { name: /New binder or box/ }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: /A box/ }));
    fireEvent.change(within(dialog).getByLabelText("Box name"), { target: { value: "Dime box" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Put it on the shelf" }));
    expect(await screen.findByRole("region", { name: "Dime box, open" })).toBeTruthy();

    const hunt = screen.getByRole("searchbox", { name: "Hunt for one of your cards" });
    fireEvent.change(hunt, { target: { value: "jim kelly" } });
    fireEvent.click(screen.getByRole("button", { name: /^Move here: / }));
    await waitFor(() =>
      expect(screen.getAllByRole("status").some((s) => /^Moved #12 Jim Kelly from '96 Contenders to Dime box\.$/.test(s.textContent ?? ""))).toBe(true),
    );
    expect(pageUrl()).toMatch(/^\/binder-tracking\?demo=on&tab=binders&b=/);
  });
});
