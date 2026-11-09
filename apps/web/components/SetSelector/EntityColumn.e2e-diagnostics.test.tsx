/**
 * NEO-475 (D1) — EntityColumn used to add a timeline of `e2e_column` entries and
 * a hold on the press listeners (NEO-392, NEO-417). Both are gone: the mock
 * below still offers them, and these tests fail if the column calls either.
 */

import { act, render } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityColumnProps } from "./EntityColumn";

vi.mock("./SlSetReviewPill", () => ({ default: () => null }));

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptions: "getSelectorOptions",
      getSelectorSyncStatus: "getSelectorSyncStatus",
      addCustomSelectorOption: "addCustomSelectorOption",
      ensureSelectorOptions: "ensureSelectorOptions",
    },
  },
}));

const state: { items: unknown; status: unknown } = { items: undefined, status: null };

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useConvex: () => ({ query: vi.fn() }),
  useAction: () => vi.fn().mockResolvedValue({ scheduled: false }),
  useQuery: (ref: string) => {
    if (ref === "getSelectorSyncStatus") return state.status;
    return ref === "getSelectorOptions" ? state.items : undefined;
  },
}));

const diagnostics = vi.hoisted(() => ({
  e2eDiagnostic: vi.fn(),
  holdE2EPressListeners: vi.fn(),
}));

vi.mock("@/lib/observability/e2e-diagnostics", () => ({
  e2eDiagnostic: diagnostics.e2eDiagnostic,
  holdE2EPressListeners: diagnostics.holdE2EPressListeners,
}));

import EntityColumn from "./EntityColumn";

const props: EntityColumnProps = {
  selector: <div>selector</div>,
  addButtonText: "Sync Sets",
  isVisible: true,
  level: "variantType",
  useEnsureSync: true,
  syncingLabel: "Syncing Sets",
};

const column = () => <EntityColumn {...props} />;

describe("EntityColumn E2E diagnostics (NEO-475: none are sent)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.items = [{ _id: "vt1", value: "Base", level: "variantType" }];
    state.status = null;
  });

  it("emits no diagnostic on mount, on the idle <-> syncing swap, or on unmount", async () => {
    const view = render(column());
    await act(async () => {});

    state.status = { status: "syncing" };
    await act(async () => {
      view.rerender(column());
    });
    state.status = null;
    await act(async () => {
      view.rerender(column());
    });
    view.unmount();

    expect(diagnostics.e2eDiagnostic).not.toHaveBeenCalled();
  });

  it("does not hold the press listeners, visible or not", async () => {
    render(column());
    render(<EntityColumn {...props} isVisible={false} />);
    await act(async () => {});
    expect(diagnostics.holdE2EPressListeners).not.toHaveBeenCalled();
  });
});
