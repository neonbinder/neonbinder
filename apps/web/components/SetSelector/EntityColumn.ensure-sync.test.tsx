/**
 * NEO-47 — EntityColumn new "ensureSync" path (sync redesign).
 *
 * The legacy path stranded a column in sync mode when the form's onDone handoff
 * was dropped (the #28 stuck-"Syncing" race). The new path has NO sync mode and
 * NO onDone: the column's display is derived purely from the reactive
 * selectorSyncStatus query, so the dropped-handoff race is structurally
 * impossible. These deterministic tests pin that behavior:
 *   1. empty column → triggers ensureSelectorOptions once + shows "+ Custom"
 *      immediately (no sync mode hiding it).
 *   2. status=syncing → loading box (flow-asserted heading) + "+ Custom" hidden.
 *   3. status=error → error message, "+ Custom" still available (not stranded).
 *
 * Mocking mirrors EntityColumn.field-class.test.tsx but branches useQuery /
 * useMutation by reference so items vs syncStatus (and ensure vs addCustom) can
 * be controlled independently.
 */

import { act, render } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { EntityColumnProps } from "./EntityColumn";

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

const mockEnsure = vi.fn();
const mockAddCustom = vi.fn();
// Mutable holders read lazily by the mocked hooks at call time.
const state: { items: unknown; status: unknown } = {
  items: undefined,
  status: null,
};

vi.mock("convex/react", () => ({
  useMutation: () => mockAddCustom,
  useAction: (ref: string) =>
    ref === "ensureSelectorOptions" ? mockEnsure : vi.fn(),
  useQuery: (ref: string) =>
    ref === "getSelectorSyncStatus" ? state.status : state.items,
}));

import EntityColumn from "./EntityColumn";

const vtProps: EntityColumnProps = {
  selector: <div>selector</div>,
  renderForm: () => <div>legacy-form</div>,
  addButtonText: "Sync Variant Types",
  isVisible: true,
  level: "variantType",
  useEnsureSync: true,
  syncingLabel: "Syncing Variant Types",
};

function renderVT() {
  return render(<EntityColumn {...vtProps} />);
}

