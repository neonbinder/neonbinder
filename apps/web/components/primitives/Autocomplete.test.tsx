/**
 * NEO-147 — unit tests for the shared Autocomplete (ARIA 1.2 combobox).
 *
 * "Fully keyboard operable" is an acceptance criterion on the ticket, so the
 * keyboard contract is asserted here rather than left to a manual pass:
 * ↑/↓ move, Home/End jump, Enter confirms, Escape cancels.
 *
 * Two of these lock in behaviour that is easy to regress and invisible until
 * it bites:
 *
 *  - **Escape only stops propagating while the list is open.** Carried over
 *    from `CareerTeamEntry`; if this leaks, a host dialog's Escape-to-cancel
 *    dies while the combobox merely has focus.
 *  - **`aria-activedescendant` tracks the highlight.** Its absence is the gap
 *    in the four typeaheads this replaces — a screen reader announced that a
 *    listbox existed but never which row was highlighted.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import React, { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Autocomplete } from "./Autocomplete";

type Row = { id: string; name: string; sport?: string };

const ROWS: Row[] = [
  { id: "1", name: "Ken Griffey Jr.", sport: "Baseball" },
  { id: "2", name: "Ken Caminiti", sport: "Baseball" },
  { id: "3", name: "Kenny Lofton", sport: "Baseball" },
];

function Harness({
  items = ROWS,
  onSelect = vi.fn(),
  loading = false,
  initialQuery = "Ken",
}: {
  items?: Row[];
  onSelect?: (row: Row) => void;
  loading?: boolean;
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  return (
    <Autocomplete<Row>
      query={query}
      onQueryChange={setQuery}
      items={items}
      getKey={(r) => r.id}
      getLabel={(r) => r.name}
      getDescription={(r) => r.sport}
      onSelect={onSelect}
      label="Player name"
      loading={loading}
    />
  );
}

const input = () => screen.getByLabelText("Player name");
const openList = () => fireEvent.focus(input());

describe("Autocomplete — keyboard", () => {
  it("moves the highlight with ArrowDown and ArrowUp", () => {
    render(<Harness />);
    openList();

    // The first row starts highlighted, so one ArrowDown lands on the second.
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(screen.getByText("Ken Caminiti").closest("li")!.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(screen.getByText("Ken Griffey Jr.").closest("li")!.getAttribute("aria-selected")).toBe("true");
  });

  it("clamps the highlight at both ends rather than wrapping", () => {
    render(<Harness />);
    openList();

    for (let i = 0; i < 10; i += 1) {
      fireEvent.keyDown(input(), { key: "ArrowDown" });
    }
    expect(screen.getByText("Kenny Lofton").closest("li")!.getAttribute("aria-selected")).toBe("true");

    for (let i = 0; i < 10; i += 1) {
      fireEvent.keyDown(input(), { key: "ArrowUp" });
    }
    expect(screen.getByText("Ken Griffey Jr.").closest("li")!.getAttribute("aria-selected")).toBe("true");
  });

  it("jumps to the ends with Home and End", () => {
    render(<Harness />);
    openList();

    fireEvent.keyDown(input(), { key: "End" });
    expect(screen.getByText("Kenny Lofton").closest("li")!.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input(), { key: "Home" });
    expect(screen.getByText("Ken Griffey Jr.").closest("li")!.getAttribute("aria-selected")).toBe("true");
  });

  it("confirms the highlighted row with Enter", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    openList();

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].name).toBe("Ken Caminiti");
  });

  it("closes on Escape without selecting anything", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    openList();
    expect(screen.getByRole("listbox")).toBeTruthy();

    fireEvent.keyDown(input(), { key: "Escape" });

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("lets Escape reach a host dialog when the list is closed", () => {
    // The list is closed here because the query is empty, not because the user
    // dismissed it — a host's Escape-to-cancel must still fire.
    const onHostEscape = vi.fn();
    render(
      <div onKeyDown={onHostEscape}>
        <Harness initialQuery="" />
      </div>,
    );

    fireEvent.keyDown(input(), { key: "Escape" });

    expect(onHostEscape).toHaveBeenCalled();
  });

  it("stops Escape from reaching a host dialog while the list is open", () => {
    const onHostEscape = vi.fn();
    render(
      <div onKeyDown={onHostEscape}>
        <Harness />
      </div>,
    );
    openList();

    fireEvent.keyDown(input(), { key: "Escape" });

    expect(onHostEscape).not.toHaveBeenCalled();
  });
});

describe("Autocomplete — ARIA", () => {
  it("wires the combobox to its listbox", () => {
    render(<Harness />);
    openList();

    const combobox = input();
    expect(combobox!.getAttribute("role")).toBe("combobox");
    expect(combobox!.getAttribute("aria-autocomplete")).toBe("list");
    expect(combobox!.getAttribute("aria-expanded")).toBe("true");
    expect(combobox.getAttribute("aria-controls")).toBe(
      screen.getByRole("listbox").getAttribute("id"),
    );
  });

  it("points aria-activedescendant at the highlighted option", () => {
    render(<Harness />);
    openList();
    fireEvent.keyDown(input(), { key: "ArrowDown" });

    const active = input().getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    expect(screen.getByText("Ken Caminiti").closest("li")!.getAttribute("id")).toBe(
      active,
    );
  });

  it("reports expanded whenever the popup is shown, results or not", () => {
    // aria-expanded tracks popup VISIBILITY, not result count. The empty state
    // renders a real listbox holding a disabled "No matches" option, so
    // reporting collapsed would contradict both what the user sees and the
    // aria-controls element being present in the accessibility tree.
    render(<Harness items={[]} />);
    openList();
    expect(input()!.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("reports collapsed before the user types, when no popup exists", () => {
    render(<Harness initialQuery="" />);
    openList();
    expect(input()!.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("Autocomplete — states", () => {
  it("shows nothing at all until the user types", () => {
    render(<Harness initialQuery="" />);
    openList();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("distinguishes a search in flight from an empty result", () => {
    const { rerender } = render(<Harness items={[]} loading />);
    openList();
    expect(screen.getByText("Searching…")).toBeTruthy();

    rerender(<Harness items={[]} loading={false} />);
    expect(screen.getByText("No matches")).toBeTruthy();
  });

  it("selects on mouse down, before the input's blur can close the list", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    openList();

    fireEvent.mouseDown(screen.getByText("Kenny Lofton"));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].name).toBe("Kenny Lofton");
  });

  it("resets the highlight when the result set changes", () => {
    // Arrowing to row 3 and then typing another character must not leave the
    // highlight past the end of a shorter list.
    const { rerender } = render(<Harness />);
    openList();
    fireEvent.keyDown(input(), { key: "End" });

    rerender(<Harness items={[ROWS[0]]} />);

    expect(screen.getByText("Ken Griffey Jr.").closest("li")!.getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the highlight when a caller rebuilds an equal array inline", () => {
    // `items={rows.filter(...)}` is the natural way to write a caller, and it
    // yields a new array identity on every render. If the reset keyed on
    // identity, moving the highlight would trigger the re-render that undoes
    // it, and arrow keys would look completely dead.
    const { rerender } = render(<Harness items={[...ROWS]} />);
    openList();
    fireEvent.keyDown(input(), { key: "ArrowDown" });

    rerender(<Harness items={[...ROWS]} />);

    expect(screen.getByText("Ken Caminiti").closest("li")!.getAttribute("aria-selected")).toBe("true");
  });
});
