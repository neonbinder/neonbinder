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
  ...picker
}: {
  items?: Row[];
  onSelect?: (row: Row) => void;
  loading?: boolean;
  initialQuery?: string;
} & Pick<
  React.ComponentProps<typeof Autocomplete<Row>>,
  | "openOnEmpty"
  | "selectedKey"
  | "onDismiss"
  | "selectOnFocus"
  | "listMaxHeightClassName"
  | "inputGeometryClassName"
>) {
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
      {...picker}
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

  it("never points aria-controls at a listbox that is not rendered", () => {
    // An IDREF to a missing element is invalid; ARIA 1.2 lets a collapsed
    // combobox omit it. So it comes and goes with the popup.
    render(<Harness />);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input().hasAttribute("aria-controls")).toBe(false);

    openList();
    const id = input().getAttribute("aria-controls");
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)).toBe(screen.getByRole("listbox"));

    fireEvent.keyDown(input(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input().hasAttribute("aria-controls")).toBe(false);
  });

  it("drops aria-controls in the empty-query state a search caller starts in", () => {
    render(<Harness initialQuery="" />);
    openList();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input().hasAttribute("aria-controls")).toBe(false);
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

// ---------------------------------------------------------------------------
// NEO-307 — the picker props (the New Team form's League field)
//
// All optional and all off by default, so the search callers above keep the
// behaviour they were written against. These pin what they add.
// ---------------------------------------------------------------------------

describe("Autocomplete — picker mode", () => {
  const optionFor = (name: string) => screen.getByText(name).closest("li")!;

  it("opens on focus with nothing typed when openOnEmpty is set", () => {
    render(<Harness initialQuery="" openOnEmpty />);
    openList();
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("opens with the highlight on the selected item, not row 0", () => {
    render(<Harness selectedKey="3" />);
    openList();
    expect(optionFor("Kenny Lofton").getAttribute("aria-selected")).toBe("true");
    expect(input().getAttribute("aria-activedescendant")).toBe(
      optionFor("Kenny Lofton").id,
    );
  });

  it("marks the selected item with a check that stays out of its name and text", () => {
    render(<Harness selectedKey="2" />);
    openList();
    const marked = optionFor("Ken Caminiti");
    const mark = marked.querySelector('[aria-hidden="true"]');
    expect(mark?.textContent).toBe("✓");
    // The label is still the option's accessible name, exactly.
    expect(screen.getByRole("option", { name: /^Ken Caminiti/ })).toBe(marked);
    // Every row gets the slot, so labels stay aligned; only one is checked.
    const checks = screen
      .getAllByRole("option")
      .map((o) => o.querySelector('[aria-hidden="true"]')?.textContent);
    expect(checks.map((c) => c ?? "")).toEqual(["", "✓", ""]);
  });

  it("renders no check slot at all without a selectedKey", () => {
    render(<Harness />);
    openList();
    expect(optionFor("Ken Caminiti").querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it("tells the caller when the list is dismissed by blur or Escape, not by a pick", () => {
    const onDismiss = vi.fn();
    const onSelect = vi.fn();
    render(<Harness onDismiss={onDismiss} onSelect={onSelect} />);

    openList();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);

    openList();
    fireEvent.mouseDown(screen.getByText("Kenny Lofton"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    fireEvent.blur(input());
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("does not report a dismissal for Escape on a list that is already shut", () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("selects the text on focus when selectOnFocus is set, so typing replaces it", () => {
    render(<Harness initialQuery="Ken Griffey Jr." selectOnFocus />);
    openList();
    const el = input() as HTMLInputElement;
    expect(el.selectionStart).toBe(0);
    expect(el.selectionEnd).toBe("Ken Griffey Jr.".length);
  });

  it("keeps a click-to-focus selection by cancelling only the first mouseup", () => {
    render(<Harness initialQuery="Ken" selectOnFocus />);
    openList();
    // `false` from fireEvent means preventDefault was called.
    expect(fireEvent.mouseUp(input())).toBe(false);
    // A later click inside the text places the caret normally.
    expect(fireEvent.mouseUp(input())).toBe(true);
  });

  it("leaves mouseup alone without selectOnFocus", () => {
    render(<Harness />);
    openList();
    expect(fireEvent.mouseUp(input())).toBe(true);
  });

  it("reopens on a click after a pick closed the list", () => {
    render(<Harness />);
    openList();
    fireEvent.mouseDown(screen.getByText("Kenny Lofton"));
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.click(input());
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("replaces the list's height cap and the input's geometry rather than stacking them", () => {
    render(
      <Harness
        listMaxHeightClassName="max-h-40"
        inputGeometryClassName="py-1.5 pl-1.5 text-sm"
      />,
    );
    openList();
    const list = screen.getByRole("listbox");
    expect(list.className).toContain("max-h-40");
    expect(list.className).not.toContain("max-h-60");
    expect(input().className).toContain("py-1.5 pl-1.5 text-sm");
    expect(input().className).not.toContain("px-3");
  });

  it("keeps the old cap and geometry by default", () => {
    render(<Harness />);
    openList();
    expect(screen.getByRole("listbox").className).toContain("max-h-60");
    expect(input().className).toContain("px-3 py-2 text-base");
  });

  it("scrolls the highlighted option into view as the arrows move", () => {
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.textContent ?? "");
    };
    try {
      render(<Harness />);
      openList();
      fireEvent.keyDown(input(), { key: "ArrowDown" });
      expect(scrolled.at(-1)).toContain("Ken Caminiti");
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});
