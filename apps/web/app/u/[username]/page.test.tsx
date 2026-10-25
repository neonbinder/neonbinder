/**
 * NEO-360 — the profile's shelf: a tile per public binder, then the public
 * shelves that have something on them, and nothing at all when there is none.
 */

import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ProfileShelf } from "./page";

const EMPTY = { binders: [], wantList: false, trade: false, forSale: false };

function renderShelf(shelves: Parameters<typeof ProfileShelf>[0]["shelves"]) {
  return render(
    <MemoryRouter>
      <ProfileShelf username="ace" shelves={shelves} />
    </MemoryRouter>,
  );
}

describe("ProfileShelf", () => {
  it("lists each public binder, then the public shelves, each linked", () => {
    renderShelf({
      binders: [{ name: "Ohtani rainbow", slug: "ohtani-rainbow", count: { copies: 3, lines: 2 } }],
      wantList: false,
      trade: true,
      forSale: true,
    });
    const shelf = within(screen.getByRole("region", { name: "Collection" }));
    const links = shelf.getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/u/ace/binders/ohtani-rainbow",
      "/u/ace/up-for-trade",
      "/u/ace/for-sale",
    ]);
    expect(links[0].textContent).toBe("Ohtani rainbow3 cards");
    expect(shelf.queryByRole("link", { name: "Want List" })).toBeNull();
  });

  it("a single card reads as one card", () => {
    renderShelf({ ...EMPTY, binders: [{ name: "One", slug: "one-binder", count: { copies: 1, lines: 1 } }] });
    expect(screen.getByText("1 card")).toBeTruthy();
  });

  it("renders nothing when nothing is public", () => {
    const { container } = renderShelf(EMPTY);
    expect(container.textContent).toBe("");
  });
});
