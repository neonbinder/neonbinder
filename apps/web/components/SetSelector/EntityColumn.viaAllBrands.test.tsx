/**
 * NEO-237 — `EntityColumn`'s manufacturer-level confirm-create control:
 * "Link to SportLots through All Brands", offered only when the parent chain
 * could actually be asked (`resolvableSides(parentChain, { level:
 * "manufacturer" }).sportlots.resolvable` — the SAME gate the sync itself
 * uses), wired to `slViaAllBrands: true` on create, reset on Back/Cancel, and
 * the rehome sentence under the create prompt.
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

/** A chain whose sport AND year both carry SportLots ids — the control's gate. */
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

/** A chain with NO SportLots ids anywhere — the control must not appear. */
const SL_UNRESOLVABLE_YEAR_CHAIN = [
  { _id: "sport-hockey" as unknown as OptionId, level: "sport", value: "Hockey" },
  { _id: YEAR_ID, level: "year", value: "1997" },
];

const EXISTING_ITEMS = [
  { _id: "mfr-existing" as unknown as OptionId, value: "Topps", isCustom: false },
];

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

describe("EntityColumn — via-All-Brands confirm-create control (NEO-237)", () => {
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

  it("is offered when the chain could actually be asked (sport + year carry SL ids)", async () => {
    renderManufacturerColumn();
    await typeAndSubmit("Bandai");

    await waitFor(() => {
      expect(screen.getByText(/SportLots has no brand for this/)).toBeTruthy();
    });
  });

  it("is HIDDEN — not disabled — when the chain has no SportLots ids at all", async () => {
    state.chain = SL_UNRESOLVABLE_YEAR_CHAIN;
    renderManufacturerColumn();
    await typeAndSubmit("Bandai");

    await waitFor(() => {
      expect(screen.getByText(/Create manufacturer 'Bandai'/)).toBeTruthy();
    });
    expect(screen.queryByText(/SportLots has no brand for this/)).toBeNull();
  });

  it("carries aria-pressed and toggles on click", async () => {
    renderManufacturerColumn();
    await typeAndSubmit("Bandai");

    const toggle = await screen.findByText(/SportLots has no brand for this/);
    const button = toggle.closest("button")!;
    expect(button.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("passes slViaAllBrands: true on create only when the control was turned ON", async () => {
    renderManufacturerColumn();
    await typeAndSubmit("Bandai");

    const toggle = await screen.findByText(/SportLots has no brand for this/);
    fireEvent.click(toggle.closest("button")!);

    await act(async () => {
      fireEvent.click(screen.getByText("Create"));
    });

    expect(mockAddCustom).toHaveBeenCalledWith({
      level: "manufacturer",
      value: "Bandai",
      parentId: YEAR_ID,
      slViaAllBrands: true,
    });
  });

  it("does NOT pass slViaAllBrands when the control was left off", async () => {
    renderManufacturerColumn();
    await typeAndSubmit("Bandai");
    await screen.findByText(/SportLots has no brand for this/);

    await act(async () => {
      fireEvent.click(screen.getByText("Create"));
    });

    expect(mockAddCustom).toHaveBeenCalledWith({
      level: "manufacturer",
      value: "Bandai",
      parentId: YEAR_ID,
    });
  });

  it("resets to off after Back to manufacturer name", async () => {
    renderManufacturerColumn();
    await typeAndSubmit("Bandai");

    const toggle = await screen.findByText(/SportLots has no brand for this/);
    fireEvent.click(toggle.closest("button")!);
    expect(toggle.closest("button")!.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Back to manufacturer name" }),
      );
    });
    // Back returns to the INPUT stage (value still filled) — submit again
    // rather than reopening "+ Custom", which is not on screen mid-form.
    const input = screen.getByPlaceholderText(
      "Enter custom value...",
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    const toggleAgain = await screen.findByText(/SportLots has no brand for this/);
    expect(toggleAgain.closest("button")!.getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("resets to off after Cancel and re-opening", async () => {
    renderManufacturerColumn();
    await typeAndSubmit("Bandai");
    const toggle = await screen.findByText(/SportLots has no brand for this/);
    fireEvent.click(toggle.closest("button")!);

    // Back to the input stage, then Cancel closes the form entirely.
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Back to manufacturer name" }),
      );
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Cancel new manufacturer" }),
      );
    });
    await typeAndSubmit("Bandai");

    const toggleAgain = await screen.findByText(/SportLots has no brand for this/);
    expect(toggleAgain.closest("button")!.getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("shows the rehome sentence under the create prompt at manufacturer level", async () => {
    renderManufacturerColumn();
    await typeAndSubmit("Bandai");

    await waitFor(() => {
      expect(
        screen.getByText("Sets in Unknown whose names start with 'Bandai' move here."),
      ).toBeTruthy();
    });
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
