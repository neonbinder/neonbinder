import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import PublicCollectionDemo from "./PublicCollectionDemo";
import { PUBLIC_DESTINATIONS } from "./mode";
import { PUBLIC_STORAGE_KEY } from "./store";

/**
 * NEO-350 — the public collection demo on `/binder-tracking`: it renders for a
 * signed-out visitor with no Clerk provider and no Convex client, keeps its
 * own sessionStorage and its view state out of the page URL, and points every
 * signed-in destination at the public tour.
 *
 * The auth and Convex client modules are mocked EMPTY: any hook or client the
 * demo reached for would throw "No … export is defined on the mock".
 */
vi.mock("@clerk/clerk-react", () => ({}));
vi.mock("convex/react", () => ({}));

const DEMO_URL = "/binder-tracking?demo=on";

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <output aria-label="Page URL">{pathname + search}</output>;
}

function renderDemo(onExit = vi.fn()) {
  render(
    <MemoryRouter initialEntries={[DEMO_URL]}>
      <Routes>
        <Route
          path="/binder-tracking"
          element={
            <>
              <PublicCollectionDemo onExit={onExit} entryHref={DEMO_URL} />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
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

  it("switches tabs without touching the page URL", () => {
    renderDemo();
    openTab("My Binders");
    expect(screen.getByRole("list", { name: "Your binders" })).toBeTruthy();
    expect(pageUrl()).toBe(DEMO_URL);

    fireEvent.click(screen.getByRole("button", { name: /^Ohtani rainbow,/ }));
    expect(screen.getByRole("heading", { level: 2, name: "Ohtani rainbow" })).toBeTruthy();
    expect(pageUrl()).toBe(DEMO_URL);

    openTab("Checklists");
    expect(pageUrl()).toBe(DEMO_URL);
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
    }

    fireEvent.click(screen.getByRole("button", { name: "Edit label for '96 Contenders" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("link", { name: "Print this label" }).getAttribute("href")).toBe(
      PUBLIC_DESTINATIONS.printShop,
    );
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

  it("keeps its state under its own storage key, never the signed-in page's", () => {
    renderDemo();
    expect(window.sessionStorage.getItem(PUBLIC_STORAGE_KEY)).not.toBeNull();
    expect(window.sessionStorage.getItem("nb-collection-final")).toBeNull();
  });
});
