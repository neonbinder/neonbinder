/**
 * NEO-334 — the set builder's last column, Sub-Variants (level `parallel`,
 * "+ Custom" only since NEO-425), exists ONLY when the selected variant
 * type is an Insert type. Never under Base, a Parallel type, a Promo type, or
 * a type with no kind (Jason, 2026-10-10).
 *
 * NEO-425 (Jason, 2026-11-03) — and only when the insert HAS sub-variants.
 * Sub-variants are NB-only (no marketplace has them), so the column has no
 * Sync button, and an insert with none is a leaf: no column at all. Whether it
 * has any is read from the same `getSelectorOptions` subscription the
 * column's own list holds; until that answers, the column is not drawn and a
 * `parallel` id in the drill stands.
 *
 * The gate is the variant type's TITLE (NEO-334: "Insert" or "Inserts",
 * read through `variantTypeKind`), never a flag: a type titled "Insert Set"
 * gets no column, and neither does a type titled "Gold". "Group Parallels"
 * lands rows as sub-variants, so it follows the same gate.
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
import { beforeEach, describe, expect, it, vi } from "vitest";

const INSERT_TYPE = {
  _id: "vt-insert",
  value: "Insert",
  platformData: {},
};
/** A hand-made plural title is the same kind. */
const INSERTS_TYPE = {
  _id: "vt-inserts",
  value: "Inserts",
  platformData: {},
};
const PARALLEL_TYPE = {
  _id: "vt-parallel",
  value: "Parallel",
  platformData: {},
};
/** No kind at all, an operator's own name. */
const PROMO_TYPE = {
  _id: "vt-promo",
  value: "Promo",
  platformData: {},
};
/** CONTAINS the word Insert: exact word only, so it has no kind. */
const INSERT_SET_TYPE = {
  _id: "vt-insert-set",
  value: "Insert Set",
  platformData: {},
};
const GOLD_TYPE = {
  _id: "vt-gold",
  value: "Gold",
  platformData: {},
};

const ROWS: Record<string, unknown> = Object.fromEntries(
  [INSERT_TYPE, INSERTS_TYPE, PARALLEL_TYPE, PROMO_TYPE, INSERT_SET_TYPE, GOLD_TYPE].map(
    (r) => [r._id, r],
  ),
);

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptionById: "getSelectorOptionById",
      getAncestorChain: "getAncestorChain",
      getSelectorOptions: "getSelectorOptions",
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

/**
 * What `getSelectorOptions({ level: "parallel", parentId })` answers, per
 * insert: an insert missing from the map is still loading. Tests reassign it;
 * `beforeEach` gives `ins1` one sub-variant.
 */
const subVariants: { byInsert: Record<string, unknown[]> } = { byInsert: {} };
/** Every `getSelectorOptions` args object the page subscribed with. */
const subVariantReads: unknown[] = [];

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (ref === "getSelectorOptions" && args !== "skip") {
      subVariantReads.push(args);
      const { parentId } = args as { parentId: string };
      return subVariants.byInsert[parentId];
    }
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

/**
 * Renders the column's selector and its extra actions, tagged by level, with
 * the two props NEO-425 sets on the Sub-Variants column (the real button row
 * is EntityColumn's, proved in EntityColumn.hideSync.test.tsx).
 */