describe("EntityColumn — ensureSync new path (NEO-47)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.items = undefined;
    state.status = null;
    mockEnsure.mockResolvedValue({ scheduled: true, reason: "scheduled" });
  });

  it("empty column triggers ensureSelectorOptions once + shows + Custom (no sync mode, no legacy form)", async () => {
    state.items = [];
    state.status = null;
    const { getByText, queryByText } = renderVT();
    await act(async () => {});
    expect(mockEnsure).toHaveBeenCalledTimes(1);
    expect(getByText("+ Custom")).toBeTruthy();
    expect(queryByText("Syncing Variant Types")).toBeNull();
    expect(queryByText("legacy-form")).toBeNull();
  });

  it("status=syncing shows the loading box heading and hides + Custom", async () => {
    state.items = [];
    state.status = { status: "syncing" };
    const { getByText, queryByText } = renderVT();
    await act(async () => {});
    expect(getByText("Syncing Variant Types")).toBeTruthy();
    expect(queryByText("+ Custom")).toBeNull();
    expect(queryByText("legacy-form")).toBeNull();
  });

  it("status=error surfaces the message but keeps + Custom available (not stranded)", async () => {
    state.items = [];
    state.status = { status: "error", message: "Couldn't sync options." };
    const { getByText } = renderVT();
    await act(async () => {});
    expect(getByText("Couldn't sync options.")).toBeTruthy();
    expect(getByText("+ Custom")).toBeTruthy();
  });

  // The Sport aggregator level's selectorSyncStatus row is a single GLOBAL
  // record shared across every concurrent session (no parentId → no per-user
  // scoping). A concurrent admin/E2E worker running a real "Sync Sports" flips
  // it to "syncing" for EVERYONE. These pin the freeze-on-interaction carve-out
  // that stops that global flip from evicting an in-progress session's idle UI.
  describe("concurrent global-sync eviction (freeze-on-interaction)", () => {
    // Fires one of the capture-phase interaction listeners on the column root,
    // exactly as a real scroll / pointerdown / keydown would.
    function interact(root: Element | null) {
      root?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    }

    // Mounts loading, then resolves items to a populated list — mirroring the
    // real lifecycle (items undefined → data). That post-mount transition is
    // what latches "first sync done" so a subsequent interaction can freeze the
    // column; a column mounted already-populated has its latch cleared by the
    // parentId-reset effect and would never freeze (an existing subtlety this
    // test deliberately steps around by transitioning like production does).
    async function mountThenPopulate(
      rerender: (ui: React.ReactElement) => void,
    ) {
      state.items = [{ _id: "vt1", value: "Base", level: "variantType" }];
      await act(async () => {
        rerender(<EntityColumn {...vtProps} />);
      });
    }

    it("keeps + Custom for an interacted, already-synced column when a background sync flips status to syncing", async () => {
      state.items = undefined; // loading
      state.status = null;
      const { container, getByText, queryByText, rerender } = renderVT();
      await act(async () => {});
      await mountThenPopulate(rerender); // items resolve → first sync latched
      expect(getByText("+ Custom")).toBeTruthy();

      // This session engages the column (about to click "+ Custom").
      await act(async () => {
        interact(container.firstElementChild);
      });

      // A DIFFERENT session's "Sync" flips the shared global row to syncing.
      state.status = { status: "syncing" };
      await act(async () => {
        rerender(<EntityColumn {...vtProps} />);
      });

      // Idle UI must survive — the background sync must not swallow the
      // interaction by swapping in the "Fetching from marketplaces…" panel.
      expect(getByText("+ Custom")).toBeTruthy();
      expect(queryByText("Syncing Variant Types")).toBeNull();
    });

    it("still shows the syncing panel for the session that clicked Sync itself", async () => {
      state.items = undefined;
      state.status = null;
      const { getByText, queryByText, rerender } = renderVT();
      await act(async () => {});
      await mountThenPopulate(rerender);

      // Real click = pointerdown (sets hasInteracted) then click (runs
      // forceSync → setSelfRequestedSync). Both must be present so this test
      // proves selfRequestedSync overrides hasInteracted, not just that
      // hasInteracted happens to be false.
      const syncBtn = getByText("Sync Variant Types");
      await act(async () => {
        syncBtn.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        syncBtn.click();
      });
      expect(mockEnsure).toHaveBeenCalledWith(
        expect.objectContaining({ level: "variantType", force: true }),
      );

      // The operator's own sync now reports progress via the shared row.
      state.status = { status: "syncing" };
      await act(async () => {
        rerender(<EntityColumn {...vtProps} />);
      });
      expect(getByText("Syncing Variant Types")).toBeTruthy();
      expect(queryByText("+ Custom")).toBeNull();
    });

    it("re-hides the panel once the self-requested sync ends, so a later background sync no longer evicts", async () => {
      state.items = undefined;
      state.status = null;
      const { getByText, queryByText, rerender } = renderVT();
      await act(async () => {});
      await mountThenPopulate(rerender);

      const syncBtn = getByText("Sync Variant Types");
      await act(async () => {
        syncBtn.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        syncBtn.click();
      });

      // Own sync in flight → panel shows.
      state.status = { status: "syncing" };
      await act(async () => {
        rerender(<EntityColumn {...vtProps} />);
      });
      expect(getByText("Syncing Variant Types")).toBeTruthy();

      // Own sync completes (row cleared) → selfRequestedSync latch resets.
      state.status = null;
      await act(async () => {
        rerender(<EntityColumn {...vtProps} />);
      });
      expect(getByText("+ Custom")).toBeTruthy();

      // A subsequent BACKGROUND sync (someone else) must NOT re-evict, because
      // this session is still interacted but no longer self-requesting.
      state.status = { status: "syncing" };
      await act(async () => {
        rerender(<EntityColumn {...vtProps} />);
      });
      expect(getByText("+ Custom")).toBeTruthy();
      expect(queryByText("Syncing Variant Types")).toBeNull();
    });
  });
});
