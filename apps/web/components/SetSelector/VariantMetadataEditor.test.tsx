/**
 * NEO-111 regression coverage — VariantMetadataEditor's reactive stomp.
 *
 * Found by enabling `react-hooks/set-state-in-effect` on `.tsx` for the first
 * time. This is the NEO-41 shape in miniature: the component is both a live view
 * of a `selectorOptions` row and an editor for one of its fields, and its
 * hydration effect resynced `cardNumberPrefix` unconditionally.
 *
 * So a server-side change to that field while the operator was typing did two
 * things, both silent: it replaced what they had typed, and it reset `dirty` to
 * false — removing the only signal that there was an unsaved edit at all.
 *
 * The fix mirrors NEO-41: hydrate only when the local draft is clean. Switching
 * to a different row still resets, because that is a different draft.
 *
 * --- Mocking strategy ---
 * `convex/react` is module-mocked with `useQuery` routed by the (string-mocked)
 * query reference, as in CardDetailPanel.test.tsx. `currentOption` is a
 * module-level handle the tests swap to simulate a reactive push, then force
 * through with RTL's `rerender`.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptionById: "getSelectorOptionById",
      getAncestorChain: "getAncestorChain",
      updateSelectorOptionMetadata: "updateSelectorOptionMetadata",
    },
  },
}));

type Option = Record<string, unknown> | undefined;
let currentOption: Option;
const mockUpdate = vi.fn(() => Promise.resolve());

vi.mock("convex/react", () => ({
  useQuery: (ref: string) =>
    ref === "getSelectorOptionById"
      ? currentOption
      : [{ level: "variantType", value: "insert" }],
  useMutation: () => mockUpdate,
}));

import VariantMetadataEditor from "./VariantMetadataEditor";

/** A fresh object each call — what a Convex reactive push actually looks like. */
const option = (prefix: string | undefined, id = "opt1") => ({
  _id: id,
  level: "insert",
  metadata: { cardNumberPrefix: prefix, isInsert: true, isParallel: false },
});

const prefixField = () =>
  screen.getByPlaceholderText("e.g. DK-") as HTMLInputElement;

const render0 = () =>
  render(<VariantMetadataEditor optionId={"opt1" as never} />);
const rerender0 = (v: ReturnType<typeof render0>) =>
  v.rerender(<VariantMetadataEditor optionId={"opt1" as never} />);

beforeEach(() => {
  currentOption = undefined;
  mockUpdate.mockClear();
});

describe("VariantMetadataEditor — prefix hydration", () => {
  it("hydrates the prefix from the row", () => {
    currentOption = option("DK-");
    render0();
    expect(prefixField().value).toBe("DK-");
  });

  it("re-hydrates on a later push while the draft is clean", () => {
    currentOption = option("DK-");
    const view = render0();

    currentOption = option("ZX-");
    rerender0(view);

    expect(prefixField().value).toBe("ZX-");
  });
});

describe("VariantMetadataEditor — reactive stomp guard", () => {
  it("does NOT overwrite a prefix the operator is editing", () => {
    currentOption = option("DK-");
    const view = render0();

    fireEvent.change(prefixField(), { target: { value: "MY-EDIT" } });

    // A concurrent change to the same field lands mid-edit.
    currentOption = option("ZX-");
    rerender0(view);

    expect(prefixField().value).toBe("MY-EDIT");
  });

  it("keeps the unsaved-edit state visible after such a push", () => {
    // The old effect also reset `dirty`, so the edit survived nowhere and the
    // Save affordance went away — the edit was lost silently.
    currentOption = option("DK-");
    const view = render0();

    fireEvent.change(prefixField(), { target: { value: "MY-EDIT" } });
    currentOption = option("ZX-");
    rerender0(view);

    // Plain DOM assertion — this project does not load jest-dom matchers.
    const save = screen.getByRole("button", {
      name: /save/i,
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
  });

  it("survives repeated pushes, not just the first", () => {
    currentOption = option("DK-");
    const view = render0();
    fireEvent.change(prefixField(), { target: { value: "MINE" } });

    for (const p of ["a-", "b-", "c-"]) {
      currentOption = option(p);
      rerender0(view);
    }

    expect(prefixField().value).toBe("MINE");
  });

  it("DOES reset when the row itself changes — a new row is a new draft", () => {
    currentOption = option("DK-");
    const view = render0();
    fireEvent.change(prefixField(), { target: { value: "MY-EDIT" } });

    currentOption = option("ZX-", "opt2");
    rerender0(view);

    expect(prefixField().value).toBe("ZX-");
  });
});
