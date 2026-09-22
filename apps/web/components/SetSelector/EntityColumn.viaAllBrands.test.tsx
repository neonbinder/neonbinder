/**
 * NEO-237 — `EntityColumn`'s manufacturer-level confirm-create step after
 * Jason's preview feedback (2026-09-21): the "SportLots has no brand for this
 * — match its sets by name" checkbox is GONE. The server links every new
 * manufacturer to SportLots through its all-brands option whenever the year
 * can be asked (`addCustomSelectorOption`, no arg), so the confirm carries
 * no control for it in either kind of year, the rehome sentence under the
 * create prompt still says what happens to the year's sets, and the create
 * call passes no flag. The Attributes panel's toggle
 * (`SetAttributesPanel.test.tsx`) is the one door to turn the link off.
 *
 * Also covers the unrelated but adjacent `hideCustom` a11y park: when another
 * column's selection (the All Brands view) swaps "+ Custom" for a plain line,
 * a focused "+ Custom" button unmounting parks focus on the column container
 * rather than dropping it to <body>.
 *
 * Scaffold mirrors `EntityColumn.custom-confirm.test.tsx`.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GenericId } from "convex/values";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type OptionId = GenericId<"selectorOptions">;

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptions: "getSelectorOptions",
      addCustomSelectorOption: "addCustomSelectorOption",
      getAncestorChain: "getAncestorChain",
      findSelectorOptionElsewhere: "findSelectorOptionElsewhere",
    },
  },
}));

const mockAddCustom = vi.fn();
const mockFindElsewhere = vi.fn();
const state: { items: unknown; chain: unknown } = { items: [], chain: undefined };

vi.mock("convex/react", () => ({
  useMutation: () => mockAddCustom,
  useAction: () => vi.fn(),
  useConvex: () => ({
    query: (...args: unknown[]) => mockFindElsewhere(...args),
  }),
  useQuery: (ref: string) =>
    ref === "getAncestorChain" ? state.chain : state.items,
}));

import EntityColumn from "./EntityColumn";

const YEAR_ID = "year-1997" as unknown as OptionId;

/** A chain whose sport AND year both carry SportLots ids. */
const SL_RESOLVABLE_YEAR_CHAIN = [
  {
    _id: "sport-hockey" as unknown as OptionId,
    level: "sport",
    value: "Hockey",
    platformData: { sportlots: { s0: "HK" } },
  },
  {
    _id: YEAR_ID,
    level: "year",
    value: "1997",
    platformData: { sportlots: { s0: "1997" } },
  },
];

/** A chain with NO SportLots ids anywhere. */
const SL_UNRESOLVABLE_YEAR_CHAIN = [
  { _id: "sport-hockey" as unknown as OptionId, level: "sport", value: "Hockey" },
  { _id: YEAR_ID, level: "year", value: "1997" },
];

const EXISTING_ITEMS = [
  { _id: "mfr-existing" as unknown as OptionId, value: "Topps", isCustom: false },
];

/** The removed control's sentence — asserted ABSENT. */
const REMOVED_CONTROL = /SportLots has no brand for this/;

function renderManufacturerColumn() {
  return render(
    <EntityColumn
      selector={<div>selector</div>}
      renderForm={() => <div>form</div>}
      addButtonText="Sync Manufacturers"
      isVisible={true}
      level="manufacturer"
      parentId={YEAR_ID}
    />,
  );
}

async function typeAndSubmit(typed: string) {
  await act(async () => {
    fireEvent.click(screen.getByText("+ Custom"));
  });
  const input = screen.getByPlaceholderText(
    "Enter custom value...",
  ) as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { value: typed } });
  });
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
  });
  return input;
}

