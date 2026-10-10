/**
 * NEO-334 — the set builder's last column, Sub-Variants (level `parallel`,
 * "Sync Sub-Variants" / "+ Custom"), exists ONLY when the selected variant
 * type is an Insert type. Never under Base, a Parallel type, a Promo type, or
 * a type with no role (Jason, 2026-10-10).
 *
 * The gate is the variant type's NB role (`metadata.variantRole === "insert"`,
 * read through `variantTypeRole`), never its name: a roleless row NAMED
 * "Insert" gets no column. "Group Parallels" lands rows as sub-variants, so it
 * follows the same gate.
 *
 * A `parallel` id left in the drill under a type that is not an Insert type
 * (a stale link) must not leave the page half-built: the checklist falls back
 * to the insert and the id is cleared from the URL.
 *
 * Mocking mirrors SetSelector.baseParallels.test.tsx: every column child is a
 * stub and `useQuery` is routed by reference string.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";

const INSERT_TYPE = {
  _id: "vt-insert",
  value: "Insert",
  metadata: { variantRole: "insert" },
  platformData: {},
};
const PARALLEL_TYPE = {
  _id: "vt-parallel",
  value: "Parallel",
  metadata: { variantRole: "parallel" },
  platformData: {},
};
/** No role at all, an operator's own name. */
const PROMO_TYPE = {
  _id: "vt-promo",
  value: "Promo",
  metadata: {},
  platformData: {},
};
/** NAMED "Insert" with no role recorded: a label is just a label. */
const LOOKALIKE_INSERT = {
  _id: "vt-lookalike",
  value: "Insert",
  platformData: {},
};

const ROWS: Record<string, unknown> = Object.fromEntries(
  [INSERT_TYPE, PARALLEL_TYPE, PROMO_TYPE, LOOKALIKE_INSERT].map((r) => [r._id, r]),
);

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptionById: "getSelectorOptionById",
      getAncestorChain: "getAncestorChain",
    },
    parallelChecklistBuild: {
      getParallelsForBuild: "getParallelsForBuild",
      buildParallelChecklist: "buildParallelChecklist",
    },
    drillPath: {
      resolveDrillPath: "resolveDrillPath",
    },
  },
}));

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    // Every id is "valid" here, so the resolver answers with the whole path:
    // the page itself, not the resolver, has to cope with a stale parallel.
    if (ref === "resolveDrillPath" && args !== "skip") {
      return (args as { ids: string[] }).ids.map((_id) => ({ _id }));
    }
    if (args === "skip") return undefined;
    if (ref === "getSelectorOptionById") {
      const id = (args as { id: string } | undefined)?.id;
      return id ? (ROWS[id] ?? null) : undefined;
    }
    if (ref === "getAncestorChain") return [];
    if (ref === "getParallelsForBuild") return undefined;
    return undefined;
  },
  useConvex: () => ({ query: vi.fn(), action: vi.fn() }),
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
}));

vi.mock("../../convex/bscFacets", () => ({
  bscSourceView: () => ({ sources: [] }),
}));

/** Renders the column's selector and its extra actions, tagged by level. */
vi.mock("../SetSelector/ResilientEntityColumn", () => ({
  default: ({
    selector,
    extraActions,
    level,
  }: {
    selector: React.ReactNode;
    extraActions?: React.ReactNode;
    level: string;
  }) => (
    <div data-testid={`column-${level}`}>
      {selector}
      {extraActions}
    </div>
  ),
}));

