/**
 * NEO-425 — `hideSync`: a column whose rows exist only in NB (Sub-Variants:
 * no marketplace has them) has nothing to sync. It shows no "Sync <X>"
 * button, never auto-opens the legacy sync form when it opens empty, and
 * keeps "+ Custom", still named from the column's noun.
 *
 * Mocking mirrors EntityColumn.field-class.test.tsx, except that `useQuery`
 * answers by reference so the column's own list can be empty.
 */

import { render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptions: "getSelectorOptions",
      addCustomSelectorOption: "addCustomSelectorOption",
    },
  },
}));

/** What the column's own `getSelectorOptions` answers. */
let items: unknown[] | undefined;

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useConvex: () => ({ query: vi.fn() }),
  useAction: () => vi.fn(),
  useQuery: (ref: string, args: unknown) =>
    args !== "skip" && ref === "getSelectorOptions" ? items : undefined,
}));

import EntityColumn from "./EntityColumn";

const PARENT = "insert-1" as never;

beforeEach(() => {
  items = [{ _id: "p1", value: "Gold" }];
});

describe("EntityColumn — hideSync (NEO-425)", () => {
  it("draws no Sync button, and keeps + Custom named from the noun", () => {
    render(
      <EntityColumn
        selector={<div>selector</div>}
        addButtonText="Sub-Variants"
        hideSync
        isVisible
        level="parallel"
        parentId={PARENT}
      />,
    );

    // Positive first: the column's button row is drawn.
    expect(
      screen.getByRole("button", { name: "Add custom Sub-Variants" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Sync/ })).toBeNull();
    expect(screen.queryByText("Sub-Variants")).toBeNull();
  });

  it("opening empty does not auto-open a sync form", () => {
    items = [];
    const renderForm = vi.fn(() => <div>sync form</div>);
    render(
      <EntityColumn
        selector={<div>selector</div>}
        renderForm={renderForm}
        addButtonText="Sub-Variants"
        hideSync
        isVisible
        level="parallel"
        parentId={PARENT}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Add custom Sub-Variants" }),
    ).toBeTruthy();
    expect(renderForm).not.toHaveBeenCalled();
    expect(screen.queryByText("sync form")).toBeNull();
  });

  it("without it, an empty legacy column still auto-opens its sync form (the control)", () => {
    items = [];
    render(
      <EntityColumn
        selector={<div>selector</div>}
        renderForm={() => <div>sync form</div>}
        addButtonText="Sync Inserts"
        isVisible
        level="insert"
        parentId={PARENT}
      />,
    );

    expect(screen.getByText("sync form")).toBeTruthy();
  });

  it("without it, the Sync button is drawn (the control)", () => {
    render(
      <EntityColumn
        selector={<div>selector</div>}
        renderForm={() => <div>sync form</div>}
        addButtonText="Sync Inserts"
        isVisible
        level="insert"
        parentId={PARENT}
      />,
    );

    expect(screen.getByRole("button", { name: "Sync Inserts" })).toBeTruthy();
  });
});