describe("EntityColumn — manufacturer confirm-create has no via-All-Brands control (NEO-237, Jason 2026-09-21)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.items = EXISTING_ITEMS;
    state.chain = SL_RESOLVABLE_YEAR_CHAIN;
    mockAddCustom.mockResolvedValue("newly-created-id");
    mockFindElsewhere.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers no control when the chain could be asked (sport + year carry SL ids) — the link is the default", async () => {
    renderManufacturerColumn();
    await typeAndSubmit("Bandai");

    await waitFor(() => {
      expect(screen.getByText(/Create manufacturer 'Bandai'/)).toBeTruthy();
    });
    expect(screen.queryByText(REMOVED_CONTROL)).toBeNull();
    // Nor any pressed-toggle standing in for it.
    expect(document.querySelectorAll("button[aria-pressed]")).toHaveLength(0);
  });

  it("offers no control when the chain has no SportLots ids either", async () => {
    state.chain = SL_UNRESOLVABLE_YEAR_CHAIN;
    renderManufacturerColumn();
    await typeAndSubmit("Bandai");

    await waitFor(() => {
      expect(screen.getByText(/Create manufacturer 'Bandai'/)).toBeTruthy();
    });
    expect(screen.queryByText(REMOVED_CONTROL)).toBeNull();
  });

  it("still says what creating the brand does to the year's sets", async () => {
    renderManufacturerColumn();
    await typeAndSubmit("Bandai");

    await waitFor(() => {
      expect(
        screen.getByText("Sets in Unknown whose names start with 'Bandai' move here."),
      ).toBeTruthy();
    });
  });

  it("does not say it at other levels", async () => {
    render(
      <EntityColumn
        selector={<div>selector</div>}
        renderForm={() => <div>form</div>}
        addButtonText="Sync Sets"
        isVisible={true}
        level="setName"
        parentId={YEAR_ID}
      />,
    );
    await typeAndSubmit("Bandai Carddass");

    await waitFor(() => {
      expect(screen.getByText(/Create set 'Bandai Carddass'/)).toBeTruthy();
    });
    expect(screen.queryByText(/move here\./)).toBeNull();
  });

  it("creates with level, value and parent only — no slViaAllBrands flag, whatever the chain", async () => {
    renderManufacturerColumn();
    await typeAndSubmit("Bandai");
    await screen.findByText(/Create manufacturer 'Bandai'/);

    await act(async () => {
      fireEvent.click(screen.getByText("Create"));
    });

    expect(mockAddCustom).toHaveBeenCalledTimes(1);
    expect(mockAddCustom).toHaveBeenCalledWith({
      level: "manufacturer",
      value: "Bandai",
      parentId: YEAR_ID,
    });
    expect(Object.keys(mockAddCustom.mock.calls[0][0])).not.toContain(
      "slViaAllBrands",
    );
  });

  it("the confirm's only buttons are Create and Back — nothing between the sentence and the decision", async () => {
    renderManufacturerColumn();
    await typeAndSubmit("Bandai");
    await screen.findByText(/Create manufacturer 'Bandai'/);

    const names = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim());
    expect(names).toContain("Create manufacturer");
    expect(names).toContain("Back to manufacturer name");
    expect(names.some((n) => REMOVED_CONTROL.test(n ?? ""))).toBe(false);
  });
});

describe("EntityColumn — hideCustom swap parks focus (NEO-237 a11y)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.items = EXISTING_ITEMS;
    state.chain = SL_RESOLVABLE_YEAR_CHAIN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parks focus on the column container when a focused '+ Custom' unmounts", () => {
    const { rerender, container } = render(
      <EntityColumn
        selector={<div>selector</div>}
        renderForm={() => <div>form</div>}
        addButtonText="Sync Sets"
        isVisible={true}
        level="setName"
        parentId={YEAR_ID}
      />,
    );

    const openCustom = screen.getByText("+ Custom");
    openCustom.focus();
    expect(document.activeElement).toBe(openCustom);
    // Simulate focus falling to <body>, the way a real unmount does when
    // nothing else claims it — the effect only parks when this is true.
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);

    rerender(
      <EntityColumn
        selector={<div>selector</div>}
        renderForm={() => <div>form</div>}
        addButtonText="Sync Sets"
        isVisible={true}
        level="setName"
        parentId={YEAR_ID}
        hideCustom={{ reason: "Pick a brand to add a set" }}
      />,
    );

    expect(screen.queryByText("+ Custom")).toBeNull();
    expect(screen.getByText("Pick a brand to add a set")).toBeTruthy();
    const outer = container.querySelector('[tabindex="-1"]');
    expect(document.activeElement).toBe(outer);
  });

  it("does NOT steal focus the operator has already moved elsewhere", () => {
    const { rerender } = render(
      <EntityColumn
        selector={<div>selector</div>}
        renderForm={() => <div>form</div>}
        addButtonText="Sync Sets"
        isVisible={true}
        level="setName"
        parentId={YEAR_ID}
      />,
    );

    const openCustom = screen.getByText("+ Custom");
    openCustom.focus();
    // Focus goes somewhere else in the document instead of <body>.
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);

    rerender(
      <EntityColumn
        selector={<div>selector</div>}
        renderForm={() => <div>form</div>}
        addButtonText="Sync Sets"
        isVisible={true}
        level="setName"
        parentId={YEAR_ID}
        hideCustom={{ reason: "Pick a brand to add a set" }}
      />,
    );

    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});
