/**
 * NEO-321 — when the set builder shows the "Parallels of Base" section, and
 * what it hands the checklist beneath it.
 *
 * The gate is the selected variant type's NB role (`metadata.variantRole ===
 * "parallel"`, read through `variantTypeRole`), never its name. The fixtures
 * below lean on that: a row NAMED "Parallel" with no role gets no section,
 * and a row named anything at all with the role gets one.
 *
 * Mocking mirrors SetSelector.baseMapping.test.tsx: every column child is a
 * stub, `useQuery` is routed by reference string. Unlike that file, the real
 * `BaseParallelsBuildSection` and the real hosted runner are mounted, because
 * the wiring between them (the start row, the single ledger, the shared plan
 * query) is what this file pins. `CardChecklist` is a stub that prints the
 * props the set builder gave it.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const BASE_ROW = {
  _id: "vt-base",
  value: "Base",
  metadata: { isBase: true },
  platformData: {},
};

/** The Parallel variant type, as the sync flags it. */
const PARALLEL_TYPE = {
  _id: "vt-parallel",
  value: "Parallel",
  metadata: { variantRole: "parallel" },
  platformData: {},
};

/** Same role, an operator's own name: the role is the gate, not the label. */
const PARALLEL_TYPE_RENAMED = {
  _id: "vt-parallel-renamed",
  value: "Shimmer Stuff",
  metadata: { variantRole: "parallel" },
  platformData: {},
};

/** NAMED "Parallel" but flagged insert: a label is just a label. */
const LOOKALIKE_INSERT_TYPE = {
  _id: "vt-lookalike",
  value: "Parallel",
  metadata: { variantRole: "insert" },
  platformData: {},
};

/** NAMED "Parallel" with no role recorded at all. */
const LOOKALIKE_NO_ROLE = {
  _id: "vt-no-role",
  value: "Parallel",
  metadata: {},
  platformData: {},
};

const ROWS: Record<string, unknown> = Object.fromEntries(
  [
    BASE_ROW,
    PARALLEL_TYPE,
    PARALLEL_TYPE_RENAMED,
    LOOKALIKE_INSERT_TYPE,
    LOOKALIKE_NO_ROLE,
  ].map((r) => [r._id, r]),
);

type Plan = {
  parallels: Array<Record<string, unknown>>;
  truncated: boolean;
  source?: { id: string; value: string; kind: "base" | "insert"; hasCards: boolean } | null;
  sourceBlocked?: string;
};

const state: { plan: Plan | undefined } = { plan: undefined };
const planCalls: unknown[] = [];

const mockConvex = {
  query: vi.fn(),
  // Never resolves: the run stays live so the wiring can be observed.
  action: vi.fn(() => new Promise(() => {})),
};

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
    // NEO-224: the drill's URL gate (skipped unless the URL names rows).
    drillPath: {
      resolveDrillPath: "resolveDrillPath",
    },
  },
}));

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    // NEO-224: the drill is read from the URL, and an id the page did not
    // pick itself is checked by `resolveDrillPath` first. Every id is valid
    // here, so the answer is the whole path.
    if (ref === "resolveDrillPath" && args !== "skip") {
      return (args as { ids: string[] }).ids.map((_id) => ({ _id }));
    }
    if (ref === "getParallelsForBuild") {
      planCalls.push(args);
      return args === "skip" ? undefined : state.plan;
    }
    if (args === "skip") return undefined;
    if (ref === "getSelectorOptionById") {
      const id = (args as { id: string } | undefined)?.id;
      return id ? ROWS[id] : undefined;
    }
    if (ref === "getAncestorChain") return [];
    return undefined;
  },
  useConvex: () => mockConvex,
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
}));

vi.mock("../../convex/bscFacets", () => ({
  bscSourceView: () => ({ sources: [] }),
}));

vi.mock("../SetSelector/ResilientEntityColumn", () => ({
  default: ({ selector }: { selector: React.ReactNode }) => <div>{selector}</div>,
}));

vi.mock("../SetSelector/SetVariantSelector", () => ({
  default: ({
    onVariantTypeSelect,
  }: {
    onVariantTypeSelect: (id: string) => void;
  }) => (
    <div>
      {Object.keys(ROWS).map((id) => (
        <button key={id} onClick={() => onVariantTypeSelect(id)}>
          {`select-${id}`}
        </button>
      ))}
    </div>
  ),
}));

/** One selectable row on the Variants column: a base-parallel under the Parallel type. */
vi.mock("../SetSelector/VariantSelector", () => ({
  default: ({ onVariantSelect }: { onVariantSelect: (id: string) => void }) => (
    <button onClick={() => onVariantSelect("row-gold-wave")}>select-row</button>
  ),
}));

