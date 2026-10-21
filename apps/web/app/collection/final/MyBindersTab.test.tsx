import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import FinalCollectionPage from "./FinalCollectionPage";

/**
 * My Binders on the consolidated page, through the page itself (real store,
 * real drawer, no Convex): the special shelf, opening a binder scopes the
 * page, the Want List opens to its wants, the pack's Enter never guesses
 * between two cards, and Share shows a readable link.
 */

function renderBinders(start = "/collection?tab=binders") {
  return render(
    <MemoryRouter initialEntries={[start]}>
      <Routes>
        <Route path="/collection" element={<FinalCollectionPage />} />
        <Route path="/inventory" element={<p>Inventory page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("My Binders", () => {
  it("puts Want List, Up for Trade and the Inventory door on their own shelf", () => {
    renderBinders();
    const special = screen.getByRole("list", { name: "Special places" });
    expect(within(special).getByRole("button", { name: /^Want List,/ })).toBeTruthy();
    expect(within(special).getByRole("button", { name: /^Up for Trade,/ })).toBeTruthy();
    const door = within(special).getByRole("link", { name: /^Inventory,/ });
    expect(door.getAttribute("href")).toBe("/inventory");

    const mine = screen.getByRole("list", { name: "Your binders" });
    const spines = within(mine).getAllByRole("button");
    expect(spines[0].getAttribute("aria-label")).toMatch(/^All my cards,/);
    expect(spines[1].getAttribute("aria-label")).toMatch(/^Main,/);
    expect(within(mine).queryByRole("button", { name: /^Want List,/ })).toBeNull();
  });

  it("opening a binder scopes the page to it, and the shelf shows it", () => {
    renderBinders();
    fireEvent.click(screen.getByRole("button", { name: /^'96 Contenders,/ }));
    expect(screen.getByRole("heading", { level: 2, name: "'96 Contenders" })).toBeTruthy();
    expect(screen.getByText("Checklists and My Cards are looking through '96 Contenders.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back to the shelf" }));
    const spine = screen.getByRole("button", { name: /^'96 Contenders,/ });
    expect(spine.getAttribute("aria-current")).toBe("true");
  });

  it("opens the Want List to its wants, unscoped first, and a want opens the drawer to add it", () => {
    renderBinders();
    fireEvent.click(screen.getByRole("button", { name: /^Want List,/ }));
    expect(screen.getByRole("heading", { level: 2, name: "Want List" })).toBeTruthy();
    expect(screen.getByRole("group", { name: /^Page 1, Just want it/ })).toBeTruthy();

    const need = screen.getAllByRole("button", { name: /, need\. Add it$/ })[0];
    act(() => {
      fireEvent.click(need);
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("while the Want List is open, the pack adds a want, never a filed copy", () => {
    renderBinders("/collection?tab=binders&b=binder-want");
    const search = screen.getByRole("searchbox", { name: "Rip a pack: search for a card you want" });
    fireEvent.change(search, { target: { value: "96 contenders reggie white" } });
    const want = screen.getAllByRole("button", { name: /^Want / })[0];
    fireEvent.click(want);
    expect(
      screen.getAllByRole("status").some((s) => /is on your Want List/.test(s.textContent ?? "")),
    ).toBe(true);
  });

  it("Enter in the pack asks when two cards fit instead of taking the first", () => {
    renderBinders("/collection?tab=binders&all=1");
    const search = screen.getByRole("searchbox", { name: "Rip a pack: search for a card to add" });
    fireEvent.change(search, { target: { value: "1" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getAllByRole("status").some((s) => /we won't guess/.test(s.textContent ?? ""))).toBe(true);
    expect(screen.queryByRole("group", { name: /^Where should/ })).toBeNull();
  });

  it("Share shows a human-readable link and who can see it", () => {
    renderBinders("/collection?tab=binders&b=binder-ohtani-rainbow");
    fireEvent.click(screen.getByRole("button", { name: "Share Ohtani rainbow" }));
    expect(screen.getByText("neonbinder.io/@jason/binders/ohtani-rainbow")).toBeTruthy();
    expect(screen.getByText("Anyone with the link can see it. Only you can change it.")).toBeTruthy();
  });
});
