/**
 * NEO-306 — the Sets column's SportLots-only review pill: "N SportLots sets
 * to sort" (or "N … left — save again" after a save stopped part-way), where
 * it shows, what it opens, and what the column does when the review reports
 * back.
 *
 * The REAL pill (`SlSetReviewPill`) renders against a routed `useQuery`; the
 * dialog is stubbed so this file tests the column's wiring, not the dialog
 * (`SlSetReviewModal.test.tsx` covers that).
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { GenericId } from "convex/values";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type OptionId = GenericId<"selectorOptions">;

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptions: "getSelectorOptions",
      getAncestorChain: "getAncestorChain",
      getSelectorSyncSuggestions: "getSelectorSyncSuggestions",
      addCustomSelectorOption: "addCustomSelectorOption",
      findSelectorOptionElsewhere: "findSelectorOptionElsewhere",
    },
    slSetReview: { getSlSetReviewSummary: "getSlSetReviewSummary" },
  },
}));

const state: { summary: unknown; summaryArgs: unknown[] } = {
  summary: null,
  summaryArgs: [],
};

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
  useConvex: () => ({ query: vi.fn() }),
  useQuery: (ref: string, args: unknown) => {
    if (args === "skip") return undefined;
    if (ref === "getSlSetReviewSummary") {
      state.summaryArgs.push(args);
      return state.summary;
    }
    // A populated column: an empty one auto-opens its sync form.
    if (ref === "getSelectorOptions") return [{ _id: "set-bowman", value: "Bowman" }];
    return undefined;
  },
}));

type ModalProps = {
  manufacturerId: OptionId;
  restoreFocusRef?: React.RefObject<HTMLElement | null>;
  fallbackFocusRef?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onSaved: (text: string) => void;
};
const modalProps: ModalProps[] = [];
vi.mock("./SlSetReviewModal", () => ({
  default: (props: ModalProps) => {
    modalProps.push(props);
    return (
      <div role="dialog" aria-label="review stub">
        <button type="button" onClick={props.onClose}>
          stub cancel
        </button>
        <button type="button" onClick={() => props.onSaved("Saved 1 set, 2 parallels.")}>
          stub save
        </button>
      </div>
    );
  },
}));

import EntityColumn from "./EntityColumn";

const BRAND_ID = "mfr-bowman" as unknown as OptionId;
const YEAR_ID = "year-2026" as unknown as OptionId;

function renderColumn(
  overrides: Partial<{
    level: "setName" | "manufacturer";
    parentId: OptionId;
    hideCustom: { reason: string };
  }> = {},
) {
  return render(
    <EntityColumn
      selector={<div>selector</div>}
      renderForm={() => <div>form</div>}
      addButtonText="Sync Sets"
      isVisible={true}
      level={overrides.level ?? "setName"}
      parentId={overrides.parentId ?? BRAND_ID}
      hideCustom={overrides.hideCustom}
    />,
  );
}

beforeEach(() => {
  state.summary = null;
  state.summaryArgs = [];
  modalProps.length = 0;
});

describe("the SportLots-only review pill on the Sets column (NEO-306)", () => {
  it("says how many SportLots sets wait, and asks for THIS brand's review", () => {
    state.summary = { pending: 3, partial: false, moreNextSync: 0 };
    renderColumn();
    const pill = screen.getByRole("button", { name: "3 SportLots sets to sort" });
    expect(pill.getAttribute("aria-haspopup")).toBe("dialog");
    expect(state.summaryArgs).toContainEqual({ manufacturerId: BRAND_ID });
  });

  it("uses the singular for one", () => {
    state.summary = { pending: 1, partial: false, moreNextSync: 0 };
    renderColumn();
    expect(screen.getByRole("button", { name: "1 SportLots set to sort" })).toBeTruthy();
  });

  it("says 'left — save again' when a save stopped part-way", () => {
    state.summary = { pending: 2, partial: true, moreNextSync: 0 };
    renderColumn();
    expect(
      screen.getByRole("button", { name: "2 SportLots sets left — save again" }),
    ).toBeTruthy();
  });

  it("is absent when nothing waits, while loading, and for a malformed answer", () => {
    for (const summary of [null, undefined, { pending: 0, partial: false }, [1, 2]]) {
      state.summary = summary;
      const { unmount } = renderColumn();
      expect(screen.queryByText(/SportLots set/)).toBeNull();
      unmount();
    }
  });

  it("is not asked for on another level, nor in the All Brands view (a year parent)", () => {
    state.summary = { pending: 4, partial: false, moreNextSync: 0 };
    const { unmount } = renderColumn({ level: "manufacturer", parentId: YEAR_ID });
    expect(screen.queryByText(/SportLots set/)).toBeNull();
    unmount();
    renderColumn({ parentId: YEAR_ID, hideCustom: { reason: "Pick a brand to add a set" } });
    expect(screen.queryByText(/SportLots set/)).toBeNull();
    expect(state.summaryArgs).toEqual([]);
  });

  it("opens the review for this brand, with the pill as the focus return target", async () => {
    state.summary = { pending: 3, partial: false, moreNextSync: 0 };
    renderColumn();
    const pill = screen.getByRole("button", { name: "3 SportLots sets to sort" });
    await act(async () => {
      fireEvent.click(pill);
    });
    expect(screen.getByRole("dialog", { name: "review stub" })).toBeTruthy();
    const props = modalProps[modalProps.length - 1];
    expect(props.manufacturerId).toBe(BRAND_ID);
    expect(props.restoreFocusRef?.current).toBe(pill);
    expect(props.fallbackFocusRef?.current).toBeTruthy();
  });

  it("opens on Enter too (maestro-web's pressKey is synthetic)", async () => {
    state.summary = { pending: 3, partial: false, moreNextSync: 0 };
    renderColumn();
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("button", { name: "3 SportLots sets to sort" }), {
        key: "Enter",
      });
    });
    expect(screen.getByRole("dialog", { name: "review stub" })).toBeTruthy();
  });

  it("Cancel closes the review and says nothing", async () => {
    state.summary = { pending: 3, partial: false, moreNextSync: 0 };
    renderColumn();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "3 SportLots sets to sort" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByText("stub cancel"));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a finished save closes the review and toasts what it saved, then the toast goes", async () => {
    vi.useFakeTimers();
    try {
      state.summary = { pending: 3, partial: false, moreNextSync: 0 };
      renderColumn();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "3 SportLots sets to sort" }));
      });
      await act(async () => {
        fireEvent.click(screen.getByText("stub save"));
      });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByRole("status").textContent).toBe("Saved 1 set, 2 parallels.");
      await act(async () => {
        vi.advanceTimersByTime(6000);
      });
      expect(screen.queryByRole("status")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