/** Prints what the set builder handed the checklist. */
vi.mock("../SetSelector/CardChecklist", () => ({
  default: (props: {
    variantId: string;
    parallelBuild?: unknown;
    parallelPanelElsewhere?: boolean;
  }) => (
    <div
      data-testid="checklist"
      data-variant-id={props.variantId}
      data-parallel-build={JSON.stringify(props.parallelBuild ?? null)}
      data-panel-elsewhere={String(!!props.parallelPanelElsewhere)}
    />
  ),
}));

vi.mock("../SetSelector/BaseMappingForm", () => ({ default: () => null }));
vi.mock("../SetSelector/SportSelector", () => ({ default: () => null }));
vi.mock("../SetSelector/YearSelector", () => ({ default: () => null }));
vi.mock("../SetSelector/ManufacturerSelector", () => ({ default: () => null }));
vi.mock("../SetSelector/SetSelector", () => ({ default: () => null }));
vi.mock("../SetSelector/ParallelSelector", () => ({ default: () => null }));
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

/**
 * NEO-224: the drill lives in the URL and has no holes, so the page opens
 * drilled to a set — the variant-type column below is then a real column
 * under a real set, which is what these tests reach for.
 */
const DrilledToASet = ({ children }: { children: React.ReactNode }) => (
  <MemoryRouter initialEntries={["/?sport=sp&year=yr&brand=br&set=set1"]}>
    {children}
  </MemoryRouter>
);
import { PARALLEL_BUILD_HEADING_ID, UNFINISHED_TEXT } from "../SetSelector/ParallelBuildPanel";
import { BASE_PARALLELS_REASON_ID } from "../SetSelector/BaseParallelsBuildSection";

const selectType = (id: string) => fireEvent.click(screen.getByText(`select-${id}`));

const sectionHeading = () => screen.queryByRole("heading", { name: /^Parallels of / });

const BASE_SOURCE = { id: "vt-base", value: "Base", kind: "base" as const, hasCards: true };

const planWith = (parallels: Array<Record<string, unknown>>): Plan => ({
  parallels,
  truncated: false,
  source: BASE_SOURCE,
});

const PARALLEL_A = {
  _id: "p-a",
  value: "Gold Wave",
  sides: { bsc: true, sportlots: false },
  hasCards: false,
};

const checklistProps = () => {
  const el = screen.getByTestId("checklist");
  return {
    variantId: el.getAttribute("data-variant-id"),
    parallelBuild: JSON.parse(el.getAttribute("data-parallel-build") ?? "null"),
    panelElsewhere: el.getAttribute("data-panel-elsewhere"),
  };
};

beforeEach(() => {
  // The runner remembers a run that was live when its host unmounted, at
  // module scope, so the next mount starts on it. A previous test's live run
  // must not leak into this one: mount and unmount once (the mount clears it).
  render(<SetSelector />, { wrapper: DrilledToASet }).unmount();
  vi.clearAllMocks();
  planCalls.length = 0;
  state.plan = planWith([PARALLEL_A]);
  mockConvex.query.mockImplementation(async () => state.plan);
});

describe("SetSelector — Parallels of Base section visibility (NEO-321)", () => {
  it("shows for a variant type whose role is parallel", () => {
    render(<SetSelector />, { wrapper: DrilledToASet });
    selectType("vt-parallel");
    expect(sectionHeading()?.textContent).toBe("Parallels of Base");
  });

  it("shows for a role-parallel type with ANY name: renaming the row does not change the result", () => {
    render(<SetSelector />, { wrapper: DrilledToASet });
    selectType("vt-parallel-renamed");
    expect(sectionHeading()).toBeTruthy();
  });

  it("does not show for a row merely named Parallel when its role is insert", () => {
    render(<SetSelector />, { wrapper: DrilledToASet });
    selectType("vt-lookalike");
    expect(sectionHeading()).toBeNull();
  });

  it("does not show for a row merely named Parallel with no role at all", () => {
    render(<SetSelector />, { wrapper: DrilledToASet });
    selectType("vt-no-role");
    expect(sectionHeading()).toBeNull();
  });

  it("does not show on Base", () => {
    render(<SetSelector />, { wrapper: DrilledToASet });
    selectType("vt-base");
    expect(sectionHeading()).toBeNull();
  });

  it("goes away when the selection moves to a non-parallel type, and does not list parallels for it", () => {
    render(<SetSelector />, { wrapper: DrilledToASet });
    selectType("vt-parallel");
    expect(sectionHeading()).toBeTruthy();

    planCalls.length = 0;
    selectType("vt-lookalike");
    expect(sectionHeading()).toBeNull();
    // The plan query is skipped for a type that is not role-parallel.
    expect(planCalls.every((args) => args === "skip")).toBe(true);
  });

  it("lists the parallels by the variant type's id", () => {
    render(<SetSelector />, { wrapper: DrilledToASet });
    selectType("vt-parallel");
    expect(planCalls).toContainEqual({ sourceId: "vt-parallel" });
  });
});

