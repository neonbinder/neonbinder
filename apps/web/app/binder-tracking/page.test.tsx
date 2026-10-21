import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import BinderTrackingPage from "./page";

/**
 * NEO-350 — the tour's "Take it for a spin": the demo opens in place on
 * `?demo=on` (lazy-loaded), and Back to the tour returns to the section with
 * the keyboard on its link. Signed out: the only Clerk piece on the page is
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
    </MemoryRouter>,
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
});
