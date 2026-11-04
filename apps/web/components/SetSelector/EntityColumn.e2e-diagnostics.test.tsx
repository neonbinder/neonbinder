/**
 * NEO-417 — what EntityColumn adds to the E2E timeline: a `branch` entry for
 * every swap of what the column shows, including the idle <-> syncing swap that
 * `mode` never records, and one hold on the press listeners per mounted column.
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
  release: vi.fn(),
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

function branchEntries() {
  return diagnostics.e2eDiagnostic.mock.calls
    .filter(([, properties]) => properties.action === "branch")
    .map(([event, properties]) => ({ event, ...properties }));
}

describe("EntityColumn E2E diagnostics (NEO-417)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    diagnostics.holdE2EPressListeners.mockReturnValue(diagnostics.release);
    state.items = [{ _id: "vt1", value: "Base", level: "variantType" }];
    state.status = null;
  });

  it("records nothing for the branch a column mounts on", async () => {
    render(column());
    await act(async () => {});
    expect(branchEntries()).toEqual([]);
  });

  it("records the idle <-> syncing swap, which mode never shows", async () => {
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

    expect(branchEntries()).toEqual([
      {
        event: "e2e_column",
        action: "branch",
        level: "variantType",
        from: "idle",
        to: "syncing",
        has_interacted: false,
      },
      {
        event: "e2e_column",
        action: "branch",
        level: "variantType",
        from: "syncing",
        to: "idle",
        has_interacted: false,
      },
    ]);
    const modeChanges = diagnostics.e2eDiagnostic.mock.calls.filter(
      ([, properties]) => properties.action === "mode",
    );
    expect(modeChanges).toEqual([]);
  });

  it("holds the press listeners once per column and releases them on unmount", async () => {
    const view = render(column());
    await act(async () => {});
    view.rerender(column());
    await act(async () => {});

    expect(diagnostics.holdE2EPressListeners).toHaveBeenCalledTimes(1);
    expect(diagnostics.release).not.toHaveBeenCalled();

    view.unmount();
    expect(diagnostics.release).toHaveBeenCalledTimes(1);
  });

  it("holds them from a mounted column that is not visible yet", async () => {
    render(<EntityColumn {...props} isVisible={false} />);
    await act(async () => {});
    expect(diagnostics.holdE2EPressListeners).toHaveBeenCalledTimes(1);
  });
});