describe("SetSelector — starting from the section (NEO-321)", () => {
  it("starts the hosted run with the Parallel variant type as the start row", async () => {
    render(<SetSelector />, { wrapper: DrilledToASet });
    selectType("vt-parallel");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Build 1 parallel from Base/ }));
    });

    await waitFor(() =>
      expect(mockConvex.query).toHaveBeenCalledWith("getParallelsForBuild", {
        sourceId: "vt-parallel",
      }),
    );
    await waitFor(() =>
      expect(mockConvex.action).toHaveBeenCalledWith("buildParallelChecklist", {
        parallelId: "p-a",
      }),
    );
  });

  it("draws the ledger once, in the section, and tells the checklist not to draw a second", async () => {
    render(<SetSelector />, { wrapper: DrilledToASet });
    selectType("vt-parallel");
    fireEvent.click(screen.getByText("select-row"));
    expect(checklistProps().panelElsewhere).toBe("false");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Build 1 parallel from Base/ }));
    });

    await waitFor(() =>
      expect(document.querySelectorAll(`#${PARALLEL_BUILD_HEADING_ID}`)).toHaveLength(1),
    );
    expect(checklistProps().panelElsewhere).toBe("true");
  });
});

describe("SetSelector — leaving and coming back mid-run (NEO-321)", () => {
  it("a returning set builder shows what the left run left, in the section", async () => {
    const first = render(<SetSelector />, { wrapper: DrilledToASet });
    selectType("vt-parallel");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Build 1 parallel from Base/ }));
    });
    await waitFor(() => expect(mockConvex.action).toHaveBeenCalled());
    first.unmount();

    render(<SetSelector />, { wrapper: DrilledToASet });
    selectType("vt-parallel");
    expect(document.querySelectorAll(`#${PARALLEL_BUILD_HEADING_ID}`)).toHaveLength(1);
    expect(screen.getByText(new RegExp(UNFINISHED_TEXT))).toBeTruthy();
  });
});

describe("SetSelector — a base-parallel row builds from Base (NEO-321 D3)", () => {
  it("hands the checklist the source the server resolved, by id and name", () => {
    render(<SetSelector />, { wrapper: DrilledToASet });
    selectType("vt-parallel");
    fireEvent.click(screen.getByText("select-row"));

    const { variantId, parallelBuild } = checklistProps();
    expect(variantId).toBe("row-gold-wave");
    expect(parallelBuild).toEqual({
      role: "parallel",
      sourceId: "vt-base",
      sourceValue: "Base",
    });
  });

  it("carries the server's name for the source, so a renamed Base is labelled by what it is called", () => {
    state.plan = {
      ...planWith([PARALLEL_A]),
      source: { ...BASE_SOURCE, value: "Flagship" },
    };
    render(<SetSelector />, { wrapper: DrilledToASet });
    selectType("vt-parallel");
    fireEvent.click(screen.getByText("select-row"));
    expect(checklistProps().parallelBuild.sourceValue).toBe("Flagship");
  });

  it("carries no source while the plan loads, so the checklist's button waits instead of fetching", () => {
    state.plan = undefined;
    render(<SetSelector />, { wrapper: DrilledToASet });
    selectType("vt-parallel");
    fireEvent.click(screen.getByText("select-row"));

    const { parallelBuild } = checklistProps();
    expect(parallelBuild.role).toBe("parallel");
    expect(parallelBuild.sourceValue).toBeUndefined();
    // Loading is not "no Base": the stand-in must say Loading…, not Can't build.
    expect(parallelBuild.unavailableReasonId).toBeUndefined();
  });

  it("points the row at the section's reason line once the plan is in and there is no single Base", () => {
    state.plan = { parallels: [PARALLEL_A], truncated: false, source: null, sourceBlocked: "no base" };
    render(<SetSelector />, { wrapper: DrilledToASet });
    selectType("vt-parallel");
    fireEvent.click(screen.getByText("select-row"));

    const { parallelBuild } = checklistProps();
    expect(parallelBuild.sourceValue).toBeUndefined();
    expect(parallelBuild.unavailableReasonId).toBe(BASE_PARALLELS_REASON_ID);
    // ...and that id is on the page, on the sentence that says why.
    expect(document.getElementById(BASE_PARALLELS_REASON_ID)).toBeTruthy();
  });

  it("a row under a role-insert type stays an insert", () => {
    render(<SetSelector />, { wrapper: DrilledToASet });
    selectType("vt-lookalike");
    fireEvent.click(screen.getByText("select-row"));
    expect(checklistProps().parallelBuild).toEqual({ role: "insert" });
  });

  it("Base's own checklist gets no parallelBuild: its save builds nothing (D2)", () => {
    render(<SetSelector />, { wrapper: DrilledToASet });
    selectType("vt-base");
    expect(checklistProps().parallelBuild).toBeNull();
  });
});
