import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { Theme } from "@radix-ui/themes";
import BinderTrackingPage from "./page";

/**
 * NEO-350 — the tour's "Take it for a spin": the demo opens in place on
 * `?demo=on` (lazy-loaded), its views ride on the URL beside it so Back steps
 * back through them, and Back to the tour returns to the section with the
 * keyboard on its link, in one step however deep the visitor went. Signed out: the only Clerk piece on the page is
 * the tour's own Get Started button, stubbed here; Convex is mocked empty so
 * any client use would throw.
 */
vi.mock("@clerk/clerk-react", () => ({
  SignUpButton: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("convex/react", () => ({}));

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <output aria-label="Page URL">{pathname + search}</output>;
}

function renderTour(start = "/binder-tracking") {
  render(
    <Theme>
      <MemoryRouter initialEntries={[start]}>
        <Routes>
          <Route
            path="/binder-tracking"
            element={
              <>
                <BinderTrackingPage />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </Theme>,
  );
}

const pageUrl = () => screen.getByRole("status", { name: "Page URL" }).textContent;

// The demo is lazy-loaded; importing its module graph cold can outlast a
// findBy under load, so load it once up front (lazy() still suspends a tick).
beforeAll(async () => {
  await import("@/app/collection/final/PublicCollectionDemo");
});
beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("Take it for a spin", () => {
  it("opens the demo in place and comes back to the section", async () => {
    renderTour();
    expect(screen.getByRole("heading", { level: 2, name: "Take it for a spin" })).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "Open the demo binder" }));
    expect(pageUrl()).toBe("/binder-tracking?demo=on");
    expect(await screen.findByRole("region", { name: "About this demo" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Collection" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Take it for a spin" })).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "Back to the tour" })[0]);
    await waitFor(() => expect(pageUrl()).toBe("/binder-tracking"));
    const link = screen.getByRole("link", { name: "Open the demo binder" });
    expect(document.activeElement).toBe(link);
  });

  it("opens straight into the demo from a ?demo=on link, and Back to the tour stays on the page", async () => {
    renderTour("/binder-tracking?demo=on");
    expect(await screen.findByRole("region", { name: "About this demo" })).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Back to the tour" })[0]);
    await waitFor(() => expect(pageUrl()).toBe("/binder-tracking"));
    expect(screen.getByRole("heading", { level: 2, name: "Take it for a spin" })).toBeTruthy();
  });

  // Jason's walk: My Cards scoped to Up for Trade, the 1996-97 Upper Deck
  // wall, My Binders, All Reggie White.
  async function walkDeep() {
    const tabs = () => screen.getByRole("navigation", { name: "Collection sections" });
    await screen.findByRole("region", { name: "About this demo" });
    fireEvent.click(within(tabs()).getByRole("link", { name: "My Cards" }));
    const scope = screen.getByRole("combobox", { name: "Binder" }) as HTMLSelectElement;
    const trade = within(scope).getByRole("option", { name: "Up for Trade" }) as HTMLOptionElement;
    fireEvent.change(scope, { target: { value: trade.value } });
    fireEvent.click(screen.getByRole("link", { name: "1996-97 Upper Deck" }));
    fireEvent.click(within(tabs()).getByRole("link", { name: "My Binders" }));
    fireEvent.click(screen.getByRole("button", { name: /^All Reggie White,/ }));
    expect(screen.getByRole("heading", { level: 2, name: "All Reggie White" })).toBeTruthy();
  }

  it("Back steps back through the demo's views, and the step after the first view is the tour", async () => {
    renderTour();
    fireEvent.click(screen.getByRole("link", { name: "Open the demo binder" }));
    await walkDeep();
    const back = () => fireEvent.click(screen.getByRole("button", { name: "← Back" }));

    back();
    expect(pageUrl()).toMatch(/^\/binder-tracking\?demo=on&tab=binders&scope=[\w-]+$/);
    expect(screen.getByRole("list", { name: "Your binders" })).toBeTruthy();
    back();
    expect(pageUrl()).toMatch(/^\/binder-tracking\?demo=on&tab=cards&set=1996-97-upper-deck-hockey&scope=[\w-]+$/);
    expect(screen.getByRole("group", { name: "1996-97 Upper Deck checklist wall" })).toBeTruthy();
    back();
    expect(pageUrl()).toMatch(/^\/binder-tracking\?demo=on&tab=cards&scope=[\w-]+$/);
    const picked = screen.getByRole("combobox", { name: "Binder" }) as HTMLSelectElement;
    expect(picked.options[picked.selectedIndex].text).toBe("Up for Trade");
    back();
    expect(pageUrl()).toBe("/binder-tracking?demo=on");
    expect(screen.getByRole("region", { name: "About this demo" })).toBeTruthy();
    back();
    await waitFor(() => expect(pageUrl()).toBe("/binder-tracking"));
    expect(screen.getByRole("heading", { level: 2, name: "Take it for a spin" })).toBeTruthy();
  });

  it("Back to the tour from deep in the demo goes straight back to the tour entry", async () => {
    renderTour();
    fireEvent.click(screen.getByRole("link", { name: "Open the demo binder" }));
    await walkDeep();

    fireEvent.click(screen.getAllByRole("button", { name: "Back to the tour" })[0]);
    await waitFor(() => expect(pageUrl()).toBe("/binder-tracking"));
    expect(screen.getByRole("heading", { level: 2, name: "Take it for a spin" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Open the demo binder" }));
  });

  it("a shared deep link opens straight into that view, and Back to the tour replaces it", async () => {
    renderTour("/binder-tracking?demo=on&tab=binders");
    expect(await screen.findByRole("list", { name: "Your binders" })).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Back to the tour" })[0]);
    await waitFor(() => expect(pageUrl()).toBe("/binder-tracking"));
  });
});
