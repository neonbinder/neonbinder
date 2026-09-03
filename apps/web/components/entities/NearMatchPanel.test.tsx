/**
 * NEO-212 — the shared "is it one of these?" panel.
 *
 * Four things are locked in here, and each of them is load-bearing somewhere
 * the panel itself cannot see:
 *
 *  - **The default pick label is `Link to {name}`.** The entity-review wizard's
 *    Maestro flows tap exactly that string. A well-meaning rename to something
 *    neutral would break E2E with no local test failing, so the default is
 *    asserted verbatim rather than left to the caller.
 *  - **Exact matches sort first and are tagged.** An exact normalized-name
 *    match is the duplicate the panel exists to prevent; buried three rows down
 *    it may as well not be there.
 *  - **Nothing renders when there is nothing to show** — no empty "Possible
 *    matches" heading flickering while a query is in flight.
 *  - **`hasExact` is exported**, because the caller (not this panel) owns the
 *    consequence — the admin add form demotes its create button on it.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NearMatchPanel, hasExact, type NearMatch } from "./NearMatchPanel";

const close: NearMatch = { _id: "p1", name: "Ken Griffey", confidence: "close" };
const exact: NearMatch = {
  _id: "p2",
  name: "Ken Griffey Jr.",
  confidence: "exact",
};

describe("NearMatchPanel", () => {
  it("renders nothing while there are no matches", () => {
    const { rerender } = render(
      <NearMatchPanel kind="player" matches={undefined} onPick={vi.fn()} />,
    );
    expect(screen.queryByText("Possible matches")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();

    rerender(<NearMatchPanel kind="player" matches={[]} onPick={vi.fn()} />);
    expect(screen.queryByText("Possible matches")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("keeps the live region mounted before there is anything to announce", () => {
    // The reason is the same one primitives/CopyButton documents: a live region
    // inserted at the instant its text appears is announced unreliably. It has
    // to be there, empty, first.
    const { container, rerender } = render(
      <NearMatchPanel kind="player" matches={undefined} onPick={vi.fn()} />,
    );
    const region = container.querySelector("[aria-live='polite']");
    expect(region).not.toBeNull();
    expect(region?.textContent).toBe("");

    rerender(
      <NearMatchPanel kind="player" matches={[close, exact]} onPick={vi.fn()} />,
    );
    expect(
      container.querySelector("[aria-live='polite']")?.textContent,
    ).toBe("2 possible matches");

    rerender(
      <NearMatchPanel kind="player" matches={[exact]} onPick={vi.fn()} />,
    );
    expect(
      container.querySelector("[aria-live='polite']")?.textContent,
    ).toBe("1 possible match");
  });

  it("puts exact matches first and tags them", () => {
    render(
      // Deliberately supplied close-first, so passing could not be an accident
      // of the input order.
      <NearMatchPanel kind="player" matches={[close, exact]} onPick={vi.fn()} />,
    );
    expect(screen.getByText("Possible matches")).toBeTruthy();

    const names = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual([
      "Link to Ken Griffey Jr.",
      "Link to Ken Griffey",
    ]);

    // Only the exact row carries the tag.
    expect(screen.getAllByText("same name")).toHaveLength(1);
  });

  it("names the list by kind", () => {
    const { rerender } = render(
      <NearMatchPanel kind="player" matches={[exact]} onPick={vi.fn()} />,
    );
    expect(screen.getByRole("list", { name: "Possible player matches" })).toBeTruthy();

    rerender(<NearMatchPanel kind="team" matches={[exact]} onPick={vi.fn()} />);
    expect(screen.getByRole("list", { name: "Possible team matches" })).toBeTruthy();
  });

  it("uses a caller-supplied pick label", () => {
    render(
      <NearMatchPanel
        kind="player"
        matches={[exact]}
        onPick={vi.fn()}
        pickLabel={(n) => `Open ${n}`}
      />,
    );
    expect(screen.getByLabelText("Open Ken Griffey Jr.")).toBeTruthy();
    expect(screen.queryByLabelText("Link to Ken Griffey Jr.")).toBeNull();
  });

  it("hands the picked id AND name back", () => {
    const onPick = vi.fn();
    render(
      <NearMatchPanel kind="player" matches={[close, exact]} onPick={onPick} />,
    );
    fireEvent.click(screen.getByLabelText("Link to Ken Griffey"));
    expect(onPick).toHaveBeenCalledWith("p1", "Ken Griffey");
  });
});

describe("hasExact", () => {
  it("is false for nothing, for an empty list, and for close-only", () => {
    expect(hasExact(undefined)).toBe(false);
    expect(hasExact([])).toBe(false);
    expect(hasExact([close])).toBe(false);
  });

  it("is true as soon as one match is exact", () => {
    expect(hasExact([close, exact])).toBe(true);
  });
});