vi.mock("../SetSelector/ResilientEntityColumn", () => ({
  default: ({
    selector,
    extraActions,
    level,
    hideSync,
    addButtonText,
  }: {
    selector: React.ReactNode;
    extraActions?: React.ReactNode;
    level: string;
    hideSync?: boolean;
    addButtonText: string;
  }) => (
    <div
      data-testid={`column-${level}`}
      data-hide-sync={hideSync ? "yes" : "no"}
      data-noun={addButtonText}
    >
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

beforeEach(() => {
  subVariants.byInsert = { ins1: [{ _id: "par1", value: "Gold" }] };
  subVariantReads.length = 0;
});

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

  it("opens under a hand-made type titled Inserts too", () => {
    renderAt(DRILLED_TO_A_SET);
    pickTypeAndInsert("vt-inserts");

    expect(subVariantColumn()).toBeTruthy();
    expect(groupParallels()).toBeTruthy();
  });

  for (const [label, typeId] of [
    ["a Parallel type", "vt-parallel"],
    ["a type with no kind", "vt-promo"],
    ["a type titled \"Insert Set\" (the exact word decides)", "vt-insert-set"],
    ["a type titled Gold (the title decides)", "vt-gold"],
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

describe("SetSelector — the Sub-Variants column needs sub-variants (NEO-425)", () => {
  it("has no Sync button: the column is passed hideSync, and its noun for + Custom", () => {
    renderAt(DRILLED_TO_A_SET);
    pickTypeAndInsert("vt-insert");

    const column = subVariantColumn();
    expect(column?.getAttribute("data-hide-sync")).toBe("yes");
    // "Add custom Sub-Variants" and the stall banner are named from it.
    expect(column?.getAttribute("data-noun")).toBe("Sub-Variants");
  });

  it("reads the count through the column's own subscription (same args, same key order)", () => {
    renderAt(DRILLED_TO_A_SET);
    pickTypeAndInsert("vt-insert");

    expect(subVariantReads.length).toBeGreaterThan(0);
    for (const args of subVariantReads) {
      expect(JSON.stringify(args)).toBe(
        JSON.stringify({ level: "parallel", parentId: "ins1" }),
      );
    }
  });

  it("an insert with no sub-variants opens no column: it is a leaf with its own checklist", () => {
    subVariants.byInsert = { ins1: [] };
    renderAt(DRILLED_TO_A_SET);
    pickTypeAndInsert("vt-insert");

    // Positive first: the insert is picked and its checklist is open.
    expect(screen.getByTestId("checklist").getAttribute("data-variant-id")).toBe("ins1");
    expect(subVariantColumn()).toBeNull();
    expect(screen.queryByTestId("sub-variant-selector")).toBeNull();
    // Group Parallels stays: it is how an insert gets its first sub-variant.
    expect(groupParallels()).toBeTruthy();
    // The deepest column announced is the inserts column, not a Parallels one.
    expect(screen.getByRole("status").textContent).toBe("Inserts column opened");
  });

  it("draws no column while the sub-variants are still loading", () => {
    subVariants.byInsert = {};
    renderAt(DRILLED_TO_A_SET);
    pickTypeAndInsert("vt-insert");

    expect(screen.getByTestId("checklist").getAttribute("data-variant-id")).toBe("ins1");
    expect(subVariantColumn()).toBeNull();
  });

  it("opens the column when the insert's first rows land (Group Parallels made them)", () => {
    subVariants.byInsert = { ins1: [] };
    const view = renderAt(DRILLED_TO_A_SET);
    pickTypeAndInsert("vt-insert");
    expect(subVariantColumn()).toBeNull();

    subVariants.byInsert = { ins1: [{ _id: "par1", value: "Gold" }] };
    view.rerender(
      <MemoryRouter>
        <SetSelector />
        <LocationProbe />
      </MemoryRouter>,
    );
    expect(subVariantColumn()).toBeTruthy();
  });

  it("does not read sub-variants under a type known not to be an Insert type", () => {
    renderAt(DRILLED_TO_A_SET);
    pickTypeAndInsert("vt-parallel");

    expect(screen.getByTestId("checklist").getAttribute("data-variant-id")).toBe("ins1");
    expect(subVariantReads).toHaveLength(0);
  });
});

describe("SetSelector — a sub-variant in the drill of an insert that has none (NEO-425)", () => {
  it("is dropped from the URL, and the checklist is the insert's", async () => {
    subVariants.byInsert = { ins1: [] };
    renderAt(`${DRILLED_TO_A_SET}&type=vt-insert&insert=ins1&parallel=par1`);

    await waitFor(() => expect(search()).not.toContain("parallel=par1"));
    expect(search()).toContain("insert=ins1");
    expect(subVariantColumn()).toBeNull();
    expect(screen.getByTestId("checklist").getAttribute("data-variant-id")).toBe("ins1");
  });

  it("stands while the sub-variants load, so a real one does not flash its insert's checklist", () => {
    subVariants.byInsert = {};
    renderAt(`${DRILLED_TO_A_SET}&type=vt-insert&insert=ins1&parallel=par1`);

    expect(search()).toContain("parallel=par1");
    expect(screen.getByTestId("checklist").getAttribute("data-variant-id")).toBe("par1");
  });
});
