/**
 * NEO-189 — MultiSourcePanel is the only place an operator sees what a row is
 * actually attached to, so it has to say which BSC FACET each slot filters on.
 *
 * Two BSC slugs on one row can mean completely different things: a slug tagged
 * `setName` sources the whole set at this row's variant (the Topps Series 1 /
 * Series 2 split this feature exists for), while a slug tagged `variantName`
 * sources one named variant inside a set. Nothing in the label or the slug
 * separates them, and getting it wrong mis-sources an entire checklist — which
 * is the failure mode this whole surface guards against.
 *
 * An UNTAGGED slot renders with no tag at all, deliberately. Every slot written
 * before NEO-189 and every slot the reconciler writes is untagged, and those
 * are handled by the old NB-level rule; showing a guessed tag would tell the
 * operator the row sources something it does not.
 *
 * Mocking strategy mirrors AttachSetsDialog.test.tsx: convex/react's
 * useQuery/useMutation are module-mocked and routed by the (string-mocked)
 * function reference.
 */

import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptionById: "getSelectorOptionById",
      getAncestorChain: "getAncestorChain",
      detachPlatformId: "detachPlatformId",
      renamePlatformLabel: "renamePlatformLabel",
    },
    setReconciliation: {
      fetchSlAttachSets: "fetchSlAttachSets",
      fetchBscAttachOptions: "fetchBscAttachOptions",
    },
  },
}));

const queryResults: Record<string, unknown> = {};

vi.mock("convex/react", () => ({
  useQuery: (ref: string) => queryResults[ref],
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
}));

import MultiSourcePanel from "./MultiSourcePanel";

const ROW_ID = "row-1" as unknown as Parameters<
  typeof MultiSourcePanel
>[0]["selectorOptionId"];

const SERIES_1 = "2024-topps-series-1";
const SERIES_2 = "2024-topps-series-2";

/** A Base row carrying the reconciler's untagged slot plus tagged extras. */
function setRow(row: Record<string, unknown>) {
  queryResults.getSelectorOptionById = {
    _id: ROW_ID,
    level: "variantType",
    value: "Base",
    ...row,
  };
  queryResults.getAncestorChain = [
    { _id: "sport-1", level: "sport", value: "Baseball", platformData: {} },
    { _id: ROW_ID, level: "variantType", value: "Base", platformData: {} },
  ];
}

const bscColumn = () => screen.getByText("BSC").parentElement as HTMLElement;

beforeEach(() => {
  delete queryResults.getSelectorOptionById;
  delete queryResults.getAncestorChain;
});

describe("MultiSourcePanel — the facet a BSC slot filters on (NEO-189)", () => {
  test("a setName slot reads 'set' and a variantName slot reads 'variant'", () => {
    setRow({
      platformData: { bsc: { b0: "base", b1: SERIES_1, b2: "gold-foil" } },
      platformLabels: {
        bsc: { b0: "Base", b1: "Series 1", b2: "Gold Foil" },
      },
      platformFacets: { bsc: { b1: "setName", b2: "variantName" } },
      primaryPlatformId: { bsc: "b0" },
    });
    render(<MultiSourcePanel selectorOptionId={ROW_ID} />);

    const bsc = within(bscColumn());
    expect(
      bsc.getByLabelText("Series 1 is attached as a BSC set"),
    ).toBeTruthy();
    expect(
      bsc.getByLabelText("Gold Foil is attached as a BSC variant"),
    ).toBeTruthy();
  });

  test("an UNTAGGED slot shows no tag — it is inert, not unknown", () => {
    setRow({
      platformData: { bsc: { b0: "base" } },
      platformLabels: { bsc: { b0: "Base" } },
      primaryPlatformId: { bsc: "b0" },
    });
    render(<MultiSourcePanel selectorOptionId={ROW_ID} />);

    const bsc = within(bscColumn());
    expect(bsc.getByText("Base")).toBeTruthy();
    expect(bsc.queryByLabelText(/is attached as a BSC/)).toBeNull();
  });

  test("both halves of an N:M split are listed, each tagged as a set", () => {
    // The product owner's case rendered: one NB Base row, two BSC sets.
    setRow({
      platformData: { bsc: { b1: SERIES_1, b2: SERIES_2 } },
      platformLabels: { bsc: { b1: "Series 1", b2: "Series 2" } },
      platformFacets: { bsc: { b1: "setName", b2: "setName" } },
      primaryPlatformId: { bsc: "b1" },
    });
    render(<MultiSourcePanel selectorOptionId={ROW_ID} />);

    const bsc = within(bscColumn());
    expect(bsc.getByLabelText("Series 1 is attached as a BSC set")).toBeTruthy();
    expect(bsc.getByLabelText("Series 2 is attached as a BSC set")).toBeTruthy();
  });

  test("SportLots chips never carry a facet tag", () => {
    // SL has one unit of attachment, so a tag there would be noise that reads
    // as a distinction the marketplace does not make.
    setRow({
      platformData: { sportlots: { s0: "884412" } },
      platformLabels: { sportlots: { s0: "Topps" } },
      primaryPlatformId: { sportlots: "s0" },
    });
    render(<MultiSourcePanel selectorOptionId={ROW_ID} />);

    const sl = within(screen.getByText("SportLots").parentElement as HTMLElement);
    expect(sl.getByText("Topps")).toBeTruthy();
    expect(sl.queryByLabelText(/is attached as a BSC/)).toBeNull();
  });
});
