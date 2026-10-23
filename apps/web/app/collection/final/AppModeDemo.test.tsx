import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Theme } from "@radix-ui/themes";
import FinalCollectionPage from "./FinalCollectionPage";

// NEO-356: the demo bar's theme switch asks Clerk who is looking (signed in here).
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true }) }));

/**
 * NEO-350 — `/collection` for a signed-in collector is the same hard-coded
 * demo as the public one, and says so: the demo bar marks it as sample data
 * (with Reset, minus the public demo's exits), and a card request never
 * promises a review that does not happen.
 */

function renderApp(start = "/collection") {
  return render(
    <Theme>
      <MemoryRouter initialEntries={[start]}>
        <Routes>
          <Route path="/collection" element={<FinalCollectionPage />} />
        </Routes>
      </MemoryRouter>
    </Theme>,
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("the signed-in collection is marked as a demo", () => {
  it("shows the demo bar with Reset, and no sign-up or tour exits", () => {
    renderApp();
    const bar = screen.getByRole("region", { name: "About this demo" });
    expect(within(bar).getByText("Demo binder")).toBeTruthy();
    expect(within(bar).getByText("Sample cards, real buttons. Play away: none of it touches your account.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Reset demo data" })).toHaveLength(1);
    expect(within(bar).getByRole("button", { name: "Reset demo data" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Sign up free" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to the tour" })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Leave the demo" })).toBeNull();
    // An ordinary page of the app: the bar does not grab focus.
    expect(document.activeElement).not.toBe(bar);
    expect(bar.hasAttribute("tabindex")).toBe(false);
  });

  it("Reset in the bar puts the starting stack back", () => {
    renderApp("/collection?tab=binders");
    fireEvent.click(screen.getByRole("button", { name: "Reset demo data" }));
    expect(screen.getAllByRole("status").some((s) => s.textContent === "Back to the starting stack.")).toBe(true);
  });
});

describe("asking for a card in the signed-in demo", () => {
  it("says the request stays on the page, never that an admin will review it", () => {
    renderApp("/collection?tab=checklists");
    fireEvent.click(screen.getByRole("button", { name: "Can't find it? Ask us to add it" }));
    const dialog = screen.getByRole("dialog", { name: "Ask us to add a card" });
    expect(
      within(dialog).getByText(
        "Tell us what you've got. These binders are a demo, so for now your request stays on the list below.",
      ),
    ).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText("Player"), { target: { value: "Reggie White" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send request" }));
    expect(
      within(dialog).getByText("Got it! This is the demo, so it stays right here on the list."),
    ).toBeTruthy();
    expect(within(dialog).getByText("Demo request · only you can see it")).toBeTruthy();
    expect(within(dialog).queryByText(/admin|review/i)).toBeNull();
  });
});