vi.mock("../SetSelector/SetVariantSelector", () => ({
  default: ({ onVariantTypeSelect }: { onVariantTypeSelect: (id: string) => void }) => (
    <div>
      {Object.keys(ROWS).map((id) => (
        <button key={id} onClick={() => onVariantTypeSelect(id)}>
          {`select-${id}`}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("../SetSelector/VariantSelector", () => ({
  default: ({ onVariantSelect }: { onVariantSelect: (id: string) => void }) => (
    <button onClick={() => onVariantSelect("ins1")}>select-insert</button>
  ),
}));

vi.mock("../SetSelector/ParallelSelector", () => ({
  default: ({
    insertId,
    selectedParallelId,
  }: {
    insertId: string;
    selectedParallelId: string | null;
  }) => (
    <div
      data-testid="sub-variant-selector"
      data-insert-id={insertId}
      data-selected={selectedParallelId ?? ""}
    />
  ),
}));

vi.mock("../SetSelector/CardChecklist", () => ({
  default: (props: { variantId: string }) => (
    <div data-testid="checklist" data-variant-id={props.variantId} />
  ),
}));

vi.mock("../SetSelector/BaseMappingForm", () => ({ default: () => null }));
vi.mock("../SetSelector/SportSelector", () => ({ default: () => null }));
vi.mock("../SetSelector/YearSelector", () => ({ default: () => null }));
vi.mock("../SetSelector/ManufacturerSelector", () => ({ default: () => null }));
vi.mock("../SetSelector/SetSelector", () => ({ default: () => null }));
vi.mock("../SetSelector/YearForm", () => ({ default: () => null }));
vi.mock("../SetSelector/ManufacturerForm", () => ({ default: () => null }));
vi.mock("../SetSelector/SetForm", () => ({ default: () => null }));
vi.mock("../SetSelector/SetVariantForm", () => ({ default: () => null }));
vi.mock("../SetSelector/VariantForm", () => ({ default: () => null }));
vi.mock("../SetSelector/ParallelForm", () => ({ default: () => null }));
vi.mock("../SetSelector/ParallelGroupingModal", () => ({ default: () => null }));
vi.mock("../SetSelector/MultiSourcePanel", () => ({ default: () => null }));
vi.mock("../SetSelector/SetAttributesPanel", () => ({ default: () => null }));
vi.mock("../SetSelector/SportForm", () => ({ SportForm: () => null }));

import SetSelector from "./SetSelector";

/** Prints the router's query string, so a URL correction can be asserted. */
function LocationProbe() {
  const { search } = useLocation();
  return <div data-testid="location" data-search={search} />;
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <SetSelector />
      <LocationProbe />
    </MemoryRouter>,
  );
}

const DRILLED_TO_A_SET = "/?sport=sp&year=yr&brand=br&set=set1";

const pickTypeAndInsert = (typeId: string) => {
  fireEvent.click(screen.getByText(`select-${typeId}`));
  fireEvent.click(screen.getByText("select-insert"));
};

const subVariantColumn = () => screen.queryByTestId("column-parallel");
const groupParallels = () => screen.queryByRole("button", { name: "Group Parallels" });
const search = () => screen.getByTestId("location").getAttribute("data-search") ?? "";

describe("SetSelector — the Sub-Variants column only under an Insert type (NEO-334)", () => {
  it("opens under an insert of an Insert type, with Group Parallels on the inserts column", () => {
    renderAt(DRILLED_TO_A_SET);
    pickTypeAndInsert("vt-insert");

    expect(subVariantColumn()).toBeTruthy();
    expect(
      screen.getByTestId("sub-variant-selector").getAttribute("data-insert-id"),
    ).toBe("ins1");
    expect(groupParallels()).toBeTruthy();
  });

  for (const [label, typeId] of [
    ["a Parallel type", "vt-parallel"],
    ["a type with no role", "vt-promo"],
    ["a roleless type named \"Insert\" (the role decides, never the name)", "vt-lookalike"],
  ] as const) {
    it(`does not open under ${label}: the insert is the end of the cascade`, () => {
      renderAt(DRILLED_TO_A_SET);
      pickTypeAndInsert(typeId);

      expect(subVariantColumn()).toBeNull();
      expect(screen.queryByTestId("sub-variant-selector")).toBeNull();
      expect(groupParallels()).toBeNull();
      // The insert itself is still the selection the checklist works on.
      expect(screen.getByTestId("checklist").getAttribute("data-variant-id")).toBe("ins1");
    });
  }

  it("announces the inserts column, not a Parallels column, as the deepest under a Promo type", () => {
    renderAt(DRILLED_TO_A_SET);
    pickTypeAndInsert("vt-promo");

    expect(screen.getByRole("status").textContent).toBe("Promos column opened");
  });

  it("announces the Parallels column under an Insert type", () => {
    renderAt(DRILLED_TO_A_SET);
    pickTypeAndInsert("vt-insert");

    expect(screen.getByRole("status").textContent).toBe("Parallels column opened");
  });
});

describe("SetSelector — a stale sub-variant in the drill (NEO-334)", () => {
  it("under a Parallel type: the checklist falls back to the insert and the URL drops the parallel", async () => {
    renderAt(`${DRILLED_TO_A_SET}&type=vt-parallel&insert=ins1&parallel=par1`);

    await waitFor(() => expect(search()).not.toContain("parallel=par1"));
    expect(search()).toContain("insert=ins1");
    expect(subVariantColumn()).toBeNull();
    expect(screen.getByTestId("checklist").getAttribute("data-variant-id")).toBe("ins1");
  });

  it("under an Insert type: the sub-variant stays selected and the checklist is its own", () => {
    renderAt(`${DRILLED_TO_A_SET}&type=vt-insert&insert=ins1&parallel=par1`);

    expect(search()).toContain("parallel=par1");
    expect(
      screen.getByTestId("sub-variant-selector").getAttribute("data-selected"),
    ).toBe("par1");
    expect(screen.getByTestId("checklist").getAttribute("data-variant-id")).toBe("par1");
  });
});
