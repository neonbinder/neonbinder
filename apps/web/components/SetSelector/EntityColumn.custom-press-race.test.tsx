/**
 * NEO-417 — a press on "+ Custom" that beats auto-sync must keep the form.
 *
 * ## The ordering
 *
 * A commit that is not a discrete update (a Convex result arriving, which is a
 * plain `useState` write off the socket) leaves its passive effects for later,
 * so a click can land between the commit and the flush. React then flushes
 * those effects BEFORE rendering the click's update, which puts the two writes
 * in this queue order:
 *
 *     setMode("custom")   the click handler
 *     setMode("sync")     auto-sync, whose closure saw mode === "idle"
 *
 * They collapse in one render, last write wins, and the only thing the timeline
 * shows is `custom_open` followed by `mode idle -> sync`.
 *
 * ## How this reproduces it
 *
 * `PressBeforePassiveEffects` is a child that clicks the real button from a
 * layout effect. That is inside the commit in which `items` resolves to `[]`:
 * the DOM is updated, and that commit's passive effects have not run. It is a
 * stand-in for "the input event was handled first", which a test cannot time
 * through the scheduler, but React handles the two identically: the click's
 * update is queued, then `flushPendingEffects` runs ahead of the render.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { GenericId } from "convex/values";
import React, { useLayoutEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./SlSetReviewPill", () => ({ default: () => null }));

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

const state: { items: unknown } = { items: undefined };

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
  useConvex: () => ({ query: vi.fn() }),
  useQuery: (ref: string) => (ref === "getSelectorOptions" ? state.items : undefined),
}));

import EntityColumn from "./EntityColumn";

const PARENT_ID = "variant-type-id" as unknown as GenericId<"selectorOptions">;
const SYNC_FORM = "sync-form";
const CUSTOM_HEADING = "Add Custom Entry";

const press = { armed: false, fired: 0 };

function PressBeforePassiveEffects() {
  useLayoutEffect(() => {
    if (!press.armed) return;
    press.armed = false;
    press.fired += 1;
    screen.getByText("+ Custom").click();
  });
  return null;
}

/** A fresh element each call: the same object would bail out of the rerender. */
const column = (onDoneRef?: { current: (() => void) | null }) => (
  <EntityColumn
    selector={<PressBeforePassiveEffects />}
    renderForm={(onDone) => {
      if (onDoneRef) onDoneRef.current = onDone;
      return <div>{SYNC_FORM}</div>;
    }}
    addButtonText="Sync Parallels"
    isVisible
    level="insert"
    parentId={PARENT_ID}
  />
);

/** The column is mounted and loading, then the press lands in the commit that resolves it empty. */
async function pressAsItemsResolveEmpty() {
  state.items = undefined;
  const view = render(column());
  await act(async () => {});
  press.armed = true;
  state.items = [];
  await act(async () => {
    view.rerender(column());
  });
  return view;
}

describe("EntityColumn — a press that beats auto-sync (NEO-417)", () => {
  beforeEach(() => {
    state.items = undefined;
    press.armed = false;
    press.fired = 0;
  });

  it("keeps the custom form when the press lands before auto-sync's effect flushes", async () => {
    await pressAsItemsResolveEmpty();

    // The press really did land in that commit, or this proves nothing.
    expect(press.fired).toBe(1);
    expect(screen.getByText(CUSTOM_HEADING)).toBeTruthy();
    expect(screen.queryByText(SYNC_FORM)).toBeNull();
  });

  it("still auto-syncs an empty column nobody pressed", async () => {
    state.items = undefined;
    const view = render(column());
    await act(async () => {});
    state.items = [];
    await act(async () => {
      view.rerender(column());
    });

    expect(screen.getByText(SYNC_FORM)).toBeTruthy();
    expect(screen.queryByText(CUSTOM_HEADING)).toBeNull();
  });

  // The key records a sync that happened. A press that won means none did, so
  // cancelling lands exactly where a press made before the list loaded lands.
  it("auto-syncs after the operator cancels a press that beat it", async () => {
    await pressAsItemsResolveEmpty();
    expect(screen.queryByText(SYNC_FORM)).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Cancel new insert"));
    });

    expect(screen.getByText(SYNC_FORM)).toBeTruthy();
    expect(screen.queryByText(CUSTOM_HEADING)).toBeNull();
  });

  it("does the same for a press made before the list loaded, the path with no race", async () => {
    state.items = undefined;
    const view = render(column());
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByText("+ Custom"));
    });
    state.items = [];
    await act(async () => {
      view.rerender(column());
    });
    expect(screen.getByText(CUSTOM_HEADING)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Cancel new insert"));
    });

    expect(screen.getByText(SYNC_FORM)).toBeTruthy();
  });

  it("does not sync a second time once a sync really ran, even after a cancelled form", async () => {
    const onDone: { current: (() => void) | null } = { current: null };
    state.items = undefined;
    const view = render(column(onDone));
    await act(async () => {});
    state.items = [];
    await act(async () => {
      view.rerender(column(onDone));
    });
    expect(screen.getByText(SYNC_FORM)).toBeTruthy();

    // The sync finds nothing and hands back to idle, the column still empty.
    await act(async () => {
      onDone.current?.();
    });
    expect(screen.queryByText(SYNC_FORM)).toBeNull();
    expect(screen.getByText("+ Custom")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("+ Custom"));
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Cancel new insert"));
    });

    expect(screen.queryByText(SYNC_FORM)).toBeNull();
    expect(screen.getByText("+ Custom")).toBeTruthy();
  });

  // Not the commit ordering above: an old fetch outliving the form that started
  // it, which VariantForm's has no mount guard against.
  it("keeps the custom form when a frozen sync's old fetch finishes", async () => {
    const onDone: { current: (() => void) | null } = { current: null };
    state.items = undefined;
    const view = render(column(onDone));
    await act(async () => {});
    // Rows arriving after mount are what let a later press freeze the column.
    state.items = [{ _id: "row-id", value: "Row" }];
    await act(async () => {
      view.rerender(column(onDone));
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Sync Parallels"));
    });
    const staleOnDone = onDone.current;
    expect(screen.getByText(SYNC_FORM)).toBeTruthy();

    await act(async () => {
      fireEvent.pointerDown(screen.getByText(SYNC_FORM));
    });
    expect(screen.queryByText(SYNC_FORM)).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByText("+ Custom"));
    });
    expect(screen.getByText(CUSTOM_HEADING)).toBeTruthy();

    await act(async () => {
      staleOnDone?.();
    });

    expect(screen.getByText(CUSTOM_HEADING)).toBeTruthy();
  });
});
