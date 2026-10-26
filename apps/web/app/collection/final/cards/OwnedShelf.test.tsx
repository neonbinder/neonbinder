import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Theme } from "@radix-ui/themes";
import FinalCollectionPage from "../FinalCollectionPage";
import { comparePlayerNames } from "../playerName";

/**
 * NEO-364 — My Cards' shelf ("Everything I own") sorts players the way a
 * collector files them: by last name, then first, on the demo store.
 */
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" }) }));

function renderShelf() {
  render(
    <Theme>
      <MemoryRouter initialEntries={["/collection?tab=cards"]}>
        <Routes>
          <Route path="/collection" element={<FinalCollectionPage />} />
        </Routes>
      </MemoryRouter>
    </Theme>,
  );
}

const shelf = () => screen.getByRole("navigation", { name: "Shelves and binders" }).parentElement!;
const cardNames = () =>
  within(within(shelf()).getByRole("list", { name: /, \d[\d,]* cards?/ }))
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label")!);

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(cleanup);

describe("My Cards' shelf, sorted by player", () => {
  it("files the cards by the first player's last name, then first name", () => {
    renderShelf();
    fireEvent.change(within(shelf()).getByRole("combobox", { name: "Sort by" }), { target: { value: "player" } });
    const labels = cardNames();
    expect(labels.length).toBeGreaterThan(1);
    // The first player on each card, as its label reads ("… #12 Elly De La Cruz, have").
    const players = labels.map((l) => /#\S+ (.+?)(?:,| \/ )/.exec(l)?.[1] ?? "");
    expect(players).toEqual([...players].sort(comparePlayerNames));
    // Not first-name order: Josh Allen files before Jayden Daniels, and Elly De La Cruz under D.
    expect(players).toEqual(expect.arrayContaining(["Josh Allen", "Jayden Daniels", "Elly De La Cruz", "Brett Favre"]));
    expect(players.indexOf("Josh Allen")).toBeLessThan(players.indexOf("Jayden Daniels"));
    expect(players.indexOf("Jayden Daniels")).toBeLessThan(players.indexOf("Elly De La Cruz"));
    expect(players.indexOf("Elly De La Cruz")).toBeLessThan(players.indexOf("Brett Favre"));
  });
});
