/**
 * NEO-306 — the shared set-shape dialog: it fits under the site's sticky
 * header (the title was hidden under it at the 1024×629 E2E viewport), its
 * description is optional, and `ChoiceList` folds a settled answer to one
 * line with a `Change` button, reporting a deliberate pick (click / Enter)
 * apart from arrow-key browsing.
 *
 * The owners' flows (which list folds when, where focus goes next) are
 * covered in `MakeInsertControl.test.tsx` and `MakeParallelControl.test.tsx`.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import React, { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANGE_LABEL, ChoiceList, SetShapeDialog, type Choice } from "./SetShapeDialog";

afterEach(() => {
  document.querySelectorAll("header[data-test-header]").forEach((h) => h.remove());
});

function dialogProps(overrides: Partial<React.ComponentProps<typeof SetShapeDialog>> = {}) {
  return {
    title: "Make “Red Ink” an insert",
    confirmLabel: "Make it an insert",
    busyLabel: "Moving…",
    busy: false,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

/** A page header pinned to the top edge, `bottom` pixels tall. */
function stickyHeader(bottom: number, position = "sticky") {
  const header = document.createElement("header");
  header.setAttribute("data-test-header", "");
  header.style.position = position;
  header.getBoundingClientRect = () =>
    ({ top: 0, bottom, left: 0, right: 1024, width: 1024, height: bottom, x: 0, y: 0 }) as DOMRect;
  document.body.prepend(header);
}

describe("SetShapeDialog — fits under the site header", () => {
  it("pads the overlay's top by the sticky header's bottom plus the 1rem margin", () => {
    stickyHeader(78);
    render(<SetShapeDialog {...dialogProps()} />);
    expect(screen.getByRole("dialog").style.paddingTop).toBe("94px");
  });

  it("ignores a header that scrolls with the page", () => {
    stickyHeader(78, "static");
    render(<SetShapeDialog {...dialogProps()} />);
    expect(screen.getByRole("dialog").style.paddingTop).toBe("16px");
  });

  it("re-measures when the viewport resizes (a phone's header wraps taller)", () => {
    stickyHeader(78);
    render(<SetShapeDialog {...dialogProps()} />);
    document.querySelector<HTMLElement>("header[data-test-header]")!.getBoundingClientRect = () =>
      ({ top: 0, bottom: 120 }) as DOMRect;
    fireEvent(window, new Event("resize"));
    expect(screen.getByRole("dialog").style.paddingTop).toBe("136px");
  });

  it("the panel is bounded by what the overlay leaves, with only the middle scrolling", () => {
    render(<SetShapeDialog {...dialogProps({ preview: <p>Bowman › Insert</p> })} />);
    const heading = screen.getByRole("heading", { name: "Make “Red Ink” an insert" });
    const panel = heading.parentElement!.parentElement!;
    expect(panel.className).toContain("max-h-full");
    expect(panel.className).not.toContain("90vh");
    // Title block, then the one scroller, then the pinned preview and buttons.
    const [, body] = Array.from(panel.children) as HTMLElement[];
    expect(body.className).toContain("overflow-y-auto");
  });
});

describe("SetShapeDialog — description is optional", () => {
  it("with none, renders no paragraph and no aria-describedby", () => {
    render(<SetShapeDialog {...dialogProps()} />);
    expect(screen.getByRole("dialog").getAttribute("aria-describedby")).toBeNull();
  });

  it("with one, describes the dialog by it, and by a refusal too", () => {
    render(<SetShapeDialog {...dialogProps({ description: "Lifts it out.", error: "Nope." })} />);
    const ids = (screen.getByRole("dialog").getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual([
      "Lifts it out.",
      "Nope.",
    ]);
  });
});

const CHOICES: Choice[] = [
  { id: "a", label: "Bowman", ariaLabel: "Insert of Bowman" },
  { id: "b", label: "Bowman Chrome", ariaLabel: "Insert of Bowman Chrome" },
];

/** A ChoiceList owner that folds on a pick and unfolds on Change. */
function Harness({ onPick }: { onPick?: (id: string) => void }) {
  const [selected, setSelected] = useState("a");
  const [folded, setFolded] = useState(true);
  return (
    <ChoiceList
      legend="Insert of"
      choices={CHOICES}
      selectedId={selected}
      onSelect={setSelected}
      onPick={(id) => {
        onPick?.(id);
        setFolded(true);
      }}
      filterLabel="Find a set"
      collapsed={folded}
      changeLabel="Change insert of"
      onExpand={() => setFolded(false)}
    />
  );
}

describe("ChoiceList — folding", () => {
  it("folded, it is one line of text and a Change button, not a radio group", () => {
    render(<Harness />);
    expect(screen.getByText("Insert of: Bowman")).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    const change = screen.getByRole("button", { name: "Change insert of" });
    expect(change.textContent).toBe(CHANGE_LABEL);
    expect(change.getAttribute("id")).toBeNull();
  });

  it("Change (click or a synthetic Enter) unfolds it with the choice still checked", () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Change insert of" }), { key: "Enter" });
    expect(screen.getByRole("radiogroup", { name: "Insert of" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Insert of Bowman" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("a click or Enter is a pick; an arrow key is not", () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: "Change insert of" }));
    fireEvent.keyDown(screen.getByRole("radio", { name: "Insert of Bowman" }), { key: "ArrowDown" });
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByRole("radiogroup", { name: "Insert of" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("radio", { name: "Insert of Bowman Chrome" }), {
      key: "Enter",
    });
    expect(onPick).toHaveBeenCalledWith("b");
    expect(screen.getByText("Insert of: Bowman Chrome")).toBeTruthy();
  });

  it("never folds while nothing is chosen", () => {
    render(
      <ChoiceList
        legend="Insert of"
        choices={CHOICES}
        selectedId={null}
        onSelect={vi.fn()}
        filterLabel="Find a set"
        collapsed
        changeLabel="Change insert of"
        onExpand={vi.fn()}
      />,
    );
    expect(screen.getByRole("radiogroup", { name: "Insert of" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change insert of" })).toBeNull();
  });

  it("takeFocus lands on Change when folded and on the checked radio when open, once", () => {
    const onTookFocus = vi.fn();
    const props = {
      legend: "Insert of",
      choices: CHOICES,
      selectedId: "b",
      onSelect: vi.fn(),
      filterLabel: "Find a set",
      changeLabel: "Change insert of",
      onExpand: vi.fn(),
      takeFocus: true,
      onTookFocus,
    };
    const { rerender } = render(<ChoiceList {...props} collapsed />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Change insert of" }));
    rerender(<ChoiceList {...props} collapsed={false} />);
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Insert of Bowman Chrome" }));
    expect(onTookFocus).toHaveBeenCalled();
  });
});
